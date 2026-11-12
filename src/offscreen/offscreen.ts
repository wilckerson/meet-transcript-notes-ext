/**
 * Offscreen Document (PLAN §3.2, §5, §7, §8, §14.1, §14.3, §14.4).
 *
 * Responsibilities:
 *  - Opens the Meet tab stream (`chromeMediaSource: 'tab'`) AND the user's microphone
 *    (`echoCancellation: true, noiseSuppression: true`), always together (§8).
 *  - Routes tab audio back to `audioContext.destination` so the user continues hearing the call (§3.2).
 *  - Never connects the microphone to `destination` (avoids echo).
 *  - Sums both streams into the 16 kHz mono AudioWorklet resampler.
 *  - Runs the chunker + VAD, queues chunks to the Whisper Web Worker, and retains unconfirmed
 *    chunks so GPU device-lost recovery (§14.3) can replay them without losing audio.
 *  - Performs the cheap size-only model cache check before loading the model (§14.1).
 *  - On Stop: stops capture, flushes the final partial buffer, drains the worker queue,
 *    and notifies the service worker when drained (§7).
 *  - On Release: disposes the worker pipeline and frees all audio/GPU resources (§14.4).
 */
import { AudioChunker, deduplicateOverlapSegments, type AudioChunk } from './chunker';
import {
  getResamplerWorkletUrl,
  WORKLET_PROCESSOR_NAME,
  type ResamplerFrameMessage,
} from './resampler.worklet';
import { RecoveryTracker } from './recovery';
import { verifyPresetSizes } from '../shared/integrity';
import { ChannelEnergyTracker } from '../shared/speaker';
import {
  sendSafe,
  type OffscreenCommand,
  type OffscreenStartConfig,
} from '../shared/messages';
import type { Device, QuantPreset, Segment } from '../shared/types';
import type { WorkerInboundMessage, WorkerOutboundMessage } from '../worker/whisper.worker';

const LAG_QUEUE_THRESHOLD = 2;
const HEARTBEAT_INTERVAL_MS = 15_000;

interface ActiveSession {
  sessionId: string;
  language: string;
  preset: QuantPreset;
  device: Device;
  tabStream: MediaStream | null;
  micStream: MediaStream | null;
  audioCtx: AudioContext | null;
  workletNode: AudioWorkletNode | null;
  chunker: AudioChunker;
  energyTracker: ChannelEnergyTracker;
  worker: Worker | null;
  workerReady: boolean;
  /** Unconfirmed chunks in FIFO order; front of queue may currently be in-flight. */
  pendingChunks: AudioChunk[];
  inFlightChunkId: number | null;
  emittedSegments: Segment[];
  stopping: boolean;
  haltedByError: boolean;
  recovery: RecoveryTracker;
  heartbeatTimer?: ReturnType<typeof setInterval>;
}

let session: ActiveSession | null = null;

async function detectPreferredDevice(): Promise<Device> {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    } catch {
      // fall through
    }
  }
  return 'wasm';
}

async function startSession(config: OffscreenStartConfig): Promise<void> {
  if (session) {
    await releaseAll();
  }

  // 1. Cheap size-only check on cached model files before loading (PLAN §14.1).
  const sizeCheck = await verifyPresetSizes(config.preset);
  if (!sizeCheck.ok) {
    const failed = sizeCheck.files.find((f) => !f.ok);
    await sendSafe({
      target: 'background',
      type: 'OFFSCREEN_ENGINE',
      sessionId: config.sessionId,
      phase: 'failed',
      error: `Model file verification failed (${failed?.file ?? 'missing file'}: ${failed?.reason ?? 'invalid'}). Open Setup to re-download or verify the model.`,
    });
    return;
  }

  // 2. Open BOTH tab audio and microphone streams (PLAN §8: Start is blocked unless both open).
  let tabStream: MediaStream;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Chrome-specific mandatory tab capture constraints
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: config.streamId,
        },
      } as unknown as MediaTrackConstraints,
      video: false,
    });
  } catch (err) {
    await sendSafe({
      target: 'background',
      type: 'OFFSCREEN_CAPTURE_ERROR',
      sessionId: config.sessionId,
      source: 'tab',
      error: `Could not capture Google Meet tab audio: ${String((err as Error)?.message ?? err)}`,
    });
    return;
  }

  let micStream: MediaStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    for (const t of tabStream.getTracks()) t.stop();
    await sendSafe({
      target: 'background',
      type: 'OFFSCREEN_CAPTURE_ERROR',
      sessionId: config.sessionId,
      source: 'mic',
      error: `Microphone access is required alongside tab audio (${String((err as Error)?.message ?? err)}). Grant microphone access on the Setup page.`,
    });
    return;
  }

  const device = await detectPreferredDevice();
  const chunker = new AudioChunker();
  const energyTracker = new ChannelEnergyTracker();

  session = {
    sessionId: config.sessionId,
    language: config.language,
    preset: config.preset,
    device,
    tabStream,
    micStream,
    audioCtx: null,
    workletNode: null,
    chunker,
    energyTracker,
    worker: null,
    workerReady: false,
    pendingChunks: [],
    inFlightChunkId: null,
    emittedSegments: [],
    stopping: false,
    haltedByError: false,
    recovery: new RecoveryTracker(3, 10 * 60 * 1000),
  };

  // Watch for mid-call microphone disconnect (PLAN §8).
  for (const track of micStream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (!session || session.stopping || session.sessionId !== config.sessionId) return;
      stopCaptureTracksOnly(session);
      void sendSafe({
        target: 'background',
        type: 'OFFSCREEN_MIC_LOST',
        sessionId: config.sessionId,
      });
    });
  }

  // 3. Build Web Audio graph:
  //    - tabSource -> destination (so the user still hears the meeting, PLAN §3.2)
  //    - tabSource (gain 1.0) + micSource (gain 1.0) -> resampler AudioWorklet (16 kHz mono)
  try {
    const audioCtx = new AudioContext();
    await audioCtx.resume();
    await audioCtx.audioWorklet.addModule(getResamplerWorkletUrl());

    const tabSource = audioCtx.createMediaStreamSource(tabStream);
    const micSource = audioCtx.createMediaStreamSource(micStream);

    // Critical: route tab audio back to speakers so tab capture doesn't mute the call.
    tabSource.connect(audioCtx.destination);

    const tabGain = audioCtx.createGain();
    tabGain.gain.value = 1.0;
    const micGain = audioCtx.createGain();
    micGain.gain.value = 1.0;

    const workletNode = new AudioWorkletNode(audioCtx, WORKLET_PROCESSOR_NAME, {
      numberOfInputs: 2,
      numberOfOutputs: 0,
      channelCount: 1,
      processorOptions: {
        targetSampleRate: 16000,
        frameSamples: 1600,
      },
    });

    // Input 0 = Meet tab audio (remote participants); Input 1 = User microphone (You).
    tabSource.connect(tabGain);
    micSource.connect(micGain);
    tabGain.connect(workletNode, 0, 0);
    micGain.connect(workletNode, 0, 1);

    const activeSession = session;
    workletNode.port.onmessage = (evt: MessageEvent<ResamplerFrameMessage>) => {
      if (!session || session !== activeSession || session.stopping || session.haltedByError) {
        return;
      }
      const { pcm, tabRms, micRms } = evt.data;
      session.energyTracker.pushFrameEnergy(tabRms, micRms);
      const chunks = session.chunker.pushFrame(pcm);
      for (const c of chunks) {
        enqueueChunk(session, c);
      }
    };

    session.audioCtx = audioCtx;
    session.workletNode = workletNode;
  } catch (err) {
    stopCaptureTracksOnly(session);
    await sendSafe({
      target: 'background',
      type: 'OFFSCREEN_CAPTURE_ERROR',
      sessionId: config.sessionId,
      source: 'audio',
      error: `Failed to initialize Web Audio pipeline: ${String((err as Error)?.message ?? err)}`,
    });
    return;
  }

  // Keep the service worker alive with regular heartbeats while recording (PLAN §13).
  session.heartbeatTimer = setInterval(() => {
    void sendSafe({
      target: 'background',
      type: 'OFFSCREEN_HEARTBEAT',
      sessionId: session?.sessionId,
    });
  }, HEARTBEAT_INTERVAL_MS);

  await sendSafe({
    target: 'background',
    type: 'OFFSCREEN_CAPTURE_STARTED',
    sessionId: config.sessionId,
  });

  // 4. Spawn inference worker and load the model from Cache Storage (offline mode).
  spawnAndInitWorker(session, false);
}

function spawnAndInitWorker(active: ActiveSession, isRecovery: boolean): void {
  if (active.worker) {
    try {
      active.worker.terminate();
    } catch {
      // ignore
    }
  }

  active.workerReady = false;
  active.inFlightChunkId = null;

  void sendSafe({
    target: 'background',
    type: 'OFFSCREEN_ENGINE',
    sessionId: active.sessionId,
    phase: isRecovery ? 'recovering' : 'loading-model',
    device: active.device,
  });

  const worker = new Worker(new URL('../worker/whisper.worker.ts', import.meta.url), {
    type: 'module',
  });
  active.worker = worker;

  worker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
    if (!session || session !== active) return;
    handleWorkerMessage(active, event.data);
  };

  worker.onerror = (err) => {
    if (!session || session !== active) return;
    handleWorkerCrashOrDeviceLoss(active, err.message || 'Inference worker crashed');
  };

  const initMsg: WorkerInboundMessage = {
    type: 'INIT',
    preset: active.preset,
    device: active.device,
    allowRemote: false, // Model is already cached during setup (PLAN §4).
  };
  worker.postMessage(initMsg);
}

function handleWorkerMessage(active: ActiveSession, msg: WorkerOutboundMessage): void {
  switch (msg.type) {
    case 'PROGRESS': {
      void sendSafe({
        target: 'background',
        type: 'OFFSCREEN_ENGINE',
        sessionId: active.sessionId,
        phase: 'loading-model',
        device: active.device,
        progress: msg.progress,
      });
      break;
    }

    case 'READY': {
      active.workerReady = true;
      void sendSafe({
        target: 'background',
        type: 'OFFSCREEN_ENGINE',
        sessionId: active.sessionId,
        phase: active.stopping ? 'draining' : 'transcribing',
        device: msg.device,
      });
      dispatchNextChunk(active);
      checkIfDrained(active);
      break;
    }

    case 'TRANSCRIBE_RESULT': {
      // Remove the confirmed chunk from the front of pendingChunks.
      const idx = active.pendingChunks.findIndex((c) => c.chunkId === msg.chunkId);
      if (idx !== -1) {
        active.pendingChunks.splice(idx, 1);
      }
      active.inFlightChunkId = null;

      if (msg.detectedLanguage) {
        void sendSafe({
          target: 'background',
          type: 'OFFSCREEN_LANGUAGE_DETECTED',
          sessionId: active.sessionId,
          language: msg.detectedLanguage,
        });
      }

      const rawSegments: Segment[] = msg.segments.map((s) => ({
        sessionId: active.sessionId,
        chunkId: msg.chunkId,
        start: s.start,
        end: s.end,
        text: s.text,
        speakerSource: active.energyTracker.classifySegment(s.start, s.end),
      }));

      if (msg.segments.length > 0) {
        active.energyTracker.pruneBefore(msg.segments[0].start);
      }

      const deduped = deduplicateOverlapSegments(active.emittedSegments, rawSegments);
      if (deduped.length > 0) {
        active.emittedSegments.push(...deduped);
        // Keep only the last 20 segments in memory for overlap comparison.
        if (active.emittedSegments.length > 20) {
          active.emittedSegments.splice(0, active.emittedSegments.length - 20);
        }
        void sendSafe({
          target: 'background',
          type: 'OFFSCREEN_SEGMENTS',
          sessionId: active.sessionId,
          segments: deduped,
        });
      }

      reportQueueDepth(active);
      dispatchNextChunk(active);
      checkIfDrained(active);
      break;
    }

    case 'DEVICE_LOST': {
      handleWorkerCrashOrDeviceLoss(active, msg.reason);
      break;
    }

    case 'ERROR': {
      if (msg.isDeviceLost) {
        handleWorkerCrashOrDeviceLoss(active, msg.error);
        return;
      }
      // Drop only the failed chunk (if any) so the queue can still drain.
      if (typeof msg.chunkId === 'number') {
        const idx = active.pendingChunks.findIndex((c) => c.chunkId === msg.chunkId);
        if (idx !== -1) active.pendingChunks.splice(idx, 1);
        active.inFlightChunkId = null;
        reportQueueDepth(active);
        dispatchNextChunk(active);
        checkIfDrained(active);
      } else {
        active.haltedByError = true;
        void sendSafe({
          target: 'background',
          type: 'OFFSCREEN_ENGINE',
          sessionId: active.sessionId,
          phase: 'failed',
          error: msg.error,
        });
        checkIfDrained(active);
      }
      break;
    }

    case 'DISPOSED':
      break;
  }
}

/**
 * Handles GPU device loss or worker crash (PLAN §14.3):
 *  - Up to 3 recoveries within 10 minutes on WebGPU.
 *  - If WebGPU fails 3 times, falls back to WASM once so the user doesn't lose the session.
 *  - If WASM also fails, stops inference, keeps the transcript in IndexedDB, and lets Stop & save finish.
 */
function handleWorkerCrashOrDeviceLoss(active: ActiveSession, reason: string): void {
  if (active.haltedByError) return;

  if (active.recovery.tryRecord()) {
    spawnAndInitWorker(active, true);
    return;
  }

  if (active.device === 'webgpu') {
    // Optional fallback after repeated GPU failures (PLAN §14.3).
    active.device = 'wasm';
    active.recovery.reset();
    spawnAndInitWorker(active, true);
    return;
  }

  // Exceeded recovery limit. Halt inference and drain so "Stop and save" still exports what was transcribed.
  active.haltedByError = true;
  active.pendingChunks = [];
  active.inFlightChunkId = null;
  void sendSafe({
    target: 'background',
    type: 'OFFSCREEN_ENGINE',
    sessionId: active.sessionId,
    phase: 'failed',
    error: `Transcription engine stopped after repeated GPU resets (${reason}). Click "Stop and save" to download the transcript captured so far.`,
  });
  checkIfDrained(active);
}

function enqueueChunk(active: ActiveSession, chunk: AudioChunk): void {
  active.pendingChunks.push(chunk);
  reportQueueDepth(active);
  dispatchNextChunk(active);
}

function dispatchNextChunk(active: ActiveSession): void {
  if (
    !active.worker ||
    !active.workerReady ||
    active.inFlightChunkId !== null ||
    active.pendingChunks.length === 0 ||
    active.haltedByError
  ) {
    return;
  }

  const next = active.pendingChunks[0];
  active.inFlightChunkId = next.chunkId;

  // Send a copy of the Float32Array so `next.audio` stays intact in `pendingChunks`
  // until the worker confirms `TRANSCRIBE_RESULT` (needed for §14.3 replay on GPU reset).
  const audioCopy = next.audio.slice(0);
  const msg: WorkerInboundMessage = {
    type: 'TRANSCRIBE',
    chunkId: next.chunkId,
    audio: audioCopy,
    chunkStartTime: next.chunkStartTime,
    language: active.language,
  };
  active.worker.postMessage(msg, [audioCopy.buffer]);
}

function reportQueueDepth(active: ActiveSession): void {
  const depth = active.pendingChunks.length;
  void sendSafe({
    target: 'background',
    type: 'OFFSCREEN_QUEUE',
    sessionId: active.sessionId,
    depth,
    lagging: depth >= LAG_QUEUE_THRESHOLD,
  });
}

function stopCaptureTracksOnly(active: ActiveSession): void {
  if (active.workletNode) {
    try {
      active.workletNode.port.onmessage = null;
      active.workletNode.disconnect();
    } catch {
      // ignore
    }
    active.workletNode = null;
  }
  if (active.audioCtx) {
    void active.audioCtx.close().catch(() => {});
    active.audioCtx = null;
  }
  if (active.tabStream) {
    for (const t of active.tabStream.getTracks()) t.stop();
    active.tabStream = null;
  }
  if (active.micStream) {
    for (const t of active.micStream.getTracks()) t.stop();
    active.micStream = null;
  }
}

function handleStop(): void {
  if (!session) return;
  session.stopping = true;
  stopCaptureTracksOnly(session);

  if (!session.haltedByError) {
    const finalChunk = session.chunker.flush();
    if (finalChunk) {
      enqueueChunk(session, finalChunk);
    }
  }

  void sendSafe({
    target: 'background',
    type: 'OFFSCREEN_ENGINE',
    sessionId: session.sessionId,
    phase: 'draining',
    device: session.device,
  });

  checkIfDrained(session);
}

function checkIfDrained(active: ActiveSession): void {
  if (!active.stopping) return;
  if (active.pendingChunks.length === 0 || active.haltedByError) {
    void sendSafe({
      target: 'background',
      type: 'OFFSCREEN_DRAINED',
      sessionId: active.sessionId,
    });
  }
}

async function releaseAll(): Promise<void> {
  if (!session) {
    await sendSafe({ target: 'background', type: 'OFFSCREEN_RELEASED' });
    return;
  }
  const active = session;
  session = null;

  if (active.heartbeatTimer) {
    clearInterval(active.heartbeatTimer);
  }
  stopCaptureTracksOnly(active);

  if (active.worker) {
    const w = active.worker;
    active.worker = null;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try {
          w.terminate();
        } catch {
          // ignore
        }
        resolve();
      }, 1500);
      w.onmessage = (evt: MessageEvent<WorkerOutboundMessage>) => {
        if (evt.data?.type === 'DISPOSED') {
          clearTimeout(timeout);
          try {
            w.terminate();
          } catch {
            // ignore
          }
          resolve();
        }
      };
      try {
        w.postMessage({ type: 'DISPOSE' } satisfies WorkerInboundMessage);
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  await sendSafe({ target: 'background', type: 'OFFSCREEN_RELEASED' });
}

chrome.runtime.onMessage.addListener(
  (msg: OffscreenCommand, _sender, sendResponse): boolean | undefined => {
    if (!msg || msg.target !== 'offscreen') return undefined;

    switch (msg.type) {
      case 'START':
        void startSession(msg.config);
        sendResponse({ ok: true });
        return false;

      case 'STOP':
        handleStop();
        sendResponse({ ok: true });
        return false;

      case 'SET_LANGUAGE':
        if (session) {
          session.language = msg.language;
        }
        sendResponse({ ok: true });
        return false;

      case 'RELEASE':
        void releaseAll().then(() => sendResponse({ ok: true }));
        return true;

      case 'PING':
        sendResponse({
          ok: true,
          activeSessionId: session?.sessionId,
          queueDepth: session?.pendingChunks.length ?? 0,
        });
        return false;
    }
  },
);

