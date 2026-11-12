/**
 * Builds src/shared/model-manifest.json from the Hugging Face Hub API (PLAN §14.1).
 *
 * For a pinned revision of onnx-community/whisper-large-v3-turbo it records the
 * path, size and SHA-256 of every file the extension may load:
 *  - LFS files: SHA-256 taken from the `lfs.oid` field returned by the Hub.
 *  - Small (non-LFS) files: downloaded and hashed locally, because the Hub only
 *    reports a git blob SHA-1 for those.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-model-manifest.ts [revision]
 * Without a revision, the current `main` commit is resolved and pinned.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = 'onnx-community/whisper-large-v3-turbo';
const HUB = 'https://huggingface.co';

/** Config/tokenizer files loaded by the Transformers.js Whisper pipeline. */
const CONFIG_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
];

/**
 * ONNX files per quantization preset. Keep in sync with QUANT_PRESETS in
 * src/shared/types.ts.
 */
const ONNX_FILES = [
  'onnx/encoder_model_fp16.onnx',
  'onnx/encoder_model.onnx',
  'onnx/encoder_model.onnx_data',
  'onnx/encoder_model_q4.onnx',
  'onnx/decoder_model_merged_q4.onnx',
];

interface TreeEntry {
  type: string;
  path: string;
  size: number;
  oid: string;
  lfs?: { oid: string; size: number };
}

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  let revision = process.argv[2];
  if (!revision) {
    const info = await json<{ sha: string }>(`${HUB}/api/models/${REPO}`);
    revision = info.sha;
  }
  console.log(`Pinning ${REPO} @ ${revision}`);

  const tree = [
    ...(await json<TreeEntry[]>(`${HUB}/api/models/${REPO}/tree/${revision}`)),
    ...(await json<TreeEntry[]>(`${HUB}/api/models/${REPO}/tree/${revision}/onnx`)),
  ];
  const byPath = new Map(tree.map((e) => [e.path, e]));

  const files: Record<string, { size: number; sha256: string }> = {};
  for (const file of [...CONFIG_FILES, ...ONNX_FILES]) {
    const entry = byPath.get(file);
    if (!entry) throw new Error(`File not found in repo tree: ${file}`);
    if (entry.lfs) {
      files[file] = { size: entry.lfs.size, sha256: entry.lfs.oid };
    } else {
      const res = await fetch(`${HUB}/${REPO}/resolve/${revision}/${file}`);
      if (!res.ok) throw new Error(`${res.status} downloading ${file}`);
      const buf = Buffer.from(await res.arrayBuffer());
      files[file] = { size: buf.byteLength, sha256: createHash('sha256').update(buf).digest('hex') };
    }
    console.log(`  ${file}  ${files[file].size}  ${files[file].sha256}`);
  }

  const manifest = { repo: REPO, revision, generatedAt: new Date().toISOString(), files };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = path.resolve(here, '../src/shared/model-manifest.json');
  await writeFile(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

