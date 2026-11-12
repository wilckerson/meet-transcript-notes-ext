/**
 * Google Meet content script (PLAN §3.6, §7, §9).
 *
 * Responsibilities:
 *  1. Extracts the meeting title and code from the Meet page so exported Markdown files
 *     have a meaningful title and filename.
 *  2. Tier 2 Active Speaker & Participant Observer (§9):
 *     - Discovers participant tiles (`[jscontroller="W156lc"]`, `[data-participant-id]`, etc.)
 *       across Google Meet's DOM.
 *     - Extracts participant display names from `.XEazBc [jsslot] span.notranslate` /
 *       `.XEazBc [data-tooltip-id]` (avoiding duplicate `[role="tooltip"]` nodes).
 *     - Identifies the local user's self tile via `data-use-raw-local-presentation-stream="true"`
 *       or explicit `(You)` / `(Você)` labels.
 *     - Detects active speaking via class/style mutations on `.IisKdb` / `.DYfzY` voice meters
 *       (`jscontroller="tae9tc"`, `jscontroller="YQvg8b"`, `.UBNDXc`, `.HPxjXe`, `.DwvCqe`).
 *     - Also reports all visible remote participant names (`remoteParticipants`) so 1-on-1 calls
 *       deterministically attribute remote audio even when a participant joins muted or when
 *       the Meet tab is in the background.
 */
import { sendSafe, type ContentRequest } from '../shared/messages';
import { isSelfLabel } from '../shared/speaker';
import type { MeetingInfo, SpeakerEvent, SpeakerSnapshot } from '../shared/types';

/**
 * Centralized selectors matched against actual Google Meet participant tile DOM (PLAN §9).
 */
export const MEET_SELECTORS = {
  /**
   * Top-level container for a single participant tile in the call grid.
   * `div[jscontroller="W156lc"].FKJK2b` is the outer tile wrapper that holds both the
   * video/avatar (`div.CNjCjf`) and the name/voice-meter overlay (`div[jscontroller="gu0YGc"]`).
   */
  participantTile: [
    '[jscontroller="W156lc"]',
    '.FKJK2b',
    '[data-participant-id]',
    '[data-requested-participant-id]',
  ].join(', '),

  /**
   * Elements inside a participant tile that hold the participant's visible display name,
   * ordered from most specific to fallback. Excludes `[role="tooltip"]` so `textContent`
   * never concatenates the visible name and tooltip text (`"JoãoJoão"`).
   */
  participantName: [
    '.XEazBc [jsslot] span.notranslate',
    '.XEazBc [data-tooltip-id] span.notranslate',
    '.XEazBc [jsslot]',
    '[data-self-name]',
    '.zWGUib',
    '.cS7aqe',
    '.dwSJ2e',
  ].join(', '),

  /**
   * Voice-meter / speaking-indicator elements inside a participant tile:
   *  - `.IisKdb[jscontroller="tae9tc"]` with 3 bar children (`.UBNDXc`, `.HPxjXe`, `.DwvCqe`)
   *  - `.DYfzY[jscontroller="YQvg8b"]` avatar speaking ring
   *  - `[jscontroller="mUJV5"]` voice status wrapper
   */
  voiceMeterContainers: [
    '.IisKdb',
    '[jscontroller="tae9tc"]',
    '[jscontroller="YQvg8b"]',
    '[jscontroller="ES310d"]',
    '.gjg47c',
  ].join(', '),

  voiceMeterBars: '.UBNDXc, .HPxjXe, .DwvCqe',
};

/** Common Google Meet UI strings or Material icon ligatures that are NOT participant names. */
const IGNORED_UI_LABELS = new Set([
  'devices',
  'more_vert',
  'mic_off',
  'mic',
  'videocam',
  'videocam_off',
  'volume_up',
  'volume_off',
  'keep',
  'keep_off',
  'frame_person',
  'visual_effects',
  'mute',
  'unmute',
  'pin',
  'unpin',
  'more options',
  'more actions',
  'reframe',
  'backgrounds and effects',
  'backgrounds',
  'visual effects',
  'turn off microphone',
  'turn on microphone',
  'turn off camera',
  'turn on camera',
  'raise hand',
  'lower hand',
  'send a reaction',
  'present now',
  'share screen',
  'leave call',
  'meeting details',
  'people',
  'chat',
  'activities',
  'host controls',
  'remove from the call',
  "don't watch",
  'watch',
  'desativar som',
  'ativar som',
  'fixar',
  'desafixar',
  'mais opções',
  'mais ações',
  'planos de fundo e efeitos',
  'efeitos visuais',
  'levantar a mão',
  'abaixar a mão',
  'apresentar agora',
  'sair da chamada',
  'detalhes da reunião',
  'pessoas',
  'remover da chamada',
  'não assistir',
  'assistir',
]);

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
 * Deduplicates nested tile elements so if a tile matches both `[jscontroller="W156lc"]`
 * and an inner `[data-participant-id]`, we only process the outermost tile container.
 */
function queryTopLevelTiles(root: ParentNode = document): Element[] {
  const raw = Array.from(root.querySelectorAll(MEET_SELECTORS.participantTile));
  return raw.filter((el) => !raw.some((other) => other !== el && other.contains(el)));
}

/**
 * Extracts a participant's clean name and whether the tile belongs to the local user.
 *
 * Note on `data-use-raw-local-presentation-stream`:
 * Google Meet sets this attribute on all tiles in some layouts, so we determine whether
 * a tile is the local user by checking:
 *  1. Whether its name label is `(You)` / `(Você)` (`isSelfLabel`), OR
 *  2. Whether the tile lacks a remote WebRTC `data-ssrc` stream AND there are other tiles
 *     with `data-ssrc` in the call.
 */
export function parseParticipantTile(
  tile: Element,
  hasAnyRemoteSsrcTile: boolean,
): { name: string; isSelf: boolean } | null {
  try {
    const candidates: string[] = [];

    const selfAttr = tile.getAttribute('data-self-name');
    if (selfAttr) candidates.push(selfAttr);

    const nameEls = tile.querySelectorAll<HTMLElement>(MEET_SELECTORS.participantName);
    for (const el of nameEls) {
      if (el.getAttribute('role') === 'tooltip') continue;
      if (el.dataset?.selfName) candidates.push(el.dataset.selfName);
      if (el.textContent) candidates.push(el.textContent);
    }

    // Fallback: if none of the specific selectors matched, check `.XEazBc [role="tooltip"]`
    if (candidates.length === 0) {
      const tooltip = tile.querySelector<HTMLElement>('.XEazBc [role="tooltip"]');
      if (tooltip?.textContent) candidates.push(tooltip.textContent);
    }

    let isSelf = false;
    let bestName: string | null = null;

    for (const raw of candidates) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (isSelfLabel(trimmed)) {
        isSelf = true;
      }
      const cleaned = cleanParticipantName(trimmed);
      if (cleaned && !isSelfLabel(cleaned)) {
        if (!bestName) bestName = cleaned;
      }
    }

    // Remote participant video streams in Meet carry a numeric `data-ssrc` on `.p2hjYe[data-ssrc]`.
    // If other tiles have `data-ssrc` and this tile does NOT, it is the local user's self preview.
    const hasSsrc = tile.querySelector('[data-ssrc]') !== null || tile.hasAttribute('data-ssrc');
    if (!hasSsrc && hasAnyRemoteSsrcTile) {
      isSelf = true;
    }

    if (isSelf) {
      return { name: bestName ?? 'You', isSelf: true };
    }
    if (bestName) {
      return { name: bestName, isSelf: false };
    }
  } catch {
    // Fail silently
  }
  return null;
}

export function cleanParticipantName(raw: string): string | null {
  if (!raw) return null;
  const line = raw.split('\n')[0].trim();
  if (!line || line.length < 2 || line.length > 60) return null;
  const lower = line.toLowerCase();
  if (IGNORED_UI_LABELS.has(lower)) return null;
  if (/^(\d+\s+(others?|outros?)|[0-9:]+)$/i.test(line)) return null;
  return line;
}

// ---- Track voice-meter class/style changes per tile -----------------------------------------

/**
 * In Google Meet, `.IisKdb` (`jscontroller="tae9tc"`) and `.DYfzY` (`jscontroller="YQvg8b"`)
 * hold the idle class `Oaajhc` when silent, and swap classes / update inline bar styles on
 * `.UBNDXc`, `.HPxjXe`, `.DwvCqe` when the participant is speaking.
 */
const tileLastVoiceMutationMs = new WeakMap<Element, number>();
const meterBaselineClass = new WeakMap<Element, string>();

function setupMutationTracker(): void {
  try {
    const observer = new MutationObserver((mutations) => {
      const now = Date.now();
      for (const m of mutations) {
        const target = m.target as HTMLElement | null;
        if (!target || typeof target.closest !== 'function') continue;
        if (m.type !== 'attributes') continue;

        const isVoiceElement =
          target.matches?.(MEET_SELECTORS.voiceMeterContainers) ||
          target.matches?.(MEET_SELECTORS.voiceMeterBars) ||
          target.closest?.(MEET_SELECTORS.voiceMeterContainers) !== null;

        if (!isVoiceElement) continue;

        const tile = target.closest(MEET_SELECTORS.participantTile);
        if (tile) {
          tileLastVoiceMutationMs.set(tile, now);
        }
      }
    });

    const attach = () => {
      if (document.body) {
        observer.observe(document.body, {
          subtree: true,
          attributes: true,
          attributeFilter: ['style', 'class'],
        });
      }
    };

    if (document.body) attach();
    else window.addEventListener('DOMContentLoaded', attach, { once: true });
  } catch {
    // Fail silently
  }
}

/**
 * Detects whether a participant tile currently shows an active speaking indicator.
 */
function isTileCurrentlySpeaking(tile: Element, now: number): boolean {
  try {
    // 1. Recent mutation on the tile's `.IisKdb` / `.DYfzY` voice meter or its 3 bars
    const lastMut = tileLastVoiceMutationMs.get(tile);
    if (lastMut && now - lastMut <= 500) {
      return true;
    }

    // 2. Check `.IisKdb` / `.DYfzY` class list changes (Meet removes `Oaajhc` when active)
    const meters = tile.querySelectorAll<HTMLElement>(MEET_SELECTORS.voiceMeterContainers);
    for (const meter of meters) {
      const cls = meter.className || '';
      if (!meterBaselineClass.has(meter)) {
        meterBaselineClass.set(meter, cls);
      }
      // When silent/idle, Meet includes `Oaajhc` on both `DYfzY` and `IisKdb`.
      if (
        (cls.includes('IisKdb') || cls.includes('DYfzY')) &&
        !cls.includes('Oaajhc')
      ) {
        return true;
      }

      // 3. Check the 3 bar children (`.UBNDXc`, `.HPxjXe`, `.DwvCqe`) for active height/scale
      const bars = meter.querySelectorAll<HTMLElement>(MEET_SELECTORS.voiceMeterBars);
      for (const bar of bars) {
        const style = window.getComputedStyle(bar);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          continue;
        }
        const heightPx = parseFloat(style.height || '0');
        const transform = style.transform || '';
        const scaleMatch = transform.match(/matrix\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)/);
        const scaleY = scaleMatch ? parseFloat(scaleMatch[1]) : 1;
        if ((heightPx > 5.5 && scaleY > 0.3) || (scaleMatch && scaleY > 0.4)) {
          return true;
        }
      }
    }
  } catch {
    // Fail silently
  }
  return false;
}

// ---- Poll, snapshot & batch active-speaker spans --------------------------------------------

const POLL_INTERVAL_MS = 250;
const FLUSH_INTERVAL_MS = 1500;

const ongoingSpans = new Map<string, { startMs: number; lastSeenMs: number }>();
const completedEvents: SpeakerEvent[] = [];
let latestRemoteParticipants: string[] = [];

export function scanMeetDom(root: ParentNode = document): SpeakerSnapshot {
  const now = Date.now();
  const activeSpeakers = new Set<string>();
  const remoteParticipants = new Set<string>();

  try {
    const tiles = queryTopLevelTiles(root);
    const hasAnyRemoteSsrcTile = tiles.some(
      (t) =>
        (t.querySelector('[data-ssrc]') !== null || t.hasAttribute('data-ssrc')) &&
        !Array.from(t.querySelectorAll(MEET_SELECTORS.participantName)).some((el) =>
          isSelfLabel(el.textContent ?? ''),
        ),
    );

    const parsedTiles: Array<{ tile: Element; name: string; isSelf: boolean }> = [];
    for (const tile of tiles) {
      const info = parseParticipantTile(tile, hasAnyRemoteSsrcTile);
      if (info) {
        parsedTiles.push({ tile, ...info });
      }
    }

    // If multiple tiles share a participant name or none were explicitly marked self,
    // collect all non-self names.
    for (const item of parsedTiles) {
      if (item.isSelf) continue;
      remoteParticipants.add(item.name);
      if (isTileCurrentlySpeaking(item.tile, now)) {
        activeSpeakers.add(item.name);
      }
    }
  } catch {
    // Never disrupt the host page
  }

  latestRemoteParticipants = Array.from(remoteParticipants);

  for (const name of activeSpeakers) {
    const existing = ongoingSpans.get(name);
    if (existing) {
      existing.lastSeenMs = now + POLL_INTERVAL_MS;
    } else {
      ongoingSpans.set(name, { startMs: now, lastSeenMs: now + POLL_INTERVAL_MS });
    }
  }

  for (const [name, span] of ongoingSpans) {
    if (!activeSpeakers.has(name) && now - span.lastSeenMs >= POLL_INTERVAL_MS) {
      completedEvents.push({
        name,
        startMs: span.startMs,
        endMs: span.lastSeenMs,
      });
      ongoingSpans.delete(name);
    }
  }

  return {
    timestampMs: now,
    activeSpeakers: Array.from(activeSpeakers),
    remoteParticipants: latestRemoteParticipants,
    totalTiles: queryTopLevelTiles(root).length,
  };
}

function flushSpeakerEvents(): void {
  try {
    const now = Date.now();
    const batch: SpeakerEvent[] = [...completedEvents];
    completedEvents.length = 0;

    for (const [name, span] of ongoingSpans) {
      batch.push({
        name,
        startMs: span.startMs,
        endMs: Math.max(span.lastSeenMs, now),
      });
    }

    if (batch.length > 0 || latestRemoteParticipants.length > 0) {
      void sendSafe({
        target: 'background',
        type: 'SPEAKER_EVENTS',
        events: batch,
        remoteParticipants: latestRemoteParticipants,
      });
    }
  } catch {
    // ignore
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  setupMutationTracker();
  setInterval(() => scanMeetDom(document), POLL_INTERVAL_MS);
  setInterval(flushSpeakerEvents, FLUSH_INTERVAL_MS);

  chrome.runtime?.onMessage?.addListener(
    (
      msg: ContentRequest,
      _sender,
      sendResponse: (res: MeetingInfo | SpeakerSnapshot) => void,
    ) => {
      if (!msg) return undefined;
      if (msg.type === 'GET_MEETING_INFO') {
        sendResponse(extractMeetingInfo());
        return false;
      }
      if (msg.type === 'GET_SPEAKER_SNAPSHOT') {
        sendResponse(scanMeetDom(document));
        return false;
      }
      return undefined;
    },
  );
}
