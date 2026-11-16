// Audio-visual auto-alignment (P1, M4): "音画自动对齐".
// Problem: the camera audio and a separately recorded mic track of the
// same take start at different times. Solution: estimate the time offset
// between the two audio files by cross-correlation, then shift one
// track by that offset (Clip.audioOffset, applied in the filter graph).
//
// Algorithm (pure TypeScript on decoded PCM — deterministic; the PCM
// decode itself was probed byte-identical 3x on the same file, md5
// 8340643f… in the P1c batch — so unlike vidstabdetect there is no
// library nondeterminism hiding in here):
// 1. decode both files to 16 kHz mono float PCM (ffmpeg, one pass);
// 2. coarse lag: normalised cross-correlation of the 10 ms RMS
//    envelopes over ±maxOffsetSec (default 5 s). Envelopes are used
//    because raw-sample correlation over a 5 s search range is
//    800x more work for no gain at the coarse stage, and the envelope
//    is robust to the small level/EQ differences between a camera mic
//    and an external mic;
// 3. fine lag: raw-sample normalised cross-correlation around the
//    coarse lag (±30 ms), over a 1 s window centred on the strongest
//    envelope peak of the reference — sample-accurate offset;
// 4. confidence: the peak normalised correlation, plus the ratio of
//    the peak to the second-best peak outside ±0.1 s of it. When the
//    two files share nothing (different noise, or one is silent) the
//    peak is low and flat — the result is flagged unreliable instead
//    of inventing a fake offset.
// Sign convention: estimateOffset(ref, target) returns d such that
// target(t) ≈ ref(t − d). Positive d = the target LAGS the reference
// (it starts later). To align the target to the reference, shift the
// target EARLIER by d, i.e. Clip.audioOffset = −d (see
// shiftClipAudioToReference below).
// Limits, stated plainly: this is a global-offset estimator, not a
// drift corrector — it assumes one constant offset for the whole file
// (no clock drift between recorders). It needs SOME shared content
// with energy (speech, claps, clicks); on pure silence or on two
// unrelated recordings it returns reliable=false and the caller must
// fall back to manual nudge. Periodic signals (a metronome, a
// repeating loop) alias — several lags score equally and peakRatio
// drops, which is exactly what `reliable` is for.
// LGPL: everything here is our own code + ffmpeg decode (no extra
// filter to re-check); the shift itself uses adelay/atrim/apad
// (native libavfilter, LGPL part — still to be re-checked on the
// BtbN LGPL 9.0 build at the M2 gate, like every other new filter).

import { decodeAudioMono } from './beat.js';
import { clipDuration, type Clip } from './project.js';

export interface AlignResult {
  /** Offset in seconds: target(t) ≈ ref(t − offsetSec). Positive =
   *  the target lags the reference. */
  offsetSec: number;
  /** 0..1: peak normalised cross-correlation of the envelopes. */
  confidence: number;
  /** Peak / second-best peak (second peak outside ±0.1 s of the
   *  peak). Near 1 = ambiguous (periodic content, or no shared
   *  content at all). */
  peakRatio: number;
  /** True when the estimate is trustworthy: confidence and peakRatio
   *  both pass their bars (see RELIABLE_* below). When false, the
   *  offset is the best lag found but must NOT be applied blindly. */
  reliable: boolean;
  /** Lag search range used, seconds. */
  searchRangeSec: number;
}

export interface AlignOptions {
  /** Analysis sample rate (default 16000). */
  sampleRate?: number;
  /** Maximum |offset| searched, seconds (default 5). */
  maxOffsetSec?: number;
  /** Minimum confidence for `reliable` (default 0.5). */
  minConfidence?: number;
  /** Minimum peakRatio for `reliable` (default 1.2). */
  minPeakRatio?: number;
}

const ALIGN_DEFAULTS: Required<AlignOptions> = {
  sampleRate: 16000,
  maxOffsetSec: 5,
  minConfidence: 0.5,
  // Probe 2026-11-17 (irregular bursts, 3x identical): matched content
  // conf=1.000, peakRatio 1.38–1.39; unrelated noise conf 0.095–0.114,
  // peakRatio 1.01–1.02; silence conf 0. The 1.2 bar sits between the
  // matched ratio (1.38) and the ambiguous ratio (~1.0) with margin
  // on both sides; the confidence bar (0.5) separates cleanly.
  minPeakRatio: 1.2,
};

/** RMS of a sample array (0 for empty/silent input). */
function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let s = 0;
  for (const v of samples) s += v * v;
  return Math.sqrt(s / samples.length);
}

/** 10 ms RMS envelope (one value per 160 samples at 16 kHz). */
function rmsEnvelope(samples: Float32Array, sampleRate: number): Float64Array {
  const win = Math.max(1, Math.round(0.01 * sampleRate));
  const n = Math.max(1, Math.floor(samples.length / win));
  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const off = i * win;
    for (let j = 0; j < win; j++) {
      const v = samples[off + j];
      s += v * v;
    }
    env[i] = Math.sqrt(s / win);
  }
  return env;
}

/**
 * Normalised cross-correlation of two envelopes at integer lags (in
 * envelope steps). Returns the correlation array indexed by
 * lag + maxLag, where lag > 0 means the target lags the reference.
 * Each lag is normalised over its own overlap, so short overlaps do
 * not score higher than long ones.
 */
function envelopeXcorr(
  a: Float64Array,
  b: Float64Array,
  maxLag: number,
): Float64Array {
  const out = new Float64Array(2 * maxLag + 1);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    // Overlap: a[i] with b[i + lag]; i ranges so both indexes are in range.
    const i0 = Math.max(0, -lag);
    const i1 = Math.min(a.length, b.length - lag);
    if (i1 - i0 < 8) {
      out[lag + maxLag] = 0;
      continue;
    }
    let meanA = 0;
    let meanB = 0;
    for (let i = i0; i < i1; i++) {
      meanA += a[i];
      meanB += b[i + lag];
    }
    meanA /= i1 - i0;
    meanB /= i1 - i0;
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let i = i0; i < i1; i++) {
      const da = a[i] - meanA;
      const db = b[i + lag] - meanB;
      ab += da * db;
      aa += da * da;
      bb += db * db;
    }
    out[lag + maxLag] = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
  }
  return out;
}

/**
 * Fine refinement on raw samples: correlate a 1 s window of the
 * reference (centred on its strongest envelope peak) against the
 * target around the coarse lag (±30 ms). Returns the refined offset
 * in seconds. Pure function — deterministic.
 */
function refineOffsetRaw(
  ref: Float32Array,
  target: Float32Array,
  sampleRate: number,
  coarseSec: number,
): number {
  const win = Math.round(0.01 * sampleRate);
  const env = rmsEnvelope(ref, sampleRate);
  let peakIdx = 0;
  let peakVal = -1;
  for (let i = 0; i < env.length; i++) {
    if (env[i] > peakVal) {
      peakVal = env[i];
      peakIdx = i;
    }
  }
  const centre = peakIdx * win;
  const half = Math.round(0.5 * sampleRate);
  const r0 = Math.max(0, centre - half);
  const r1 = Math.min(ref.length, centre + half);
  if (r1 - r0 < 0.1 * sampleRate) return coarseSec;
  const coarseSamples = Math.round(coarseSec * sampleRate);
  const search = Math.round(0.03 * sampleRate);
  let bestLag = coarseSamples;
  let bestVal = -Infinity;
  for (let lag = coarseSamples - search; lag <= coarseSamples + search; lag++) {
    const t0 = r0 + lag;
    const t1 = r1 + lag;
    if (t0 < 0 || t1 > target.length) continue;
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let i = r0; i < r1; i++) {
      const x = ref[i];
      const y = target[i + lag];
      ab += x * y;
      aa += x * x;
      bb += y * y;
    }
    const v = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
    if (v > bestVal) {
      bestVal = v;
      bestLag = lag;
    }
  }
  return bestLag / sampleRate;
}

/**
 * Estimate the offset between two audio signals (pure function on
 * decoded PCM — no ffmpeg, no I/O — so it is unit-testable and
 * exactly reproducible).
 */
export function estimateOffsetFromSamples(
  ref: Float32Array,
  target: Float32Array,
  sampleRate: number,
  opts: AlignOptions = {},
): AlignResult {
  const o = { ...ALIGN_DEFAULTS, ...opts };
  const searchRangeSec = o.maxOffsetSec;
  const silent: AlignResult = {
    offsetSec: 0,
    confidence: 0,
    peakRatio: 1,
    reliable: false,
    searchRangeSec,
  };
  if (ref.length === 0 || target.length === 0) return silent;
  if (rms(ref) < 1e-4 || rms(target) < 1e-4) return silent;
  const envA = rmsEnvelope(ref, sampleRate);
  const envB = rmsEnvelope(target, sampleRate);
  const hopSec = 0.01;
  const maxLag = Math.max(1, Math.round(o.maxOffsetSec / hopSec));
  const xc = envelopeXcorr(envA, envB, maxLag);
  let peakIdx = 0;
  let peakVal = -Infinity;
  for (let i = 0; i < xc.length; i++) {
    if (xc[i] > peakVal) {
      peakVal = xc[i];
      peakIdx = i;
    }
  }
  const peakLag = peakIdx - maxLag;
  // Second-best peak outside ±0.1 s (10 envelope steps) of the peak.
  const guard = Math.round(0.1 / hopSec);
  let secondVal = -Infinity;
  for (let i = 0; i < xc.length; i++) {
    if (Math.abs(i - peakIdx) <= guard) continue;
    if (xc[i] > secondVal) secondVal = xc[i];
  }
  const peakRatio =
    secondVal > 0.01 ? peakVal / secondVal : peakVal > 0.01 ? Infinity : 1;
  const coarseSec = peakLag * hopSec;
  const offsetSec = refineOffsetRaw(ref, target, sampleRate, coarseSec);
  const reliable =
    peakVal >= o.minConfidence && peakRatio >= o.minPeakRatio;
  return {
    offsetSec,
    confidence: Math.max(0, Math.min(1, peakVal)),
    peakRatio,
    reliable,
    searchRangeSec,
  };
}

/** Estimate the offset between two audio files (ffmpeg decode + pure TS). */
export async function estimateOffset(
  refFile: string,
  targetFile: string,
  opts: AlignOptions & { ffmpeg?: string } = {},
): Promise<AlignResult> {
  const { samples: ref, sampleRate } = await decodeAudioMono(refFile, opts);
  const { samples: target } = await decodeAudioMono(targetFile, opts);
  return estimateOffsetFromSamples(ref, target, sampleRate, opts);
}

/**
 * Return a copy of the clip with its audio shifted so it lines up
 * with the reference the offset was measured against.
 * `offsetSec` is the estimateOffset() result for THIS clip's audio
 * (positive = the clip audio lags the reference): the audio is
 * shifted earlier by that amount, i.e. audioOffset = −offsetSec.
 * audioOffset semantics (Clip.audioOffset): shift the clip's audio
 * relative to its video, in OUTPUT seconds (after speed); positive =
 * audio plays later (delayed), negative = audio plays earlier.
 */
export function shiftClipAudioToReference(clip: Clip, offsetSec: number): Clip {
  if (!Number.isFinite(offsetSec)) {
    throw new Error(`clip ${clip.id}: alignment offset must be a finite number`);
  }
  return { ...clip, audioOffset: -offsetSec };
}

/**
 * Validate a clip's audioOffset. Throws on out-of-range values and on
 * a shift as long as (or longer than) the clip itself — that would
 * leave nothing but silence / cut the whole audio away.
 */
export function validateAudioOffset(clip: Clip): number | undefined {
  const d = clip.audioOffset;
  if (d === undefined) return undefined;
  if (!Number.isFinite(d)) {
    throw new Error(`clip ${clip.id}: audioOffset must be finite`);
  }
  if (Math.abs(d) > 10) {
    throw new Error(`clip ${clip.id}: audioOffset ${d} outside [-10, 10] s`);
  }
  if (Math.abs(d) >= clipDuration(clip)) {
    throw new Error(
      `clip ${clip.id}: audioOffset ${d} as long as the clip itself (${clipDuration(clip).toFixed(2)} s)`,
    );
  }
  return d;
}

/**
 * FFmpeg filter fragment that shifts an audio stream by `offsetSec`
 * seconds while keeping its total duration at `durationSec`.
 * Positive offset = audio later: adelay pads the head, then trim
 * back to duration. Negative offset = audio earlier: cut the head,
 * then pad silence at the tail. Both are native libavfilter filters
 * (LGPL part — still to be re-checked on the BtbN LGPL 9.0 build at
 * the M2 gate, like every other new filter).
 */
export function audioShiftFilter(offsetSec: number, durationSec: number): string {
  if (offsetSec === 0) return 'anull';
  if (offsetSec > 0) {
    const ms = Math.round(offsetSec * 1000);
    return (
      `adelay=${ms}:all=1,atrim=start=0:end=${durationSec},` +
      `asetpts=PTS-STARTPTS`
    );
  }
  const cut = -offsetSec;
  return (
    `atrim=start=${cut},asetpts=PTS-STARTPTS,` +
    `apad=whole_dur=${durationSec},atrim=start=0:end=${durationSec},` +
    `asetpts=PTS-STARTPTS`
  );
}
