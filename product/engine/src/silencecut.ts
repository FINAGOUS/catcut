// One-click silence removal / speech trimming (P3 batch 5, M4 §8.6).
// Reuses P1's silencedetect (autozoom.ts detectSilences) to locate
// silent spans — this batch DELETES or COMPRESSES them, where P1 only
// used silences to drive auto-zoom. Engine layer only.
//
// Two modes:
// - 'delete': silent spans are cut out entirely (the clip is split
//   into the kept segments; timeline duration shrinks by exactly the
//   total silence length).
// - 'compress': silent spans are sped up to `compressFactor` (default
//   0.3x) via a speed curve on the clip — the speech is untouched, the
//   silences shrink to 30% of their length.
//
// Pure model functions (cutSilences / compressSilences) take the
// detected intervals and return new clips; detectSilencesForClip
// runs silencedetect on the clip's source and converts file times to
// clip-local source times. Export prep (export.ts) wires the two
// together when Project.silenceCut is set.
//
// Limits, stated plainly: silencedetect is an energy gate
// (noise threshold in dBFS, min duration), not speech recognition —
// a quiet whisper under the threshold reads as silence, and a loud
// room tone above it does not. The threshold/min-duration defaults
// (-40 dB / 0.3 s) are the P1 probe values; the caller picks them per
// recording. A silence that touches the clip head/tail is cut the
// same way as one in the middle. Speed-curve clips cannot be
// compressed (the silence speed nodes would collide with the
// existing curve — delete mode still works, it splits on source
// time).
// LGPL: silencedetect is a native libavfilter filter, only verified
// on the local GPL 8.1.2 build; re-check on the BtbN LGPL 9.0 build
// at the M2 gate.

import type { Clip, SpeedCurvePoint } from './project.js';
import { detectSilences, type SilenceInterval } from './autozoom.js';

export interface SilenceCutOptions {
  /** 'delete' removes silences; 'compress' speeds them up. */
  mode?: 'delete' | 'compress';
  /** silencedetect noise threshold, e.g. '-40dB' (default '-40dB'). */
  thresholdDb?: string;
  /** Shortest silence to act on, seconds (default 0.3). */
  minDuration?: number;
  /** Compress mode: silences shrink to this fraction of their length
   *  (0.1..1, default 0.3) — implemented as playback speed 1/factor. */
  compressFactor?: number;
}

export const SILENCE_CUT_DEFAULTS: Required<SilenceCutOptions> = {
  mode: 'delete',
  thresholdDb: '-40dB',
  minDuration: 0.3,
  compressFactor: 0.3,
};

/** Validate a SilenceCutOptions block; throws on bad values. */
export function validateSilenceCut(opts: SilenceCutOptions | undefined, what = 'silenceCut'): SilenceCutOptions | undefined {
  if (!opts) return undefined;
  if (opts.mode !== undefined && opts.mode !== 'delete' && opts.mode !== 'compress') {
    throw new Error(`${what}.mode "${opts.mode}" must be 'delete' or 'compress'`);
  }
  if (opts.thresholdDb !== undefined && !/^-\d+(\.\d+)?dB$/.test(opts.thresholdDb)) {
    throw new Error(`${what}.thresholdDb "${opts.thresholdDb}" must look like '-40dB'`);
  }
  if (opts.minDuration !== undefined && (opts.minDuration <= 0 || opts.minDuration > 10)) {
    throw new Error(`${what}.minDuration ${opts.minDuration} outside (0, 10]`);
  }
  if (opts.compressFactor !== undefined && (opts.compressFactor < 0.1 || opts.compressFactor > 1)) {
    throw new Error(`${what}.compressFactor ${opts.compressFactor} outside [0.1, 1]`);
  }
  return opts;
}

/**
 * Clip a silence interval list (clip-local SOURCE seconds, 0 =
 * clip.in) down to the clip range and merge overlaps. Intervals
 * fully outside [0, srcDur] are dropped; partial ones are clamped.
 */
export function clampSilences(silences: SilenceInterval[], srcDur: number): SilenceInterval[] {
  const out: SilenceInterval[] = [];
  for (const s of silences.slice().sort((a, b) => a.start - b.start)) {
    const start = Math.max(0, s.start);
    const end = Math.min(srcDur, s.end);
    if (end - start < 0.01) continue;
    const last = out[out.length - 1];
    if (last && start <= last.end + 1e-9) {
      last.end = Math.max(last.end, end);
    } else {
      out.push({ start, end });
    }
  }
  return out;
}

/**
 * Delete mode: split the clip into the kept (non-silent) source
 * segments. Each kept segment becomes a clip with the same effects
 * (speed, colour, audioFx, ...) and a suffixed id. Returns [] when
 * the whole clip is silent (the caller then deletes the clip).
 * Kept segments shorter than 0.05 s are dropped (encoder jitter).
 */
export function cutSilences(clip: Clip, silences: SilenceInterval[]): Clip[] {
  const srcDur = clip.out - clip.in;
  const sil = clampSilences(silences, srcDur);
  if (sil.length === 0) return [{ ...clip }];
  if ((clip.speedCurve ?? []).length > 0 || clip.beatSpeed || clip.reverse || clip.freezeAt !== undefined) {
    throw new Error(`clip ${clip.id}: silence delete does not support speedCurve/beatSpeed/reverse/freeze yet`);
  }
  const kept: { start: number; end: number }[] = [];
  let cur = 0;
  for (const s of sil) {
    if (s.start > cur + 0.001) kept.push({ start: cur, end: s.start });
    cur = Math.max(cur, s.end);
  }
  if (cur < srcDur - 0.001) kept.push({ start: cur, end: srcDur });
  return kept
    .filter((k) => k.end - k.start >= 0.05)
    .map((k, i) => ({
      ...clip,
      id: kept.length === 1 ? clip.id : `${clip.id}-k${i + 1}`,
      in: clip.in + k.start,
      out: clip.in + k.end,
    }));
}

/**
 * Compress mode: keep the whole clip, but add a speed curve that
 * plays silent spans at `factor` (default 0.3x) and speech at 1x.
 * The clip's base speed must be 1 (a base speed != 1 would compose
 * with the curve in a way the duration math cannot see — the curve
 * nodes are absolute speeds). Returns the clip with a speedCurve.
 */
export function compressSilences(clip: Clip, silences: SilenceInterval[], factor = 0.3): Clip {
  const o = validateSilenceCut({ compressFactor: factor });
  const f = o?.compressFactor ?? 0.3;
  if (clip.speed !== 1) {
    throw new Error(`clip ${clip.id}: silence compress needs base speed 1 (got ${clip.speed})`);
  }
  if ((clip.speedCurve ?? []).length > 0 || clip.beatSpeed) {
    throw new Error(`clip ${clip.id}: silence compress does not support an existing speedCurve/beatSpeed`);
  }
  if (clip.reverse || clip.freezeAt !== undefined) {
    throw new Error(`clip ${clip.id}: silence compress does not support reverse/freeze yet`);
  }
  const srcDur = clip.out - clip.in;
  const sil = clampSilences(silences, srcDur);
  if (sil.length === 0) return { ...clip };
  // Silence plays FASTER (speed 1/factor, e.g. 3.33x for factor 0.3)
  // so it shrinks to factor of its length; speech stays at 1x.
  const fast = 1 / f;
  const nodes: SpeedCurvePoint[] = [{ t: 0, speed: 1 }];
  for (const s of sil) {
    nodes.push({ t: s.start, speed: fast });
    nodes.push({ t: s.end, speed: 1 });
  }
  // Drop a node that lands exactly on the clip end (it would create
  // a zero-length final segment) and collapse duplicate times.
  const cleaned: SpeedCurvePoint[] = [];
  for (const n of nodes) {
    if (n.t >= srcDur - 1e-9) continue;
    const last = cleaned[cleaned.length - 1];
    if (last && Math.abs(last.t - n.t) < 1e-9) last.speed = n.speed;
    else cleaned.push({ ...n });
  }
  return { ...clip, speedCurve: cleaned };
}

/** Total silence length in a (clamped) interval list. */
export function totalSilence(silences: SilenceInterval[], srcDur: number): number {
  return clampSilences(silences, srcDur).reduce((s, iv) => s + (iv.end - iv.start), 0);
}

/**
 * Detect silences inside one clip's source window and return them in
 * clip-local SOURCE seconds (0 = clip.in). Thin wrapper over P1's
 * detectSilences (silencedetect on the file, then re-based).
 */
export async function detectSilencesForClip(
  clip: Clip,
  opts: SilenceCutOptions & { ffmpeg?: string } = {},
): Promise<SilenceInterval[]> {
  const noise = opts.thresholdDb ?? SILENCE_CUT_DEFAULTS.thresholdDb;
  const minDur = opts.minDuration ?? SILENCE_CUT_DEFAULTS.minDuration;
  const all = await detectSilences(clip.source, {
    noise,
    minDuration: minDur,
    ffmpeg: opts.ffmpeg,
  });
  return all
    .map((s) => ({ start: s.start - clip.in, end: s.end - clip.in }))
    .filter((s) => s.end > 0 && s.start < clip.out - clip.in);
}
