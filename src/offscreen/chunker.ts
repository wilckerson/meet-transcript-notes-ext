/**
 * Audio chunking, pause boundary selection, overlap deduplication, and
 * hallucination filtering (PLAN §5, §13).
 *
 * Policy (§5.4):
 *  - Feed 100 ms frames of 16 kHz mono Float32 PCM.
 *  - Target chunk length: 10 s to 25 s, cut at the first pause >= 300 ms after 10 s.
 *  - Hard cap at 28 s (within Whisper's 30 s context window).
 *  - Keep 0.5 s overlap with the previous chunk and remove duplicate boundary words/segments.
 *  - Skip chunks that contain only silence.
 */
import { DEFAULT_RMS_THRESHOLD, hasVoiceActivity, isSpeechFrame } from './vad';
import type { Segment } from '../shared/types';

export const SAMPLE_RATE = 16000;
export const FRAME_DURATION_S = 0.1; // 100 ms frames from AudioWorklet
export const MIN_CHUNK_S = 10;
export const TARGET_MAX_S = 25;
export const HARD_CAP_S = 28;
export const PAUSE_THRESHOLD_S = 0.3; // 300 ms pause
export const OVERLAP_S = 0.5; // 500 ms overlap
export const MIN_FLUSH_S = 0.6; // minimum audio on Stop to transcribe

export interface AudioChunk {
  chunkId: number;
  /** Audio samples at 16 kHz mono. */
  audio: Float32Array;
  /** Start timestamp of `audio[0]` in seconds from the session start. */
  chunkStartTime: number;
  /** Duration of `audio` in seconds. */
  duration: number;
  /** Seconds at the start of `audio` that overlap with the previous emitted chunk. */
  overlapSeconds: number;
}

export interface ChunkerOptions {
  sampleRate?: number;
  minChunkSeconds?: number;
  hardCapSeconds?: number;
  pauseSeconds?: number;
  overlapSeconds?: number;
  rmsThreshold?: number;
}

export class AudioChunker {
  private readonly sampleRate: number;
  private readonly minSamples: number;
  private readonly hardCapSamples: number;
  private readonly pauseSamples: number;
  private readonly overlapSamples: number;
  private readonly rmsThreshold: number;

  private buffer: Float32Array;
  private bufferedSamples = 0;
  /** Sample index (from session start) corresponding to `buffer[0]`. */
  private bufferStartSample = 0;
  private trailingSilenceSamples = 0;
  private speechSamplesInBuffer = 0;
  private nextChunkId = 1;
  private hasEmittedBefore = false;

  constructor(opts: ChunkerOptions = {}) {
    this.sampleRate = opts.sampleRate ?? SAMPLE_RATE;
    this.minSamples = Math.round((opts.minChunkSeconds ?? MIN_CHUNK_S) * this.sampleRate);
    this.hardCapSamples = Math.round((opts.hardCapSeconds ?? HARD_CAP_S) * this.sampleRate);
    this.pauseSamples = Math.round((opts.pauseSeconds ?? PAUSE_THRESHOLD_S) * this.sampleRate);
    this.overlapSamples = Math.round((opts.overlapSeconds ?? OVERLAP_S) * this.sampleRate);
    this.rmsThreshold = opts.rmsThreshold ?? DEFAULT_RMS_THRESHOLD;
    this.buffer = new Float32Array(this.hardCapSamples + this.sampleRate * 4);
  }

  /** Appends a PCM frame and returns any completed chunks ready for inference. */
  pushFrame(frame: Float32Array): AudioChunk[] {
    if (frame.length === 0) return [];
    const emitted: AudioChunk[] = [];

    let offset = 0;
    while (offset < frame.length) {
      const spaceToCap = this.hardCapSamples - this.bufferedSamples;
      const take = Math.min(frame.length - offset, Math.max(1, spaceToCap));
      const slice = frame.subarray(offset, offset + take);
      offset += take;

      this.appendSlice(slice);

      const isPauseCut =
        this.bufferedSamples >= this.minSamples && this.trailingSilenceSamples >= this.pauseSamples;
      const isHardCap = this.bufferedSamples >= this.hardCapSamples;

      if (isPauseCut || isHardCap) {
        const chunk = this.emitCurrentBuffer(true);
        if (chunk) emitted.push(chunk);
      }
    }

    return emitted;
  }

  /** Flushes any remaining buffered audio on Stop. */
  flush(): AudioChunk | null {
    const minSamples = Math.round(MIN_FLUSH_S * this.sampleRate);
    if (this.bufferedSamples < minSamples) {
      this.resetBuffer(this.bufferStartSample + this.bufferedSamples);
      return null;
    }
    return this.emitCurrentBuffer(false);
  }

  private appendSlice(slice: Float32Array): void {
    if (this.bufferedSamples + slice.length > this.buffer.length) {
      const next = new Float32Array(Math.max(this.buffer.length * 2, this.bufferedSamples + slice.length));
      next.set(this.buffer.subarray(0, this.bufferedSamples));
      this.buffer = next;
    }
    this.buffer.set(slice, this.bufferedSamples);
    this.bufferedSamples += slice.length;

    if (isSpeechFrame(slice, this.rmsThreshold)) {
      this.trailingSilenceSamples = 0;
      this.speechSamplesInBuffer += slice.length;
    } else {
      this.trailingSilenceSamples += slice.length;
    }
  }

  private emitCurrentBuffer(keepOverlap: boolean): AudioChunk | null {
    const totalSamples = this.bufferedSamples;
    const chunkSamples = this.buffer.slice(0, totalSamples);
    const chunkStartSample = this.bufferStartSample;
    const hadSpeech =
      this.speechSamplesInBuffer > 0 &&
      hasVoiceActivity(chunkSamples, this.sampleRate, this.rmsThreshold);

    if (!hadSpeech) {
      // Pure silence: advance timeline without queuing an inference job, and don't carry overlap.
      this.resetBuffer(chunkStartSample + totalSamples);
      this.hasEmittedBefore = false;
      return null;
    }

    const overlapSec = this.hasEmittedBefore ? this.overlapSamples / this.sampleRate : 0;
    const chunk: AudioChunk = {
      chunkId: this.nextChunkId++,
      audio: chunkSamples,
      chunkStartTime: chunkStartSample / this.sampleRate,
      duration: totalSamples / this.sampleRate,
      overlapSeconds: overlapSec,
    };

    if (keepOverlap && totalSamples > this.overlapSamples) {
      const keepStart = totalSamples - this.overlapSamples;
      const tail = chunkSamples.subarray(keepStart);
      this.buffer.set(tail, 0);
      this.bufferedSamples = tail.length;
      this.bufferStartSample = chunkStartSample + keepStart;
      this.trailingSilenceSamples = Math.min(this.trailingSilenceSamples, tail.length);
      this.speechSamplesInBuffer = isSpeechFrame(tail, this.rmsThreshold) ? tail.length : 0;
      this.hasEmittedBefore = true;
    } else {
      this.resetBuffer(chunkStartSample + totalSamples);
      this.hasEmittedBefore = false;
    }

    return chunk;
  }

  private resetBuffer(nextStartSample: number): void {
    this.bufferedSamples = 0;
    this.bufferStartSample = nextStartSample;
    this.trailingSilenceSamples = 0;
    this.speechSamplesInBuffer = 0;
  }
}

// ---- Hallucination filtering & boundary overlap deduplication (PLAN §5.4, §13) ---------------

/** Common Whisper silence/music hallucinations when no speech is actually present. */
const HALLUCINATION_PATTERNS: readonly RegExp[] = [
  /^\[?(?:music|applause|laughter|silence|blank_audio|inaudible)\]?$/i,
  /^\((?:music|applause|laughter|silence|cheering)\)$/i,
  /^♪+.*♪*$/,
  /^(?:thank you(?: very much)?|thanks for watching|please subscribe|subtitles by .*|amara\.org)[.!?\s]*$/i,
];

/**
 * Collapses phrases that repeat 4+ times back-to-back inside a single segment
 * (Whisper repetition loop hallucination).
 */
export function collapseRepeatedPhrases(text: string): string {
  // Match a 1..6 word phrase repeated >= 4 times consecutively.
  return text.replace(/\b(\w+(?:\s+\w+){0,5})(?:[,\s]+\1){3,}\b/gi, '$1');
}

export function isLikelyHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (HALLUCINATION_PATTERNS.some((re) => re.test(trimmed))) return true;
  // Detect extreme single-character or punctuation loops
  if (/^(.)\1{12,}$/.test(trimmed)) return true;
  return false;
}

/**
 * Merges newly decoded segments from a chunk with the tail of previously emitted
 * segments, trimming duplicate words/segments in the ~0.5 s overlap zone.
 */
export function deduplicateOverlapSegments(
  previousSegments: readonly Segment[],
  incomingSegments: readonly Segment[],
  overlapWindowSec = 1.2,
): Segment[] {
  const prevLast = previousSegments.at(-1);
  const result: Segment[] = [];

  for (const raw of incomingSegments) {
    const cleanedText = collapseRepeatedPhrases(raw.text).trim();
    if (isLikelyHallucination(cleanedText)) continue;

    let seg: Segment = { ...raw, text: cleanedText };

    const compareAgainst = result.at(-1) ?? prevLast;
    if (compareAgainst && seg.start <= compareAgainst.end + overlapWindowSec) {
      if (normalizeWords(seg.text) === normalizeWords(compareAgainst.text)) {
        continue;
      }
      const trimmed = stripOverlapPrefix(compareAgainst.text, seg.text);
      if (!trimmed) continue;
      if (trimmed !== seg.text) {
        seg = {
          ...seg,
          start: Math.max(seg.start, compareAgainst.end),
          text: trimmed,
        };
      }
    }

    result.push(seg);
  }

  return result;
}

/**
 * If the suffix of `prevText` matches the prefix of `nextText` (1..8 words),
 * strips the duplicated prefix from `nextText`.
 */
export function stripOverlapPrefix(prevText: string, nextText: string): string {
  const prevWords = prevText.trim().split(/\s+/).filter(Boolean);
  const nextWords = nextText.trim().split(/\s+/).filter(Boolean);
  if (prevWords.length === 0 || nextWords.length === 0) return nextText.trim();

  const maxOverlap = Math.min(8, prevWords.length, nextWords.length);
  for (let k = maxOverlap; k >= 1; k--) {
    let matches = true;
    for (let i = 0; i < k; i++) {
      if (cleanWord(prevWords[prevWords.length - k + i]) !== cleanWord(nextWords[i])) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return nextWords.slice(k).join(' ').trim();
    }
  }
  return nextText.trim();
}

function cleanWord(w: string): string {
  return w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function normalizeWords(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

