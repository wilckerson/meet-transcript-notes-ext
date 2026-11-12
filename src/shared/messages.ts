/** Typed message contracts between extension contexts (chrome.runtime messaging). */
import type {
  Device,
  EnginePhase,
  MeetingInfo,
  QuantPreset,
  RecorderState,
  Segment,
  SpeakerEvent,
} from './types';

// ---- Popup / UI / Content → Service worker ---------------------------------------------------

export type BackgroundRequest =
  | {
      target: 'background';
      type: 'START';
      streamId: string;
      tabId: number;
      language: string;
      meeting: MeetingInfo;
    }
  | { target: 'background'; type: 'STOP' }
  | { target: 'background'; type: 'GET_STATE' }
  | { target: 'background'; type: 'SET_LANGUAGE'; language: string }
  | { target: 'background'; type: 'SAVE_RECOVERED'; sessionId: string }
  | { target: 'background'; type: 'DISCARD_RECOVERED'; sessionId: string }
  | { target: 'background'; type: 'DISMISS_ERROR' }
  | { target: 'background'; type: 'SPEAKER_EVENTS'; events: SpeakerEvent[] };

export interface GetStateResponse {
  state: RecorderState;
  segments: Segment[];
}

export interface OkResponse {
  ok: boolean;
  error?: string;
}

// ---- Offscreen → Service worker --------------------------------------------------------------

export type OffscreenEvent =
  | { target: 'background'; type: 'OFFSCREEN_CAPTURE_STARTED'; sessionId: string }
  | {
      target: 'background';
      type: 'OFFSCREEN_CAPTURE_ERROR';
      sessionId: string;
      source: 'tab' | 'mic' | 'audio';
      error: string;
    }
  | {
      target: 'background';
      type: 'OFFSCREEN_ENGINE';
      sessionId: string;
      phase: EnginePhase;
      device?: Device;
      progress?: number;
      error?: string;
    }
  | { target: 'background'; type: 'OFFSCREEN_SEGMENTS'; sessionId: string; segments: Segment[] }
  | {
      target: 'background';
      type: 'OFFSCREEN_QUEUE';
      sessionId: string;
      depth: number;
      lagging: boolean;
    }
  | { target: 'background'; type: 'OFFSCREEN_LANGUAGE_DETECTED'; sessionId: string; language: string }
  | { target: 'background'; type: 'OFFSCREEN_MIC_LOST'; sessionId: string }
  | { target: 'background'; type: 'OFFSCREEN_DRAINED'; sessionId: string }
  | { target: 'background'; type: 'OFFSCREEN_RELEASED' }
  | { target: 'background'; type: 'OFFSCREEN_HEARTBEAT'; sessionId?: string };

// ---- Service worker → Offscreen --------------------------------------------------------------

export interface OffscreenStartConfig {
  sessionId: string;
  streamId: string;
  language: string;
  preset: QuantPreset;
}

export type OffscreenCommand =
  | { target: 'offscreen'; type: 'START'; config: OffscreenStartConfig }
  | { target: 'offscreen'; type: 'STOP' }
  | { target: 'offscreen'; type: 'SET_LANGUAGE'; language: string }
  | { target: 'offscreen'; type: 'RELEASE' }
  | { target: 'offscreen'; type: 'PING' };

// ---- Service worker → UI broadcasts ----------------------------------------------------------

export type UiBroadcast =
  | { target: 'ui'; type: 'STATE'; state: RecorderState }
  | { target: 'ui'; type: 'SEGMENTS_ADDED'; sessionId: string; segments: Segment[] };

// ---- Content script --------------------------------------------------------------------------

export type ContentRequest = { type: 'GET_MEETING_INFO' };

export type AnyMessage = BackgroundRequest | OffscreenEvent | OffscreenCommand | UiBroadcast;

/** Sends a message and swallows "no receiver" errors (e.g. popup closed). */
export async function sendSafe<T = unknown>(message: AnyMessage): Promise<T | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch {
    return undefined;
  }
}

