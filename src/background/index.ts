/**
 * Background Service Worker — state orchestrator (PLAN §3.1, §7, §8, §14.4).
 *
 * Responsibilities:
 *  - Single source of truth for recording state (`idle | starting | recording | stopping | error`).
 *  - Opens the Setup page on initial install (`chrome.runtime.onInstalled`).
 *  - Creates and closes the offscreen document.
 *  - Persists sessions and segments to IndexedDB and broadcasts live updates to the popup.
 *  - Builds the Markdown file on "Stop and save", downloads it via `chrome.downloads.download`,
 *    and releases GPU/offscreen resources afterward (§14.4).
 *  - Updates the action badge: red "REC" while recording, "…" while starting/stopping.
 */
import { buildMarkdownTranscript, formatFilename } from './export';
import {
  ensureOffscreenDocument,
  hasOffscreenDocument,
  releaseAndCloseOffscreenDocument,
} from './offscreen-manager';
import {
  sendSafe,
  type BackgroundRequest,
  type GetStateResponse,
  type OffscreenEvent,
  type OkResponse,
} from '../shared/messages';
import { resolveSpeakerLabel } from '../shared/speaker';
import {
  addSegments,
  deleteSession,
  getModelInfo,
  getSegments,
  getSession,
  getSettings,
  listSessions,
  loadRecorderState,
  pruneSavedSessions,
  pushRecentLanguage,
  putSession,
  saveRecorderState,
  updateSession,
} from '../shared/storage';
import {
  DEFAULT_STATE,
  type RecorderState,
  type SessionMeta,
  type SpeakerEvent,
  type SpeakerSnapshot,
} from '../shared/types';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SPEAKER_EVENT_RETENTION_MS = 3 * 60 * 1000; // Keep last 3 minutes of DOM speaker spans

let state: RecorderState = { ...DEFAULT_STATE };
let stateReadyPromise: Promise<void> | null = null;
/** Active-speaker timeline reported by the Meet content script during the current session. */
let speakerTimeline: SpeakerEvent[] = [];
/** Known non-self remote participants currently in the Meet call. */
let currentRemoteParticipants: string[] = [];
/** Local user's own display name detected in the Meet call (if available). */
let currentSelfName: string | undefined;

async function ensureStateInitialized(): Promise<void> {
  if (!stateReadyPromise) {
    stateReadyPromise = (async () => {
      state = await loadRecorderState();

      // Reconcile state if the service worker restarted or browser crashed.
      if (state.status === 'recording' || state.status === 'starting' || state.status === 'stopping') {
        const offscreenAlive = await hasOffscreenDocument();
        if (!offscreenAlive) {
          if (state.sessionId) {
            await updateSession(state.sessionId, {
              status: 'interrupted',
              endedAt: Date.now(),
            });
          }
          state = {
            ...DEFAULT_STATE,
            recoverableSessionId: state.sessionId,
          };
          await saveRecorderState(state);
        }
      }

      // Check for any previously interrupted sessions with unsaved segments in IndexedDB.
      if (!state.recoverableSessionId && state.status === 'idle') {
        const sessions = await listSessions();
        for (const s of sessions) {
          if (s.status === 'active' || s.status === 'interrupted') {
            const segs = await getSegments(s.id);
            if (segs.length > 0) {
              await updateSession(s.id, { status: 'interrupted', endedAt: s.endedAt ?? Date.now() });
              state.recoverableSessionId = s.id;
              await saveRecorderState(state);
              break;
            } else {
              await deleteSession(s.id);
            }
          }
        }
      }

      await updateBadge(state);
      await pruneSavedSessions(SEVEN_DAYS_MS);
    })();
  }
  await stateReadyPromise;
}

async function setState(patch: Partial<RecorderState>): Promise<void> {
  state = { ...state, ...patch };
  await saveRecorderState(state);
  await updateBadge(state);
  await sendSafe({ target: 'ui', type: 'STATE', state });
}

async function updateBadge(s: RecorderState): Promise<void> {
  try {
    if (s.status === 'recording') {
      await chrome.action.setBadgeText({ text: 'REC' });
      await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    } else if (s.status === 'starting' || s.status === 'stopping') {
      await chrome.action.setBadgeText({ text: '…' });
      await chrome.action.setBadgeBackgroundColor({ color: '#f29900' });
    } else if (s.status === 'error') {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch {
    // ignore badge errors in headless/test environments
  }
}

// Open Setup / Options page automatically on install (PLAN §3.5, §4).
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    void chrome.runtime.openOptionsPage();
  }
});

async function handleStart(
  req: Extract<BackgroundRequest, { type: 'START' }>,
): Promise<OkResponse> {
  await ensureStateInitialized();

  if (state.status === 'recording' || state.status === 'starting' || state.status === 'stopping') {
    return { ok: false, error: 'A transcription session is already active.' };
  }

  const modelInfo = await getModelInfo();
  if (!modelInfo?.verifiedAt) {
    return {
      ok: false,
      error: 'The Whisper model has not been downloaded and verified yet. Open Setup first.',
    };
  }

  const settings = await getSettings();
  const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  const language = req.language || settings.defaultLanguage || 'auto';

  const sessionMeta: SessionMeta = {
    id: sessionId,
    startedAt,
    meetingTitle: req.meeting.title || 'Google Meet',
    meetingUrl: req.meeting.url || 'https://meet.google.com',
    language,
    status: 'active',
  };
  await putSession(sessionMeta);
  await pushRecentLanguage(language);
  speakerTimeline = [];
  currentRemoteParticipants = [];
  currentSelfName = undefined;

  await setState({
    status: 'starting',
    sessionId,
    tabId: req.tabId,
    startedAt,
    language,
    detectedLanguage: undefined,
    phase: 'loading-model',
    loadProgress: 0,
    queueDepth: 0,
    lagging: false,
    error: undefined,
    errorAction: undefined,
    detectedParticipants: [],
    activeDomSpeakers: [],
  });

  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'START',
      config: {
        sessionId,
        streamId: req.streamId,
        language,
        preset: modelInfo.preset ?? settings.quantPreset,
      },
    });
    return { ok: true };
  } catch (err) {
    await deleteSession(sessionId);
    await setState({
      status: 'error',
      sessionId: undefined,
      error: `Failed to start capture: ${String((err as Error)?.message ?? err)}`,
      errorAction: 'none',
    });
    return { ok: false, error: state.error };
  }
}

async function handleStop(): Promise<OkResponse> {
  await ensureStateInitialized();
  if (state.status !== 'recording' && state.status !== 'starting' && state.status !== 'error') {
    return { ok: false, error: 'No active recording to stop.' };
  }

  if (!state.sessionId) {
    await releaseAndCloseOffscreenDocument();
    await setState({ ...DEFAULT_STATE });
    return { ok: true };
  }

  await setState({
    status: 'stopping',
    phase: 'draining',
  });

  if (await hasOffscreenDocument()) {
    await sendSafe({ target: 'offscreen', type: 'STOP' });
  } else {
    await finalizeAndSaveSession(state.sessionId);
  }

  return { ok: true };
}

async function finalizeAndSaveSession(sessionId: string): Promise<void> {
  const endedAt = Date.now();
  const sessionMeta =
    (await updateSession(sessionId, {
      endedAt,
      status: 'saved',
      device: state.device,
      detectedLanguage: state.detectedLanguage,
    })) ??
    ({
      id: sessionId,
      startedAt: state.startedAt ?? endedAt,
      endedAt,
      meetingTitle: 'Google Meet',
      meetingUrl: 'https://meet.google.com',
      language: state.language,
      detectedLanguage: state.detectedLanguage,
      device: state.device,
      status: 'saved',
    } satisfies SessionMeta);

  const segments = await getSegments(sessionId);
  const settings = await getSettings();
  const markdown = buildMarkdownTranscript(sessionMeta, segments, settings.timestampStyle);
  const filename = formatFilename(settings.filenameTemplate, sessionMeta);

  // Release model/worker/GPU memory and close the offscreen document (PLAN §14.4).
  await releaseAndCloseOffscreenDocument();
  speakerTimeline = [];
  currentRemoteParticipants = [];
  currentSelfName = undefined;

  // Clear active session state immediately so the popup preview resets right away,
  // even while the user is choosing a file location in the Save As dialog.
  await setState({
    ...DEFAULT_STATE,
    language: settings.defaultLanguage,
    recoverableSessionId:
      state.recoverableSessionId === sessionId ? undefined : state.recoverableSessionId,
  });

  await triggerMarkdownDownload(markdown, filename);
}

async function triggerMarkdownDownload(markdown: string, filename: string): Promise<void> {
  // Service workers don't have URL.createObjectURL, so encode UTF-8 Markdown as a data: URL (§7).
  const bytes = new TextEncoder().encode(markdown);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const dataUrl = `data:text/markdown;charset=utf-8;base64,${btoa(binary)}`;

  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true,
  });
}

async function handleOffscreenEvent(evt: OffscreenEvent): Promise<void> {
  await ensureStateInitialized();

  switch (evt.type) {
    case 'OFFSCREEN_CAPTURE_STARTED': {
      if (state.sessionId !== evt.sessionId) return;
      await setState({
        status: 'recording',
        startedAt: state.startedAt ?? Date.now(),
      });
      break;
    }

    case 'OFFSCREEN_CAPTURE_ERROR': {
      if (state.sessionId === evt.sessionId) {
        await deleteSession(evt.sessionId);
      }
      await releaseAndCloseOffscreenDocument();
      await setState({
        ...DEFAULT_STATE,
        status: 'error',
        error: evt.error,
        errorAction: evt.source === 'mic' ? 'open-setup' : 'none',
      });
      break;
    }

    case 'OFFSCREEN_ENGINE': {
      if (state.sessionId !== evt.sessionId) return;
      if (evt.phase === 'failed') {
        const segs = await getSegments(evt.sessionId);
        if (segs.length === 0) {
          await deleteSession(evt.sessionId);
          await releaseAndCloseOffscreenDocument();
          await setState({
            ...DEFAULT_STATE,
            status: 'error',
            error: evt.error ?? 'Failed to initialize Whisper model.',
            errorAction: 'open-setup',
          });
        } else {
          await setState({
            phase: 'failed',
            error: evt.error,
          });
        }
        return;
      }

      if (evt.device) {
        await updateSession(evt.sessionId, { device: evt.device });
      }

      await setState({
        phase: evt.phase,
        device: evt.device ?? state.device,
        loadProgress: evt.progress ?? state.loadProgress,
      });
      break;
    }

    case 'OFFSCREEN_SEGMENTS': {
      if (state.sessionId !== evt.sessionId) return;
      const sessionStartedAt = state.startedAt ?? Date.now();

      // Pull a fresh DOM snapshot from the Meet tab whenever we need remote speaker names
      // or haven't discovered the local user's own display name yet.
      if (
        state.tabId &&
        evt.segments.some(
          (s) => !s.speaker && (s.speakerSource !== 'you' || !currentSelfName),
        )
      ) {
        try {
          const snap = (await chrome.tabs.sendMessage(state.tabId, {
            type: 'GET_SPEAKER_SNAPSHOT',
          })) as SpeakerSnapshot | undefined;
          if (snap) {
            if (snap.selfName) {
              currentSelfName = snap.selfName;
            }
            if (Array.isArray(snap.remoteParticipants)) {
              currentRemoteParticipants = snap.remoteParticipants;
            }
            if (Array.isArray(snap.activeSpeakers)) {
              for (const name of snap.activeSpeakers) {
                speakerTimeline.push({
                  name,
                  startMs: snap.timestampMs - 2000,
                  endMs: snap.timestampMs + 500,
                });
              }
            }
            await setState({
              detectedParticipants: currentRemoteParticipants,
              activeDomSpeakers: snap.activeSpeakers ?? [],
            });
          }
        } catch {
          // Content script may be unreachable; fallback to cached timeline/Remote.
        }
      }

      const labeled = evt.segments.map((seg) => ({
        ...seg,
        speaker:
          seg.speaker ??
          resolveSpeakerLabel(
            seg.speakerSource,
            seg.start,
            seg.end,
            sessionStartedAt,
            speakerTimeline,
            currentRemoteParticipants,
            currentSelfName,
          ),
      }));
      const saved = await addSegments(labeled);
      if (saved.length > 0) {
        await sendSafe({
          target: 'ui',
          type: 'SEGMENTS_ADDED',
          sessionId: evt.sessionId,
          segments: saved,
        });
      }
      break;
    }

    case 'OFFSCREEN_QUEUE': {
      if (state.sessionId !== evt.sessionId) return;
      await setState({
        queueDepth: evt.depth,
        lagging: evt.lagging,
      });
      break;
    }

    case 'OFFSCREEN_LANGUAGE_DETECTED': {
      if (state.sessionId !== evt.sessionId) return;
      await updateSession(evt.sessionId, { detectedLanguage: evt.language });
      await setState({
        detectedLanguage: evt.language,
      });
      break;
    }

    case 'OFFSCREEN_MIC_LOST': {
      // PLAN §8: If the mic track ends mid-session, pause and show an error; never continue with tab audio only.
      if (state.sessionId !== evt.sessionId) return;
      await setState({
        error:
          'Microphone disconnected during the meeting. Click "Stop and save" to save the transcript captured so far.',
        errorAction: 'none',
      });
      break;
    }

    case 'OFFSCREEN_DRAINED': {
      if (state.sessionId !== evt.sessionId) return;
      await finalizeAndSaveSession(evt.sessionId);
      break;
    }

    case 'OFFSCREEN_RELEASED':
    case 'OFFSCREEN_HEARTBEAT':
      break;
  }
}

chrome.runtime.onMessage.addListener(
  (
    msg: BackgroundRequest | OffscreenEvent,
    _sender,
    sendResponse: (res: unknown) => void,
  ): boolean | undefined => {
    if (!msg || msg.target !== 'background') return undefined;

    void (async () => {
      await ensureStateInitialized();

      switch (msg.type) {
        case 'GET_STATE': {
          const segments = state.sessionId ? await getSegments(state.sessionId) : [];
          sendResponse({ state, segments } satisfies GetStateResponse);
          return;
        }

        case 'START': {
          const res = await handleStart(msg);
          sendResponse(res);
          return;
        }

        case 'STOP': {
          const res = await handleStop();
          sendResponse(res);
          return;
        }

        case 'SET_LANGUAGE': {
          await pushRecentLanguage(msg.language);
          if (state.sessionId) {
            await updateSession(state.sessionId, {
              language: msg.language,
              detectedLanguage: msg.language === 'auto' ? undefined : state.detectedLanguage,
            });
          }
          await setState({
            language: msg.language,
            detectedLanguage: msg.language === 'auto' ? undefined : state.detectedLanguage,
          });
          if (await hasOffscreenDocument()) {
            await sendSafe({
              target: 'offscreen',
              type: 'SET_LANGUAGE',
              language: msg.language,
            });
          }
          sendResponse({ ok: true } satisfies OkResponse);
          return;
        }

        case 'SAVE_RECOVERED': {
          const sess = await getSession(msg.sessionId);
          if (sess) {
            await finalizeAndSaveSession(msg.sessionId);
          } else {
            await setState({ recoverableSessionId: undefined });
          }
          sendResponse({ ok: true } satisfies OkResponse);
          return;
        }

        case 'DISCARD_RECOVERED': {
          await deleteSession(msg.sessionId);
          await setState({
            recoverableSessionId:
              state.recoverableSessionId === msg.sessionId
                ? undefined
                : state.recoverableSessionId,
          });
          sendResponse({ ok: true } satisfies OkResponse);
          return;
        }

        case 'DISMISS_ERROR': {
          if (state.status === 'error') {
            await setState({ ...DEFAULT_STATE });
          } else {
            await setState({ error: undefined, errorAction: undefined });
          }
          sendResponse({ ok: true } satisfies OkResponse);
          return;
        }

        case 'SPEAKER_EVENTS': {
          if (state.status === 'recording' || state.status === 'starting' || state.status === 'stopping') {
            const cutoff = Date.now() - SPEAKER_EVENT_RETENTION_MS;
            speakerTimeline = speakerTimeline.filter((e) => e.endMs >= cutoff);
            speakerTimeline.push(...msg.events);
            if (msg.selfName) {
              currentSelfName = msg.selfName;
            }
            if (Array.isArray(msg.remoteParticipants)) {
              currentRemoteParticipants = msg.remoteParticipants;
              await setState({
                detectedParticipants: currentRemoteParticipants,
              });
            }
          }
          sendResponse({ ok: true } satisfies OkResponse);
          return;
        }

        default: {
          await handleOffscreenEvent(msg);
          sendResponse({ ok: true });
        }
      }
    })();

    return true;
  },
);

