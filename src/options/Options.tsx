/**
 * Setup & Options Page (PLAN §3.5, §4, §8, §14.1, §14.5).
 *
 * Responsibilities:
 *  - Runs hardware/storage capability checks (WebGPU, shader-f16, buffer limits, RAM, disk quota).
 *  - Downloads `onnx-community/whisper-large-v3-turbo` at the pinned revision from Hugging Face
 *    with progress and resume-from-cache on Retry.
 *  - Verifies every cached model file's size and streaming SHA-256 against `model-manifest.json`
 *    before marking the model Ready (§14.1).
 *  - Runs warm-up + 10 s speech benchmark (`public/bench/sample.wav`) to measure real-time factor (§14.5).
 *  - Requests persistent microphone access (`getUserMedia`) from a visible page (§8).
 *  - Configures default language, quantization preset, filename template, and timestamp style.
 *  - Provides "Verify model", "Re-download", and "Delete model" actions.
 */
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { LanguageSelect } from '../shared/LanguageSelect';
import {
  deleteModelCache,
  verifyPresetIntegrity,
  type PresetVerificationResult,
} from '../shared/integrity';
import {
  MODEL_DISPLAY_NAME,
  MODEL_ID,
  MODEL_REVISION,
  QUANT_PRESETS,
  presetSize,
} from '../shared/model';
import { formatBytes, runResourceChecks, type CapabilityReport } from '../shared/resources';
import { getModelInfo, getSettings, setModelInfo, updateSettings } from '../shared/storage';
import { decodeWavPcm16 } from '../shared/wav';
import type {
  CheckLevel,
  ModelInfo,
  QuantPreset,
  Settings,
  TimestampStyle,
} from '../shared/types';
import type { WorkerInboundMessage, WorkerOutboundMessage } from '../worker/whisper.worker';

type DownloadPhase =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'benchmarking'
  | 'ready'
  | 'error';

function levelIcon(level: CheckLevel): string {
  if (level === 'ok') return '✅';
  if (level === 'warn') return '⚠️';
  return '❌';
}

function OptionsApp() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [modelInfo, setModelState] = useState<ModelInfo | undefined>(undefined);
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [micGranted, setMicGranted] = useState<boolean>(false);
  const [micError, setMicError] = useState<string | undefined>(undefined);

  const [dlPhase, setDlPhase] = useState<DownloadPhase>('idle');
  const [dlProgress, setDlProgress] = useState<number>(0);
  const [dlDetail, setDlDetail] = useState<string>('');
  const [dlError, setDlError] = useState<string | undefined>(undefined);
  const [verifyReport, setVerifyReport] = useState<PresetVerificationResult | null>(null);

  useEffect(() => {
    void (async () => {
      const [s, m] = await Promise.all([getSettings(), getModelInfo()]);
      const cap = await runResourceChecks(m?.benchmarkRtf);
      setSettings(s);
      setModelState(m);
      setReport(cap);
      if (m?.verifiedAt) {
        setDlPhase('ready');
      }

      // If browser lacks shader-f16 and user still has default 'balanced', switch to recommended preset.
      if (!m?.verifiedAt && !cap.hasShaderF16 && s.quantPreset === 'balanced') {
        const updated = await updateSettings({ quantPreset: cap.recommendedPreset });
        setSettings(updated);
      }

      try {
        const perm = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        setMicGranted(perm.state === 'granted');
        perm.onchange = () => setMicGranted(perm.state === 'granted');
      } catch {
        setMicGranted(false);
      }
    })();
  }, []);

  const requestMicrophone = async () => {
    setMicError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      for (const t of stream.getTracks()) t.stop();
      setMicGranted(true);
    } catch (err) {
      setMicGranted(false);
      setMicError(
        `Microphone access was denied (${String((err as Error)?.message ?? err)}). Allow microphone access in Chrome site settings for this extension.`,
      );
    }
  };

  const loadBenchmarkSample = async (): Promise<Float32Array | undefined> => {
    try {
      const url = chrome.runtime.getURL('bench/sample.wav');
      const res = await fetch(url);
      if (!res.ok) return undefined;
      const buf = await res.arrayBuffer();
      return decodeWavPcm16(buf).samples;
    } catch {
      return undefined;
    }
  };

  const handleDownloadAndSetup = async () => {
    if (!settings) return;
    const preset = settings.quantPreset;
    const cap = report ?? (await runResourceChecks());

    setDlPhase('downloading');
    setDlProgress(0);
    setDlError(undefined);
    setVerifyReport(null);
    setDlDetail('Connecting to Hugging Face CDN…');

    const benchSample = await loadBenchmarkSample();

    const worker = new Worker(new URL('../worker/whisper.worker.ts', import.meta.url), {
      type: 'module',
    });

    try {
      const { benchmarkRtf, device } = await new Promise<{
        benchmarkRtf?: number;
        device: 'webgpu' | 'wasm';
      }>((resolve, reject) => {
        worker.onmessage = (evt: MessageEvent<WorkerOutboundMessage>) => {
          const msg = evt.data;
          if (msg.type === 'PROGRESS') {
            setDlProgress(msg.progress);
            setDlDetail(
              `Downloading ${msg.file || 'model files'} — ${formatBytes(msg.loadedBytes)} / ${formatBytes(msg.totalBytes)}`,
            );
          } else if (msg.type === 'READY') {
            resolve({ benchmarkRtf: msg.benchmarkRtf, device: msg.device });
          } else if (msg.type === 'ERROR') {
            reject(new Error(msg.error));
          }
        };
        worker.onerror = (err) => reject(new Error(err.message || 'Worker failed during setup'));

        const initMsg: WorkerInboundMessage = {
          type: 'INIT',
          preset,
          device: cap.recommendedDevice,
          allowRemote: true,
          benchmarkAudio: benchSample,
        };
        worker.postMessage(initMsg);
      });

      // Dispose worker immediately so GPU memory isn't held idle (PLAN §14.4).
      worker.postMessage({ type: 'DISPOSE' } satisfies WorkerInboundMessage);
      setTimeout(() => worker.terminate(), 500);

      // Step 2: Streaming SHA-256 verification against pinned manifest (PLAN §14.1).
      setDlPhase('verifying');
      setDlProgress(0);
      setDlDetail('Verifying SHA-256 checksums of cached model files…');

      const verification = await verifyPresetIntegrity(preset, (p) => {
        const ratio = p.totalBytes > 0 ? p.bytesHashed / p.totalBytes : 0;
        setDlProgress(ratio);
        setDlDetail(
          `Verifying ${p.file} (${p.fileIndex + 1}/${p.fileCount}) — ${Math.round(ratio * 100)}%`,
        );
      });
      setVerifyReport(verification);

      if (!verification.ok) {
        const bad = verification.files.find((f) => !f.ok);
        await setModelInfo(undefined);
        setModelState(undefined);
        setDlPhase('error');
        setDlError(
          `Model file failed verification (${bad?.file}: ${bad?.reason}). The corrupted file was deleted from cache — click Retry to re-download it.`,
        );
        return;
      }

      const updatedCap = await runResourceChecks(benchmarkRtf);
      setReport(updatedCap);

      const info: ModelInfo = {
        modelId: MODEL_ID,
        revision: MODEL_REVISION,
        preset,
        downloadedAt: Date.now(),
        verifiedAt: Date.now(),
        benchmarkRtf,
        benchmarkDevice: device,
        resourceSummary: updatedCap.summary,
      };
      await setModelInfo(info);
      setModelState(info);
      setDlPhase('ready');
      setDlDetail('Model downloaded, verified (SHA-256), and warmed up.');
    } catch (err) {
      worker.terminate();
      setDlPhase('error');
      setDlError(
        `Model download failed: ${String((err as Error)?.message ?? err)}. Cached files are preserved — click Retry to resume.`,
      );
    }
  };

  const handleVerifyOnly = async () => {
    if (!settings) return;
    const preset = modelInfo?.preset ?? settings.quantPreset;
    setDlPhase('verifying');
    setDlProgress(0);
    setDlError(undefined);

    const verification = await verifyPresetIntegrity(preset, (p) => {
      const ratio = p.totalBytes > 0 ? p.bytesHashed / p.totalBytes : 0;
      setDlProgress(ratio);
      setDlDetail(`Verifying ${p.file} — ${Math.round(ratio * 100)}%`);
    });
    setVerifyReport(verification);

    if (!verification.ok) {
      const bad = verification.files.find((f) => !f.ok);
      await setModelInfo(undefined);
      setModelState(undefined);
      setDlPhase('error');
      setDlError(
        `Model file failed verification (${bad?.file}: ${bad?.reason}). The bad file was removed from Cache Storage. Click Retry to download it again.`,
      );
      return;
    }

    if (modelInfo) {
      const updated: ModelInfo = { ...modelInfo, verifiedAt: Date.now() };
      await setModelInfo(updated);
      setModelState(updated);
    }
    setDlPhase('ready');
    setDlDetail('All cached model files passed SHA-256 verification.');
  };

  const handleDeleteModel = async () => {
    await deleteModelCache();
    await setModelInfo(undefined);
    setModelState(undefined);
    setVerifyReport(null);
    setDlPhase('idle');
    setDlDetail('');
  };

  const handlePresetChange = async (preset: QuantPreset) => {
    if (!settings) return;
    const next = await updateSettings({ quantPreset: preset });
    setSettings(next);
  };

  const preset = settings?.quantPreset ?? 'balanced';
  const totalPresetBytes = presetSize(preset);
  const setupComplete = Boolean(modelInfo?.verifiedAt && micGranted);

  return (
    <div>
      <header class="page-header">
        <h1 class="page-title">Meet Transcript Notes — Setup &amp; Settings</h1>
        <p class="page-subtitle">
          100% local Google Meet transcription powered by{' '}
          <code>{MODEL_DISPLAY_NAME}</code>. No audio or transcript text ever leaves your machine.
        </p>
      </header>

      {setupComplete ? (
        <div class="alert alert-ok" style={{ marginBottom: '16px' }}>
          <strong>Setup complete!</strong> Open a Google Meet call, click the extension icon, and
          press <strong>Start transcription</strong>.
        </div>
      ) : (
        <div class="alert alert-warn" style={{ marginBottom: '16px' }}>
          Complete both steps below (1. Download &amp; verify the Whisper model, 2. Grant microphone
          access) to enable live transcription.
        </div>
      )}

      {/* Step 1: Hardware & Resource Checks (PLAN §14.5) */}
      <section class="card">
        <div class="card-header">
          <h2 class="card-title">System &amp; GPU Readiness</h2>
          <button
            type="button"
            class="btn"
            onClick={() => void runResourceChecks(modelInfo?.benchmarkRtf).then(setReport)}
          >
            Re-check
          </button>
        </div>
        <div class="check-list">
          {report?.checks.map((c) => (
            <div key={c.id} class="check-item">
              <span class="check-icon">{levelIcon(c.level)}</span>
              <div class="check-body">
                <div class="check-label">{c.label}</div>
                <div class="check-detail">{c.detail}</div>
              </div>
            </div>
          ))}
        </div>
        <div class="form-help">
          <strong>Tips for best results:</strong> Wear headphones during calls so remote audio from
          your speakers isn&apos;t picked up twice by your microphone, and keep laptops plugged into
          power during long meetings to avoid thermal GPU throttling.
        </div>
      </section>

      {/* Step 2: One-Time Model Download & SHA-256 Verification (PLAN §4, §14.1) */}
      <section class="card">
        <div class="card-header">
          <h2 class="card-title">Step 1 — Whisper Model ({MODEL_DISPLAY_NAME})</h2>
          {modelInfo?.verifiedAt ? (
            <span class="badge badge-ok">Verified &amp; Cached</span>
          ) : (
            <span class="badge badge-warn">Not downloaded</span>
          )}
        </div>

        <div class="form-row">
          <label class="form-label">Quantization preset</label>
          <select
            class="select"
            value={preset}
            disabled={dlPhase === 'downloading' || dlPhase === 'verifying'}
            onChange={(e) => void handlePresetChange((e.target as HTMLSelectElement).value as QuantPreset)}
          >
            {(Object.keys(QUANT_PRESETS) as QuantPreset[]).map((key) => {
              const p = QUANT_PRESETS[key];
              return (
                <option key={key} value={key}>
                  {p.label} — {formatBytes(presetSize(key))} ({p.description})
                </option>
              );
            })}
          </select>
          <div class="form-help">
            Pinned Hugging Face revision: <code>{MODEL_REVISION.slice(0, 12)}</code> · Total download
            size: <strong>{formatBytes(totalPresetBytes)}</strong>. Stored in persistent browser
            Cache Storage for offline use.
          </div>
        </div>

        {(dlPhase === 'downloading' || dlPhase === 'verifying' || dlPhase === 'benchmarking') && (
          <div style={{ marginBottom: '12px' }}>
            <div class="progress-track">
              <div
                class="progress-fill"
                style={{ width: `${Math.round(dlProgress * 100)}%` }}
              />
            </div>
            <div class="form-help" style={{ marginTop: '6px' }}>
              {dlDetail}
            </div>
          </div>
        )}

        {dlError && (
          <div class="alert alert-err" style={{ marginBottom: '12px' }}>
            {dlError}
          </div>
        )}

        {dlPhase === 'ready' && modelInfo && (
          <div class="alert alert-ok" style={{ marginBottom: '12px' }}>
            Model cached &amp; SHA-256 verified ({QUANT_PRESETS[modelInfo.preset].label}).
            {typeof modelInfo.benchmarkRtf === 'number' && (
              <>
                {' '}
                Benchmark RTF: <strong>{modelInfo.benchmarkRtf.toFixed(2)}x</strong> on{' '}
                {modelInfo.benchmarkDevice?.toUpperCase()}.
              </>
            )}
          </div>
        )}

        <div class="btn-row">
          <button
            type="button"
            class="btn btn-primary"
            disabled={dlPhase === 'downloading' || dlPhase === 'verifying'}
            onClick={() => void handleDownloadAndSetup()}
          >
            {dlPhase === 'error'
              ? 'Retry download (resume)'
              : modelInfo?.verifiedAt
                ? 'Re-download / Benchmark'
                : `Download model (${formatBytes(totalPresetBytes)})`}
          </button>

          {modelInfo?.verifiedAt && (
            <>
              <button
                type="button"
                class="btn"
                disabled={dlPhase === 'downloading' || dlPhase === 'verifying'}
                onClick={() => void handleVerifyOnly()}
              >
                Verify model (SHA-256)
              </button>
              <button
                type="button"
                class="btn btn-danger"
                disabled={dlPhase === 'downloading' || dlPhase === 'verifying'}
                onClick={() => void handleDeleteModel()}
              >
                Delete model from disk
              </button>
            </>
          )}
        </div>

        {verifyReport && (
          <div class="form-help" style={{ marginTop: '10px' }}>
            Checked {verifyReport.files.length} files against <code>model-manifest.json</code>:{' '}
            {verifyReport.files.filter((f) => f.ok).length}/{verifyReport.files.length} passed.
          </div>
        )}
      </section>

      {/* Step 3: Microphone Permission (PLAN §8) */}
      <section class="card">
        <div class="card-header">
          <h2 class="card-title">Step 2 — Microphone Access (Required)</h2>
          {micGranted ? (
            <span class="badge badge-ok">Granted</span>
          ) : (
            <span class="badge badge-warn">Permission required</span>
          )}
        </div>
        <p style={{ marginTop: 0, color: 'var(--text-muted)' }}>
          Google Meet tab capture only contains remote participants. To capture the full
          conversation, this extension always records both the Meet tab audio and your microphone
          together (with echo cancellation enabled, and never playing your mic back to your
          speakers).
        </p>
        {micError && (
          <div class="alert alert-err" style={{ marginBottom: '10px' }}>
            {micError}
          </div>
        )}
        <button
          type="button"
          class={micGranted ? 'btn' : 'btn btn-primary'}
          onClick={() => void requestMicrophone()}
        >
          {micGranted ? 'Re-test microphone access' : 'Grant microphone access'}
        </button>
      </section>

      {/* Step 4: Preferences (PLAN §3.5, §6, §7) */}
      {settings && (
        <section class="card">
          <div class="card-header">
            <h2 class="card-title">Transcript &amp; Language Defaults</h2>
          </div>

          <div class="form-row">
            <label class="form-label">Default spoken language</label>
            <LanguageSelect
              value={settings.defaultLanguage}
              favorites={settings.favoriteLanguages}
              recents={settings.recentLanguages}
              onChange={(code) => void updateSettings({ defaultLanguage: code }).then(setSettings)}
              onToggleFavorite={(code) => {
                const exists = settings.favoriteLanguages.includes(code);
                const favs = exists
                  ? settings.favoriteLanguages.filter((c) => c !== code)
                  : [...settings.favoriteLanguages, code];
                void updateSettings({ favoriteLanguages: favs }).then(setSettings);
              }}
            />
            <div class="form-help">
              Auto-detect identifies the language from the first 30 s window and locks it for the
              session. You can also switch languages mid-call from the popup.
            </div>
          </div>

          <div class="form-row">
            <label class="form-label">Markdown filename template</label>
            <input
              type="text"
              class="input"
              value={settings.filenameTemplate}
              onInput={(e) =>
                void updateSettings({
                  filenameTemplate: (e.target as HTMLInputElement).value,
                }).then(setSettings)
              }
            />
            <div class="form-help">
              Supported placeholders: <code>{'{meetingTitle}'}</code>,{' '}
              <code>{'{YYYY-MM-DD HHmm}'}</code>, <code>{'{YYYY-MM-DD}'}</code>,{' '}
              <code>{'{HHmm}'}</code>. Always saved as <code>.md</code>.
            </div>
          </div>

          <div class="form-row" style={{ marginBottom: 0 }}>
            <label class="form-label">Timestamp style</label>
            <select
              class="select"
              value={settings.timestampStyle}
              onChange={(e) =>
                void updateSettings({
                  timestampStyle: (e.target as HTMLSelectElement).value as TimestampStyle,
                }).then(setSettings)
              }
            >
              <option value="hms">[HH:MM:SS] (default, e.g. [00:04:12])</option>
              <option value="ms">[MM:SS] when under 1 hour</option>
              <option value="none">No per-segment timestamps</option>
            </select>
          </div>
        </section>
      )}
    </div>
  );
}

const root = document.getElementById('app');
if (root) {
  render(<OptionsApp />, root);
}

