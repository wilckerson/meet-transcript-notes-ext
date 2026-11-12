/** Model identity, pinned revision and quantization presets (PLAN §2, §4, §14.1). */
import manifest from './model-manifest.json';
import type { QuantPreset } from './types';

export const MODEL_ID = manifest.repo;
export const MODEL_REVISION = manifest.revision;
export const MODEL_DISPLAY_NAME = 'whisper-large-v3-turbo';

/** Cache Storage bucket used by Transformers.js (hard-coded there). */
export const MODEL_CACHE_NAME = 'transformers-cache';

export const HF_HOST = 'https://huggingface.co/';

export interface FileEntry {
  size: number;
  sha256: string;
}

export const MODEL_FILES: Record<string, FileEntry> = manifest.files;

const CONFIG_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
];

export interface QuantPresetDef {
  label: string;
  description: string;
  dtype: { encoder_model: string; decoder_model_merged: string };
  /** Requires the WebGPU `shader-f16` feature. */
  needsF16: boolean;
  files: string[];
}

export const QUANT_PRESETS: Record<QuantPreset, QuantPresetDef> = {
  balanced: {
    label: 'Balanced (recommended)',
    description: 'Encoder fp16, decoder q4. Needs WebGPU with shader-f16.',
    dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' },
    needsF16: true,
    files: [...CONFIG_FILES, 'onnx/encoder_model_fp16.onnx', 'onnx/decoder_model_merged_q4.onnx'],
  },
  fp32: {
    label: 'Full precision encoder',
    description: 'Encoder fp32, decoder q4. For GPUs without shader-f16. Bigger and slower.',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    needsF16: false,
    files: [
      ...CONFIG_FILES,
      'onnx/encoder_model.onnx',
      'onnx/encoder_model.onnx_data',
      'onnx/decoder_model_merged_q4.onnx',
    ],
  },
  compact: {
    label: 'Compact',
    description: 'Encoder q4, decoder q4. Smallest download, slightly lower accuracy.',
    dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' },
    needsF16: false,
    files: [...CONFIG_FILES, 'onnx/encoder_model_q4.onnx', 'onnx/decoder_model_merged_q4.onnx'],
  },
};

/**
 * URL of a model file at the pinned revision. This is also the Cache Storage key
 * Transformers.js uses (`remoteHost + remotePathTemplate + filename`).
 */
export function modelFileUrl(file: string, revision = MODEL_REVISION): string {
  return `${HF_HOST}${MODEL_ID}/resolve/${encodeURIComponent(revision)}/${file}`;
}

export function presetFiles(preset: QuantPreset): { file: string; url: string; entry: FileEntry }[] {
  return QUANT_PRESETS[preset].files.map((file) => {
    const entry = MODEL_FILES[file];
    if (!entry) throw new Error(`Model manifest is missing ${file}`);
    return { file, url: modelFileUrl(file), entry };
  });
}

export function presetSize(preset: QuantPreset): number {
  return presetFiles(preset).reduce((sum, f) => sum + f.entry.size, 0);
}

