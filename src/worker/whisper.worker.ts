/**
 * Dedicated Inference Web Worker (PLAN §3.3, §4, §5, §6, §14.3, §14.4).
 *
 * Loads `onnx-community/whisper-large-v3-turbo` at the pinned revision via
 * `@huggingface/transformers`, runs 16 kHz Float32 audio chunks, performs automatic
 * language detection when `language === 'auto'`, and supports clean disposal.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import { MODEL_ID, MODEL_REVISION, QUANT_PRESETS, presetSize } from '../shared/model';
import { AUTO_LANGUAGE } from '../shared/languages';
import type { Device, QuantPreset } from '../shared/types';

export interface WorkerInitMessage {
  type: 'INIT';
  preset: QuantPreset;
  device: Device;
  /** True when downloading during setup; false during meetings so we run offline from cache. */
  allowRemote: boolean;
  /** Optional 16 kHz audio sample to run a real-time factor benchmark after loading. */
  benchmarkAudio?: Float32Array;
}

export interface WorkerTranscribeMessage {
  type: 'TRANSCRIBE';
  chunkId: number;
  audio: Float32Array;
  chunkStartTime: number;
  language: string;
}

export interface WorkerDisposeMessage {
  type: 'DISPOSE';
}

export type WorkerInboundMessage =
  | WorkerInitMessage
  | WorkerTranscribeMessage
  | WorkerDisposeMessage;

export interface RawChunkSegment {
  start: number;
  end: number;
  text: string;
}

export type WorkerOutboundMessage =
  | {
      type: 'PROGRESS';
      file: string;
      status: string;
      loadedBytes: number;
      totalBytes: number;
      progress: number;
    }
  | {
      type: 'READY';
      device: Device;
      preset: QuantPreset;
      benchmarkRtf?: number;
    }
  | {
      type: 'TRANSCRIBE_RESULT';
      chunkId: number;
      segments: RawChunkSegment[];
      detectedLanguage?: string;
      processingMs: number;
    }
  | {
      type: 'DEVICE_LOST';
      reason: string;
    }
  | {
      type: 'ERROR';
      chunkId?: number;
      error: string;
      isDeviceLost?: boolean;
    }
  | {
      type: 'DISPOSED';
    };

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let currentDevice: Device = 'webgpu';
let lockedDetectedLanguage: string | null = null;

const originalFetch = self.fetch.bind(self);

/**
 * Configures Transformers.js environment.
 *
 * Note on `env.allowRemoteModels`:
 * Transformers.js throws at the very top of `getModelFile()` (before checking browser
 * Cache Storage) if both `allowLocalModels` and `allowRemoteModels` are `false`.
 * However, setting `allowLocalModels = true` causes it to try `fetch('/models/onnx-community/...')`
 * on cache misses. Instead, we keep `allowLocalModels = false` and `allowRemoteModels = true` so
 * `getModelFile()` checks Cache Storage first by the canonical Hugging Face URL, and when
 * `allowRemote === false` (during meetings) we block any outbound network fetch to Hugging Face
 * so inference is guaranteed 100% offline from Cache Storage.
 */
function configureEnv(allowRemote: boolean): void {
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;

  self.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!allowRemote && /^https:\/\/([^/]+\.)?(huggingface\.co|hf\.co)\//i.test(url)) {
      return Promise.reject(
        new Error(
          `Offline mode: model file was not found in Cache Storage (${url}). Open Setup to verify or re-download the model.`,
        ),
      );
    }
    return originalFetch(input, init);
  };

  if (env.backends?.onnx?.wasm) {
    // Point ONNX Runtime Web to locally bundled .wasm/.mjs files (PLAN §10, §14.2).
    const baseUrl =
      typeof chrome !== 'undefined' && chrome.runtime?.getURL
        ? chrome.runtime.getURL('ort/')
        : new URL('/ort/', self.location.origin).href;
    env.backends.onnx.wasm.wasmPaths = baseUrl;
    env.backends.onnx.wasm.numThreads = 1;
  }
}

function post(msg: WorkerOutboundMessage): void {
  self.postMessage(msg);
}

/** Monitors WebGPU adapter/device loss so the offscreen manager can recover (§14.3). */
async function watchGpuDeviceLoss(): Promise<void> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) return;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter?.requestDevice();
    device?.lost.then((info) => {
      if (info.reason !== 'destroyed') {
        post({ type: 'DEVICE_LOST', reason: info.message || info.reason || 'GPU device lost' });
      }
    });
  } catch {
    // Ignore: main pipeline load will report any WebGPU error.
  }
}

async function handleInit(msg: WorkerInitMessage): Promise<void> {
  configureEnv(msg.allowRemote);
  currentDevice = msg.device;
  lockedDetectedLanguage = null;

  const presetDef = QUANT_PRESETS[msg.preset];
  const expectedTotal = presetSize(msg.preset);
  const fileLoaded = new Map<string, number>();

  if (msg.device === 'webgpu') {
    void watchGpuDeviceLoss();
  }

  // @ts-expect-error pipeline overload union is very large in @huggingface/transformers
  transcriber = (await pipeline('automatic-speech-recognition', MODEL_ID, {
    revision: MODEL_REVISION,
    device: msg.device,
    dtype: presetDef.dtype as Record<string, 'fp16' | 'fp32' | 'q4'>,
    progress_callback: (evt: {
      status?: string;
      file?: string;
      loaded?: number;
      total?: number;
    }) => {
      if (evt.file && typeof evt.loaded === 'number') {
        fileLoaded.set(evt.file, evt.loaded);
      }
      let loadedBytes = 0;
      for (const b of fileLoaded.values()) loadedBytes += b;
      const totalBytes = Math.max(expectedTotal, loadedBytes);
      const progress = totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : 0;
      post({
        type: 'PROGRESS',
        file: evt.file ?? '',
        status: evt.status ?? 'progress',
        loadedBytes,
        totalBytes,
        progress,
      });
    },
  })) as AutomaticSpeechRecognitionPipeline;

  // Warm-up inference on 1 s of silence to compile WebGPU shaders (PLAN §4).
  const warmupSilence = new Float32Array(16000);
  await transcriber(warmupSilence, {
    language: 'en',
    task: 'transcribe',
    return_timestamps: false,
  });

  // Optional real-time benchmark on bundled ~10 s speech sample (PLAN §14.5).
  let benchmarkRtf: number | undefined;
  if (msg.benchmarkAudio && msg.benchmarkAudio.length > 0) {
    const audioSec = msg.benchmarkAudio.length / 16000;
    const t0 = performance.now();
    await transcriber(msg.benchmarkAudio, {
      language: 'en',
      task: 'transcribe',
      return_timestamps: true,
    });
    const elapsedSec = (performance.now() - t0) / 1000;
    benchmarkRtf = elapsedSec / audioSec;
  }

  post({
    type: 'READY',
    device: msg.device,
    preset: msg.preset,
    benchmarkRtf,
  });
}

/**
 * Detects the spoken language from the encoder features using the Whisper decoder's
 * first token logits over `generation_config.lang_to_id` (PLAN §6).
 */
async function detectLanguageCode(audio: Float32Array): Promise<string> {
  if (!transcriber) return 'en';
  try {
    const processor = transcriber.processor as unknown as (
      input: Float32Array,
    ) => Promise<{ input_features: unknown }>;
    const model = transcriber.model as unknown as {
      generation_config?: {
        decoder_start_token_id?: number;
        lang_to_id?: Record<string, number>;
      };
      forward: (inputs: Record<string, unknown>) => Promise<{ logits?: { data: Float32Array; dims: number[] } }>;
      _prepare_inputs_for_generation?: unknown;
    };

    const genCfg = model.generation_config;
    const langToId = genCfg?.lang_to_id;
    const sotId = genCfg?.decoder_start_token_id ?? 50258;
    if (!langToId) return 'en';

    const processed = await processor(audio);
    const { Tensor } = await import('@huggingface/transformers');
    const decoderInputIds = new Tensor('int64', BigInt64Array.from([BigInt(sotId)]), [1, 1]);
    const out = await model.forward({
      input_features: processed.input_features,
      decoder_input_ids: decoderInputIds,
    });

    const logits = out?.logits;
    if (!logits || !logits.data) return 'en';
    const vocabSize = logits.dims[logits.dims.length - 1] ?? logits.data.length;
    const offset = logits.data.length - vocabSize;

    let bestCode = 'en';
    let bestScore = -Infinity;
    for (const [token, tokenId] of Object.entries(langToId)) {
      const score = logits.data[offset + tokenId];
      if (typeof score === 'number' && score > bestScore) {
        bestScore = score;
        const m = token.match(/^<\|([a-z]{2,3})\|>$/);
        if (m) bestCode = m[1];
      }
    }
    return bestCode;
  } catch {
    return 'en';
  }
}

async function handleTranscribe(msg: WorkerTranscribeMessage): Promise<void> {
  if (!transcriber) {
    post({ type: 'ERROR', chunkId: msg.chunkId, error: 'Transcription pipeline is not loaded.' });
    return;
  }

  const t0 = performance.now();
  let lang = msg.language;
  let newlyDetected: string | undefined;

  if (!lang || lang === AUTO_LANGUAGE) {
    if (!lockedDetectedLanguage) {
      lockedDetectedLanguage = await detectLanguageCode(msg.audio);
      newlyDetected = lockedDetectedLanguage;
    }
    lang = lockedDetectedLanguage;
  } else {
    // Explicit language selected by the user; reset auto-lock in case they switch back.
    lockedDetectedLanguage = null;
  }

  const chunkDuration = msg.audio.length / 16000;
  const output = (await transcriber(msg.audio, {
    language: lang,
    task: 'transcribe',
    return_timestamps: true,
  })) as {
    text?: string;
    chunks?: Array<{ text: string; timestamp: [number | null, number | null] }>;
  };

  const segments: RawChunkSegment[] = [];
  if (Array.isArray(output.chunks) && output.chunks.length > 0) {
    for (const c of output.chunks) {
      const text = (c.text ?? '').trim();
      if (!text) continue;
      const relStart = typeof c.timestamp?.[0] === 'number' ? c.timestamp[0] : 0;
      const relEnd =
        typeof c.timestamp?.[1] === 'number' && c.timestamp[1] !== null
          ? c.timestamp[1]
          : chunkDuration;
      segments.push({
        start: msg.chunkStartTime + Math.max(0, relStart),
        end: msg.chunkStartTime + Math.max(relStart, relEnd),
        text,
      });
    }
  } else if (output.text && output.text.trim()) {
    segments.push({
      start: msg.chunkStartTime,
      end: msg.chunkStartTime + chunkDuration,
      text: output.text.trim(),
    });
  }

  post({
    type: 'TRANSCRIBE_RESULT',
    chunkId: msg.chunkId,
    segments,
    detectedLanguage: newlyDetected,
    processingMs: performance.now() - t0,
  });
}

async function handleDispose(): Promise<void> {
  try {
    if (transcriber) {
      await transcriber.dispose();
      transcriber = null;
    }
  } finally {
    post({ type: 'DISPOSED' });
  }
}

function isGpuDeviceLostError(err: unknown): boolean {
  if (currentDevice !== 'webgpu') return false;
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return (
    msg.includes('device lost') ||
    msg.includes('gpudevice') ||
    msg.includes('webgpu') ||
    msg.includes('out of memory') ||
    msg.includes('destroyed') ||
    msg.includes('context lost')
  );
}

self.addEventListener('message', (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'INIT') {
    handleInit(msg).catch((err) => {
      post({
        type: 'ERROR',
        error: String((err as Error)?.message ?? err),
        isDeviceLost: isGpuDeviceLostError(err),
      });
    });
  } else if (msg.type === 'TRANSCRIBE') {
    handleTranscribe(msg).catch((err) => {
      const isLost = isGpuDeviceLostError(err);
      if (isLost) {
        post({ type: 'DEVICE_LOST', reason: String((err as Error)?.message ?? err) });
      } else {
        post({
          type: 'ERROR',
          chunkId: msg.chunkId,
          error: String((err as Error)?.message ?? err),
        });
      }
    });
  } else if (msg.type === 'DISPOSE') {
    void handleDispose();
  }
});

