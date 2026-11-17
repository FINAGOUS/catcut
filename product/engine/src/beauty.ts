// Face beautify (P3, M4 §8.7 + direction doc 2026-11-17 §八): skin
// smoothing + slight brightening, masked to the person only.
//
// Pipeline: the same MediaPipe Selfie Segmentation ONNX mask as the
// portrait cutout (P1e) locates the person — prepareBeautyMasks runs
// scripts/portrait_segment.py (unchanged) and then
// scripts/beauty_mask.py, which labels the mask's connected
// components at 64x36 and keeps either the largest component only
// (mode 'single': only the main subject is retouched) or all of them
// (mode 'multi': everyone is retouched). The graph stage
// (filtergraph.ts applyBeautyStage) splits the picture, runs the
// beautify filter on one branch (hqdn3d + slight brightness +
// unsharp detail restore), alphamerges it with the mask, and
// overlays it back on the untouched original — outside the mask the
// frame is bit-identical to the input.
//
// What v1 does NOT do (stated plainly): no face slimming / eye
// enlargement (those need facial landmarks, not a body mask);
// per-person strengths in multi mode are NOT supported (the direction
// doc asks for "各自强度" — that needs cross-frame identity
// tracking to keep person 1 = person 1; multi mode uses one strength
// for everyone in v1); a clip with no face at all is a hard error
// ("no face" — the export refuses instead of silently doing
// nothing). Beauty + portraitCutout is rejected in v1 (two mask
// consumers on one clip); beauty + multicam is rejected (the mask is
// per-source, multicam has N sources).
//
// LGPL: hqdn3d, eq, unsharp, gblur, alphamerge, overlay are native
// libavfilter filters (LGPL part) — only verified on the local GPL
// 8.1.2 build, re-check on the BtbN LGPL 9.0 build at the M2 gate.
// The ONNX model is Apache 2.0 (see portrait.ts); onnxruntime is MIT.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { clipDuration, type Clip, type Project } from './project.js';
import {
  defaultPortraitModelPath,
  defaultPortraitScriptPath,
  PORTRAIT_SETUP,
  probeVideoFps,
  resolvePortraitModelPath,
} from './portrait.js';

const execFileAsync = promisify(execFile);

export type BeautyMode = 'single' | 'multi';

export interface BeautyOptions {
  /** Beautify strength 0..100 (default 50). 0 = the stage is skipped
   *  entirely (export is bit-identical to no beauty). */
  strength?: number;
  /** 'single' (default): only the largest mask component (the main
   *  subject) is retouched. 'multi': every detected person. */
  mode?: BeautyMode;
  /** Soften the mask edge in px (gblur sigma on the mask, default 1). */
  edgeFeather?: number;
}

/** Default helper script (engine/scripts/beauty_mask.py). */
export function defaultBeautyScriptPath(): string {
  return join(fileURLToPath(new URL('../scripts/', import.meta.url)), 'beauty_mask.py');
}

/** Mask video path for one clip (kept next to the export as an audit trail). */
export function beautyMaskVideoPath(dir: string, clipIndex: number): string {
  return join(dir, `beauty-c${clipIndex}-mask.mp4`);
}

/** Unfiltered ONNX mask video (intermediate, kept for debugging). */
export function beautyRawMaskVideoPath(dir: string, clipIndex: number): string {
  return join(dir, `beauty-c${clipIndex}-raw-mask.mp4`);
}

/**
 * hqdn3d strength mapping (probe 2026-11-18, noisy grey HF 10.56):
 * strength 25 -> HF 10.49, 50 -> 10.37, 75 -> 9.25, 100 -> 6.37
 * (luma_spatial = s*0.08, chroma_spatial = s*0.06, luma_tmp =
 * s*0.1, chroma_tmp = s*0.08). The mapping is deliberately
 * top-heavy: the probe noise (alls=30) is heavy, and light hqdn3d
 * barely dents it. Mean luma is unchanged at every strength
 * (125.8 -> 125.9). Shared by beautyFilter and the standalone
 * video denoise (Clip.videoDenoise).
 */
export function hqdn3dFilter(strength: number): string {
  const s = Math.max(0, Math.min(100, strength));
  return (
    `hqdn3d=${(s * 0.08).toFixed(2)}:${(s * 0.06).toFixed(2)}:` +
    `${(s * 0.1).toFixed(2)}:${(s * 0.08).toFixed(2)}`
  );
}

export function beautyFilter(strength: number): string {
  const s = Math.max(0, Math.min(100, strength));
  const bright = (0.03 * s / 100).toFixed(3);
  // unsharp amount is 0.1 on purpose, not 0.3: probe 2026-11-18 on
  // the P1e person video (in-mask HF 2.60 plain) — hqdn3d only 2.25,
  // +brightness 2.26, +unsharp 0.3 eats the smoothing back to 2.46,
  // +unsharp 0.1 keeps 2.33. Out-of-mask HF stays 1.74-1.75 in all
  // variants (the mask confines the effect).
  return (
    `${hqdn3dFilter(s)},` +
    `eq=brightness=${bright},` +
    `unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=0.1`
  );
}

/** Validate a beauty block against its clip; throws on anything v1 cannot do. */
export function validateBeauty(beauty: BeautyOptions, clip: Clip): void {
  const strength = beauty.strength ?? 50;
  if (typeof strength !== 'number' || Number.isNaN(strength) || strength < 0 || strength > 100) {
    throw new Error(`clip ${clip.id}: beauty.strength ${beauty.strength} outside [0, 100]`);
  }
  if (beauty.mode !== undefined && beauty.mode !== 'single' && beauty.mode !== 'multi') {
    throw new Error(`clip ${clip.id}: beauty.mode "${beauty.mode}" must be 'single' or 'multi'`);
  }
  if (beauty.edgeFeather !== undefined && beauty.edgeFeather < 0) {
    throw new Error(`clip ${clip.id}: beauty.edgeFeather ${beauty.edgeFeather} must be >= 0`);
  }
  if (clip.portraitCutout) {
    throw new Error(`clip ${clip.id}: beauty and portraitCutout cannot be combined in v1 (two mask consumers on one clip)`);
  }
  if (clip.multicam) {
    throw new Error(`clip ${clip.id}: beauty does not support multicam clips in v1 (the mask is per-source)`);
  }
  if (clip.reverse) {
    throw new Error(`clip ${clip.id}: beauty + reverse is rejected (reversed frame order breaks mask alignment)`);
  }
  if (clip.freezeAt !== undefined) {
    throw new Error(`clip ${clip.id}: beauty + freeze frame is not supported in v1`);
  }
  if (clip.speed !== 1 || (clip.speedCurve ?? []).some((p) => p.speed !== 1)) {
    throw new Error(`clip ${clip.id}: beauty requires speed 1 (v1 masks are computed on source frames)`);
  }
  if (clip.beatSpeed) {
    throw new Error(`clip ${clip.id}: beauty cannot combine with beatSpeed (beatSpeed changes the speed)`);
  }
}

/** One JSON summary line printed by scripts/beauty_mask.py. */
export interface BeautyMaskSummary {
  frames: number;
  /** Median person count across frames (the reported人数). */
  personCount: number;
  /** Max person count across frames. */
  maxCount: number;
  mode: string;
  out: string;
}

export interface BeautyMaskInfo {
  /** Filtered mask video path (largest component or all components). */
  mask: string;
  /** Median person count across frames. */
  personCount: number;
  /** Max person count across frames. */
  maxCount: number;
  frames: number;
}

export interface PrepareBeautyOptions {
  /** Python binary with onnxruntime installed (venv python). */
  python?: string;
  /** Portrait helper script path (default: engine/scripts/portrait_segment.py). */
  portraitScript?: string;
  /** Beauty mask filter script path (default: engine/scripts/beauty_mask.py). */
  beautyScript?: string;
  /** Default model path override (per-clip `model` still wins). */
  model?: string;
  ffmpeg?: string;
  ffprobe?: string;
}

/**
 * Run the segmentation + mask-filter helpers for every beauty clip
 * (strength > 0) and write one filtered mask video per clip under
 * `dir`. Returns clip index -> mask info. A clip whose mask has no
 * person at all (personCount 0) is a hard error — the export refuses
 * instead of silently exporting an unretouched clip as "beautified".
 * Strength-0 clips are skipped here (and in the graph) — they export
 * bit-identical to a plain clip.
 */
export async function prepareBeautyMasks(
  project: Project,
  dir: string,
  opts: PrepareBeautyOptions = {},
): Promise<Map<number, BeautyMaskInfo>> {
  const out = new Map<number, BeautyMaskInfo>();
  const python = opts.python ?? 'python3';
  const portraitScript = opts.portraitScript ?? defaultPortraitScriptPath();
  const beautyScript = opts.beautyScript ?? defaultBeautyScriptPath();
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < project.clips.length; i++) {
    const clip = project.clips[i];
    const beauty = clip.beauty;
    if (!beauty) continue;
    validateBeauty(beauty, clip);
    const strength = beauty.strength ?? 50;
    if (strength === 0) continue;
    const model = resolvePortraitModelPath(undefined, opts.model);
    if (!existsSync(model)) {
      throw new Error(
        `clip ${clip.id}: portrait model not found: ${model}\n${PORTRAIT_SETUP}`,
      );
    }
    if (!existsSync(portraitScript)) {
      throw new Error(`portrait helper script not found: ${portraitScript}`);
    }
    if (!existsSync(beautyScript)) {
      throw new Error(`beauty mask helper script not found: ${beautyScript}`);
    }
    const fps = await probeVideoFps(clip.source, opts.ffprobe);
    const rawPath = beautyRawMaskVideoPath(dir, i);
    const outPath = beautyMaskVideoPath(dir, i);
    const dur = clipDuration(clip);
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(python, [
        portraitScript,
        '--video', clip.source,
        '--model', model,
        '--out', rawPath,
        '--fps', String(fps),
        '--in', String(clip.in),
        '--dur', String(dur),
        '--width', String(project.width),
        '--height', String(project.height),
        '--sample-every', '1',
        '--ffmpeg', ffmpeg,
      ], { maxBuffer: 64 * 1024 * 1024 }));
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      throw new Error(
        `clip ${clip.id}: beauty segmentation failed: ${(err.stderr ?? err.message ?? String(e)).toString().trim()}`,
      );
    }
    let segSummary: { frames?: number; sampled?: number };
    try {
      segSummary = JSON.parse(stdout.trim().split('\n').pop() as string) as { frames?: number; sampled?: number };
    } catch {
      throw new Error(`clip ${clip.id}: portrait helper printed unparsable output: ${stdout.trim()}`);
    }
    if (!existsSync(rawPath) || (segSummary.frames ?? 0) === 0) {
      throw new Error(`clip ${clip.id}: beauty segmentation produced no mask video`);
    }
    const mode = beauty.mode ?? 'single';
    try {
      ({ stdout } = await execFileAsync(python, [
        beautyScript,
        '--mask', rawPath,
        '--out', outPath,
        '--mode', mode,
        '--width', String(project.width),
        '--height', String(project.height),
        '--fps', String(fps),
        '--ffmpeg', ffmpeg,
      ], { maxBuffer: 64 * 1024 * 1024 }));
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      throw new Error(
        `clip ${clip.id}: beauty mask filtering failed: ${(err.stderr ?? err.message ?? String(e)).toString().trim()}`,
      );
    }
    let summary: BeautyMaskSummary;
    try {
      summary = JSON.parse(stdout.trim().split('\n').pop() as string) as BeautyMaskSummary;
    } catch {
      throw new Error(`clip ${clip.id}: beauty helper printed unparsable output: ${stdout.trim()}`);
    }
    if (!existsSync(outPath)) {
      throw new Error(`clip ${clip.id}: beauty helper reported success but wrote no mask video: ${outPath}`);
    }
    if (summary.personCount === 0) {
      throw new Error(
        `clip ${clip.id}: beauty found no face/person in the clip (mask is empty); ` +
          `remove beauty or use a clip with a person in frame`,
      );
    }
    out.set(i, {
      mask: outPath,
      personCount: summary.personCount,
      maxCount: summary.maxCount,
      frames: summary.frames,
    });
  }
  return out;
}

// --- Connected-component labelling (pure TS, unit-testable) ---
// The Python helper implements the same algorithm at 64x36; this
// version exists so the counting logic is testable without a video
// file. 4-connectivity union-find over pixels above `threshold`
// (default 128); components smaller than minAreaFrac of the frame
// (default 0.5%) are speckle, not people.

export interface MaskComponents {
  /** Number of components at or above the minimum area. */
  count: number;
  /** Pixel count of the largest component (0 when count is 0). */
  largestArea: number;
  /** Areas of all qualifying components, largest first. */
  areas: number[];
}

export function countComponents(
  gray: Uint8Array,
  w: number,
  h: number,
  opts: { threshold?: number; minAreaFrac?: number } = {},
): MaskComponents {
  const threshold = opts.threshold ?? 128;
  const minArea = Math.max(1, Math.floor(w * h * (opts.minAreaFrac ?? 0.005)));
  const n = w * h;
  const parent = new Int32Array(n).fill(-1);
  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) {
      const next = parent[a];
      parent[a] = r;
      a = next;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (gray[i] < threshold) continue;
      parent[i] = i;
      if (x > 0 && parent[i - 1] >= 0) union(i, i - 1);
      if (y > 0 && parent[i - w] >= 0) union(i, i - w);
    }
  }
  const areas = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (parent[i] < 0) continue;
    const r = find(i);
    areas.set(r, (areas.get(r) ?? 0) + 1);
  }
  const kept = [...areas.values()].filter((a) => a >= minArea).sort((a, b) => b - a);
  return { count: kept.length, largestArea: kept[0] ?? 0, areas: kept };
}
