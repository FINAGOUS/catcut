// Subtitles: model, SRT import/export, drawtext burn-in conversion,
// ASS karaoke (word highlight) generation, and timing-alignment checks.
// Times are seconds. Clip-level subtitles live in clip-local OUTPUT time
// (after speed is applied); project-level subtitles live in project time
// and are burned with the ASS filter after the timeline is assembled.
import { writeFileSync } from 'node:fs';
import type { TextOverlay } from './project.js';
import type { TextStylePreset } from './presets.js';

export interface SubtitleWord {
  /** Word/character as transcribed. */
  w: string;
  start: number;
  end: number;
}

export interface SubtitleItem {
  text: string;
  start: number;
  end: number;
  /** Word-level timestamps when the transcriber provides them. Estimates. */
  words?: SubtitleWord[];
}

/** HH:MM:SS,mmm (SRT timecode). */
export function formatSrtTime(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60000) % 60;
  const h = Math.floor(totalMs / 3600000);
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

/** H:MM:SS.cc (ASS timecode, centiseconds). */
export function formatAssTime(sec: number): string {
  const totalCs = Math.max(0, Math.round(sec * 100));
  const cs = totalCs % 100;
  const s = Math.floor(totalCs / 100) % 60;
  const m = Math.floor(totalCs / 6000) % 60;
  const h = Math.floor(totalCs / 360000);
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs, 2)}`;
}

export function toSRT(items: SubtitleItem[]): string {
  return items
    .map((it, i) => `${i + 1}\n${formatSrtTime(it.start)} --> ${formatSrtTime(it.end)}\n${it.text}\n`)
    .join('\n');
}

export function writeSRT(items: SubtitleItem[], file: string): void {
  writeFileSync(file, toSRT(items), 'utf8');
}

function parseSrtTime(s: string): number {
  const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) throw new Error(`bad SRT timecode: ${s}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** Parse SRT text back into subtitle items (word timestamps are not in SRT). */
export function parseSRT(srt: string): SubtitleItem[] {
  const blocks = srt.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  const items: SubtitleItem[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length < 2) continue;
    // First line may be the numeric index; the timecode line contains '-->'.
    const tcIdx = lines.findIndex((l) => l.includes('-->'));
    if (tcIdx < 0) continue;
    const [a, b] = lines[tcIdx].split('-->');
    items.push({
      text: lines.slice(tcIdx + 1).join('\n'),
      start: parseSrtTime(a),
      end: parseSrtTime(b),
    });
  }
  items.sort((x, y) => x.start - y.start);
  return items;
}

/** One drawtext overlay per subtitle item (sentence-level burn-in). */
export function subtitlesToTextOverlays(
  items: SubtitleItem[],
  style: TextStylePreset,
): TextOverlay[] {
  return items.map((it) => ({
    ...style,
    text: it.text,
    start: it.start,
    end: it.end,
  }));
}

export interface AssStyle {
  fontname: string;
  fontsize: number;
  /** Base text colour, ASS &H00BBGGRR. */
  primaryColor: string;
  /** Karaoke highlight colour, ASS &H00BBGGRR. */
  highlightColor: string;
  outline: number;
  shadow: number;
  /** Bottom-centre margin in px. */
  marginV: number;
}

export const DEFAULT_ASS_STYLE: AssStyle = {
  fontname: 'Noto Serif CJK SC',
  fontsize: 40,
  primaryColor: '&H00FFFFFF',
  highlightColor: '&H0000FFFF',
  outline: 2,
  shadow: 1,
  marginV: 30,
};

/**
 * ASS file with karaoke word highlight ({\k<centiseconds>} per word).
 * Items without word timestamps get one {\k} span for the whole line.
 * Rendered with FFmpeg's `ass` filter (libass). Verified against
 * ffmpeg 8.1: karaoke sweep uses the style's secondary colour.
 */
export function subtitlesToASS(
  items: SubtitleItem[],
  style: AssStyle,
  playResX: number,
  playResY: number,
): string {
  const header = [
    '[Script Info]',
    'Title: auto subtitles',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Sub,${style.fontname},${style.fontsize},${style.primaryColor},${style.highlightColor},&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${style.outline},${style.shadow},2,20,20,${style.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const escAss = (s: string) => s.replace(/\{/g, '\\{').replace(/\}/g, '\\}');
  for (const it of items) {
    let text: string;
    if (it.words && it.words.length > 0) {
      text = it.words
        .map((w) => `{\\k${Math.max(1, Math.round((w.end - w.start) * 100))}}${escAss(w.w)}`)
        .join('');
    } else {
      text = `{\\k${Math.max(1, Math.round((it.end - it.start) * 100))}}${escAss(it.text)}`;
    }
    header.push(
      `Dialogue: 0,${formatAssTime(it.start)},${formatAssTime(it.end)},Sub,,0,0,0,,${text}`,
    );
  }
  return header.join('\n') + '\n';
}

/**
 * Count subtitle items whose start or end deviates from the nearest
 * reference boundary (e.g. speech-activity intervals from silencedetect)
 * by more than `tol` seconds. Returns the offending item indexes.
 * This is how a timing error > tol is made countable instead of eyeballed.
 */
export function countBoundaryErrors(
  items: SubtitleItem[],
  bounds: { start: number; end: number }[],
  tol = 0.2,
): number[] {
  const bad: number[] = [];
  items.forEach((it, i) => {
    const nearestStart = bounds.reduce(
      (best, b) => Math.min(best, Math.abs(b.start - it.start)),
      Infinity,
    );
    const nearestEnd = bounds.reduce(
      (best, b) => Math.min(best, Math.abs(b.end - it.end)),
      Infinity,
    );
    if (nearestStart > tol || nearestEnd > tol) bad.push(i);
  });
  return bad;
}

/** Word timestamps must be monotonic and inside their segment. */
export function validateWordTimes(items: SubtitleItem[]): string[] {
  const problems: string[] = [];
  items.forEach((it, i) => {
    (it.words ?? []).forEach((w, j) => {
      if (w.start < it.start - 0.001 || w.end > it.end + 0.001) {
        problems.push(`item ${i} word ${j} outside segment`);
      }
      if (j > 0 && w.start < (it.words as SubtitleWord[])[j - 1].end - 0.001) {
        problems.push(`item ${i} word ${j} overlaps previous word`);
      }
      if (w.end < w.start) problems.push(`item ${i} word ${j} negative duration`);
    });
  });
  return problems;
}
