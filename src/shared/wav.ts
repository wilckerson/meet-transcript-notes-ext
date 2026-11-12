/**
 * 16 kHz mono PCM16 WAV encoder and decoder.
 * Used for the setup benchmark sample (PLAN §14.5) and debug WAV export (PLAN §12 M1).
 */

export const TARGET_SAMPLE_RATE = 16000;

/** Encodes mono Float32 PCM [-1, 1] into a 16-bit PCM RIFF WAV ArrayBuffer. */
export function encodeWavPcm16(samples: Float32Array, sampleRate = TARGET_SAMPLE_RATE): ArrayBuffer {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataBytes = samples.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, int16, true);
    offset += 2;
  }
  return buf;
}

/**
 * Decodes a 16-bit PCM RIFF WAV file into mono Float32Array samples.
 * Handles arbitrary extra chunks (e.g. `FLLR` emitted by macOS `afconvert`).
 */
export function decodeWavPcm16(buf: ArrayBuffer): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(buf);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Invalid WAV header');
  }

  let offset = 12;
  let sampleRate = TARGET_SAMPLE_RATE;
  let numChannels = 1;
  let bitsPerSample = 16;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readAscii(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;

    if (chunkId === 'fmt ') {
      const audioFormat = view.getUint16(chunkDataOffset, true);
      if (audioFormat !== 1) {
        throw new Error(`Unsupported WAV audioFormat ${audioFormat} (expected PCM=1)`);
      }
      numChannels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
      if (bitsPerSample !== 16) {
        throw new Error(`Unsupported WAV bitsPerSample ${bitsPerSample} (expected 16)`);
      }
    } else if (chunkId === 'data') {
      const totalFrames = Math.floor(chunkSize / (numChannels * 2));
      const samples = new Float32Array(totalFrames);
      let p = chunkDataOffset;
      for (let i = 0; i < totalFrames; i++) {
        let sum = 0;
        for (let c = 0; c < numChannels; c++) {
          sum += view.getInt16(p, true) / 0x8000;
          p += 2;
        }
        samples[i] = sum / numChannels;
      }
      return { samples, sampleRate };
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  throw new Error('No data chunk found in WAV');
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function readAscii(view: DataView, offset: number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}

