# Privacy Policy — Meet Transcript Notes

**Effective date:** November 11, 2026

## 1. 100% On-Device Processing

Meet Transcript Notes processes all audio and transcripts **locally inside your browser** using WebGPU / WebAssembly and the open-source `openai/whisper-large-v3-turbo` model (`onnx-community/whisper-large-v3-turbo`, MIT License).

- **No audio leaves your device.** Neither the Google Meet tab audio nor your microphone stream is uploaded, streamed, or sent to any external server.
- **No transcripts leave your device.** Transcripts are held locally in browser IndexedDB while a call is active and exported directly to your computer as a Markdown (`.md`) file when you click **Stop and save**.
- **No analytics, telemetry, or tracking.** The extension contains no analytics SDKs, crash reporters, or remote logging.

## 2. Network Requests

The only network requests made by the extension are to **Hugging Face** (`https://huggingface.co` and its CDN domains `*.huggingface.co`, `*.hf.co`) during the **one-time model download** on the Setup page.

- Model files are pinned to a specific commit revision and verified against bundled SHA-256 checksums (`src/shared/model-manifest.json`).
- Once cached in browser Cache Storage, the extension sets `env.allowRemoteModels = false` during meetings so transcription runs completely offline.

## 3. Permissions Used

| Permission | Why it is required |
|---|---|
| `tabCapture` | Captures audio from the active Google Meet tab when you press **Start transcription**. |
| `offscreen` | Hosts the `MediaStream`, Web Audio mixer, and Whisper Web Worker in a Chrome MV3 offscreen document. |
| `storage` & `unlimitedStorage` | Stores user preferences, model verification metadata, the ~1 GB cached Whisper weights, and local IndexedDB crash-recovery segments. |
| `downloads` | Saves the final `.md` transcript file to your machine when you click **Stop and save**. |
| Microphone (`getUserMedia`) | Captures your own voice alongside remote Meet participants so both sides of the conversation appear in the transcript. |

## 4. Participant Consent

Always inform meeting participants before recording or transcribing a call, in accordance with applicable laws and your organization's policies.

