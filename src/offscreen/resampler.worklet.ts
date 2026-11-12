/**
 * AudioWorklet processor that accepts 2 inputs:
 *  - Input 0: Google Meet tab stream (remote participants)
 *  - Input 1: User's microphone stream (You)
 *
 * For every 100 ms (1600-sample @ 16 kHz) frame, it:
 *  1. Downmixes each input to mono, resamples from the AudioContext rate (typically 48 kHz)
 *     to 16 kHz, and sums both into the mono PCM buffer sent to Whisper.
 *  2. Computes the separate RMS energy of Input 0 (`tabRms`) and Input 1 (`micRms`) over
 *     that 100 ms window for Tier 1 speaker attribution ("You" vs. "Remote").
 *
 * Emitted as a real `chrome-extension://<id>/resampler.worklet.js` asset in the bundle
 * because MV3's default `script-src 'self' 'wasm-unsafe-eval'` CSP blocks `blob:` URLs
 * in `audioWorklet.addModule()`.
 */

export const WORKLET_PROCESSOR_NAME = 'pcm-16k-resampler';
export const WORKLET_BUNDLE_PATH = 'resampler.worklet.js';

export interface ResamplerFrameMessage {
  pcm: Float32Array;
  tabRms: number;
  micRms: number;
}

/** Self-contained worklet source run inside AudioWorkletGlobalScope. */
export const RESAMPLER_WORKLET_SOURCE = `
class Pcm16kResamplerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetSampleRate || 16000;
    this.frameSamples = opts.frameSamples || 1600; // 100 ms @ 16 kHz
    this.outBuffer = new Float32Array(this.frameSamples);
    this.outFill = 0;
    this.tabSqSum = 0;
    this.micSqSum = 0;
    this.ratio = sampleRate / this.targetRate;
    this.srcPos = 0;
  }

  downmixInput(input, len) {
    const out = new Float32Array(len);
    if (!input || input.length === 0 || !input[0]) return out;
    const numChannels = input.length;
    for (let c = 0; c < numChannels; c++) {
      const ch = input[c];
      if (!ch) continue;
      for (let i = 0; i < len; i++) {
        out[i] += ch[i];
      }
    }
    if (numChannels > 1) {
      const inv = 1 / numChannels;
      for (let i = 0; i < len; i++) out[i] *= inv;
    }
    return out;
  }

  process(inputs) {
    const tabIn = inputs[0];
    const micIn = inputs[1];
    const inLen =
      (tabIn && tabIn[0] && tabIn[0].length) ||
      (micIn && micIn[0] && micIn[0].length) ||
      0;
    if (inLen === 0) return true;

    const tabMono = this.downmixInput(tabIn, inLen);
    const micMono = this.downmixInput(micIn, inLen);

    // Linear interpolation resample from sampleRate -> targetRate
    while (this.srcPos < inLen) {
      const i0 = Math.floor(this.srcPos);
      const i1 = Math.min(inLen - 1, i0 + 1);
      const frac = this.srcPos - i0;

      const tabSample = tabMono[i0] + (tabMono[i1] - tabMono[i0]) * frac;
      const micSample = micMono[i0] + (micMono[i1] - micMono[i0]) * frac;
      const mixed = Math.max(-1, Math.min(1, tabSample + micSample));

      this.outBuffer[this.outFill++] = mixed;
      this.tabSqSum += tabSample * tabSample;
      this.micSqSum += micSample * micSample;

      if (this.outFill >= this.frameSamples) {
        const pcm = this.outBuffer.slice(0);
        const tabRms = Math.sqrt(this.tabSqSum / this.frameSamples);
        const micRms = Math.sqrt(this.micSqSum / this.frameSamples);
        this.port.postMessage({ pcm, tabRms, micRms }, [pcm.buffer]);
        this.outFill = 0;
        this.tabSqSum = 0;
        this.micSqSum = 0;
      }
      this.srcPos += this.ratio;
    }
    this.srcPos -= inLen;
    return true;
  }
}

registerProcessor('${WORKLET_PROCESSOR_NAME}', Pcm16kResamplerProcessor);
`;

export function getResamplerWorkletUrl(): string {
  return chrome.runtime.getURL(WORKLET_BUNDLE_PATH);
}



