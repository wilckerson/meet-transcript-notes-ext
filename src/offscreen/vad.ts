/**
 * Energy/RMS Voice Activity Detection (PLAN §5.3).
 *
 * Used to:
 *  1. Skip completely silent stretches so Whisper doesn't hallucinate ("Thank you.").
 *  2. Detect pauses of >= 300 ms so the chunker cuts at natural boundaries instead of mid-word.
 */

export const DEFAULT_RMS_THRESHOLD = 0.008;

/** Root-mean-square energy of a Float32 PCM buffer. */
export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples.length);
}

/** Returns true when frame RMS meets or exceeds the speech energy threshold. */
export function isSpeechFrame(samples: Float32Array, threshold = DEFAULT_RMS_THRESHOLD): boolean {
  return computeRms(samples) >= threshold;
}

/**
 * Checks whether an entire audio chunk contains enough voice activity to bother
 * running Whisper. At least `minSpeechFrames` 100 ms frames must exceed `threshold`.
 */
export function hasVoiceActivity(
  samples: Float32Array,
  sampleRate = 16000,
  threshold = DEFAULT_RMS_THRESHOLD,
  minSpeechRatio = 0.04,
): boolean {
  if (samples.length === 0) return false;
  const frameLen = Math.max(1, Math.floor(sampleRate * 0.1)); // 100 ms
  let totalFrames = 0;
  let speechFrames = 0;

  for (let offset = 0; offset < samples.length; offset += frameLen) {
    const end = Math.min(samples.length, offset + frameLen);
    const frame = samples.subarray(offset, end);
    totalFrames++;
    if (computeRms(frame) >= threshold) {
      speechFrames++;
    }
  }

  return speechFrames > 0 && speechFrames / totalFrames >= minSpeechRatio;
}

