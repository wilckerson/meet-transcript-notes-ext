/**
 * Tier 1 + Tier 2 Speaker Attribution (PLAN §8, §9).
 *
 * - Tier 1 (Always reliable): Dual-channel RMS energy tracker comparing Channel 0
 *   (Google Meet tab audio = remote participants) vs. Channel 1 (user microphone = You)
 *   on every 100 ms frame. Classifies any `[startSec, endSec]` segment as `'you'` or `'remote'`.
 *
 * - Tier 2 (Best-effort DOM enrichment): Matches a `'remote'` segment's `[startSec, endSec]`
 *   window against active-speaker intervals `{ name, startMs, endMs }` observed in Google
 *   Meet's DOM. If a participant name overlaps the segment above a minimum threshold, uses
 *   that participant's name; otherwise reliably falls back to `'Remote'`.
 */
import type { SpeakerEvent, SpeakerSource } from './types';

export interface FrameEnergySample {
  /** Frame start time in seconds from session start. */
  timeSec: number;
  /** RMS energy of the Google Meet tab stream (remote participants). */
  tabRms: number;
  /** RMS energy of the user's microphone stream. */
  micRms: number;
}

const NOISE_FLOOR_RMS = 0.004;
/**
 * When the user speaks into the microphone, echo cancellation keeps remote bleed low;
 * when remote audio plays through speakers, a small fraction may bleed into the mic.
 * Requiring `micEnergy >= tabEnergy * 1.15` when both channels are active avoids
 * mislabeling speaker bleed as "You".
 */
const MIC_DOMINANCE_RATIO = 1.15;

/**
 * Rolling timeline of 100 ms per-channel RMS energy samples used in the offscreen document
 * to classify each transcribed segment as `'you'` or `'remote'`.
 */
export class ChannelEnergyTracker {
  private readonly frameDurationSec: number;
  private samples: FrameEnergySample[] = [];
  private nextFrameIndex = 0;

  constructor(frameDurationSec = 0.1) {
    this.frameDurationSec = frameDurationSec;
  }

  /** Appends a 100 ms frame's tab and mic RMS values. */
  pushFrameEnergy(tabRms: number, micRms: number): void {
    const timeSec = this.nextFrameIndex * this.frameDurationSec;
    this.nextFrameIndex++;
    this.samples.push({ timeSec, tabRms, micRms });
  }

  /**
   * Determines whether `'you'` (microphone) or `'remote'` (Meet tab) was the dominant
   * audio source during `[startSec, endSec]`.
   */
  classifySegment(startSec: number, endSec: number): SpeakerSource {
    if (this.samples.length === 0) return 'remote';

    const winStart = Math.max(0, startSec - this.frameDurationSec);
    const winEnd = Math.max(winStart + this.frameDurationSec, endSec);

    let tabActiveFrames = 0;
    let micActiveFrames = 0;
    let tabEnergySum = 0;
    let micEnergySum = 0;

    for (const s of this.samples) {
      if (s.timeSec + this.frameDurationSec < winStart) continue;
      if (s.timeSec > winEnd) break;

      const tabAbove = s.tabRms >= NOISE_FLOOR_RMS;
      const micAbove = s.micRms >= NOISE_FLOOR_RMS;

      if (tabAbove || micAbove) {
        tabEnergySum += s.tabRms;
        micEnergySum += s.micRms;
        if (micAbove && s.micRms >= s.tabRms * MIC_DOMINANCE_RATIO) {
          micActiveFrames++;
        } else if (tabAbove) {
          tabActiveFrames++;
        }
      }
    }

    if (micActiveFrames === 0 && tabActiveFrames === 0) {
      return micEnergySum > tabEnergySum * MIC_DOMINANCE_RATIO ? 'you' : 'remote';
    }
    if (micActiveFrames > tabActiveFrames) {
      return 'you';
    }
    if (tabActiveFrames > micActiveFrames) {
      return 'remote';
    }
    return micEnergySum >= tabEnergySum * MIC_DOMINANCE_RATIO ? 'you' : 'remote';
  }

  /** Prunes energy samples older than `beforeSec` so memory stays bounded on 2h+ calls. */
  pruneBefore(beforeSec: number): void {
    const cutoff = beforeSec - 5;
    if (cutoff <= 0 || this.samples.length === 0) return;
    let dropCount = 0;
    while (dropCount < this.samples.length && this.samples[dropCount].timeSec < cutoff) {
      dropCount++;
    }
    if (dropCount > 0) {
      this.samples.splice(0, dropCount);
    }
  }
}

/**
 * Resolves the final human-readable speaker label for a segment combining Tier 1 and Tier 2:
 *  1. If `speakerSource === 'you'`, always returns `'You'`.
 *  2. If `speakerSource === 'remote'`, looks for the Meet participant with the largest
 *     speaking-indicator overlap during the segment's wall-clock window.
 *  3. If no active-speaking animation was observed (e.g. Meet tab was in the background so
 *     Chrome throttled CSS animations), checks `remoteParticipants`: when there is exactly
 *     1 remote participant in the meeting (1-on-1 call), any remote audio is unambiguously
 *     that participant.
 *  4. Otherwise reliably falls back to `'Remote'`.
 */
export function resolveSpeakerLabel(
  speakerSource: SpeakerSource | undefined,
  segmentStartSec: number,
  segmentEndSec: number,
  sessionStartedAtMs: number,
  speakerEvents: readonly SpeakerEvent[],
  remoteParticipants: readonly string[] = [],
  minOverlapMs = 200,
): string {
  if (speakerSource === 'you') {
    return 'You';
  }

  // Allow a +-600 ms tolerance around the segment timestamps to account for
  // Meet's UI highlight lag vs. Whisper token timestamps.
  if (speakerEvents.length > 0 && sessionStartedAtMs > 0) {
    const segStartMs = sessionStartedAtMs + Math.max(0, segmentStartSec) * 1000 - 600;
    const segEndMs =
      sessionStartedAtMs + Math.max(segmentStartSec + 0.3, segmentEndSec) * 1000 + 600;

    const overlapBySpeaker = new Map<string, number>();

    for (const evt of speakerEvents) {
      const name = evt.name.trim();
      if (!name || isSelfLabel(name)) continue;
      const overlapStart = Math.max(segStartMs, evt.startMs);
      const overlapEnd = Math.min(segEndMs, evt.endMs);
      const overlap = overlapEnd - overlapStart;
      if (overlap > 0) {
        overlapBySpeaker.set(name, (overlapBySpeaker.get(name) ?? 0) + overlap);
      }
    }

    let bestName: string | undefined;
    let bestOverlap = 0;
    for (const [name, total] of overlapBySpeaker) {
      if (total > bestOverlap) {
        bestOverlap = total;
        bestName = name;
      }
    }

    if (bestName && bestOverlap >= minOverlapMs) {
      return bestName;
    }
  }

  // 1-on-1 call deterministic attribution: if there is exactly 1 remote participant in the
  // call, any remote audio (Input 0) belongs to that participant even when Meet's tab is
  // backgrounded or its voice meter animation isn't running.
  const validRemotes = remoteParticipants
    .map((n) => n.trim())
    .filter((n) => n.length > 0 && !isSelfLabel(n));
  if (validRemotes.length === 1) {
    return validRemotes[0];
  }

  return 'Remote';
}

/** Filters out Meet's self-tile labels in English, Portuguese, Spanish, etc. */
export function isSelfLabel(name: string): boolean {
  const n = name.trim().toLowerCase();
  return (
    n === 'you' ||
    n === 'você' ||
    n === 'tu' ||
    n === 'tú' ||
    n === 'vous' ||
    n === 'du' ||
    n === 'ich' ||
    n === 'io' ||
    n.endsWith('(you)') ||
    n.endsWith('(você)') ||
    n.endsWith('(tu)') ||
    n.endsWith('(tú)')
  );
}
