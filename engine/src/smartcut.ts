// Smart cut (P3 batch 2, M4 §8.7 + direction doc §三): scene detection,
// voice/music classification, subject tracking, vertical reframe,
// auto-follow zoom. All local: FFmpeg scene detection + TS feature
// analysis + the P1e ONNX portrait mask for tracking. No cloud.
//
// Honest limits (also in the build log):
// - The voice/music classifier is a HEURISTIC on measured audio
//   features, not an AI model. Its thresholds come from the probe
//   (tmp/probe-p3b.mjs, 2026-11-17) on synthetic sources only:
//   voice = tone bursts with pauses + pitch changes, music =
//   continuous 3-note chord, silence = digital zeros. Real voice /
//   real music accuracy is for the user to judge on real footage;
//   anything the features cannot separate is labelled 'unknown',
//   never force-guessed. Spectral features are averaged over ACTIVE
//   windows only (a music+silence mix reads flat 0.55 over all
//   windows but 0.109 over active ones — the silent half carries no
//   spectrum and must not vote).
// - Tracking follows the PERSON via the P1e portrait mask (one
//   subject: the largest mask mass). It is not arbitrary-object
//   tracking (M4 §8.7 对象追踪 stays 未做).
// - Reframe / follow-zoom require speed 1, no reverse/freeze — the
//   trajectory is in source time, so any resampling would desync it
//   (same rule as portraitCutout).
// - LGPL note: select/showinfo, crop, fps, format are native
//   libavfilter filters, but they have only been verified on this
//   machine's GPL 8.1.2 build — re-check each on the BtbN LGPL 9.0
//   build at the M2 gate (select, crop, fps, format are on the list).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  clipDuration,
  type Clip,
  type FollowZoomOptions,
  type Project,
  type ReframeOptions,
  type ZoomKeyframe,
} from './project.js';
import {
  defaultPortraitModelPath,
  defaultPortraitScriptPath,
  PORTRAIT_SETUP,
  probeVideoFps,
  resolvePortraitModelPath,
} from './portrait.js';

const execFileAsync = promisify(execFile);

function run(cmd: string, args: string[], binary = false): Promise<{ stdout: Buffer | string; stderr: string }> {
  return execFileAsync(cmd, args, {
    maxBuffer: 512 * 1024 * 1024,
    ...(binary ? { encoding: 'buffer' } : {}),
  }) as Promise<{ stdout: Buffer | string; stderr: string }>;
}

// ---------------------------------------------------------------------------
// Scene detection
// ---------------------------------------------------------------------------

/** Default scene threshold (FFmpeg select `scene` var, 0..1). */
export const DEFAULT_SCENE_THRESHOLD = 0.4;
export const SCENE_THRESHOLD_MIN = 0.05;
export const SCENE_THRESHOLD_MAX = 0.95;

export interface SceneCut {
  /** Clip-local SOURCE time in seconds (0 = the clip's `in`). */
  t: number;
}

export interface SceneSegment {
  start: number;
  end: number;
}

export function validateSceneThreshold(threshold: number | undefined, id: string): void {
  if (threshold === undefined) return;
  if (threshold < SCENE_THRESHOLD_MIN || threshold > SCENE_THRESHOLD_MAX) {
    throw new Error(
      `clip ${id}: sceneThreshold ${threshold} outside [${SCENE_THRESHOLD_MIN}, ${SCENE_THRESHOLD_MAX}]`,
    );
  }
}

export interface DetectScenesOptions {
  threshold?: number;
  /** Source time to start from (default 0 = file start). */
  from?: number;
  /** How many seconds to analyse (default to end of file). */
  duration?: number;
  ffmpeg?: string;
}

/**
 * Detect scene cuts with FFmpeg `select='gt(scene,threshold)'` +
 * showinfo. Returns cut times in clip-local source seconds (0 = `from`).
 * Probe-measured 2026-11-17: on a 6 s red / bright-green / blue hard-cut
 * video, thresholds 0.3/0.4/0.5 all return exactly [2.0, 4.0].
 * (Named colour "green" is dark green 0x008000 — its luma 81 equals
 * red's, so the red->green cut is invisible to the detector. The probe
 * and the tests use bright green 0x00FF00. Do not "fix" the test video
 * back to the named colour.)
 */
export async function detectScenes(
  file: string,
  opts: DetectScenesOptions = {},
): Promise<SceneCut[]> {
  const threshold = opts.threshold ?? DEFAULT_SCENE_THRESHOLD;
  validateSceneThreshold(threshold, file);
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  // Clip-local times (0 = `from`): trim + setpts re-base the stream
  // before select, so the returned pts_time is already clip-local.
  // (Input -ss seeking was tried first: showinfo then reports FILE
  // times, not clip-local ones, and the first frame after the seek
  // has no predecessor to score against — trim is the honest route.)
  const from = opts.from ?? 0;
  let vf: string;
  if (from > 0 || opts.duration !== undefined) {
    const trimEnd = opts.duration !== undefined ? `:end=${from + opts.duration}` : '';
    vf = `trim=start=${from}${trimEnd},setpts=PTS-STARTPTS,select='gt(scene,${threshold})',showinfo`;
  } else {
    vf = `select='gt(scene,${threshold})',showinfo`;
  }
  const args: string[] = [
    '-v', 'info', '-i', file,
    '-vf', vf,
    '-f', 'null', '-',
  ];
  let stderr = '';
  try {
    ({ stderr } = await run(ffmpeg, args));
  } catch (e) {
    stderr = ((e as { stderr?: string }).stderr ?? '') + ((e as { stdout?: string }).stdout ?? '');
  }
  const cuts: SceneCut[] = [];
  for (const line of stderr.split('\n')) {
    if (!line.includes('Parsed_showinfo')) continue;
    const m = line.match(/pts_time:\s*([\d.]+)/);
    if (m) cuts.push({ t: Number(m[1]) });
  }
  return cuts;
}

/** Turn cut times into [start, end) segments over [0, duration). Cuts
 *  closer than 0.1 s apart collapse to the first (encoder jitter). */
export function scenesToSegments(cuts: SceneCut[], duration: number): SceneSegment[] {
  const bounds = [0];
  for (const c of cuts.slice().sort((a, b) => a.t - b.t)) {
    if (c.t <= 0 || c.t >= duration) continue;
    if (c.t - bounds[bounds.length - 1] < 0.1) continue;
    bounds.push(c.t);
  }
  bounds.push(duration);
  const segs: SceneSegment[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    if (bounds[i + 1] - bounds[i] > 0.001) segs.push({ start: bounds[i], end: bounds[i + 1] });
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Voice / music classification (heuristic on measured audio features)
// ---------------------------------------------------------------------------

export type AudioClass = 'voice' | 'music' | 'silence' | 'unknown';

/** Goertzel probe frequencies (log-spaced 100 Hz..8 kHz). */
const CLASSIFY_FREQS: number[] = [];
for (let f = 100; f <= 8000; f *= 1.35) CLASSIFY_FREQS.push(Math.round(f));

const CLASSIFY_SAMPLE_RATE = 16000;
const CLASSIFY_WINDOW_S = 0.1;
/** A 100 ms window counts as "active" above this RMS. */
const ACTIVE_RMS_DB = -45;
/** Segments shorter than this have too few windows to judge. */
const CLASSIFY_MIN_SEGMENT_S = 0.3;

export interface ClassifiedSegment {
  start: number;
  end: number;
  label: AudioClass;
  /** 0..1. 'unknown' always carries 0 — the classifier abstains. */
  confidence: number;
  /** Mean window RMS in dB (silent windows read -240, so this is
   *  dragged down for bursty audio — see activeRmsDb). */
  meanRmsDb: number;
  /** Mean window RMS over active windows only (-240 if none). */
  activeRmsDb: number;
  /** Std-dev of window RMS in dB (bimodal for voice: loud bursts +
   *  silent gaps; ~0 for a steady chord). */
  rmsStdDb: number;
  /** Fraction of windows above ACTIVE_RMS_DB. */
  fracActive: number;
  /** Mean zero-crossing rate over ACTIVE windows (crossings/second,
   *  reported only — it does not separate the probe sources: voice
   *  928, music 532). */
  meanZcr: number;
  /** Mean spectral flatness over ACTIVE windows, 0..1 (tonal = low,
   *  noisy = high). Silent windows are excluded: their spectrum is
   *  undefined (flat reads 1.0) and would otherwise drag a
   *  half-silent segment toward "voice" (measured 2026-11-17: a
   *  music+silence mix read flat 0.55 over all windows, 0.109 over
   *  active ones). No active windows -> reported as 1.0. */
  meanFlat: number;
  /** Std-dev of the per-window dominant Goertzel frequency over
   *  ACTIVE windows, in Hz (voice changes pitch, a chord does not). */
  peakFreqStd: number;
  /** Number of distinct dominant frequencies across windows. */
  uniqPeakFreqs: number;
}

function goertzel(x: Float32Array, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr;
  const c = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    s0 = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const p = s1 * s1 + s2 * s2 - c * s1 * s2;
  return Math.sqrt(Math.max(0, p)) / x.length;
}

function mean(a: number[]): number {
  return a.length === 0 ? 0 : a.reduce((s, v) => s + v, 0) / a.length;
}

function std(a: number[]): number {
  if (a.length === 0) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function meanOr(a: number[], fallback: number): number {
  return a.length === 0 ? fallback : mean(a);
}

function stdOr(a: number[]): number {
  return a.length === 0 ? 0 : std(a);
}

/**
 * Feature aggregates for one [start, end) slice of decoded mono audio.
 * Windows are non-overlapping 100 ms slices fully inside the segment.
 * Spectral features (flatness, dominant pitch, zero-crossing rate)
 * are averaged over ACTIVE windows only — silent windows carry no
 * spectrum and would otherwise corrupt them (see meanFlat).
 */
export function audioSegmentFeatures(
  samples: Float32Array,
  sampleRate: number,
  start: number,
  end: number,
): Omit<ClassifiedSegment, 'label' | 'confidence'> {
  const win = Math.floor(sampleRate * CLASSIFY_WINDOW_S);
  const w0 = Math.ceil(start / CLASSIFY_WINDOW_S);
  const w1 = Math.floor(end / CLASSIFY_WINDOW_S);
  const rmsDb: number[] = [];
  const zcrActive: number[] = [];
  const flatActive: number[] = [];
  const peakFActive: number[] = [];
  for (let w = w0; w < w1; w++) {
    const off = w * win;
    if (off + win > samples.length) break;
    const x = samples.subarray(off, off + win);
    let sum = 0;
    let zc = 0;
    for (let i = 0; i < x.length; i++) {
      sum += x[i] * x[i];
      if (i > 0 && x[i] !== 0 && Math.sign(x[i]) !== Math.sign(x[i - 1])) zc++;
    }
    const rms = Math.sqrt(sum / x.length);
    const db = 20 * Math.log10(rms + 1e-12);
    rmsDb.push(db);
    if (db <= ACTIVE_RMS_DB) continue;
    zcrActive.push(zc / CLASSIFY_WINDOW_S);
    const mags = CLASSIFY_FREQS.map((f) => goertzel(x, f, sampleRate) + 1e-12);
    const geo = Math.exp(mags.reduce((a, m) => a + Math.log(m), 0) / mags.length);
    flatActive.push(geo / (mean(mags) || 1e-12));
    let bi = 0;
    for (let i = 1; i < mags.length; i++) if (mags[i] > mags[bi]) bi = i;
    peakFActive.push(CLASSIFY_FREQS[bi]);
  }
  const active = rmsDb.filter((v) => v > ACTIVE_RMS_DB);
  return {
    start,
    end,
    meanRmsDb: rmsDb.length > 0 ? mean(rmsDb) : -240,
    activeRmsDb: active.length > 0 ? mean(active) : -240,
    rmsStdDb: std(rmsDb),
    fracActive: rmsDb.length > 0 ? active.length / rmsDb.length : 0,
    meanZcr: meanOr(zcrActive, 0),
    meanFlat: meanOr(flatActive, 1.0),
    peakFreqStd: stdOr(peakFActive),
    uniqPeakFreqs: new Set(peakFActive).size,
  };
}

/**
 * Rule-based classification. Thresholds are the probe measurements
 * (tmp/probe-p3b.mjs + tmp/probe-p3b2.mjs, 2026-11-17), not guesses —
 * spectral features are active-window means (see audioSegmentFeatures):
 *   voice (PCM): fracActive 0.75, flat 0.343, peakFreqStd 76, rmsStd 96.36
 *   voice (AAC-decoded, 1 s windows): fracActive 0.80, flat 0.128-0.205,
 *     peakFreqStd 52-68, rmsStd 67.3
 *   music:  fracActive 1.00, flat 0.109, peakFreqStd 0,  rmsStd 0.01
 *   silence: fracActive 0.00, meanRms -240, flat 1.000
 * Voice is gated on burstiness + energy variance + pitch movement —
 * NOT on flatness: flatness is codec-sensitive (AAC strips the
 * low-level burst noise, so the same voice reads flat 0.324 on PCM
 * but 0.128-0.205 after AAC — the "noisy spectrum" marker does not
 * survive the codec). Music is still gated on flatness (a steady
 * chord stays tonal through AAC). A music+silence mix is bursty
 * like voice but its active windows are a steady chord (peakFreqStd
 * 0), so it falls through to 'unknown'. Confidence is the smallest
 * margin to a deciding threshold, mapped 0.5..1 — a segment sitting
 * on a threshold scores ~0.5. Anything the rules cannot separate
 * returns 'unknown' with confidence 0.
 */
export function classifyFeatures(
  f: Omit<ClassifiedSegment, 'label' | 'confidence'>,
): { label: AudioClass; confidence: number } {
  if (f.fracActive < 0.05) {
    return { label: 'silence', confidence: 0.9 + 0.1 * (1 - f.fracActive / 0.05) };
  }
  if (f.fracActive >= 0.95 && f.rmsStdDb <= 2 && f.meanFlat <= 0.25) {
    const m = Math.min(
      (f.fracActive - 0.95) / 0.05,
      (2 - f.rmsStdDb) / 2,
      (0.25 - f.meanFlat) / 0.25,
    );
    return { label: 'music', confidence: clamp01(0.5 + 0.5 * m) };
  }
  if (
    f.fracActive >= 0.2 && f.fracActive <= 0.9 &&
    f.rmsStdDb >= 5 && f.peakFreqStd >= 30
  ) {
    const m = Math.min(
      Math.min(f.fracActive - 0.2, 0.9 - f.fracActive) / 0.35,
      (f.rmsStdDb - 5) / 5,
      (f.peakFreqStd - 30) / 30,
    );
    return { label: 'voice', confidence: clamp01(0.5 + 0.5 * m) };
  }
  return { label: 'unknown', confidence: 0 };
}

/** Decode a file to mono float32 PCM at 16 kHz (throws when the file
 *  has no audio stream). */
export async function decodeAudioMonoF32(
  file: string,
  ffmpeg = 'ffmpeg',
): Promise<Float32Array> {
  let stdout: Buffer;
  try {
    ({ stdout } = (await run(ffmpeg, [
      '-v', 'error', '-i', file,
      '-f', 'f32le', '-ac', '1', '-ar', String(CLASSIFY_SAMPLE_RATE), '-',
    ], true)) as { stdout: Buffer; stderr: string });
  } catch (e) {
    throw new Error(
      `${file}: no decodable audio stream for smartcut analysis (${((e as { stderr?: string }).stderr ?? String(e)).trim().split('\n').pop()})`,
    );
  }
  if (stdout.length < 4) {
    throw new Error(`${file}: no audio stream (smartcut audio analysis needs audio)`);
  }
  const ab = stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.length);
  return new Float32Array(ab);
}

/** Does the file have an audio stream? (ffprobe, no decode.) */
export async function hasAudio(file: string, ffprobe = 'ffprobe'): Promise<boolean> {
  try {
    const { stdout } = await run(ffprobe, [
      '-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index', '-of', 'csv=p=0', file,
    ]);
    return String(stdout).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Classify each [start, end) segment of a file (file seconds). The
 * audio is decoded once; segments shorter than 0.3 s get 'unknown'
 * (too few 100 ms windows to judge) instead of a guess.
 */
export async function analyzeAudioSegments(
  file: string,
  segments: { start: number; end: number }[],
  opts: { ffmpeg?: string } = {},
): Promise<ClassifiedSegment[]> {
  for (const s of segments) {
    if (s.start < 0 || s.end <= s.start) {
      throw new Error(`analyzeAudioSegments: bad segment [${s.start}, ${s.end})`);
    }
  }
  const samples = await decodeAudioMonoF32(file, opts.ffmpeg ?? 'ffmpeg');
  return segments.map((s) => {
    if (s.end - s.start < CLASSIFY_MIN_SEGMENT_S) {
      return {
        ...audioSegmentFeatures(samples, CLASSIFY_SAMPLE_RATE, s.start, s.end),
        label: 'unknown' as AudioClass,
        confidence: 0,
      };
    }
    const f = audioSegmentFeatures(samples, CLASSIFY_SAMPLE_RATE, s.start, s.end);
    return { ...f, ...classifyFeatures(f) };
  });
}

// ---------------------------------------------------------------------------
// Subject tracking (from the P1e portrait mask video)
// ---------------------------------------------------------------------------

export interface TrackPoint {
  /** Clip-local time in seconds (0 = the clip's `in`). */
  t: number;
  /** Subject centre as fractions of frame width/height (0..1). */
  x: number;
  y: number;
  /** True when the frame had too little mask mass to locate anyone. */
  lost: boolean;
  /** Mask mass fraction of the frame (0..~0.75). */
  mass: number;
}

export interface SubjectTrack {
  points: TrackPoint[];
  sampleFps: number;
  width: number;
  height: number;
}

/** Tracking sample rate (frames per second pulled from the mask video). */
export const TRACK_SAMPLE_FPS = 5;
/** Mask mass below this fraction of the frame counts as "no subject". */
export const TRACK_MASS_MIN = 0.005;
/** Luma below this is treated as background when weighting the
 *  centroid (mask background reads ~16, the person ~235). */
const TRACK_BG_LUMA = 64;

async function probeVideoSize(
  file: string,
  ffprobe = 'ffprobe',
): Promise<{ width: number; height: number }> {
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ]);
  const [w, h] = String(stdout).trim().split(',').map(Number);
  if (!w || !h) throw new Error(`cannot read size of ${file}`);
  return { width: w, height: h };
}

export interface TrackFromMaskOptions {
  sampleFps?: number;
  width?: number;
  height?: number;
  ffmpeg?: string;
  ffprobe?: string;
}

/**
 * Track the subject centre from a grayscale mask video (the P1e
 * portrait mask, or any grayscale video with a bright subject on a
 * dark background). One point per sampled frame; a frame with too
 * little mask mass is marked lost and parks at the last known
 * position — the position is never invented.
 * Probe-measured 2026-11-17: a disc moving left->right over 4 s
 * tracks monotonically from x=0.156 to x=0.844 (40 points at 10 fps).
 */
export async function trackFromMaskVideo(
  maskVideo: string,
  opts: TrackFromMaskOptions = {},
): Promise<SubjectTrack> {
  const sampleFps = opts.sampleFps ?? TRACK_SAMPLE_FPS;
  const ffprobe = opts.ffprobe ?? 'ffprobe';
  const { width, height } =
    opts.width !== undefined && opts.height !== undefined
      ? { width: opts.width, height: opts.height }
      : await probeVideoSize(maskVideo, ffprobe);
  const { stdout } = (await run(opts.ffmpeg ?? 'ffmpeg', [
    '-v', 'error', '-i', maskVideo,
    '-vf', `fps=fps=${sampleFps},format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], true)) as { stdout: Buffer; stderr: string };
  const frameSize = width * height;
  const n = Math.floor(stdout.length / frameSize);
  if (n === 0) {
    throw new Error(`trackFromMaskVideo: no frames decoded from ${maskVideo}`);
  }
  const points: TrackPoint[] = [];
  let lastX = 0.5;
  let lastY = 0.5;
  for (let f = 0; f < n; f++) {
    const fr = stdout.subarray(f * frameSize, (f + 1) * frameSize);
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const w = Math.max(0, fr[y * width + x] - TRACK_BG_LUMA);
        sx += w * x;
        sy += w * y;
        sw += w;
      }
    }
    const mass = sw / (255 * frameSize);
    const lost = mass < TRACK_MASS_MIN;
    if (!lost) {
      lastX = sx / sw / width;
      lastY = sy / sw / height;
    }
    points.push({ t: f / sampleFps, x: lastX, y: lastY, lost, mass });
  }
  return { points, sampleFps, width, height };
}

/**
 * Smooth a track: moving average over `window` points (non-lost
 * neighbours only), then a speed limit of `maxSpeed` frame-fractions
 * per second applied step by step. Lost points keep the parked
 * position and are never smoothed into a fake location.
 */
export function smoothTrack(
  track: SubjectTrack,
  opts: { window?: number; maxSpeed?: number } = {},
): SubjectTrack {
  const window = opts.window ?? 5;
  const maxSpeed = opts.maxSpeed ?? 0.5;
  const src = track.points.map((p) => ({ ...p }));
  const out: TrackPoint[] = src.map((p) => ({ ...p }));
  const half = Math.floor((window - 1) / 2);
  for (let i = 0; i < src.length; i++) {
    if (src[i].lost) continue;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(src.length - 1, i + half); j++) {
      if (src[j].lost) continue;
      sx += src[j].x;
      sy += src[j].y;
      n++;
    }
    if (n > 0) {
      out[i].x = sx / n;
      out[i].y = sy / n;
    }
  }
  for (let i = 1; i < out.length; i++) {
    const dt = out[i].t - out[i - 1].t;
    if (dt <= 0) continue;
    const maxStep = maxSpeed * dt;
    const dx = out[i].x - out[i - 1].x;
    const dy = out[i].y - out[i - 1].y;
    const d = Math.hypot(dx, dy);
    if (d > maxStep) {
      const k = maxStep / d;
      out[i].x = out[i - 1].x + dx * k;
      out[i].y = out[i - 1].y + dy * k;
    }
  }
  return { ...track, points: out };
}

/** Subject centre at time t (linear interpolation between located
 *  points; null when the track has no located frame at all). */
export function trackCenterAt(
  track: SubjectTrack,
  t: number,
): { x: number; y: number } | null {
  const known = track.points.filter((p) => !p.lost);
  if (known.length === 0) return null;
  if (t <= known[0].t) return { x: known[0].x, y: known[0].y };
  const last = known[known.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y };
  for (let i = 0; i + 1 < known.length; i++) {
    const a = known[i];
    const b = known[i + 1];
    if (t >= a.t && t <= b.t) {
      const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }
  }
  return { x: last.x, y: last.y };
}

// ---------------------------------------------------------------------------
// Reframe (vertical crop following the subject)
// ---------------------------------------------------------------------------

export type ReframeAspect = '9:16' | '16:9' | '1:1';

/** Max trajectory points baked into one crop expression (nested if()s;
 *  more would bloat the graph and risk the expression parser). */
export const MAX_REFRAME_KEYS = 60;

function downsamplePoints<T extends { t: number }>(pts: T[], max: number): T[] {
  if (pts.length <= max) return pts;
  const step = Math.ceil(pts.length / max);
  const out: T[] = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
  const last = pts[pts.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** Piecewise-linear expression over key times (same nested-if pattern
 *  as filtergraph.ts lerpExpr; duplicated here so smartcut.ts does not
 *  import the filter graph). */
function lerpExprPoints<K extends { t: number }>(
  keys: K[],
  pick: (k: K) => number,
  tv = 't',
): string {
  const v = (k: K): string => pick(k).toFixed(4);
  const t = (k: K): string => k.t.toFixed(3);
  if (keys.length === 1) return v(keys[0]);
  let expr = v(keys[keys.length - 1]);
  for (let i = keys.length - 2; i >= 0; i--) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    expr =
      `if(lt(${tv},${t(k0)}),${v(k0)},` +
      `if(gt(${tv},${t(k1)}),${expr},${v(k0)}+(${v(k1)}-${v(k0)})*(${tv}-${t(k0)})/(${t(k1)}-${t(k0)})))`;
  }
  return expr;
}

/**
 * Crop filter that follows the tracked subject. Window size is fixed
 * by the aspect (and margin); only x/y move. x/y are even-rounded
 * (the stream is yuv420p) and clamped so the window never leaves the
 * frame — when the subject is lost the window parks at the last known
 * position (trackFromMaskVideo already parks lost points there).
 * The caller applies this on the SOURCE stream, before scale/pad.
 */
export function reframeCropFilter(
  track: SubjectTrack,
  opts: ReframeOptions = {},
): string {
  const aspect = opts.aspect ?? '9:16';
  const margin = opts.margin ?? 0.02;
  const followY = opts.followY ?? false;
  const m = (1 - margin).toFixed(4);
  let wExpr: string;
  let hExpr: string;
  if (aspect === '9:16') {
    hExpr = `2*floor(ih*${m}/2)`;
    wExpr = `2*floor(min(ih*${m}*9/16,iw)/2)`;
  } else if (aspect === '16:9') {
    wExpr = `2*floor(iw*${m}/2)`;
    hExpr = `2*floor(min(iw*${m}*9/16,ih)/2)`;
  } else {
    wExpr = `2*floor(min(iw,ih)*${m}/2)`;
    hExpr = wExpr;
  }
  const located = track.points.filter((p) => !p.lost);
  if (located.length === 0) {
    throw new Error('reframe: subject track has no located frames (all lost); cannot reframe');
  }
  const keys = downsamplePoints(located, MAX_REFRAME_KEYS);
  const cxExpr = lerpExprPoints(keys, (p) => p.x);
  const xExpr = `2*floor(min(max((${cxExpr})*iw-ow/2,0),iw-ow)/2)`;
  const yExpr = followY
    ? `2*floor(min(max((${lerpExprPoints(keys, (p) => p.y)})*ih-oh/2,0),ih-oh)/2)`
    : '(ih-oh)/2';
  // All four values are single-quoted: the min()/max()/if() expressions
  // contain commas, and an unquoted comma ends the option in the
  // filter parser (measured 2026-11-17: unquoted w=...min(...,iw)...
  // fails with "No option name near ..."). The whole filter_complex is
  // one argv element, so the quotes survive to the parser intact.
  return `crop=w='${wExpr}':h='${hExpr}':x='${xExpr}':y='${yExpr}'`;
}

// ---------------------------------------------------------------------------
// Auto-follow zoom (zoom keyframes from tracking + voice)
// ---------------------------------------------------------------------------

/** Follow-zoom scale cap (task range 1.0..1.35). */
export const FOLLOW_ZOOM_MAX_SCALE = 1.35;

function mergeIntervals(
  ivs: { start: number; end: number }[],
  minHold: number,
): { start: number; end: number }[] {
  const sorted = ivs
    .filter((iv) => iv.end > iv.start)
    .slice()
    .sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start - last.end < minHold) {
      last.end = Math.max(last.end, iv.end);
    } else {
      out.push({ ...iv });
    }
  }
  for (let i = 0; i < out.length; i++) {
    const iv = out[i];
    const nextStart = i + 1 < out.length ? out[i + 1].start : Infinity;
    const want = iv.start + minHold;
    if (iv.end < want && want < nextStart) iv.end = want;
  }
  return out.filter((iv) => iv.end > iv.start);
}

/** Intervals where the subject keeps moving faster than 0.1
 *  frame-fractions/second for at least minHold (fallback when there
 *  is no voice to follow). */
function movementIntervals(
  track: SubjectTrack,
  minHold: number,
): { start: number; end: number }[] {
  const ivs: { start: number; end: number }[] = [];
  let cur: { start: number; end: number } | null = null;
  const pts = track.points;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dt = b.t - a.t;
    const speed = dt > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / dt : 0;
    if (!a.lost && !b.lost && speed > 0.1) {
      if (!cur) cur = { start: a.t, end: b.t };
      else cur.end = b.t;
    } else if (cur) {
      ivs.push(cur);
      cur = null;
    }
  }
  if (cur) ivs.push(cur);
  return mergeIntervals(
    ivs.filter((iv) => iv.end - iv.start >= minHold),
    minHold,
  );
}

/**
 * Zoom keyframes: push to maxScale during voice segments (or, when
 * there is no voice, during sustained subject movement), back to 1.0
 * everywhere else — silence never pushes. The ramp is rate-limited
 * (maxRate scale units/second) so the zoom cannot whip. Centre
 * follows the track at each interval's midpoint; when the clip is
 * also reframed the subject is already centred, so cx/cy stay 0.5.
 */
export function followZoomKeys(
  track: SubjectTrack,
  voiceSegments: { start: number; end: number }[],
  opts: FollowZoomOptions = {},
  duration?: number,
  reframed = false,
): ZoomKeyframe[] {
  const maxScale = opts.maxScale ?? FOLLOW_ZOOM_MAX_SCALE;
  const minHold = opts.minHold ?? 0.5;
  const maxRate = opts.maxRate ?? 1.0;
  const ease = Math.max(opts.ease ?? 0.2, (maxScale - 1) / maxRate);
  let intervals = mergeIntervals(voiceSegments, minHold);
  if (intervals.length === 0) intervals = movementIntervals(track, minHold);
  const keys: ZoomKeyframe[] = [];
  const push = (t: number, scale: number, cx: number, cy: number) => {
    if (duration !== undefined && t > duration + 1e-6) return;
    const tt = Math.max(0, duration !== undefined ? Math.min(t, duration) : t);
    const last = keys[keys.length - 1];
    if (last && Math.abs(last.t - tt) < 1e-6) {
      last.scale = scale;
      last.cx = cx;
      last.cy = cy;
      return;
    }
    keys.push({ t: tt, cx, cy, scale });
  };
  for (const iv of intervals) {
    const mid = (iv.start + iv.end) / 2;
    const c = reframed
      ? { x: 0.5, y: 0.5 }
      : (trackCenterAt(track, mid) ?? { x: 0.5, y: 0.5 });
    push(Math.max(0, iv.start - ease), 1.0, c.x, c.y);
    push(iv.start, maxScale, c.x, c.y);
    push(iv.end, maxScale, c.x, c.y);
    push(iv.end + ease, 1.0, c.x, c.y);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Validation + export prep
// ---------------------------------------------------------------------------

/** Validate the smart-cut fields of one clip; throws on anything v1
 *  cannot do (same fail-fast pattern as validatePortraitCutout). */
export function validateSmartCut(clip: Clip): void {
  validateSceneThreshold(clip.sceneThreshold, clip.id);
  if (clip.reframe) {
    const r = clip.reframe;
    if (r.aspect !== undefined && r.aspect !== '9:16' && r.aspect !== '16:9' && r.aspect !== '1:1') {
      throw new Error(`clip ${clip.id}: reframe.aspect ${r.aspect} must be '9:16', '16:9' or '1:1'`);
    }
    if (r.margin !== undefined && (r.margin < 0 || r.margin > 0.2)) {
      throw new Error(`clip ${clip.id}: reframe.margin ${r.margin} outside [0, 0.2]`);
    }
    if (clip.speed !== 1 || (clip.speedCurve ?? []).some((p) => p.speed !== 1)) {
      throw new Error(`clip ${clip.id}: reframe requires speed 1 (the track is in source time)`);
    }
    if (clip.reverse) {
      throw new Error(`clip ${clip.id}: reframe + reverse is rejected (reversed frame order breaks the track)`);
    }
    if (clip.freezeAt !== undefined) {
      throw new Error(`clip ${clip.id}: reframe + freeze frame is not supported in v1`);
    }
    if (clip.multicam) {
      throw new Error(`clip ${clip.id}: reframe + multicam is not supported in v1`);
    }
    if (clip.portraitCutout) {
      throw new Error(
        `clip ${clip.id}: reframe + portraitCutout cannot combine (the cutout mask is computed on the full frame; reframe crops the source first)`,
      );
    }
  }
  if (clip.followZoom) {
    const f = clip.followZoom;
    if (f.maxScale !== undefined && (f.maxScale <= 1 || f.maxScale > FOLLOW_ZOOM_MAX_SCALE)) {
      throw new Error(`clip ${clip.id}: followZoom.maxScale ${f.maxScale} outside (1, ${FOLLOW_ZOOM_MAX_SCALE}]`);
    }
    if (f.ease !== undefined && (f.ease < 0.05 || f.ease > 1)) {
      throw new Error(`clip ${clip.id}: followZoom.ease ${f.ease} outside [0.05, 1]`);
    }
    if (f.minHold !== undefined && (f.minHold < 0.1 || f.minHold > 2)) {
      throw new Error(`clip ${clip.id}: followZoom.minHold ${f.minHold} outside [0.1, 2]`);
    }
    if (f.maxRate !== undefined && (f.maxRate <= 0 || f.maxRate > 5)) {
      throw new Error(`clip ${clip.id}: followZoom.maxRate ${f.maxRate} outside (0, 5]`);
    }
    if (clip.speed !== 1 || (clip.speedCurve ?? []).some((p) => p.speed !== 1)) {
      throw new Error(`clip ${clip.id}: followZoom requires speed 1 (zoom keys are built on source-time tracking)`);
    }
    if (clip.reverse) {
      throw new Error(`clip ${clip.id}: followZoom + reverse is rejected (reversed frame order breaks the track)`);
    }
    if (clip.freezeAt !== undefined) {
      throw new Error(`clip ${clip.id}: followZoom + freeze frame is not supported in v1`);
    }
    if (clip.multicam) {
      throw new Error(`clip ${clip.id}: followZoom + multicam is not supported in v1`);
    }
    if (clip.zoom && clip.zoom.length > 0) {
      throw new Error(`clip ${clip.id}: followZoom cannot combine with manual zoom keyframes`);
    }
  }
}

/** Mask video path for one clip's tracking pass (kept next to the
 *  export as an audit trail; distinct from portrait-c*-mask.mp4 so a
 *  clip with both cutout and tracking does not clobber its masks). */
export function smartcutMaskVideoPath(dir: string, clipIndex: number): string {
  return join(dir, `smartcut-c${clipIndex}-mask.mp4`);
}

export interface SmartCutPrepOptions {
  /** Python binary with onnxruntime installed (venv python). */
  python?: string;
  /** Portrait helper script override (default: scripts/portrait_segment.py). */
  script?: string;
  /** Portrait model path override (default: bundled model). */
  model?: string;
  ffmpeg?: string;
  ffprobe?: string;
}

interface PortraitRunSummary {
  frames: number;
  sampled: number;
  out: string;
}

/**
 * Run the portrait segmentation helper for every clip that needs a
 * track (reframe or followZoom) and track the subject in each mask
 * video. When a portrait mask video already exists for a clip
 * (existingMasks — the clip also has portraitCutout), it is reused
 * instead of running the model a second time.
 */
export async function prepareSubjectTracks(
  project: Project,
  dir: string,
  opts: SmartCutPrepOptions = {},
  existingMasks?: Map<number, string>,
): Promise<Map<number, SubjectTrack>> {
  const out = new Map<number, SubjectTrack>();
  const python = opts.python ?? 'python3';
  const script = opts.script ?? defaultPortraitScriptPath();
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < project.clips.length; i++) {
    const clip = project.clips[i];
    if (!clip.reframe && !clip.followZoom) continue;
    validateSmartCut(clip);
    const model = resolvePortraitModelPath(undefined, opts.model);
    if (!existsSync(model)) {
      throw new Error(
        `clip ${clip.id}: portrait model not found: ${model}\n${PORTRAIT_SETUP}`,
      );
    }
    if (!existsSync(script)) {
      throw new Error(`portrait helper script not found: ${script}`);
    }
    let maskPath = existingMasks?.get(i);
    if (!maskPath) {
      const fps = await probeVideoFps(clip.source, opts.ffprobe);
      maskPath = smartcutMaskVideoPath(dir, i);
      const dur = clipDuration(clip);
      const args = [
        script,
        '--video', clip.source,
        '--model', model,
        '--out', maskPath,
        '--fps', String(fps),
        '--in', String(clip.in),
        '--dur', String(dur),
        '--width', String(project.width),
        '--height', String(project.height),
        '--sample-every', '1',
        '--ffmpeg', ffmpeg,
      ];
      let stdout: string;
      try {
        ({ stdout } = (await run(python, args)) as { stdout: string; stderr: string });
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        throw new Error(
          `clip ${clip.id}: smartcut tracking failed: ${(err.stderr ?? err.message ?? String(e)).toString().trim()}`,
        );
      }
      let summary: PortraitRunSummary;
      try {
        summary = JSON.parse(String(stdout).trim().split('\n').pop() as string) as PortraitRunSummary;
      } catch {
        throw new Error(`clip ${clip.id}: portrait helper printed unparsable output: ${String(stdout).trim()}`);
      }
      if (!existsSync(maskPath)) {
        throw new Error(`clip ${clip.id}: portrait helper reported success but wrote no mask video: ${maskPath}`);
      }
      if (summary.sampled === 0 || summary.frames === 0) {
        throw new Error(`clip ${clip.id}: portrait helper processed 0 frames`);
      }
    }
    const raw = await trackFromMaskVideo(maskPath, {
      width: project.width,
      height: project.height,
      ffmpeg,
      ffprobe: opts.ffprobe,
    });
    out.set(i, smoothTrack(raw));
  }
  return out;
}

/**
 * Full smart-cut prep for export: tracking passes + follow-zoom
 * keyframe merge. Returns the tracks (for the graph build) and a
 * project copy whose followZoom clips carry merged zoom keys. Voice
 * segments are classified in 1 s file-time windows over the clip
 * range and converted to clip-local time; a clip with no audio falls
 * back to movement-based zoom (followZoomKeys).
 */
export async function prepareSmartCut(
  project: Project,
  dir: string,
  opts: SmartCutPrepOptions = {},
  existingMasks?: Map<number, string>,
): Promise<{ tracks: Map<number, SubjectTrack>; project: Project }> {
  const tracks = await prepareSubjectTracks(project, dir, opts, existingMasks);
  const clips = project.clips.map((c) => ({ ...c }));
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    if (!clip.followZoom) continue;
    const track = tracks.get(i);
    if (!track) {
      throw new Error(`clip ${clip.id}: followZoom track not prepared`);
    }
    const dur = clipDuration(clip);
    let voice: { start: number; end: number }[] = [];
    if (await hasAudio(clip.source, opts.ffprobe)) {
      const windows: { start: number; end: number }[] = [];
      for (let t = clip.in; t < clip.out - 1e-9; t += 1) {
        windows.push({ start: t, end: Math.min(t + 1, clip.out) });
      }
      const classified = await analyzeAudioSegments(clip.source, windows, {
        ffmpeg: opts.ffmpeg,
      });
      voice = classified
        .filter((c) => c.label === 'voice' && c.confidence >= 0.5)
        .map((c) => ({ start: c.start - clip.in, end: c.end - clip.in }));
    }
    clips[i] = {
      ...clip,
      zoom: followZoomKeys(track, voice, clip.followZoom, dur, !!clip.reframe),
    };
  }
  return { tracks, project: { ...project, clips } };
}
