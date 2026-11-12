/** Shared domain types used across the service worker, offscreen document, worker and UI pages. */

export type RecordingStatus = 'idle' | 'starting' | 'recording' | 'stopping' | 'error';

/** Sub-phase of the transcription engine while a session is active. */
export type EnginePhase = 'loading-model' | 'transcribing' | 'recovering' | 'draining' | 'failed';

export type Device = 'webgpu' | 'wasm';

export type QuantPreset = 'balanced' | 'compact' | 'fp32';

export type TimestampStyle = 'hms' | 'ms' | 'none';

export interface Settings {
  /** 'auto' or a Whisper language code (e.g. 'en', 'pt'). */
  defaultLanguage: string;
  quantPreset: QuantPreset;
  filenameTemplate: string;
  timestampStyle: TimestampStyle;
  recentLanguages: string[];
  favoriteLanguages: string[];
}

/** Saved in chrome.storage.local once the model is downloaded and verified. */
export interface ModelInfo {
  modelId: string;
  revision: string;
  preset: QuantPreset;
  downloadedAt: number;
  verifiedAt: number;
  /** Real-time factor measured during setup (processing time / audio time). */
  benchmarkRtf?: number;
  benchmarkDevice?: Device;
  /** One-line summary of resource warnings shown in the popup (§14.5). */
  resourceSummary?: string;
}

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface ResourceCheck {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
}

export type SpeakerSource = 'you' | 'remote';

/** A transcribed segment with times relative to the session start, in seconds. */
export interface Segment {
  id?: number;
  sessionId: string;
  chunkId: number;
  start: number;
  end: number;
  text: string;
  /** Tier 1 channel attribution ('you' = microphone, 'remote' = Meet tab). */
  speakerSource?: SpeakerSource;
  /** Resolved speaker label (e.g. 'You', a Meet participant name like 'Maria', or 'Remote'). */
  speaker?: string;
}

/** Active-speaker span reported by the Google Meet content script (Tier 2, PLAN §9). */
export interface SpeakerEvent {
  name: string;
  /** Wall-clock epoch ms when this speaker became active. */
  startMs: number;
  /** Wall-clock epoch ms when this speaker stopped speaking (or last seen active). */
  endMs: number;
}

export type SessionStatus = 'active' | 'saved' | 'interrupted';

export interface SessionMeta {
  id: string;
  startedAt: number;
  endedAt?: number;
  meetingTitle: string;
  meetingUrl: string;
  /** Language chosen at start ('auto' or a code). */
  language: string;
  /** Language detected by Whisper when `language === 'auto'`. */
  detectedLanguage?: string;
  device?: Device;
  status: SessionStatus;
}

/** Recorder state owned by the service worker and mirrored to chrome.storage.session. */
export interface RecorderState {
  status: RecordingStatus;
  sessionId?: string;
  tabId?: number;
  startedAt?: number;
  /** Language currently applied ('auto' or a code). */
  language: string;
  detectedLanguage?: string;
  phase?: EnginePhase;
  device?: Device;
  queueDepth: number;
  lagging: boolean;
  error?: string;
  /** Hint for the UI on how to fix the error. */
  errorAction?: 'open-setup' | 'none';
  /** Session that was interrupted by a crash and can still be saved. */
  recoverableSessionId?: string;
  /** Most recently completed session kept in the preview so the user can re-download it. */
  lastSavedSessionId?: string;
  /** Model loading progress while starting, 0..1. */
  loadProgress?: number;
  /** Non-self participant names detected in the Google Meet DOM (for live popup status badge). */
  detectedParticipants?: string[];
  /** Currently active speaker names detected in the Google Meet DOM. */
  activeDomSpeakers?: string[];
}

export const DEFAULT_STATE: RecorderState = {
  status: 'idle',
  language: 'auto',
  queueDepth: 0,
  lagging: false,
};

export interface MeetingInfo {
  title: string;
  url: string;
  code?: string;
}

/** Snapshot of participants & active speakers reported by the Google Meet content script. */
export interface SpeakerSnapshot {
  /** Wall-clock epoch ms of the snapshot. */
  timestampMs: number;
  /** Local user's own display name detected in Google Meet's DOM (if available). */
  selfName?: string;
  /** Non-self participants currently showing an active speaking indicator in Meet's DOM. */
  activeSpeakers: string[];
  /** All non-self remote participants currently visible in the call. */
  remoteParticipants: string[];
  /** Total participant tiles found in the DOM (including self). */
  totalTiles?: number;
}

