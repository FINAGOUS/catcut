// Music adaptive-length Remix (P3 batch 5, M4 §8.3 "音乐自适应时长").
// Stretch / shrink a music track to a target duration WITHOUT
// breaking it — beat-aware loop / jump-cut collage over the P1c beat
// grid. atempo is deliberately NOT used: it changes pitch (a 1.5x
// pull would shift everything up ~7 semitones). This module only
// re-orders whole beat bars, so the pitch never moves.
//
// Plan (pure): the source is sliced into bars — [0, beat0), then
// [beat_k, beat_k+1) — and the plan tiles those bars cyclically to
// lengthen, or drops bars evenly to shorten, always cutting ON a
// beat. The last bar is trimmed to land exactly on the target.
// buildRemixAudio renders the plan with ffmpeg trim + concat.
//
// Limits, stated plainly: the beat grid comes from P1c detectBeats
// (energy-onset tracker — it needs percussive / onset-rich audio;
// on legato or ambient music the grid is unreliable and the caller
// should check confidence, same rule as the beat cutter). The splice
// is a hard cut on a beat, not a crossfade — on a steady chord the
// energy is continuous across the splice (that is what the test
// measures); on a track with a reverb tail the tail is cut, which
// the ear hears as a small click. A 25 ms crossfade at splices is a
// later refinement, not in v1. The source must be at least one bar
// long; a target shorter than one bar is refused.
// LGPL: trim/setpts/concat/aresample are native libavfilter — only
// verified on the local GPL 8.1.2 build; re-check on the BtbN LGPL
// 9.0 build at the M2 gate.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectBeats, type BeatGrid } from './beat.js';

const execFileAsync = promisify(execFile);

export interface RemixOptions {
  /** Target duration in seconds (> 0). */
  targetDuration: number;
  /** Beat times (audio-file seconds). When absent, detectBeats runs
   *  on the source (needs percussive audio — see the header). */
  beats?: number[];
  /** Minimum beat-grid confidence to trust (default 0.3). */
  minConfidence?: number;
}

export interface RemixSegment {
  /** Source span in seconds. */
  start: number;
  end: number;
}

export interface RemixPlan {
  segments: RemixSegment[];
  /** Sum of segment durations (= targetDuration within 1 ms). */
  totalDuration: number;
  /** Beats used, in source seconds. */
  beats: number[];
  bpm: number;
}

/** Validate a RemixOptions block; throws on bad values. */
export function validateRemix(opts: RemixOptions): RemixOptions {
  if (!opts || typeof opts.targetDuration !== 'number' ||
    !Number.isFinite(opts.targetDuration) || opts.targetDuration <= 0) {
    throw new Error(`remix: targetDuration ${opts?.targetDuration} must be > 0`);
  }
  if (opts.beats !== undefined) {
    if (!Array.isArray(opts.beats) || opts.beats.length < 2) {
      throw new Error('remix: beats must be an array of at least 2 beat times');
    }
    let prev = -Infinity;
    for (const b of opts.beats) {
      if (typeof b !== 'number' || !Number.isFinite(b) || b < 0 || b <= prev) {
        throw new Error(`remix: beats must be strictly increasing, >= 0 (got ${b})`);
      }
      prev = b;
    }
  }
  if (opts.minConfidence !== undefined && (opts.minConfidence < 0 || opts.minConfidence > 1)) {
    throw new Error(`remix: minConfidence ${opts.minConfidence} outside [0, 1]`);
  }
  return opts;
}

/** Bars of a source: [0, beat0), [beat_k, beat_k+1), [lastBeat, dur). */
export function remixBars(beats: number[], sourceDuration: number): RemixSegment[] {
  const bounds = [0, ...beats.filter((b) => b > 0 && b < sourceDuration), sourceDuration];
  const bars: RemixSegment[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    if (bounds[i + 1] - bounds[i] > 0.01) bars.push({ start: bounds[i], end: bounds[i + 1] });
  }
  return bars;
}

/**
 * Build the splice plan. Lengthen: tile the bars cyclically from the
 * start (bar 0, 1, ... N-1, 0, 1, ...), trimming the final bar to
 * land on the target. Shorten: walk the bars in order, dropping
 * every k-th bar so the kept bars fill the target (the drop stride
 * is chosen so the total lands within one bar of the target, then
 * the final kept bar is trimmed to the exact target). Every splice
 * lands on a beat boundary by construction.
 */
export function planRemix(
  beats: number[],
  sourceDuration: number,
  targetDuration: number,
  bpm = 0,
): RemixPlan {
  if (targetDuration <= 0) throw new Error(`remix: targetDuration ${targetDuration} must be > 0`);
  const bars = remixBars(beats, sourceDuration);
  if (bars.length < 2) {
    throw new Error('remix: need at least 2 bars (source shorter than one beat interval)');
  }
  const barLen = bars.reduce((s, b) => s + (b.end - b.start), 0) / bars.length;
  if (targetDuration < barLen) {
    throw new Error(`remix: targetDuration ${targetDuration} shorter than one bar (~${barLen.toFixed(3)}s)`);
  }
  const segments: RemixSegment[] = [];
  let total = 0;
  if (targetDuration >= sourceDuration - 1e-9) {
    // Lengthen: tile bars cyclically.
    let i = 0;
    while (total < targetDuration - 1e-9) {
      const bar = bars[i % bars.length];
      const want = targetDuration - total;
      const len = bar.end - bar.start;
      if (len <= want + 1e-9) {
        segments.push({ ...bar });
        total += len;
      } else {
        segments.push({ start: bar.start, end: bar.start + want });
        total += want;
      }
      i++;
    }
  } else {
    // Shorten: drop bars evenly. Keep a fraction f = target/source
    // of the bars (rounded), spread through the track.
    const keep = Math.max(1, Math.round(bars.length * (targetDuration / sourceDuration)));
    const stride = bars.length / keep;
    const keptIdx = new Set<number>();
    for (let k = 0; k < keep; k++) keptIdx.add(Math.min(bars.length - 1, Math.floor(k * stride)));
    for (let i = 0; i < bars.length && total < targetDuration - 1e-9; i++) {
      if (!keptIdx.has(i)) continue;
      const bar = bars[i];
      const want = targetDuration - total;
      const len = bar.end - bar.start;
      if (len <= want + 1e-9) {
        segments.push({ ...bar });
        total += len;
      } else {
        segments.push({ start: bar.start, end: bar.start + want });
        total += want;
      }
    }
  }
  return { segments, totalDuration: total, beats, bpm };
}

/**
 * Render a remix plan to an audio file: one atrim per segment,
 * concat back. The output is 48 kHz stereo WAV (the export prep
 * re-encodes it to AAC when it muxes it into the clip).
 */
export async function buildRemixAudio(
  source: string,
  plan: RemixPlan,
  out: string,
  ffmpeg = 'ffmpeg',
): Promise<string> {
  if (plan.segments.length === 0) throw new Error('remix: empty plan (nothing to render)');
  const parts: string[] = [];
  const outs: string[] = [];
  plan.segments.forEach((seg, i) => {
    parts.push(
      `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS,` +
        `aresample=48000,aformat=channel_layouts=stereo[rs${i}]`,
    );
    outs.push(`[rs${i}]`);
  });
  parts.push(`${outs.join('')}concat=n=${plan.segments.length}:v=0:a=1[aout]`);
  await execFileAsync(ffmpeg, [
    '-v', 'error', '-i', source,
    '-filter_complex', parts.join(';'),
    '-map', '[aout]', '-y', out,
  ]);
  return out;
}

/**
 * Full remix: detect the beat grid on the source (or use the given
 * beats), plan the splice, render the audio. Returns the plan and
 * the rendered file. Throws when the grid confidence is below
 * minConfidence — a bad grid would cut in the middle of a phrase.
 */
export async function remixAudio(
  source: string,
  opts: RemixOptions & { ffmpeg?: string },
  out: string,
): Promise<{ plan: RemixPlan; file: string; grid: BeatGrid }> {
  const o = validateRemix(opts);
  let grid: BeatGrid;
  if (o.beats) {
    grid = { bpm: 0, period: 0, beats: o.beats, onsets: o.beats, confidence: 1, duration: 0 };
  } else {
    grid = await detectBeats(source, { ffmpeg: opts.ffmpeg });
    const minConf = o.minConfidence ?? 0.3;
    if (grid.confidence < minConf || grid.beats.length < 2) {
      throw new Error(
        `remix: beat grid unreliable (confidence ${grid.confidence.toFixed(2)} < ${minConf}, ` +
          `${grid.beats.length} beats) — the source needs percussive / onset-rich audio`,
      );
    }
  }
  // Source duration from the grid (or the last beat + one period).
  const srcDur = grid.duration > 0
    ? grid.duration
    : grid.beats[grid.beats.length - 1] + (grid.period || 0.5);
  const plan = planRemix(grid.beats, srcDur, o.targetDuration, grid.bpm);
  const file = await buildRemixAudio(source, plan, out, opts.ffmpeg ?? 'ffmpeg');
  return { plan, file, grid };
}
