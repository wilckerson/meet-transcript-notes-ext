/**
 * Model file integrity verification (PLAN §14.1).
 *
 * Uses streaming SHA-256 (`hash-wasm`) so ~1 GB model files in Cache Storage are
 * hashed in chunks without loading the entire buffer into memory.
 */
import { createSHA256 } from 'hash-wasm';
import { MODEL_CACHE_NAME, presetFiles } from './model';
import type { QuantPreset } from './types';

export interface FileVerificationResult {
  file: string;
  url: string;
  ok: boolean;
  reason?: 'missing' | 'size-mismatch' | 'hash-mismatch' | 'read-error';
  expectedSize: number;
  actualSize?: number;
  expectedSha256: string;
  actualSha256?: string;
}

export interface PresetVerificationResult {
  preset: QuantPreset;
  ok: boolean;
  files: FileVerificationResult[];
}

export type VerifyProgressCallback = (info: {
  file: string;
  fileIndex: number;
  fileCount: number;
  bytesHashed: number;
  totalBytes: number;
}) => void;

/** Computes the lowercase hex SHA-256 and byte length of a ReadableStream or Uint8Array. */
export async function sha256Stream(
  input: ReadableStream<Uint8Array> | Uint8Array,
  onChunk?: (chunkBytes: number) => void,
): Promise<{ sha256: string; size: number }> {
  const hasher = await createSHA256();
  hasher.init();
  let size = 0;

  if (input instanceof Uint8Array) {
    hasher.update(input);
    size = input.byteLength;
    onChunk?.(input.byteLength);
  } else {
    const reader = input.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          hasher.update(value);
          size += value.byteLength;
          onChunk?.(value.byteLength);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  return { sha256: hasher.digest('hex'), size };
}

/**
 * Cheap size-only check run before each model load (PLAN §14.1).
 * Falls back to reading the response body length if Content-Length isn't present.
 */
export async function verifyPresetSizes(
  preset: QuantPreset,
  cacheStorage: CacheStorage = caches,
): Promise<PresetVerificationResult> {
  const cache = await cacheStorage.open(MODEL_CACHE_NAME);
  const files = presetFiles(preset);
  const results: FileVerificationResult[] = [];

  for (const { file, url, entry } of files) {
    const res = await cache.match(url);
    if (!res) {
      results.push({
        file,
        url,
        ok: false,
        reason: 'missing',
        expectedSize: entry.size,
        expectedSha256: entry.sha256,
      });
      continue;
    }

    let actualSize: number | undefined;
    const headerLen = res.headers.get('content-length');
    if (headerLen && /^\d+$/.test(headerLen)) {
      actualSize = Number(headerLen);
    } else if (res.body) {
      const reader = res.body.getReader();
      let count = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) count += value.byteLength;
      }
      reader.releaseLock();
      actualSize = count;
    }

    if (actualSize !== entry.size) {
      await cache.delete(url);
      results.push({
        file,
        url,
        ok: false,
        reason: 'size-mismatch',
        expectedSize: entry.size,
        actualSize,
        expectedSha256: entry.sha256,
      });
    } else {
      results.push({
        file,
        url,
        ok: true,
        expectedSize: entry.size,
        actualSize,
        expectedSha256: entry.sha256,
      });
    }
  }

  return {
    preset,
    ok: results.every((r) => r.ok),
    files: results,
  };
}

/**
 * Full streaming SHA-256 verification of all cached files for `preset` (PLAN §14.1).
 * Automatically deletes any mismatched file from Cache Storage so Retry re-downloads it cleanly.
 */
export async function verifyPresetIntegrity(
  preset: QuantPreset,
  onProgress?: VerifyProgressCallback,
  cacheStorage: CacheStorage = caches,
): Promise<PresetVerificationResult> {
  const cache = await cacheStorage.open(MODEL_CACHE_NAME);
  const files = presetFiles(preset);
  const totalBytes = files.reduce((acc, f) => acc + f.entry.size, 0);
  let bytesHashed = 0;
  const results: FileVerificationResult[] = [];

  for (let i = 0; i < files.length; i++) {
    const { file, url, entry } = files[i];
    const res = await cache.match(url);
    if (!res || !res.body) {
      results.push({
        file,
        url,
        ok: false,
        reason: 'missing',
        expectedSize: entry.size,
        expectedSha256: entry.sha256,
      });
      continue;
    }

    try {
      const { sha256, size } = await sha256Stream(res.body, (chunkBytes) => {
        bytesHashed += chunkBytes;
        onProgress?.({
          file,
          fileIndex: i,
          fileCount: files.length,
          bytesHashed,
          totalBytes,
        });
      });

      if (size !== entry.size) {
        await cache.delete(url);
        results.push({
          file,
          url,
          ok: false,
          reason: 'size-mismatch',
          expectedSize: entry.size,
          actualSize: size,
          expectedSha256: entry.sha256,
          actualSha256: sha256,
        });
      } else if (sha256 !== entry.sha256) {
        await cache.delete(url);
        results.push({
          file,
          url,
          ok: false,
          reason: 'hash-mismatch',
          expectedSize: entry.size,
          actualSize: size,
          expectedSha256: entry.sha256,
          actualSha256: sha256,
        });
      } else {
        results.push({
          file,
          url,
          ok: true,
          expectedSize: entry.size,
          actualSize: size,
          expectedSha256: entry.sha256,
          actualSha256: sha256,
        });
      }
    } catch {
      await cache.delete(url);
      results.push({
        file,
        url,
        ok: false,
        reason: 'read-error',
        expectedSize: entry.size,
        expectedSha256: entry.sha256,
      });
    }
  }

  return {
    preset,
    ok: results.every((r) => r.ok),
    files: results,
  };
}

/** Deletes all cached model files from Cache Storage. */
export async function deleteModelCache(cacheStorage: CacheStorage = caches): Promise<void> {
  await cacheStorage.delete(MODEL_CACHE_NAME);
}

