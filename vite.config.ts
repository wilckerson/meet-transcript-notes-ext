/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RESAMPLER_WORKLET_SOURCE,
  WORKLET_BUNDLE_PATH,
} from './src/offscreen/resampler.worklet';

const root = resolve(__dirname, 'src');

/**
 * Emits manifest.json, the AudioWorklet script, and the ONNX Runtime .wasm/.mjs files into the bundle.
 * The ORT and worklet files are bundled as `'self'` extension assets because MV3's CSP
 * (`script-src 'self' 'wasm-unsafe-eval'`) forbids remotely hosted code and `blob:` script URLs.
 */
function extensionAssets(): Plugin {
  const ortDir = resolve(__dirname, 'node_modules/onnxruntime-web/dist');
  const ortFiles = ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs'];
  return {
    name: 'extension-assets',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: readFileSync(resolve(root, 'manifest.json'), 'utf8'),
      });
      this.emitFile({
        type: 'asset',
        fileName: WORKLET_BUNDLE_PATH,
        source: RESAMPLER_WORKLET_SOURCE.trimStart(),
      });
      for (const f of ortFiles) {
        this.emitFile({ type: 'asset', fileName: `ort/${f}`, source: readFileSync(resolve(ortDir, f)) });
      }
    },
  };
}

/** Entries whose output file name must be stable because manifest.json references them. */
const FIXED_NAME_ENTRIES = new Set(['background', 'meet.content']);

export default defineConfig(({ mode }) => ({
  root,
  publicDir: resolve(__dirname, 'public'),
  base: '',
  plugins: [extensionAssets()],
  resolve: {
    alias: {
      // Map onnxruntime-web to its extern-wasm build so the 21 MB .wasm isn't duplicated
      // inside `assets/` when we already emit it under `ort/`.
      'onnxruntime-web': resolve(
        __dirname,
        'node_modules/onnxruntime-web/dist/ort.min.mjs',
      ),
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: mode === 'development',
    minify: mode !== 'development',
    modulePreload: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        popup: resolve(root, 'popup/popup.html'),
        options: resolve(root, 'options/options.html'),
        offscreen: resolve(root, 'offscreen/offscreen.html'),
        background: resolve(root, 'background/index.ts'),
        'meet.content': resolve(root, 'content/meet.content.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          FIXED_NAME_ENTRIES.has(chunk.name) ? '[name].js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  worker: {
    format: 'es',
  },
  test: {
    root: __dirname,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
}));
