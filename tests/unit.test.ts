/**
 * Unit tests covering PLAN §15:
 *  - Chunker boundary logic (pause cut at >= 300 ms after 10 s, hard cap at 28 s, silence skipping, 0.5 s overlap)
 *  - Overlap deduplication and Whisper hallucination filtering
 *  - Markdown exporter formatting & filename template sanitization
 *  - Whisper 99-language map, search, and favorite/recent ordering
 *  - Streaming SHA-256 integrity checks (match, hash mismatch + cache deletion, size mismatch, missing file)
 *  - GPU device-lost recovery rolling window tracker
 *  - WAV PCM16 encode/decode round-trip
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  AudioChunker,
  collapseRepeatedPhrases,
  deduplicateOverlapSegments,
  isLikelyHallucination,
  stripOverlapPrefix,
} from '../src/offscreen/chunker';
import { computeRms, hasVoiceActivity, isSpeechFrame } from '../src/offscreen/vad';
import { RecoveryTracker } from '../src/offscreen/recovery';
import {
  buildMarkdownTranscript,
  formatDateRange,
  formatFilename,
  formatLanguageMeta,
  formatTimestamp,
} from '../src/background/export';
import {
  AUTO_LANGUAGE,
  LANGUAGES,
  getLanguage,
  isValidLanguage,
  languageLabel,
  orderLanguages,
  searchLanguages,
  whisperToken,
} from '../src/shared/languages';
import {
  MODEL_CACHE_NAME,
  MODEL_FILES,
  MODEL_REVISION,
  QUANT_PRESETS,
  modelFileUrl,
  presetFiles,
  presetSize,
} from '../src/shared/model';
import {
  sha256Stream,
  verifyPresetIntegrity,
  verifyPresetSizes,
} from '../src/shared/integrity';
import { decodeWavPcm16, encodeWavPcm16 } from '../src/shared/wav';
import { ChannelEnergyTracker, resolveSpeakerLabel } from '../src/shared/speaker';
import type { Segment, SessionMeta } from '../src/shared/types';

function makeSpeechFrame(samples = 1600, amplitude = 0.25): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * amplitude;
  }
  return out;
}

function makeSilentFrame(samples = 1600): Float32Array {
  return new Float32Array(samples);
}

describe('VAD (Voice Activity Detection)', () => {
  it('computes RMS and distinguishes speech from silence', () => {
    const silent = makeSilentFrame();
    const speech = makeSpeechFrame();
    expect(computeRms(silent)).toBe(0);
    expect(isSpeechFrame(silent)).toBe(false);
    expect(computeRms(speech)).toBeGreaterThan(0.1);
    expect(isSpeechFrame(speech)).toBe(true);
    expect(hasVoiceActivity(silent)).toBe(false);
    expect(hasVoiceActivity(speech)).toBe(true);
  });
});

describe('AudioChunker boundary & overlap logic (PLAN §5)', () => {
  it('cuts at the nearest pause >= 300 ms after 10 s and carries 0.5 s overlap', () => {
    const chunker = new AudioChunker();
    // Feed 11 s of continuous speech (110 frames of 100 ms): should NOT cut yet (no pause).
    for (let i = 0; i < 110; i++) {
      expect(chunker.pushFrame(makeSpeechFrame())).toHaveLength(0);
    }

    // Feed 200 ms of silence (2 frames): still below 300 ms pause threshold.
    expect(chunker.pushFrame(makeSilentFrame())).toHaveLength(0);
    expect(chunker.pushFrame(makeSilentFrame())).toHaveLength(0);

    // 3rd silent frame reaches 300 ms pause after 10 s -> emits chunk #1.
    const emitted = chunker.pushFrame(makeSilentFrame());
    expect(emitted).toHaveLength(1);
    const first = emitted[0];
    expect(first.chunkId).toBe(1);
    expect(first.chunkStartTime).toBeCloseTo(0, 3);
    expect(first.duration).toBeCloseTo(11.3, 2);
    expect(first.overlapSeconds).toBe(0);

    // Feed another 10 s of speech + 300 ms pause -> chunk #2 starts 0.5 s before chunk #1 ended.
    for (let i = 0; i < 100; i++) {
      chunker.pushFrame(makeSpeechFrame());
    }
    let second = null;
    for (let i = 0; i < 3; i++) {
      const out = chunker.pushFrame(makeSilentFrame());
      if (out.length > 0) second = out[0];
    }
    expect(second).not.toBeNull();
    expect(second!.chunkId).toBe(2);
    expect(second!.overlapSeconds).toBeCloseTo(0.5, 3);
    expect(second!.chunkStartTime).toBeCloseTo(first.duration - 0.5, 2);
  });

  it('enforces the hard cap at 28 s when speech has no pauses', () => {
    const chunker = new AudioChunker();
    const emitted = [];
    for (let i = 0; i < 285; i++) {
      emitted.push(...chunker.pushFrame(makeSpeechFrame()));
    }
    expect(emitted).toHaveLength(1);
    expect(emitted[0].duration).toBeCloseTo(28, 2);
  });

  it('skips completely silent windows without emitting a chunk', () => {
    const chunker = new AudioChunker();
    for (let i = 0; i < 150; i++) {
      expect(chunker.pushFrame(makeSilentFrame())).toHaveLength(0);
    }
    expect(chunker.flush()).toBeNull();
  });

  it('flushes remaining partial speech on Stop', () => {
    const chunker = new AudioChunker();
    for (let i = 0; i < 25; i++) {
      chunker.pushFrame(makeSpeechFrame());
    }
    const finalChunk = chunker.flush();
    expect(finalChunk).not.toBeNull();
    expect(finalChunk!.duration).toBeCloseTo(2.5, 2);
  });
});

describe('Overlap deduplication & hallucination filtering (PLAN §5.4, §13)', () => {
  it('filters common silence/music hallucinations and collapses repetition loops', () => {
    expect(isLikelyHallucination('[Music]')).toBe(true);
    expect(isLikelyHallucination('Thank you.')).toBe(true);
    expect(isLikelyHallucination('Thanks for watching!')).toBe(true);
    expect(isLikelyHallucination('Let us review the Q4 roadmap.')).toBe(false);

    const repeated = 'we need to ship, we need to ship, we need to ship, we need to ship now';
    expect(collapseRepeatedPhrases(repeated)).toBe('we need to ship now');
  });

  it('strips duplicated words across the 0.5 s chunk overlap boundary', () => {
    expect(
      stripOverlapPrefix(
        'First item is the release timeline',
        'the release timeline for Friday afternoon',
      ),
    ).toBe('for Friday afternoon');

    const prev: Segment[] = [
      {
        sessionId: 's1',
        chunkId: 1,
        start: 0,
        end: 10.5,
        text: 'First item is the release timeline',
      },
    ];
    const incoming: Segment[] = [
      {
        sessionId: 's1',
        chunkId: 2,
        start: 10.0,
        end: 18.0,
        text: 'the release timeline for Friday afternoon.',
      },
      {
        sessionId: 's1',
        chunkId: 2,
        start: 18.0,
        end: 20.0,
        text: 'Thank you.',
      },
    ];
    const merged = deduplicateOverlapSegments(prev, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('for Friday afternoon.');
    expect(merged[0].start).toBeCloseTo(10.5, 2);
  });
});

describe('Markdown Exporter & Filename Template (PLAN §7)', () => {
  const sampleSession: SessionMeta = {
    id: 'sess-1',
    startedAt: new Date(2026, 10, 11, 10, 0, 0).getTime(),
    endedAt: new Date(2026, 10, 11, 10, 42, 0).getTime(),
    meetingTitle: 'Weekly Sync',
    meetingUrl: 'https://meet.google.com/abc-defg-hij?authuser=0',
    language: 'auto',
    detectedLanguage: 'en',
    device: 'webgpu',
    status: 'saved',
  };

  it('builds Markdown matching the PLAN §7 specification', () => {
    const segments: Segment[] = [
      {
        sessionId: 'sess-1',
        chunkId: 1,
        start: 4,
        end: 12,
        text: "Okay, let's get started. First item is the release timeline…",
      },
      {
        sessionId: 'sess-1',
        chunkId: 1,
        start: 31,
        end: 45,
        text: 'I think we can ship on Friday if tests pass.',
      },
    ];

    const md = buildMarkdownTranscript(sampleSession, segments, 'hms');
    expect(md).toContain('# Meeting Transcript — Weekly Sync');
    expect(md).toContain('- **Date:** 2026-11-11 10:00–10:42 (42 min)');
    expect(md).toContain('- **Meeting:** meet.google.com/abc-defg-hij');
    expect(md).toContain('- **Language:** English (auto-detected)');
    expect(md).toContain('- **Model:** whisper-large-v3-turbo (local, WebGPU)');
    expect(md).toContain('> Automatically generated transcript — may contain errors.');
    expect(md).toContain("**[00:00:04]** Okay, let's get started.");
    expect(md).toContain('**[00:00:31]** I think we can ship on Friday if tests pass.');
  });

  it('formats filenames from template and sanitizes unsafe path characters', () => {
    const name = formatFilename(
      'Meet - {meetingTitle} - {YYYY-MM-DD HHmm}.md',
      { ...sampleSession, meetingTitle: 'Q4: Product / Eng Sync?' },
      new Date(2026, 10, 11, 10, 5, 0),
    );
    expect(name).toBe('Meet - Q4- Product - Eng Sync - 2026-11-11 1005.md');
    expect(formatTimestamp(3661, 'hms')).toBe('01:01:01');
    expect(formatTimestamp(65, 'ms')).toBe('01:05');
    expect(formatLanguageMeta('pt')).toBe('Portuguese');
    expect(formatDateRange(new Date(2026, 10, 11, 10, 0), new Date(2026, 10, 11, 10, 42))).toBe(
      '2026-11-11 10:00–10:42 (42 min)',
    );
  });
});

describe('Whisper 99-Language Map (PLAN §6)', () => {
  it('contains all 99 Whisper languages and supports search + favorite/recent ordering', () => {
    expect(LANGUAGES).toHaveLength(99);
    expect(isValidLanguage(AUTO_LANGUAGE)).toBe(true);
    expect(isValidLanguage('en')).toBe(true);
    expect(isValidLanguage('pt')).toBe(true);
    expect(isValidLanguage('xx')).toBe(false);
    expect(whisperToken('pt')).toBe('<|pt|>');
    expect(getLanguage('ja')?.native).toBe('日本語');
    expect(languageLabel('pt')).toBe('Português (Portuguese)');

    // Diacritic-insensitive search
    const found = searchLanguages('portugues');
    expect(found.map((l) => l.code)).toContain('pt');

    const { pinned, rest } = orderLanguages(['pt', 'ja'], ['es', 'pt']);
    expect(pinned.map((l) => l.code)).toEqual(['pt', 'ja', 'es']);
    expect(rest).toHaveLength(96);
  });
});

describe('Model Manifest & Streaming SHA-256 Integrity (PLAN §14.1)', () => {
  it('pins a 40-char commit hash and covers every quantization preset file', () => {
    expect(MODEL_REVISION).toMatch(/^[0-9a-f]{40}$/);
    for (const preset of Object.keys(QUANT_PRESETS) as Array<keyof typeof QUANT_PRESETS>) {
      const files = presetFiles(preset);
      expect(files.length).toBeGreaterThanOrEqual(7);
      expect(presetSize(preset)).toBeGreaterThan(500_000_000);
      for (const f of files) {
        expect(f.entry.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(f.url).toContain(`/resolve/${MODEL_REVISION}/`);
      }
    }
  });

  it('verifies matching files and deletes corrupted/mismatched files from Cache Storage', async () => {
    // Build an in-memory CacheStorage mock using small synthetic files while swapping one manifest entry.
    const store = new Map<string, Uint8Array>();
    const fakeCache: Cache = {
      match: async (req: RequestInfo | URL) => {
        const key = typeof req === 'string' ? req : req.toString();
        const bytes = store.get(key);
        if (!bytes) return undefined;
        return new Response(bytes as unknown as BodyInit, {
          headers: { 'content-length': String(bytes.byteLength) },
        });
      },
      delete: async (req: RequestInfo | URL) => {
        const key = typeof req === 'string' ? req : req.toString();
        return store.delete(key);
      },
    } as unknown as Cache;

    const fakeCacheStorage: CacheStorage = {
      open: async (name: string) => {
        expect(name).toBe(MODEL_CACHE_NAME);
        return fakeCache;
      },
    } as unknown as CacheStorage;

    // Populate synthetic payloads matching temporary manifest entries
    const originalEntries = new Map<string, { size: number; sha256: string }>();
    for (const { file, url, entry } of presetFiles('compact')) {
      originalEntries.set(file, { ...entry });
      const payload = new TextEncoder().encode(`valid-content-for-${file}`);
      const sha = createHash('sha256').update(payload).digest('hex');
      MODEL_FILES[file] = { size: payload.byteLength, sha256: sha };
      store.set(url, payload);
    }

    try {
      // 1. All valid -> passes both size and full SHA-256 check
      const sizeOk = await verifyPresetSizes('compact', fakeCacheStorage);
      expect(sizeOk.ok).toBe(true);

      const hashOk = await verifyPresetIntegrity('compact', undefined, fakeCacheStorage);
      expect(hashOk.ok).toBe(true);

      // 2. Corrupt a single byte in config.json (same size, wrong SHA-256)
      const configUrl = modelFileUrl('config.json');
      const corrupted = new TextEncoder().encode('valid-content-for-config.jsoX');
      store.set(configUrl, corrupted);

      const hashBad = await verifyPresetIntegrity('compact', undefined, fakeCacheStorage);
      expect(hashBad.ok).toBe(false);
      const failedFile = hashBad.files.find((f) => f.file === 'config.json');
      expect(failedFile?.reason).toBe('hash-mismatch');
      // Corrupted file must have been deleted from Cache Storage automatically
      expect(store.has(configUrl)).toBe(false);

      // 3. Missing file check
      const missingRes = await verifyPresetSizes('compact', fakeCacheStorage);
      expect(missingRes.ok).toBe(false);
      expect(missingRes.files.find((f) => f.file === 'config.json')?.reason).toBe('missing');
    } finally {
      for (const [file, orig] of originalEntries) {
        MODEL_FILES[file] = orig;
      }
    }
  });

  it('streams SHA-256 over multi-chunk ReadableStreams', async () => {
    const chunks = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8])];
    const expected = createHash('sha256')
      .update(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
      .digest('hex');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const res = await sha256Stream(stream);
    expect(res.size).toBe(8);
    expect(res.sha256).toBe(expected);
  });
});

describe('GPU Device-Lost Recovery Tracker (PLAN §14.3)', () => {
  it('allows 3 recoveries within 10 minutes and blocks the 4th until the window expires', () => {
    const tracker = new RecoveryTracker(3, 10 * 60 * 1000);
    const t0 = 1_000_000;
    expect(tracker.tryRecord(t0)).toBe(true);
    expect(tracker.tryRecord(t0 + 10_000)).toBe(true);
    expect(tracker.tryRecord(t0 + 20_000)).toBe(true);
    expect(tracker.tryRecord(t0 + 30_000)).toBe(false);

    // After 10 minutes + 1s from the first event, another recovery is permitted.
    expect(tracker.tryRecord(t0 + 10 * 60 * 1000 + 1000)).toBe(true);
  });
});

describe('WAV PCM16 codec (PLAN §12 M1, §14.5)', () => {
  it('round-trips Float32 mono audio through 16 kHz PCM16 WAV', () => {
    const input = makeSpeechFrame(3200, 0.5);
    const wav = encodeWavPcm16(input, 16000);
    const decoded = decodeWavPcm16(wav);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.samples.length).toBe(input.length);
    for (let i = 0; i < input.length; i += 100) {
      expect(decoded.samples[i]).toBeCloseTo(input[i], 3);
    }
  });
});

describe('Tier 1 + Tier 2 Speaker Attribution (PLAN §8, §9)', () => {
  it('Tier 1 classifies segments as You (mic) vs Remote (tab) using per-frame RMS energy', () => {
    const tracker = new ChannelEnergyTracker(0.1);
    // 0.0s .. 2.0s: Remote participant speaking on Meet tab
    for (let i = 0; i < 20; i++) {
      tracker.pushFrameEnergy(0.15, 0.001);
    }
    // 2.0s .. 4.0s: User speaking into microphone (with minor speaker bleed on tab)
    for (let i = 0; i < 20; i++) {
      tracker.pushFrameEnergy(0.01, 0.22);
    }

    expect(tracker.classifySegment(0.2, 1.8)).toBe('remote');
    expect(tracker.classifySegment(2.1, 3.8)).toBe('you');
  });

  it('Tier 2 resolves Meet DOM participant names for remote segments and reliably falls back to Remote / You', () => {
    const sessionStartMs = 1_000_000;
    const events = [
      { name: 'Maria Silva', startMs: sessionStartMs + 1000, endMs: sessionStartMs + 5000 },
      { name: 'João', startMs: sessionStartMs + 6000, endMs: sessionStartMs + 9000 },
    ];

    // Mic channel is always labeled "You" even if a remote tile flickered
    expect(resolveSpeakerLabel('you', 1.5, 4.0, sessionStartMs, events)).toBe('You');

    // Remote segment overlapping Maria's active-speaker window -> "Maria Silva"
    expect(resolveSpeakerLabel('remote', 1.2, 4.5, sessionStartMs, events)).toBe('Maria Silva');

    // Remote segment during a window with no DOM speaker events -> falls back to "Remote"
    expect(resolveSpeakerLabel('remote', 12.0, 15.0, sessionStartMs, events)).toBe('Remote');

    // Empty DOM events list -> falls back to "Remote"
    expect(resolveSpeakerLabel('remote', 1.2, 4.5, sessionStartMs, [])).toBe('Remote');
  });

  it('includes *(Speaker: ...)* in Markdown export when present', () => {
    const session: SessionMeta = {
      id: 'sess-spk',
      startedAt: new Date(2026, 10, 11, 10, 0, 0).getTime(),
      endedAt: new Date(2026, 10, 11, 10, 5, 0).getTime(),
      meetingTitle: 'Daily Standup',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      language: 'pt',
      device: 'webgpu',
      status: 'saved',
    };
    const segments: Segment[] = [
      {
        sessionId: 'sess-spk',
        chunkId: 1,
        start: 3,
        end: 8,
        text: 'Bom dia pessoal!',
        speakerSource: 'you',
        speaker: 'You',
      },
      {
        sessionId: 'sess-spk',
        chunkId: 1,
        start: 9,
        end: 14,
        text: 'Bom dia, tudo ótimo.',
        speakerSource: 'remote',
        speaker: 'Maria',
      },
    ];
    const md = buildMarkdownTranscript(session, segments, 'hms');
    expect(md).toContain('**[00:00:03]** *(Speaker: You)* Bom dia pessoal!');
    expect(md).toContain('**[00:00:09]** *(Speaker: Maria)* Bom dia, tudo ótimo.');
  });
});
