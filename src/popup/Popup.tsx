/**
 * Extension Popup UI (PLAN §3.4, §6, §7, §8).
 *
 * Responsibilities:
 *  - Shows model status (Not downloaded / Ready) and any hardware warning summary (§14.5).
 *  - Checks whether the active tab is `https://meet.google.com/*` and whether microphone
 *    permission is granted.
 *  - Searchable Language selector (can be changed before or mid-session, §6).
 *  - "Start transcription" calls `chrome.tabCapture.getMediaStreamId({ targetTabId })` inside
 *    the user gesture and sends `START` to the service worker.
 *  - Shows live transcript preview (auto-scrolling), elapsed timer, lag indicator, and
 *    "Stop and save" (always downloads `.md`, §7).
 *  - Shows crash recovery banner if an interrupted session is found in IndexedDB.
 */
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatTimestamp } from '../background/export';
import { LanguageSelect } from '../shared/LanguageSelect';
import {
  sendSafe,
  type GetStateResponse,
  type OkResponse,
  type UiBroadcast,
} from '../shared/messages';
import { getModelInfo, getSettings, updateSettings } from '../shared/storage';
import {
  DEFAULT_STATE,
  type MeetingInfo,
  type ModelInfo,
  type RecorderState,
  type Segment,
  type Settings,
  type SpeakerSnapshot,
} from '../shared/types';

function PopupApp() {
  const [state, setState] = useState<RecorderState>(DEFAULT_STATE);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [modelInfo, setModelInfo] = useState<ModelInfo | undefined>(undefined);
  const [micGranted, setMicGranted] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<{ id?: number; url?: string; title?: string }>({});
  const [domStatus, setDomStatus] = useState<{
    connected: boolean;
    selfName?: string;
    remoteParticipants: string[];
    activeSpeakers: string[];
    totalTiles: number;
  }>({ connected: false, remoteParticipants: [], activeSpeakers: [], totalTiles: 0 });
  const [now, setNow] = useState<number>(Date.now());
  const [busy, setBusy] = useState<boolean>(false);
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const previewRef = useRef<HTMLDivElement>(null);

  const isMeetTab = Boolean(activeTab.url && /^https:\/\/meet\.google\.com\//i.test(activeTab.url));
  const modelReady = Boolean(modelInfo?.verifiedAt);
  const isActive =
    state.status === 'starting' || state.status === 'recording' || state.status === 'stopping';

  useEffect(() => {
    void (async () => {
      const [s, m, stateRes] = await Promise.all([
        getSettings(),
        getModelInfo(),
        sendSafe<GetStateResponse>({ target: 'background', type: 'GET_STATE' }),
      ]);
      setSettings(s);
      setModelInfo(m);
      if (stateRes) {
        setState(stateRes.state);
        setSegments(stateRes.segments);
      }

      // Check active tab (meet.google.com host permission gives us url/title on Meet tabs).
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          setActiveTab({ id: tab.id, url: tab.url, title: tab.title });
        }
      } catch {
        // ignore
      }

      // Check microphone permission state (PLAN §8).
      try {
        const perm = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        setMicGranted(perm.state === 'granted');
        perm.onchange = () => setMicGranted(perm.state === 'granted');
      } catch {
        setMicGranted(false);
      }
    })();

    const onMessage = (msg: UiBroadcast) => {
      if (!msg || msg.target !== 'ui') return;
      if (msg.type === 'STATE') {
        setState((prev) => {
          if (msg.state.status === 'idle' || msg.state.sessionId !== prev.sessionId) {
            setSegments([]);
          }
          return msg.state;
        });
      } else if (msg.type === 'SEGMENTS_ADDED') {
        setSegments((prev) => [...prev, ...msg.segments]);
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  // Tick elapsed timer every second while recording.
  useEffect(() => {
    if (!isActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isActive]);

  // Poll the Meet content script for live participant/speaker DOM detection status while popup is open.
  useEffect(() => {
    if (!isMeetTab || !activeTab.id) return;
    const tabId = activeTab.id;
    let cancelled = false;

    const pollDom = async () => {
      try {
        const snap = (await chrome.tabs.sendMessage(tabId, {
          type: 'GET_SPEAKER_SNAPSHOT',
        })) as SpeakerSnapshot | undefined;
        if (!cancelled && snap) {
          setDomStatus({
            connected: true,
            selfName: snap.selfName,
            remoteParticipants: snap.remoteParticipants ?? [],
            activeSpeakers: snap.activeSpeakers ?? [],
            totalTiles: snap.totalTiles ?? 0,
          });
        }
      } catch {
        if (!cancelled) {
          setDomStatus({
            connected: false,
            remoteParticipants: [],
            activeSpeakers: [],
            totalTiles: 0,
          });
        }
      }
    };

    void pollDom();
    const timer = setInterval(() => void pollDom(), 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isMeetTab, activeTab.id]);

  // Auto-scroll live transcript preview as new segments arrive.
  useEffect(() => {
    const el = previewRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [segments.length]);

  const openSetup = () => {
    void chrome.runtime.openOptionsPage();
  };

  const handleLanguageChange = async (code: string) => {
    if (settings) {
      const next = await updateSettings({ defaultLanguage: code });
      setSettings(next);
    }
    await sendSafe({ target: 'background', type: 'SET_LANGUAGE', language: code });
  };

  const handleToggleFavorite = async (code: string) => {
    if (!settings) return;
    const exists = settings.favoriteLanguages.includes(code);
    const favs = exists
      ? settings.favoriteLanguages.filter((c) => c !== code)
      : [...settings.favoriteLanguages, code];
    const next = await updateSettings({ favoriteLanguages: favs });
    setSettings(next);
  };

  const handleStart = async () => {
    if (!activeTab.id || !isMeetTab) return;
    setBusy(true);
    setLocalError(undefined);

    try {
      // Must obtain the tab streamId inside the popup click gesture (PLAN §3.1).
      const streamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id }, (id) => {
          const err = chrome.runtime.lastError;
          if (err || !id) {
            reject(new Error(err?.message ?? 'Could not obtain tab capture stream ID'));
          } else {
            resolve(id);
          }
        });
      });

      // Query content script for meeting title/code (best-effort).
      let meeting: MeetingInfo = {
        title: (activeTab.title ?? 'Google Meet')
          .replace(/^Meet\s*[-–—]\s*/i, '')
          .replace(/\s*[-–—]\s*Google Meet$/i, '')
          .trim(),
        url: activeTab.url ?? 'https://meet.google.com',
      };
      try {
        const info = (await chrome.tabs.sendMessage(activeTab.id, {
          type: 'GET_MEETING_INFO',
        })) as MeetingInfo | undefined;
        if (info?.title) meeting = info;
      } catch {
        // Content script might not be injected if tab opened before install; fallback title is fine.
      }

      const lang = state.language || settings?.defaultLanguage || 'auto';
      setSegments([]);
      const res = await sendSafe<OkResponse>({
        target: 'background',
        type: 'START',
        streamId,
        tabId: activeTab.id,
        language: lang,
        meeting,
      });

      if (res && !res.ok) {
        setLocalError(res.error ?? 'Could not start recording');
      }
    } catch (err) {
      setLocalError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const handleStopAndSave = async () => {
    setBusy(true);
    try {
      await sendSafe({ target: 'background', type: 'STOP' });
      const latest = await sendSafe<GetStateResponse>({ target: 'background', type: 'GET_STATE' });
      if (latest) {
        setState(latest.state);
        setSegments(latest.segments);
      }
    } finally {
      setBusy(false);
    }
  };

  const elapsedSeconds =
    state.startedAt && isActive ? Math.max(0, Math.floor((now - state.startedAt) / 1000)) : 0;

  const canStart = isMeetTab && modelReady && micGranted && !isActive && !busy;
  const selectedLanguage = isActive
    ? state.language
    : (settings?.defaultLanguage ?? state.language ?? 'auto');

  return (
    <>
      <div class="popup-header">
        <h1 class="popup-title">Meet Transcript Notes</h1>
        <button type="button" class="link-btn" onClick={openSetup}>
          Setup &amp; Settings
        </button>
      </div>

      {/* Model & status badges */}
      <div class="popup-meta">
        {modelReady ? (
          <span class="badge badge-ok">Model ready (offline)</span>
        ) : (
          <span class="badge badge-warn">Model not downloaded</span>
        )}

        {isActive && (
          <span class="badge badge-err timer-pill">
            <span class="rec-dot" /> {formatTimestamp(elapsedSeconds, 'hms')}
          </span>
        )}

        {state.lagging && isActive && (
          <span class="badge badge-warn" title="Inference queue is behind live audio">
            Lagging ({state.queueDepth} queued)
          </span>
        )}
      </div>

      {/* Meet DOM speaker-detection status badge */}
      {isMeetTab && (
        <div class="popup-meta">
          {!domStatus.connected ? (
            <span
              class="badge badge-warn"
              title="Refresh the Google Meet tab (Cmd+R) so the speaker-name content script can attach."
            >
              Names: Refresh Meet tab (fallback: You/Remote)
            </span>
          ) : domStatus.remoteParticipants.length > 0 || domStatus.selfName ? (
            <span
              class="badge badge-ok"
              title={`Detected participants in Meet DOM: ${[domStatus.selfName ? `${domStatus.selfName} (You)` : null, ...domStatus.remoteParticipants].filter(Boolean).join(', ')}`}
            >
              Names detected:{' '}
              {[
                domStatus.selfName ? `${domStatus.selfName} (You)` : null,
                ...domStatus.remoteParticipants,
              ]
                .filter(Boolean)
                .join(', ')}
              {domStatus.activeSpeakers.length > 0
                ? ` (speaking: ${domStatus.activeSpeakers.join(', ')})`
                : ''}
            </span>
          ) : (
            <span
              class="badge"
              title={`Content script connected (${domStatus.totalTiles} tile${domStatus.totalTiles === 1 ? '' : 's'} in DOM). Waiting for participant names.`}
            >
              Names: DOM ready ({domStatus.totalTiles} tile
              {domStatus.totalTiles === 1 ? '' : 's'}, You only)
            </span>
          )}
        </div>
      )}

      {/* Hardware resource warning summary from setup (PLAN §14.5) */}
      {modelInfo?.resourceSummary && !isActive && (
        <div class="alert alert-warn">{modelInfo.resourceSummary}</div>
      )}

      {/* Crash recovery banner (PLAN §2, §12 M5) */}
      {state.recoverableSessionId && !isActive && (
        <div class="alert alert-warn">
          <div>
            <strong>Unsaved transcript found</strong> from an interrupted session.
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
            <button
              type="button"
              class="btn btn-primary"
              onClick={() =>
                void sendSafe({
                  target: 'background',
                  type: 'SAVE_RECOVERED',
                  sessionId: state.recoverableSessionId!,
                })
              }
            >
              Save Markdown
            </button>
            <button
              type="button"
              class="btn"
              onClick={() =>
                void sendSafe({
                  target: 'background',
                  type: 'DISCARD_RECOVERED',
                  sessionId: state.recoverableSessionId!,
                })
              }
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* Pre-flight blockers when idle */}
      {!isActive && !modelReady && (
        <div class="alert alert-warn">
          One-time Whisper model download required before recording.{' '}
          <button type="button" class="link-btn" onClick={openSetup}>
            Open Setup page
          </button>
        </div>
      )}

      {!isActive && !micGranted && (
        <div class="alert alert-warn">
          Microphone access is required so both your voice and remote participants are transcribed.{' '}
          <button type="button" class="link-btn" onClick={openSetup}>
            Grant microphone access
          </button>
        </div>
      )}

      {!isActive && modelReady && micGranted && !isMeetTab && (
        <div class="alert">
          Open a <strong>meet.google.com</strong> call in the active tab to start transcription.
        </div>
      )}

      {/* Error banner */}
      {(state.error || localError) && (
        <div class="alert alert-err">
          <div>{state.error ?? localError}</div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
            {state.errorAction === 'open-setup' && (
              <button type="button" class="link-btn" onClick={openSetup}>
                Open Setup
              </button>
            )}
            <button
              type="button"
              class="link-btn"
              onClick={() => {
                setLocalError(undefined);
                void sendSafe({ target: 'background', type: 'DISMISS_ERROR' });
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Engine sub-state indicators (PLAN §7, §14.3, §14.4) */}
      {isActive && state.phase === 'loading-model' && (
        <div class="alert">
          <div>Loading Whisper model into {state.device === 'wasm' ? 'WASM' : 'WebGPU'}…</div>
          {typeof state.loadProgress === 'number' && state.loadProgress > 0 && (
            <div class="progress-track" style={{ marginTop: '6px' }}>
              <div
                class="progress-fill"
                style={{ width: `${Math.round(state.loadProgress * 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {isActive && state.phase === 'recovering' && (
        <div class="alert alert-warn">
          Recovering transcription engine… Audio capture is still running.
        </div>
      )}

      {state.status === 'stopping' && (
        <div class="alert">
          Finishing transcription…{' '}
          {state.queueDepth > 0
            ? `(${state.queueDepth} chunk${state.queueDepth === 1 ? '' : 's'} left)`
            : '(building Markdown)'}
        </div>
      )}

      {/* Language selector (PLAN §6) */}
      <div>
        <label class="field-label">
          Spoken language {isActive ? '(applies from next chunk)' : ''}
        </label>
        <LanguageSelect
          value={selectedLanguage}
          detectedLanguage={state.detectedLanguage}
          favorites={settings?.favoriteLanguages ?? []}
          recents={settings?.recentLanguages ?? []}
          disabled={state.status === 'stopping'}
          onChange={(code) => void handleLanguageChange(code)}
          onToggleFavorite={(code) => void handleToggleFavorite(code)}
        />
      </div>

      {/* Live transcript preview (PLAN §3.4) */}
      <div class="preview-box" ref={previewRef}>
        {segments.length === 0 ? (
          <div class="empty-hint">
            {isActive
              ? 'Listening to Meet tab + your microphone… Speech segments will appear here every ~10–25 s.'
              : 'Transcript preview will appear here during the call. Remember to let participants know you are taking local notes.'}
          </div>
        ) : (
          segments.slice(-80).map((seg, idx) => (
            <div key={seg.id ?? `${seg.chunkId}-${idx}`} class="seg-row">
              <span class="seg-ts">[{formatTimestamp(seg.start, 'hms')}]</span>
              {seg.speaker && (
                <strong
                  style={{
                    marginRight: '6px',
                    color: seg.speakerSource === 'you' ? 'var(--primary)' : 'var(--text)',
                  }}
                >
                  {seg.speaker}:
                </strong>
              )}
              <span>{seg.text}</span>
            </div>
          ))
        )}
      </div>

      {/* Primary action button */}
      {!isActive ? (
        <button type="button" class="btn btn-primary btn-block" disabled={!canStart} onClick={handleStart}>
          Start transcription (Meet + Mic)
        </button>
      ) : (
        <button
          type="button"
          class="btn btn-danger btn-block"
          disabled={state.status === 'stopping' || busy}
          onClick={handleStopAndSave}
        >
          {state.status === 'stopping' ? 'Finishing & saving…' : 'Stop and save (.md)'}
        </button>
      )}

      <div class="footer-row">
        <span>100% on-device · Whisper large-v3-turbo</span>
        <span>.md export</span>
      </div>
    </>
  );
}

const root = document.getElementById('app');
if (root) {
  render(<PopupApp />, root);
}

