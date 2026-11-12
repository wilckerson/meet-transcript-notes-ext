/**
 * Google Meet content script (PLAN §3.6, §7, §9).
 *
 * Responsibilities:
 *  1. Extracts the meeting title and code from the Meet page so exported Markdown files
 *     have a meaningful title and filename.
 *  2. Tier 2 Active Speaker Observer (§9): Polls and observes Google Meet's participant
 *     tiles for active-speaking visual indicators (animated soundbars / speaking ring)
 *     and reports `{ name, startMs, endMs }` intervals to the background service worker.
 *     Fails silently if Meet's DOM structure changes, so Tier 1 (`You` vs. `Remote`)
 *     always remains a 100% reliable fallback.
 */
import { sendSafe, type ContentRequest } from '../shared/messages';
import { isSelfLabel } from '../shared/speaker';
import type { MeetingInfo, SpeakerEvent } from '../shared/types';

/**
 * Centralized selectors for Google Meet participant tiles and speaking indicators (PLAN §9).
 * Kept in one config object so future Meet DOM updates only touch this list.
 */
const MEET_SELECTORS = {
  /** Containers representing an individual participant tile or list row. */
  participantTile: [
    '[data-participant-id]',
    '[data-requested-participant-id]',
    '[data-self-name]',
  ].join(', '),

  /** Elements inside a participant tile that carry the participant's display name. */
  participantName: [
    '[data-self-name]',
    '[data-tooltip-id]',
    '[jscontroller] [dir="auto"]',
    '.zWGUib',
    '.XEazBc',
    '.cS7aqe',
  ].join(', '),

  /**
   * Speaking-indicator elements inside a participant tile.
   * In Google Meet, the 3-bar voice level meter animates its child bar heights or classes
   * while a participant is actively speaking.
   */
  voiceMeterBars: [
    '[jscontroller="ES310d"]',
    '[jscontroller="mUJV5"]',
    '.IisKdb',
    '.gjg47c',
    '.t3P25',
  ].join(', '),
};

function extractMeetingInfo(): MeetingInfo {
  const url = window.location.href;
  const pathMatch = window.location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  const code = pathMatch ? pathMatch[1] : undefined;

  let title = '';
  const titleEl = document.querySelector<HTMLElement>('[data-meeting-title]');
  if (titleEl?.dataset.meetingTitle) {
    title = titleEl.dataset.meetingTitle.trim();
  }

  if (!title) {
    title = document.title
      .replace(/^Meet\s*[-–—]\s*/i, '')
      .replace(/\s*[-–—]\s*Google Meet$/i, '')
      .trim();
  }

  if (!title || title.toLowerCase() === 'google meet') {
    title = code ? `Meet (${code})` : 'Google Meet';
  }

  return { title, url, code };
}

/**
 * Inspects a participant tile element and returns the participant's clean display name,
 * or `null` if none can be reliably read or if it is the user's own tile.
 */
function readTileParticipantName(tile: Element): string | null {
  try {
    // Skip the user's own video tile (Tier 1 microphone channel already identifies "You").
    if (tile.hasAttribute('data-self-name')) {
      const candidates = tile.querySelectorAll<HTMLElement>(MEET_SELECTORS.participantName);
      for (const el of candidates) {
        const txt = (el.textContent ?? '').trim();
        if (txt && isSelfLabel(txt)) return null;
      }
    }

    const nameEls = tile.querySelectorAll<HTMLElement>(MEET_SELECTORS.participantName);
    for (const el of nameEls) {
      const raw = (el.dataset.selfName || el.textContent || '').trim();
      const cleaned = cleanParticipantName(raw);
      if (cleaned && !isSelfLabel(cleaned)) {
        return cleaned;
      }
    }
  } catch {
    // Fail silently if DOM access throws
  }
  return null;
}

function cleanParticipantName(raw: string): string | null {
  if (!raw) return null;
  const line = raw.split('\n')[0].trim();
  if (!line || line.length > 60) return null;
  // Ignore UI button labels / status strings that sometimes appear inside tiles
  if (
    /^(mute|unmute|pin|unpin|more options|reframe|backgrounds|devices|turn off|turn on|\d+ others?)$/i.test(
      line,
    )
  ) {
    return null;
  }
  return line;
}

/**
 * Detects whether a participant tile currently shows an active speaking indicator.
 * Checks animated voice-meter bars whose computed height/transform indicates non-zero audio level.
 */
function isTileCurrentlySpeaking(tile: Element): boolean {
  try {
    const meters = tile.querySelectorAll<HTMLElement>(MEET_SELECTORS.voiceMeterBars);
    for (const meter of meters) {
      if (meter.offsetParent === null) continue; // hidden when muted or silent
      const bars = meter.children.length > 0 ? Array.from(meter.children) : [meter];
      let animatedBars = 0;
      for (const bar of bars) {
        const style = window.getComputedStyle(bar);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          continue;
        }
        const heightPx = parseFloat(style.height || '0');
        const transform = style.transform || '';
        const scaleMatch = transform.match(/matrix\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)/);
        const scaleY = scaleMatch ? parseFloat(scaleMatch[1]) : 1;
        if ((heightPx > 6.5 && scaleY > 0.35) || (scaleMatch && scaleY > 0.45)) {
          animatedBars++;
        }
      }
      if (animatedBars > 0) return true;
    }
  } catch {
    // Fail silently
  }
  return false;
}

// ---- Poll & batch active-speaker spans every 250 ms -----------------------------------------

const POLL_INTERVAL_MS = 250;
const FLUSH_INTERVAL_MS = 2000;

const ongoingSpans = new Map<string, { startMs: number; lastSeenMs: number }>();
const completedEvents: SpeakerEvent[] = [];

function pollActiveSpeakers(): void {
  try {
    const now = Date.now();
    const tiles = document.querySelectorAll(MEET_SELECTORS.participantTile);
    const currentlySpeaking = new Set<string>();

    for (const tile of tiles) {
      if (!isTileCurrentlySpeaking(tile)) continue;
      const name = readTileParticipantName(tile);
      if (name) {
        currentlySpeaking.add(name);
      }
    }

    for (const name of currentlySpeaking) {
      const existing = ongoingSpans.get(name);
      if (existing) {
        existing.lastSeenMs = now + POLL_INTERVAL_MS;
      } else {
        ongoingSpans.set(name, { startMs: now, lastSeenMs: now + POLL_INTERVAL_MS });
      }
    }

    for (const [name, span] of ongoingSpans) {
      if (!currentlySpeaking.has(name) && now - span.lastSeenMs >= POLL_INTERVAL_MS) {
        completedEvents.push({
          name,
          startMs: span.startMs,
          endMs: span.lastSeenMs,
        });
        ongoingSpans.delete(name);
      }
    }
  } catch {
    // Never disrupt the host page
  }
}

function flushSpeakerEvents(): void {
  try {
    const now = Date.now();
    const batch: SpeakerEvent[] = [...completedEvents];
    completedEvents.length = 0;

    // Also include snapshots of any currently ongoing speaker spans so segments that finish
    // while someone is still talking still get matched immediately.
    for (const [name, span] of ongoingSpans) {
      batch.push({
        name,
        startMs: span.startMs,
        endMs: Math.max(span.lastSeenMs, now),
      });
    }

    if (batch.length > 0) {
      void sendSafe({
        target: 'background',
        type: 'SPEAKER_EVENTS',
        events: batch,
      });
    }
  } catch {
    // ignore
  }
}

setInterval(pollActiveSpeakers, POLL_INTERVAL_MS);
setInterval(flushSpeakerEvents, FLUSH_INTERVAL_MS);

chrome.runtime.onMessage.addListener(
  (msg: ContentRequest, _sender, sendResponse: (res: MeetingInfo) => void) => {
    if (msg && msg.type === 'GET_MEETING_INFO') {
      sendResponse(extractMeetingInfo());
      return false;
    }
    return undefined;
  },
);
