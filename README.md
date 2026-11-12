# Meet Transcript Notes

A Chrome Manifest V3 extension that transcribes Google Meet calls **100% locally** in the browser using [`onnx-community/whisper-large-v3-turbo`](https://huggingface.co/onnx-community/whisper-large-v3-turbo) over WebGPU (with WASM fallback). No audio or text ever leaves your device.

## Features

- **100% Local & Verified**: Downloads Whisper weights once during setup, verifies SHA-256 checksums, and runs completely offline during calls.
- **Dual-Source Audio (Meet + Mic)**: Captures both remote participants and your microphone at 16 kHz mono while routing Meet audio back to your speakers.
- **Speaker Identification (`You` / Name / `Remote`)**:
  - Separates **You** vs. remote audio using dual-channel RMS energy.
  - Detects remote participant names from the Google Meet DOM (with a live **`Names detected`** badge in the popup and automatic fallback to **`Remote`**).
- **99 Languages + Auto-Detect**: Searchable language selector with favorites, recents, and mid-call switching.
- **Resilient & Lightweight**: Pause-aware VAD chunking, IndexedDB crash recovery, automatic WebGPU device-lost recovery, and full GPU/RAM release after **Stop and save (.md)**.

## Quick Start

```bash
npm install
npm run build
```

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `dist/`.
2. On the **Setup** page, click **Download model** and **Grant microphone access**.
3. Open a Google Meet call, click the extension icon, and press **Start transcription**.

## Privacy

See [PRIVACY.md](./PRIVACY.md).
