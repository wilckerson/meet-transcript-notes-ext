/**
 * Lifecycle manager for the singleton Chrome MV3 Offscreen Document (PLAN §3.1, §3.2, §14.4).
 */
import { sendSafe } from '../shared/messages';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

let creatingPromise: Promise<void> | null = null;

export async function hasOffscreenDocument(): Promise<boolean> {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  if ('getContexts' in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [offscreenUrl],
    });
    return contexts.length > 0;
  }
  return false;
}

export async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;

  if (creatingPromise) {
    await creatingPromise;
    return;
  }

  creatingPromise = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [
        chrome.offscreen.Reason.USER_MEDIA,
        chrome.offscreen.Reason.WORKERS,
        chrome.offscreen.Reason.AUDIO_PLAYBACK,
      ],
      justification:
        'Capture Google Meet tab audio + microphone, route tab audio to speakers, and run local Whisper transcription in a Web Worker.',
    })
    .finally(() => {
      creatingPromise = null;
    });

  await creatingPromise;
}

/**
 * Releases worker/GPU buffers in the offscreen document and then closes the document
 * so GPU memory and RAM return to baseline after "Stop and save" (PLAN §14.4).
 */
export async function releaseAndCloseOffscreenDocument(): Promise<void> {
  if (!(await hasOffscreenDocument())) return;

  try {
    await sendSafe({ target: 'offscreen', type: 'RELEASE' });
  } catch {
    // ignore
  }

  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // ignore if already closed
  }
}

