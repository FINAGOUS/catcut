// Auto-zoom by speech rhythm (P1, M4): subtitle word timestamps drive
// zoom keyframes. One push per sentence at most, never a jitter.
// Rules (from M4-动态口播剪辑 §4, parameters measured in verify-p1):
// - emphasis at sentence start, ramp over `ease` (0.15–0.25 s), hold at
//   emphasis while the sentence runs, ramp back over `ease` at its end;
// - a plateau shorter than `minHold` (0.5 s) is extended, or the sentences
//   merge if the gap between them is shorter than minHold;
// - a silence longer than `silenceGap` (0.4 s) inside a sentence dips the
//   zoom back to base for the silent span;
// - scale is capped at `maxScale` (1.6); centre is the frame centre
//   (0.5, 0.5) — no face tracking in v1.
// The output is plain ZoomKeyframes in the project model: visible,
// editable, deletable — never a black box.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ZoomKeyframe } from './project.js';
import type { SubtitleItem } from './subtitles.js';

const execFileAsync = promisify(execFile);

export interface AutoZoomOptions {
  /** Scale at rest (default 1.0). */
  baseScale?: number;
  /** Scale at emphasis (default 1.35, capped by maxScale). */
  emphasisScale?: number;
  /** Hard cap on scale (default 1.6). */
  maxScale?: number;
  /** Shortest emphasis plateau in seconds (default 0.5). */
  minHold?: number;
  /** Ramp time in/out of emphasis in seconds (default 0.2). */
  ease?: number;
  /** Silence longer than this dips zoom to base (default 0.4 s). */
  silenceGap?: number;
}

export interface SilenceInterval {
  start: number;
  end: number;
}

const DEFAULTS: Required<AutoZoomOptions> = {
  baseScale: 1.0,
  emphasisScale: 1.35,
  maxScale: 1.6,
  minHold: 0.5,
  ease: 0.2,
  silenceGap: 0.4,
};

function resolveOpts(opts?: AutoZoomOptions): Required<AutoZoomOptions> {
  const o = { ...DEFAULTS, ...opts };
  o.emphasisScale = Math.min(o.emphasisScale, o.maxScale);
  if (o.emphasisScale <= o.baseScale) o.emphasisScale = o.baseScale + 0.1;
  return o;
}

interface EmphasisInterval {
  start: number;
  end: number;
}

/** Merge subtitle items into emphasis intervals (gap < minHold merges). */
function emphasisIntervals(
  items: SubtitleItem[],
  o: Required<AutoZoomOptions>,
  duration?: number,
): EmphasisInterval[] {
  const sorted = items
    .filter((it) => it.end > it.start)
    .slice()
    .sort((a, b) => a.start - b.start);
  const intervals: EmphasisInterval[] = [];
  for (const it of sorted) {
    const last = intervals[intervals.length - 1];
    if (last && it.start - last.end < o.minHold) {
      // Gap too short to dip: stay at emphasis across it.
      last.end = Math.max(last.end, it.end);
    } else {
      intervals.push({ start: it.start, end: it.end });
    }
  }
  // Extend plateaus shorter than minHold (unless that would hit the next
  // interval — merging already handled gaps < minHold, so extending by
  // the shortfall is safe up to the next start).
  for (let i = 0; i < intervals.length; i++) {
    const iv = intervals[i];
    const nextStart = i + 1 < intervals.length ? intervals[i + 1].start : Infinity;
    const want = iv.start + o.minHold;
    if (iv.end < want && want < nextStart) iv.end = want;
    if (duration !== undefined) iv.end = Math.min(iv.end, duration);
  }
  return intervals.filter((iv) => iv.end > iv.start);
}

/** Split emphasis intervals at long silences that fall inside a sentence. */
function applySilences(
  intervals: EmphasisInterval[],
  silences: SilenceInterval[],
  o: Required<AutoZoomOptions>,
): EmphasisInterval[] {
  const out: EmphasisInterval[] = [];
  for (const iv of intervals) {
    let cur: EmphasisInterval[] = [iv];
    for (const s of silences) {
      if (s.end - s.start < o.silenceGap) continue;
      const next: EmphasisInterval[] = [];
      for (const c of cur) {
        // Silence fully inside the interval (with ease margin) splits it.
        if (s.start > c.start + o.ease && s.end < c.end - o.ease) {
          next.push({ start: c.start, end: s.start });
          next.push({ start: s.end, end: c.end });
        } else {
          next.push(c);
        }
      }
      cur = next;
    }
    out.push(...cur);
  }
  return out;
}

function intervalsToKeys(
  intervals: EmphasisInterval[],
  o: Required<AutoZoomOptions>,
): ZoomKeyframe[] {
  const keys: ZoomKeyframe[] = [];
  const push = (t: number, scale: number) => {
    const last = keys[keys.length - 1];
    if (last && Math.abs(last.t - t) < 1e-6) {
      last.scale = scale;
      return;
    }
    keys.push({ t: Math.max(0, t), cx: 0.5, cy: 0.5, scale });
  };
  for (const iv of intervals) {
    push(Math.max(0, iv.start - o.ease), o.baseScale);
    push(iv.start, o.emphasisScale);
    push(iv.end, o.emphasisScale);
    push(iv.end + o.ease, o.baseScale);
  }
  // No dedupe: two keys with the same scale are NOT redundant — e.g. the
  // (end+ease, base) key of one sentence and the (start-ease, base) key of
  // the next are both ramp anchors. Dropping one makes the ramp start
  // early and the zoom sit mid-push during a silence (measured 2026-11-17:
  // scale(13.2) read 1.17 instead of 1.0). Only same-t keys collapse,
  // handled in push().
  return keys;
}

/** Generate zoom keyframes from subtitle timing alone (deterministic). */
export function generateAutoZoom(
  subtitles: SubtitleItem[],
  opts?: AutoZoomOptions,
  duration?: number,
): ZoomKeyframe[] {
  const o = resolveOpts(opts);
  return intervalsToKeys(emphasisIntervals(subtitles, o, duration), o);
}

/** Generate zoom keyframes with audio-detected silences dipping to base. */
export function generateAutoZoomWithSilences(
  subtitles: SubtitleItem[],
  silences: SilenceInterval[],
  opts?: AutoZoomOptions,
  duration?: number,
): ZoomKeyframe[] {
  const o = resolveOpts(opts);
  const intervals = applySilences(emphasisIntervals(subtitles, o, duration), silences, o);
  return intervalsToKeys(intervals, o);
}

/** Detect silent spans with FFmpeg silencedetect (audio energy envelope). */
export async function detectSilences(
  audioFile: string,
  opts: { noise?: string; minDuration?: number; ffmpeg?: string } = {},
): Promise<SilenceInterval[]> {
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const noise = opts.noise ?? '-40dB';
  const minDur = opts.minDuration ?? 0.3;
  let stderr = '';
  try {
    const r = await execFileAsync(ffmpeg, [
      '-i', audioFile,
      '-af', `silencedetect=noise=${noise}:d=${minDur}`,
      '-f', 'null', '-',
    ]);
    stderr = (r.stderr as string) ?? '';
  } catch (e) {
    stderr = ((e as { stderr?: string }).stderr ?? '') + ((e as { stdout?: string }).stdout ?? '');
  }
  const silences: SilenceInterval[] = [];
  for (const m of stderr.matchAll(/silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g)) {
    silences.push({ start: Number(m[1]), end: Number(m[2]) });
  }
  return silences;
}

/** Zoom scale at time t (linear interpolation between keys). */
export function zoomScaleAt(keys: ZoomKeyframe[], t: number): number {
  if (keys.length === 0) return 1;
  if (t <= keys[0].t) return keys[0].scale;
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      if (b.t === a.t) return b.scale;
      return a.scale + ((b.scale - a.scale) * (t - a.t)) / (b.t - a.t);
    }
  }
  return keys[keys.length - 1].scale;
}

/** Count emphasis pushes (base -> emphasis transitions) in a key list. */
export function countScalePushes(keys: ZoomKeyframe[], emphasis: number): number {
  let pushes = 0;
  let atEmphasis = false;
  for (const k of keys) {
    if (k.scale >= emphasis - 0.01 && !atEmphasis) {
      pushes++;
      atEmphasis = true;
    } else if (k.scale < emphasis - 0.01) {
      atEmphasis = false;
    }
  }
  return pushes;
}

/** Length of each emphasis plateau in seconds (for the min-hold check). */
export function emphasisPlateaus(keys: ZoomKeyframe[], emphasis: number): number[] {
  const plateaus: number[] = [];
  let start: number | null = null;
  for (const k of keys) {
    if (k.scale >= emphasis - 0.01 && start === null) start = k.t;
    else if (k.scale < emphasis - 0.01 && start !== null) {
      plateaus.push(k.t - start);
      start = null;
    }
  }
  if (start !== null && keys.length > 0) plateaus.push(keys[keys.length - 1].t - start);
  return plateaus;
}
