/**
 * Hardware and storage capability checks for setup (PLAN §14.5).
 */
import type { Device, QuantPreset, ResourceCheck } from './types';

export interface CapabilityReport {
  hasWebGPU: boolean;
  hasShaderF16: boolean;
  recommendedDevice: Device;
  recommendedPreset: QuantPreset;
  checks: ResourceCheck[];
  /** One-line summary saved to ModelInfo and shown in the popup if warnings exist. */
  summary?: string;
}

const MIN_MAX_BUFFER_SIZE = 256 * 1024 * 1024; // 256 MB
const MIN_FREE_STORAGE_BYTES = 2 * 1024 * 1024 * 1024; // ~2 GB

export async function runResourceChecks(benchmarkRtf?: number): Promise<CapabilityReport> {
  const checks: ResourceCheck[] = [];
  let hasWebGPU = false;
  let hasShaderF16 = false;

  // 1. WebGPU & shader-f16 & buffer limits
  if (typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        hasWebGPU = true;
        hasShaderF16 = adapter.features.has('shader-f16');
        checks.push({
          id: 'webgpu',
          label: 'WebGPU acceleration',
          level: 'ok',
          detail: 'WebGPU adapter available for local GPU inference.',
        });

        if (hasShaderF16) {
          checks.push({
            id: 'f16',
            label: 'Half-precision (shader-f16)',
            level: 'ok',
            detail: 'Supports fast fp16 encoder weights (~1.6 GB total).',
          });
        } else {
          checks.push({
            id: 'f16',
            label: 'Half-precision (shader-f16)',
            level: 'warn',
            detail:
              'Missing shader-f16 support. Use the Compact (q4) or Full-precision (fp32) preset; inference may be slower.',
          });
        }

        const maxBuf = adapter.limits.maxBufferSize ?? 0;
        const maxStorage = adapter.limits.maxStorageBufferBindingSize ?? 0;
        if (maxBuf < MIN_MAX_BUFFER_SIZE || maxStorage < MIN_MAX_BUFFER_SIZE / 2) {
          checks.push({
            id: 'gpu-limits',
            label: 'GPU buffer limits',
            level: 'warn',
            detail: `Max buffer size (${formatBytes(maxBuf)}) is low for large-v3-turbo tensors.`,
          });
        } else {
          checks.push({
            id: 'gpu-limits',
            label: 'GPU buffer limits',
            level: 'ok',
            detail: `Max buffer ${formatBytes(maxBuf)}, storage binding ${formatBytes(maxStorage)}.`,
          });
        }
      } else {
        checks.push({
          id: 'webgpu',
          label: 'WebGPU acceleration',
          level: 'fail',
          detail:
            'No WebGPU adapter found. Transcription will fall back to WASM (CPU) and will fall far behind live audio.',
        });
      }
    } catch (err) {
      checks.push({
        id: 'webgpu',
        label: 'WebGPU acceleration',
        level: 'fail',
        detail: `WebGPU check failed (${String(err)}). Falling back to WASM.`,
      });
    }
  } else {
    checks.push({
      id: 'webgpu',
      label: 'WebGPU acceleration',
      level: 'fail',
      detail:
        'WebGPU is not available in this browser. Live transcription on WASM will fall far behind real time.',
    });
  }

  // 2. System RAM (navigator.deviceMemory is capped at 8 by Chrome)
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof deviceMemory === 'number') {
    if (deviceMemory < 8) {
      checks.push({
        id: 'ram',
        label: 'System memory (RAM)',
        level: 'warn',
        detail: `Reported ~${deviceMemory} GB RAM (< 8 GB). Running Whisper alongside Google Meet may cause swapping.`,
      });
    } else {
      checks.push({
        id: 'ram',
        label: 'System memory (RAM)',
        level: 'ok',
        detail: `${deviceMemory}+ GB RAM reported.`,
      });
    }
  }

  // 3. Free disk space
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      const quota = est.quota ?? 0;
      const usage = est.usage ?? 0;
      const free = Math.max(0, quota - usage);
      if (quota > 0 && free < MIN_FREE_STORAGE_BYTES) {
        checks.push({
          id: 'storage',
          label: 'Available storage',
          level: 'warn',
          detail: `Only ${formatBytes(free)} available (< 2 GB recommended for model weights and session cache).`,
        });
      } else {
        checks.push({
          id: 'storage',
          label: 'Available storage',
          level: 'ok',
          detail: `${formatBytes(free)} free (${formatBytes(usage)} used).`,
        });
      }
    } catch {
      // ignore estimate failures
    }
  }

  // 4. Real-time benchmark (if measured)
  if (typeof benchmarkRtf === 'number') {
    if (benchmarkRtf > 0.8) {
      checks.push({
        id: 'benchmark',
        label: 'Real-time benchmark',
        level: 'warn',
        detail: `Real-time factor ${benchmarkRtf.toFixed(2)}x (> 0.8x threshold). Live meetings are likely to lag behind audio.`,
      });
    } else {
      checks.push({
        id: 'benchmark',
        label: 'Real-time benchmark',
        level: 'ok',
        detail: `Real-time factor ${benchmarkRtf.toFixed(2)}x (${(1 / Math.max(benchmarkRtf, 0.01)).toFixed(1)}x faster than real time).`,
      });
    }
  }

  const recommendedDevice: Device = hasWebGPU ? 'webgpu' : 'wasm';
  const recommendedPreset: QuantPreset = hasWebGPU
    ? hasShaderF16
      ? 'balanced'
      : 'compact'
    : 'compact';

  let summary: string | undefined;
  if (!hasWebGPU) {
    summary = 'WebGPU unavailable — running on CPU (WASM); live transcription will lag behind.';
  } else if (typeof benchmarkRtf === 'number' && benchmarkRtf > 0.8) {
    summary = `This machine may struggle with live transcription (RTF ${benchmarkRtf.toFixed(2)}x).`;
  } else if (checks.some((c) => c.level === 'warn' || c.level === 'fail')) {
    summary = 'Hardware warnings detected during setup — check Settings if transcription lags.';
  }

  return {
    hasWebGPU,
    hasShaderF16,
    recommendedDevice,
    recommendedPreset,
    checks,
    summary,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i >= 2 ? 2 : 0)} ${units[i]}`;
}

