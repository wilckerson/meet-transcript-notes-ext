/// <reference types="vitest/config" />
import { defineConfig, build as viteBuild, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RESAMPLER_WORKLET_SOURCE,
  WORKLET_BUNDLE_PATH,
} from './src/offscreen/resampler.worklet';

const root = resolve(__dirname, 'src');

/**
 * Emits manifest.json, the AudioWorklet script, the self-contained classic content script,
 * and the ONNX Runtime .wasm/.mjs files into the bundle.
 *
 * Why `meet.content.ts` is bundled as an IIFE:
 * Chrome MV3 executes `content_scripts` as classic scripts (not ES modules). If Rollup
 * code-splits shared imports into `assets/*.js`, Chrome throws
 * `Uncaught SyntaxError: Cannot use import statement outside a module` when injecting
 * `meet.content.js` into `https://meet.google.com/*`.
 */
function extensionAssets(): Plugin {
  const ortDir = resolve(__dirname, 'node_modules/onnxruntime-web/dist');
  const ortFiles = ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs'];
  return {
    name: 'extension-assets',
    async generateBundle() {
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

      // Bundle meet.content.ts as a single self-contained IIFE with zero `import` statements.
      const contentBundle = await viteBuild({
        configFile: false,
        logLevel: 'silent',
        build: {
          write: false,
          target: 'chrome116',
          lib: {
            entry: resolve(root, 'content/meet.content.ts'),
            name: 'MeetTranscriptContent',
            formats: ['iife'],
            fileName: () => 'meet.content.js',
          },
        },
      });
      const outputs = Array.isArray(contentBundle) ? contentBundle : [contentBundle];
      for (const out of outputs) {
        if ('output' in out) {
          for (const chunk of out.output) {
            if (chunk.type === 'chunk' && chunk.fileName === 'meet.content.js') {
              this.emitFile({
                type: 'asset',
                fileName: 'meet.content.js',
                source: chunk.code,
              });
            }
          }
        }
      }
    },
  };
}

/** Entries whose output file name must be stable because manifest.json references them. */
const FIXED_NAME_ENTRIES = new Set(['background']);

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
