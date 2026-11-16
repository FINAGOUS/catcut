// Beat detection + automatic beat-cutting (P1, M4): "节拍检测 + 自动卡点".
// Algorithm (pure TypeScript on decoded PCM — deterministic; the PCM
// decode itself was probed byte-identical 3x on the same file, md5
// 8340643f… — so unlike vidstabdetect there is no library nondeterminism
// hiding in here):
// 1. decode the audio to 16 kHz mono float PCM (ffmpeg, one pass);
// 2. onset envelope = rectified log-energy difference over 1024-sample
//    windows, 256-sample hop (16 ms — timing resolution well inside the
//    50 ms alignment bar);
// 3. BPM = autocorrelation peak of the onset envelope over 60–200 BPM,
//    with a half-lag correction (if the lag at half the peak period
//    scores >= 0.9x the peak, the true tempo is twice the peak lag —
//    e.g. a kick that only lands on beats 1 and 3);
// 4. phase = first strong onset; the grid is anchor + k*period, each
//    beat snapped to the nearest detected onset within 60 ms.
// Limits, stated plainly: this is an energy-onset tracker, not a
// full beat tracker. It needs percussive / onset-rich audio (drums,
// clicks, plucked notes). On legato, ambient or heavily compressed
// audio the onset envelope is flat, `confidence` drops, and the grid
// is unreliable — callers should check `confidence` and warn the user
// instead of cutting blindly. It does not do downbeat detection
// (bar 1 vs bar 2), tempo drift, or multi-tempo songs; the grid is
// one fixed BPM for the whole file.
// LGPL: everything here is our own code + ffmpeg decode (no extra
// filter to re-check); the beat-pulse effect reuses the existing
// zoom-keyframe machinery, and ducking uses sidechaincompress (native
// libavfilter, LGPL part — still to be re-checked on the BtbN LGPL 9.0
// build at the M2 gate, like every other new filter).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Clip, ZoomKeyframe } from './project.js';
import { clipBaseDuration, speedCurveSegments } from './project.js';

const execFileAsync = promisify(execFile);

export interface BeatGrid {
  /** Detected tempo, beats per minute. */
  bpm: number;
  /** Seconds per beat = 60 / bpm. */
  period: number;
  /** Beat timestamps in seconds (audio-file time), from the phase anchor
   *  to the end of the analysed audio. */
  beats: number[];
  /** Detected onset timestamps (audio-file time). */
  onsets: number[];
  /** 0..1: autocorrelation peak at the chosen period divided by the
   *  zero-lag autocorrelation (total onset energy). Clean percussive
   *  audio scores high (~0.5+ on the probe click tracks); flat/legato
   *  audio scores low and the grid should not be trusted. */
  confidence: number;
  /** Analysed audio duration in seconds. */
  duration: number;
}

export interface BeatDetectOptions {
  /** Analysis sample rate (default 16000). */
  sampleRate?: number;
  /** BPM search range (default 60..200). */
  minBpm?: number;
  /** BPM search range (default 60..200). */
  maxBpm?: number;
  /** Onset-strength threshold as a fraction of the strongest onset
   *  (default 0.3). */
  onsetThreshold?: number;
  /** Snap tolerance for grid beats to the nearest onset (default 0.06 s). */
  snapTolerance?: number;
}

const BEAT_DEFAULTS: Required<BeatDetectOptions> = {
  sampleRate: 16000,
  minBpm: 60,
  maxBpm: 200,
  onsetThreshold: 0.3,
  snapTolerance: 0.06,
};

/** Decode an audio file to mono float PCM at `sampleRate` (deterministic). */
export async function decodeAudioMono(
  file: string,
  opts: { sampleRate?: number; ffmpeg?: string } = {},
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const sampleRate = opts.sampleRate ?? 16000;
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const r = await execFileAsync(
    ffmpeg,
    ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-'],
    { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
  );
  const buf = r.stdout as Buffer;
  const samples = new Float32Array(buf.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = buf.readFloatLE(i * 4);
  return { samples, sampleRate };
}

/** Onset envelope: rectified log-energy difference, hop 256 samples. */
function onsetEnvelope(samples: Float32Array, sampleRate: number): { env: Float64Array; hopSec: number } {
  const win = 1024;
  const hop = 256;
  const hopSec = hop / sampleRate;
  const n = Math.max(1, Math.floor((samples.length - win) / hop) + 1);
  const energy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    const off = i * hop;
    for (let j = 0; j < win; j++) {
      const v = samples[off + j];
      e += v * v;
    }
    energy[i] = e / win;
  }
  const env = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const d = Math.log(energy[i] + 1e-12) - Math.log(energy[i - 1] + 1e-12);
    env[i] = d > 0 ? d : 0;
  }
  return { env, hopSec };
}

/** Peak-pick the onset envelope: local maxima above threshold, min
 *  separation 0.12 s. Returns COARSE onset times in seconds — each is
 *  up to one window (64 ms) EARLY, because the log-energy jump fires
 *  as soon as a window first touches the attack (measured 2026-11-17:
 *  coarse onsets sat 52 ms before the true clicks). refineOnsets()
 *  below corrects that. */
function pickOnsets(env: Float64Array, hopSec: number, thresholdFrac: number): number[] {
  let max = 0;
  for (const v of env) if (v > max) max = v;
  if (max <= 0) return [];
  const thr = max * thresholdFrac;
  const minGap = Math.max(1, Math.round(0.12 / hopSec));
  const onsets: number[] = [];
  let last = -minGap - 1;
  for (let i = 1; i + 1 < env.length; i++) {
    if (env[i] >= thr && env[i] >= env[i - 1] && env[i] >= env[i + 1] && i - last >= minGap) {
      onsets.push(i * hopSec);
      last = i;
    }
  }
  return onsets;
}

/** Refine coarse onsets to sample accuracy: for each coarse onset,
 *  scan the raw samples around it for the first |sample| crossing 25%
 *  of the local peak amplitude. A sine burst crosses 25% of peak
 *  within ~1 ms of its true start; a drum attack within a few ms.
 *  Without this the grid sits ~50 ms early (see pickOnsets).
 *  The search window is [-10 ms, +80 ms] around the coarse onset:
 *  the coarse onset fires up to one window (64 ms) BEFORE the attack,
 *  so the attack is always ahead of it — and the peak must be measured
 *  over a window that actually contains the attack. (First version
 *  searched [-80 ms, +40 ms] and set the threshold from the quiet
 *  background drone in front of the click, so it "found" the drone
 *  131 ms early. Measured 2026-11-17.) */
function refineOnsets(
  samples: Float32Array,
  sampleRate: number,
  coarse: number[],
): number[] {
  const out: number[] = [];
  for (const c of coarse) {
    const centre = Math.round(c * sampleRate);
    const lo = Math.max(0, centre - Math.round(0.01 * sampleRate));
    const hi = Math.min(samples.length - 1, centre + Math.round(0.08 * sampleRate));
    let peak = 0;
    for (let i = lo; i <= hi; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    if (peak <= 0) {
      out.push(c);
      continue;
    }
    const thr = 0.25 * peak;
    let found = -1;
    for (let i = lo; i <= hi; i++) {
      if (Math.abs(samples[i]) >= thr) {
        found = i;
        break;
      }
    }
    out.push(found >= 0 ? found / sampleRate : c);
  }
  return out;
}

/** Autocorrelation of the envelope at integer lags (in hops). */
function autocorr(env: Float64Array, lag: number): number {
  let s = 0;
  for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
  return s;
}

/**
 * Detect the beat grid from raw samples. Pure function — no ffmpeg, no
 * I/O — so it is unit-testable and exactly reproducible.
 */
export function detectBeatsFromSamples(
  samples: Float32Array,
  sampleRate: number,
  opts: BeatDetectOptions = {},
): BeatGrid {
  const o = { ...BEAT_DEFAULTS, ...opts };
  if (o.minBpm < 20 || o.maxBpm > 300 || o.minBpm >= o.maxBpm) {
    throw new Error(`beat detect: BPM range [${o.minBpm}, ${o.maxBpm}] invalid`);
  }
  const duration = samples.length / sampleRate;
  const { env, hopSec } = onsetEnvelope(samples, sampleRate);
  const onsets = refineOnsets(
    samples,
    sampleRate,
    pickOnsets(env, hopSec, o.onsetThreshold),
  );
  const ac0 = autocorr(env, 0);
  if (onsets.length < 2 || ac0 <= 0) {
    return { bpm: 0, period: 0, beats: [], onsets, confidence: 0, duration };
  }
  // Autocorrelation peak over the BPM range (lag in hops) — COARSE
  // period only: the hop grid (16 ms) quantises the period to ±8 ms,
  // which would drift the grid by ~60 ms over 15 beats. The period is
  // refined below from the refined onset intervals (median, robust to
  // a missed/extra onset) — measured on the probe click tracks, the
  // median interval lands within 2 ms of the true period.
  const lagForBpm = (bpm: number) => Math.round(60 / bpm / hopSec);
  const minLag = lagForBpm(o.maxBpm);
  const maxLag = lagForBpm(o.minBpm);
  let bestLag = minLag;
  let bestVal = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const v = autocorr(env, lag);
    if (v > bestVal) {
      bestVal = v;
      bestLag = lag;
    }
  }
  // Half-lag correction: if the lag at half the peak period scores
  // >= 0.9x the peak, the true tempo is twice as fast (the envelope
  // only accents every other beat). The reverse correction (double
  // lag) is NOT applied: on a clean periodic click train the double
  // lag scores ~0.97x the peak (N-2 pairs vs N-1), and taking it
  // would halve the true tempo.
  let lag = bestLag;
  const halfLag = Math.round(bestLag / 2);
  if (halfLag >= minLag && autocorr(env, halfLag) >= 0.9 * bestVal) {
    lag = halfLag;
    bestVal = autocorr(env, halfLag);
  }
  const coarsePeriod = lag * hopSec;
  // Refine the period from the median inter-onset interval (intervals
  // within 0.8x..1.25x of the coarse period only — a missed beat gives
  // a 2x interval, a spurious onset a 0.5x one; both are excluded).
  // Fall back to the coarse period if no interval qualifies.
  const intervals: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    if (d >= 0.8 * coarsePeriod && d <= 1.25 * coarsePeriod) intervals.push(d);
  }
  let period = coarsePeriod;
  if (intervals.length > 0) {
    const sorted = intervals.slice().sort((a, b) => a - b);
    period = sorted[Math.floor(sorted.length / 2)];
  }
  const bpm = 60 / period;
  const confidence = Math.min(1, bestVal / ac0);
  // Phase anchor: first onset at >= 50% of the strongest onset.
  let maxOnset = 0;
  for (const v of env) if (v > maxOnset) maxOnset = v;
  const anchor =
    onsets.find((t) => {
      const i = Math.round(t / hopSec);
      return env[i] >= 0.5 * maxOnset;
    }) ?? onsets[0];
  // Grid from the anchor, each beat snapped to the nearest onset.
  const beats: number[] = [];
  for (let t = anchor; t <= duration + 1e-6; t += period) {
    let best = t;
    let bestD = o.snapTolerance;
    for (const on of onsets) {
      const d = Math.abs(on - t);
      if (d < bestD) {
        bestD = d;
        best = on;
      }
    }
    beats.push(best);
  }
  return { bpm, period, beats, onsets, confidence, duration };
}

/** Detect the beat grid of an audio file (ffmpeg decode + pure TS). */
export async function detectBeats(
  file: string,
  opts: BeatDetectOptions & { ffmpeg?: string } = {},
): Promise<BeatGrid> {
  const { samples, sampleRate } = await decodeAudioMono(file, opts);
  return detectBeatsFromSamples(samples, sampleRate, opts);
}

export interface BeatCutOptions {
  /** Shift every cut by this many seconds (default 0; negative cuts
   *  slightly before the beat). Range -0.5..0.5. */
  offset?: number;
  /** Shortest allowed segment in seconds (default 0.5); cuts that
   *  would make a shorter segment are dropped. Range 0.1..5. */
  minSegment?: number;
}

/**
 * Split one clip at the beat grid. Beats are in the clip SOURCE file's
 * time (the grid must have been detected on clip.source); cuts land on
 * beats inside (clip.in, clip.out). Returns new clips with suffixed ids,
 * same speed/volume/effects otherwise. v1 limits: the clip must have a
 * constant speed (no speedCurve), no reverse, no freeze — those make
 * source-time cuts ambiguous; the caller splits first, then adds them.
 */
export function splitClipByBeats(
  clip: Clip,
  grid: BeatGrid,
  opts: BeatCutOptions = {},
): Clip[] {
  const offset = opts.offset ?? 0;
  const minSegment = opts.minSegment ?? 0.5;
  if (offset < -0.5 || offset > 0.5) {
    throw new Error(`clip ${clip.id}: beat-cut offset ${offset} outside [-0.5, 0.5]`);
  }
  if (minSegment < 0.1 || minSegment > 5) {
    throw new Error(`clip ${clip.id}: beat-cut minSegment ${minSegment} outside [0.1, 5]`);
  }
  if (clip.speedCurve && clip.speedCurve.length > 0) {
    throw new Error(`clip ${clip.id}: beat-cut does not support speedCurve yet`);
  }
  if (clip.reverse) {
    throw new Error(`clip ${clip.id}: beat-cut does not support reverse yet`);
  }
  if (clip.freezeAt !== undefined) {
    throw new Error(`clip ${clip.id}: beat-cut does not support freeze yet`);
  }
  const eps = 1e-6;
  const cuts: number[] = [];
  for (const b of grid.beats) {
    const c = b + offset;
    if (c > clip.in + eps && c < clip.out - eps) cuts.push(c);
  }
  cuts.sort((a, b) => a - b);
  // Greedy min-segment filter: keep a cut only if it leaves >= minSegment
  // behind the previous kept cut; then drop a trailing cut that would
  // leave a too-short final segment. The comparisons carry a 1 ms
  // epsilon: refined beat times jitter by ~0.1 ms (sample-accurate,
  // not exact), so a true 0.5 s interval can read 0.499999 s and a
  // strict >= would wrongly drop the cut (measured 2026-11-17: the
  // 2.0 s and 7.5 s cuts of a 120 BPM grid were both dropped).
  const tol = 1e-3;
  const kept: number[] = [];
  let prev = clip.in;
  for (const c of cuts) {
    if (c - prev >= minSegment - tol) {
      kept.push(c);
      prev = c;
    }
  }
  while (kept.length > 0 && clip.out - kept[kept.length - 1] < minSegment - tol) kept.pop();
  const bounds = [clip.in, ...kept, clip.out];
  return bounds.slice(0, -1).map((start, i) => ({
    ...clip,
    id: `${clip.id}-b${i + 1}`,
    in: start,
    out: bounds[i + 1],
  }));
}

export interface BeatPulseOptions {
  /** Scale at rest (default 1.0). */
  baseScale?: number;
  /** Scale at the beat (default 1.15, capped by maxScale). */
  pulseScale?: number;
  /** Hard cap on scale (default 1.6, same as auto-zoom). */
  maxScale?: number;
  /** Ramp up to the pulse, seconds (default 0.08). */
  attack?: number;
  /** Ramp back to base, seconds (default 0.15). */
  release?: number;
}

/**
 * Zoom keyframes for a beat pulse: at each beat the picture pushes in
 * to pulseScale and relaxes back to base. `beats` are clip-local OUTPUT
 * times. Pulses closer together than attack+release merge (the picture
 * holds at pulse instead of dipping between two beats).
 */
export function beatPulseKeys(
  beats: number[],
  opts: BeatPulseOptions = {},
): ZoomKeyframe[] {
  const base = opts.baseScale ?? 1.0;
  const max = opts.maxScale ?? 1.6;
  const pulse = Math.min(opts.pulseScale ?? 1.15, max);
  const attack = opts.attack ?? 0.08;
  const release = opts.release ?? 0.15;
  const sorted = beats.filter((b) => b >= 0).slice().sort((a, b) => a - b);
  const keys: ZoomKeyframe[] = [];
  const push = (t: number, scale: number) => {
    const last = keys[keys.length - 1];
    if (last && Math.abs(last.t - t) < 1e-6) {
      last.scale = scale;
      return;
    }
    keys.push({ t: Math.max(0, t), cx: 0.5, cy: 0.5, scale });
  };
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    const next = sorted[i + 1];
    push(Math.max(0, b - attack), base);
    push(b, pulse);
    // Merge with the next pulse if they would overlap.
    if (next === undefined || next - b >= attack + release) {
      push(b + release, base);
    }
  }
  return keys;
}

/**
 * Apply a beat pulse to a clip: grid beats (source-file time) are
 * converted to clip-local output time via (beat - clip.in) / speed.
 * Same v1 limits as splitClipByBeats (constant speed only).
 */
export function applyBeatPulse(
  clip: Clip,
  grid: BeatGrid,
  opts: BeatPulseOptions = {},
): Clip {
  if (clip.speedCurve && clip.speedCurve.length > 0) {
    throw new Error(`clip ${clip.id}: beat pulse does not support speedCurve yet`);
  }
  if (clip.reverse) {
    throw new Error(`clip ${clip.id}: beat pulse does not support reverse yet`);
  }
  const dur = clipBaseDuration(clip);
  const outBeats = grid.beats
    .map((b) => (b - clip.in) / clip.speed)
    .filter((t) => t >= 0 && t <= dur);
  return { ...clip, zoom: beatPulseKeys(outBeats, opts) };
}
