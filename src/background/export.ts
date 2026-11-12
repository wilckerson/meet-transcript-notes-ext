/**
 * Markdown transcript builder and filename template formatter (PLAN §7).
 *
 * Output format (Markdown only):
 * ```markdown
 * # Meeting Transcript — Weekly Sync
 * - **Date:** 2026-11-11 10:00–10:42 (42 min)
 * - **Meeting:** meet.google.com/abc-defg-hij
 * - **Language:** English (auto-detected)
 * - **Model:** whisper-large-v3-turbo (local, WebGPU)
 *
 * > Automatically generated transcript — may contain errors.
 *
 * ---
 *
 * **[00:00:04]** Okay, let's get started. First item is the release timeline…
 * ```
 */
import { getLanguage } from '../shared/languages';
import { MODEL_DISPLAY_NAME } from '../shared/model';
import type { Segment, SessionMeta, TimestampStyle } from '../shared/types';

export function buildMarkdownTranscript(
  session: SessionMeta,
  segments: readonly Segment[],
  timestampStyle: TimestampStyle = 'hms',
): string {
  const title = (session.meetingTitle || 'Google Meet').trim();
  const endedAt = session.endedAt ?? Date.now();
  const dateLine = formatDateRange(new Date(session.startedAt), new Date(endedAt));
  const meetingLine = formatMeetingUrl(session.meetingUrl);
  const languageLine = formatLanguageMeta(session.language, session.detectedLanguage);
  const backendLabel = session.device === 'wasm' ? 'WASM' : 'WebGPU';

  const lines: string[] = [
    `# Meeting Transcript — ${title}`,
    `- **Date:** ${dateLine}`,
    `- **Meeting:** ${meetingLine}`,
    `- **Language:** ${languageLine}`,
    `- **Model:** ${MODEL_DISPLAY_NAME} (local, ${backendLabel})`,
    '',
    '> Automatically generated transcript — may contain errors.',
    '',
    '---',
    '',
  ];

  if (segments.length === 0) {
    lines.push('*(No speech detected during this session.)*');
  } else {
    for (const seg of segments) {
      const text = seg.text.trim();
      if (!text) continue;
      const speakerTag = seg.speaker ? `*(Speaker: ${seg.speaker})* ` : '';
      if (timestampStyle === 'none') {
        lines.push(`${speakerTag}${text}`, '');
      } else {
        const ts = formatTimestamp(seg.start, timestampStyle);
        lines.push(`**[${ts}]** ${speakerTag}${text}`, '');
      }
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

export function formatTimestamp(seconds: number, style: TimestampStyle = 'hms'): string {
  const totalSec = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  if (style === 'ms' && hrs === 0) {
    return `${pad2(mins)}:${pad2(secs)}`;
  }
  return `${pad2(hrs)}:${pad2(mins)}:${pad2(secs)}`;
}

export function formatDateRange(start: Date, end: Date): string {
  const yyyy = start.getFullYear();
  const mm = pad2(start.getMonth() + 1);
  const dd = pad2(start.getDate());
  const startHm = `${pad2(start.getHours())}:${pad2(start.getMinutes())}`;
  const endHm = `${pad2(end.getHours())}:${pad2(end.getMinutes())}`;
  const durationMin = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000));
  return `${yyyy}-${mm}-${dd} ${startHm}–${endHm} (${durationMin} min)`;
}

export function formatMeetingUrl(rawUrl: string): string {
  if (!rawUrl) return 'meet.google.com';
  try {
    const u = new URL(rawUrl);
    return `${u.host}${u.pathname}`;
  } catch {
    return rawUrl.replace(/^https?:\/\//, '');
  }
}

export function formatLanguageMeta(language: string, detectedLanguage?: string): string {
  if (!language || language === 'auto') {
    if (detectedLanguage) {
      const l = getLanguage(detectedLanguage);
      return `${l ? l.name : detectedLanguage} (auto-detected)`;
    }
    return 'Auto-detect';
  }
  const l = getLanguage(language);
  return l ? l.name : language;
}

/**
 * Formats a filename from a user template (default: `Meet - {meetingTitle} - {YYYY-MM-DD HHmm}.md`)
 * and sanitizes characters forbidden by macOS/Windows/Linux download APIs.
 */
export function formatFilename(
  template: string,
  session: SessionMeta,
  now = new Date(session.startedAt),
): string {
  const tpl = (template || 'Meet - {meetingTitle} - {YYYY-MM-DD HHmm}.md').trim();
  const yyyy = String(now.getFullYear());
  const mm = pad2(now.getMonth() + 1);
  const dd = pad2(now.getDate());
  const hh = pad2(now.getHours());
  const min = pad2(now.getMinutes());

  const cleanTitle = sanitizePathPart(session.meetingTitle || 'Google Meet') || 'Google Meet';

  let out = tpl
    .replace(/\{meetingTitle\}/g, cleanTitle)
    .replace(/\{YYYY-MM-DD HHmm\}/g, `${yyyy}-${mm}-${dd} ${hh}${min}`)
    .replace(/\{YYYY-MM-DD\}/g, `${yyyy}-${mm}-${dd}`)
    .replace(/\{HHmm\}/g, `${hh}${min}`);

  out = sanitizePathPart(out);
  if (!out.toLowerCase().endsWith('.md')) {
    out += '.md';
  }
  return out;
}

function sanitizePathPart(input: string): string {
  return input
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 180);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

