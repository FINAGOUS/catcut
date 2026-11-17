// P3 batch 7 (M4 §8.4 / §8.7, 2026-11-18) — the last engine batch:
// colour management, shot-to-shot colour match, node-based grading,
// tracked grading windows, LUT library, grade compare + reference
// stills, object tracking, clone, key outline, auto-video (text+image
// to film) and AI upscaling. Engine layer only — no WPF/UI here.
//
// Licence / honesty notes (measured 2026-11-18, probe tmp/probe-p3g.mjs):
// - zscale / tonemap / lut3d / dilation / maskedmerge are native
//   libavfilter — only verified on the local GPL 8.1.2 build; re-check
//   each on the BtbN LGPL 9.0 build at the M2 gate. zscale has NO
//   slog3 transfer in this build, and a bare `zscale=pin=...:tin=log100`
//   (or hlg) fails with "no path between colorspaces" — the input must
//   first be TAGGED with setparams (colour primaries/transfer/matrix),
//   after which the same conversion succeeds. S-Log3 therefore goes
//   through a TS-baked LUT built from Sony's published S-Log3 curve
//   (antlerpost S-Log3 page, anchor-checked: 18% grey -> 420/1023,
//   90% white -> 598/1023); the gamut part (S-Gamut3.Cine -> Rec.709
//   matrix) is NOT applied — transfer-only conversion, documented limit.
// - Object tracking is colour-centroid (primary, probe: moving disc
//   tracks with <= ~1% frame error) with NCC template matching as a
//   second method; a target that is mostly lost throws instead of
//   being followed blindly. Lost points park at the last known
//   position (same rule as P3b subject tracking) and are never invented.
// - Real-ESRGAN weights are BSD-3-Clause code with a model licence to
//   re-check before redistribution; the ONNX model is exported from
//   the official .pth with the project's own pytorch2onnx script.
//   upscaleVideo throws an honest "model not available" error when the
//   .onnx is absent and never fakes an upscaled result.
// - Node-graph masked nodes must feed the graph output directly (or
//   be the output); deeper masked sub-graphs are rejected, not silently
//   flattened. A clip may use EITHER the P2a linear advancedColor stack
//   OR a grade-node graph — mixing the two throws.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, extname, basename } from 'node:path';
import {
  applyAdvancedColorToRgb,
  buildColorLut,
  lutToCube,
  parseCube,
  validateAdvancedColor,
  type AdvancedColor,
  type BuiltLut,
} from './color.js';
import { hdrToSdrFilter } from './deliver.js';
import { renderFrameMaskPng, validateMask } from './mask.js';
import {
  trackCenterAt,
  type SubjectTrack,
  type TrackPoint,
} from './smartcut.js';
import { synthesizeSpeech } from './tts.js';
import { detectBeats, type BeatGrid } from './beat.js';
import { BUILTIN_TEMPLATE_IDS, loadBuiltInTemplate, applyTemplateToProject } from './templates.js';
import { clipDuration, type Clip, type ClipMask, type Project } from './project.js';

const execFileAsync = promisify(execFile);

async function run(cmd: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<{ stdout: Buffer; stderr: string }> {
  return execFileAsync(cmd, args, { encoding: 'buffer', maxBuffer: opts.maxBuffer ?? 256 * 1024 * 1024 }) as unknown as Promise<{ stdout: Buffer; stderr: string }>;
}

function escFilterPath(p: string): string {
  return `'${p.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")}'`;
}

/** ffprobe: width/height/fps/duration/hasAudio of a media file. */
export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  duration: number;
  hasAudio: boolean;
}

export async function probeVideoInfo(file: string, ffprobe = 'ffprobe'): Promise<VideoInfo> {
  if (!existsSync(file)) throw new Error(`probeVideoInfo: file missing: ${file}`);
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate',
    '-show_entries', 'format=duration',
    '-of', 'json', file,
  ]);
  const data = JSON.parse(stdout.toString()) as {
    streams: { width: number; height: number; r_frame_rate: string }[];
    format: { duration: string };
  };
  const v = data.streams[0];
  if (!v) throw new Error(`probeVideoInfo: no video stream in ${file}`);
  const [num, den] = v.r_frame_rate.split('/').map(Number);
  let hasAudio = false;
  try {
    const { stdout: aout } = await run(ffprobe, [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file,
    ]);
    hasAudio = aout.toString().trim().length > 0;
  } catch { hasAudio = false; }
  return {
    width: v.width,
    height: v.height,
    fps: den ? num / den : 0,
    duration: Number(data.format.duration),
    hasAudio,
  };
}

/** Decode one frame of a file as RGB24 at the given size. */
export async function decodeFrameRgb24(
  file: string,
  width: number,
  height: number,
  ss: number,
  ffmpeg = 'ffmpeg',
): Promise<Buffer> {
  const { stdout } = await run(ffmpeg, [
    '-v', 'error', '-ss', String(ss), '-i', file,
    '-vf', `scale=${width}:${height}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: 512 * 1024 * 1024 });
  if (stdout.length < width * height * 3) {
    throw new Error(`decodeFrameRgb24: short frame from ${file} (${stdout.length} bytes)`);
  }
  return stdout.subarray(0, width * height * 3);
}

// ---------------------------------------------------------------------------
// 1. Colour management (M4 line 148)
// ---------------------------------------------------------------------------

export type InputColorSpace = 'rec709' | 'srgb' | 'slog3' | 'log100' | 'hlg' | 'pq';
export type WorkingColorSpace = 'rec709' | 'srgb';
export type OutputColorSpace = 'rec709' | 'srgb';

export const INPUT_COLOR_SPACES: InputColorSpace[] = ['rec709', 'srgb', 'slog3', 'log100', 'hlg', 'pq'];

export interface ColorManagement {
  /** Per-clip input space (clip-level only). */
  inputSpace?: InputColorSpace;
  /** Timeline working space (project-level only, default 'rec709'). */
  workingSpace?: WorkingColorSpace;
  /** Delivery space (project-level only, default = working space). */
  outputSpace?: OutputColorSpace;
}

/** Sony S-Log3 decode (code value 0..1 -> scene-linear). Published
 *  S-Log3 curve (Sony): 18% grey sits at 420/1023, 90% white at
 *  598/1023 — both anchor points verified in probe-p3g (see header). */
export function slog3Decode(v: number): number {
  const cv = v * 1023;
  if (cv < 171.2102946929) {
    return ((cv - 95) * 0.01125) / (171.2102946929 - 95);
  }
  return Math.pow(10, (cv - 420) / 261.5) * 0.19 - 0.01;
}

/** Sony S-Log3 encode (scene-linear -> code value 0..1). */
export function slog3Encode(l: number): number {
  if (l < 0.01125) {
    return (l * (171.2102946929 - 95) / 0.01125 + 95) / 1023;
  }
  return (420 + 261.5 * Math.log10((l + 0.01) / 0.19)) / 1023;
}

/** BT.709 OETF (linear -> code) and its inverse. */
export function rec709Oetf(l: number): number {
  return l < 0.018 ? 4.5 * l : 1.099 * Math.pow(l, 0.45) - 0.099;
}
export function rec709OetfInv(v: number): number {
  return v < 0.081 ? v / 4.5 : Math.pow((v + 0.099) / 1.099, 1 / 0.45);
}

/** sRGB EOTF/OETF pair (IEC 61966-2-1). */
export function srgbOetf(l: number): number {
  return l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}
export function srgbOetfInv(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

type TransferSpace = 'rec709' | 'srgb' | 'slog3';

function toLinear(space: TransferSpace, v: number): number {
  if (space === 'rec709') return rec709OetfInv(v);
  if (space === 'srgb') return srgbOetfInv(v);
  return slog3Decode(v);
}
function fromLinear(space: TransferSpace, l: number): number {
  if (space === 'rec709') return rec709Oetf(Math.max(0, l));
  if (space === 'srgb') return srgbOetf(Math.max(0, l));
  return slog3Encode(Math.max(0, l));
}

/**
 * Bake a transfer-only colourspace conversion into a 3D LUT (same
 * BT.709 primaries on both sides; the gamut matrix is NOT applied —
 * see the module header). `from`/`to` are the transfer spaces only;
 * log100/hlg/pq go through the zscale path instead (inputColorFilter).
 */
export function buildTransferLut(from: TransferSpace, to: TransferSpace, size = 17): BuiltLut {
  if (size < 2 || size > 64 || !Number.isInteger(size)) {
    throw new Error(`buildTransferLut: size ${size} outside [2, 64]`);
  }
  const n = size * size * size;
  const data = new Float64Array(n * 3);
  let i = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        data[i++] = Math.max(0, Math.min(1, fromLinear(to, toLinear(from, ri / (size - 1)))));
        data[i++] = Math.max(0, Math.min(1, fromLinear(to, toLinear(from, gi / (size - 1)))));
        data[i++] = Math.max(0, Math.min(1, fromLinear(to, toLinear(from, bi / (size - 1)))));
      }
    }
  }
  return { size, data };
}

export function writeBuiltLutFile(lut: BuiltLut, outPath: string, title = 'CatCut colour management'): string {
  writeFileSync(outPath, lutToCube(lut, title), 'utf8');
  return outPath;
}

export function validateClipColorManagement(cm: ColorManagement | undefined, id: string): void {
  if (!cm) return;
  if (cm.workingSpace !== undefined || cm.outputSpace !== undefined) {
    throw new Error(`clip ${id}: colorManagement.workingSpace/outputSpace belong on the project, not the clip`);
  }
  if (cm.inputSpace !== undefined && !INPUT_COLOR_SPACES.includes(cm.inputSpace)) {
    throw new Error(`clip ${id}: unknown input color space "${String(cm.inputSpace)}" (expected one of ${INPUT_COLOR_SPACES.join(', ')})`);
  }
}

export function validateProjectColorManagement(cm: ColorManagement | undefined): void {
  if (!cm) return;
  if (cm.inputSpace !== undefined) {
    throw new Error('project colorManagement.inputSpace belongs on clips, not the project');
  }
  for (const k of ['workingSpace', 'outputSpace'] as const) {
    const v = cm[k];
    if (v !== undefined && v !== 'rec709' && v !== 'srgb') {
      throw new Error(`project colorManagement.${k} "${String(v)}" must be 'rec709' or 'srgb'`);
    }
  }
}

export interface InputColorConversion {
  /** zscale filter string (log100/hlg/pq path), or undefined. */
  filter?: string;
  /** LUT conversion needed (slog3/srgb/rec709->srgb path): [from, to]. */
  lut?: [TransferSpace, TransferSpace];
}

/**
 * Per-clip input conversion into the working space. zscale path:
 * the input is first TAGGED with setparams — a bare zscale with
 * explicit pin/min/tin fails on this build ("no path between
 * colorspaces", probe-p3g). pq goes through the P3c hable tonemap
 * (PQ->SDR must tonemap; when the working space is sRGB a
 * rec709->sRGB LUT follows it).
 */
export function inputColorConversion(
  inputSpace: InputColorSpace,
  working: WorkingColorSpace,
): InputColorConversion {
  const wp = 'bt709';
  const wt = working === 'srgb' ? 'iec61966-2-1' : 'bt709';
  const wm = 'bt709';
  switch (inputSpace) {
    case 'rec709':
      return working === 'srgb' ? { lut: ['rec709', 'srgb'] } : {};
    case 'srgb':
      return working === 'srgb' ? {} : { lut: ['srgb', 'rec709'] };
    case 'slog3':
      return { lut: ['slog3', working] };
    case 'log100':
      return {
        filter:
          `setparams=color_primaries=bt709:color_trc=log100:colorspace=bt709,` +
          `zscale=p=${wp}:t=${wt}:m=${wm}:range=tv,format=yuv420p`,
      };
    case 'hlg':
      return {
        filter:
          `setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc,` +
          `zscale=p=${wp}:t=${wt}:m=${wm}:range=tv,format=yuv420p`,
      };
    case 'pq':
      return working === 'srgb'
        ? { filter: hdrToSdrFilter(), lut: ['rec709', 'srgb'] }
        : { filter: hdrToSdrFilter() };
    default:
      throw new Error(`unknown input color space "${String(inputSpace)}"`);
  }
}

/** setparams tag for a delivery space (ffprobe-verified for sRGB:
 *  color_transfer reads iec61966-2-1, probe-p3g). */
export function outputColorTag(space: OutputColorSpace): string {
  if (space === 'srgb') {
    return 'setparams=color_trc=iec61966-2-1:color_primaries=bt709:colorspace=bt709';
  }
  return 'setparams=color_trc=bt709:color_primaries=bt709:colorspace=bt709';
}

export function workingSpaceOf(project: Project): WorkingColorSpace {
  return project.colorManagement?.workingSpace ?? 'rec709';
}
export function outputSpaceOf(project: Project): OutputColorSpace {
  return project.colorManagement?.outputSpace ?? workingSpaceOf(project);
}

/**
 * Export prep: bake input-conversion LUTs for clips whose input space
 * needs the LUT path. Returns clipIdx -> .cube paths (applied first in
 * the clip chain, before denoise/zoom/eq). Clips on the zscale path
 * get no LUT (their filter is emitted by the graph builder).
 */
export function prepareColorManagementLuts(project: Project, outDir: string, size = 17): Map<number, string[]> {
  validateProjectColorManagement(project.colorManagement);
  const working = workingSpaceOf(project);
  const out = new Map<number, string[]>();
  project.clips.forEach((clip, i) => {
    const cm = clip.colorManagement;
    if (!cm?.inputSpace) return;
    validateClipColorManagement(cm, clip.id);
    const conv = inputColorConversion(cm.inputSpace, working);
    if (!conv.lut) return;
    const p = join(outDir, `colormgmt-c${i}.cube`);
    writeBuiltLutFile(buildTransferLut(conv.lut[0], conv.lut[1], size), p, `CatCut ${conv.lut[0]} to ${conv.lut[1]}`);
    out.set(i, [p]);
  });
  return out;
}

/** Export prep: bake the working->output transfer LUT, or undefined
 *  when the output space already equals the working space. */
export function prepareOutputLut(project: Project, outDir: string, size = 17): string | undefined {
  validateProjectColorManagement(project.colorManagement);
  const working = workingSpaceOf(project);
  const output = outputSpaceOf(project);
  if (working === output) return undefined;
  const p = join(outDir, 'colormgmt-output.cube');
  writeBuiltLutFile(buildTransferLut(working, output, size), p, `CatCut ${working} to ${output}`);
  return p;
}

// ---------------------------------------------------------------------------
// 2. Shot-to-shot colour match (M4 line 149)
// ---------------------------------------------------------------------------

export interface ColorMatch {
  /** Reference still / frame file (PNG, JPG or a video file — frame 0). */
  referenceFrame: string;
  /** Blend of the matched result over the original, 0..1 (default 1). */
  strength?: number;
}

export function validateColorMatch(cm: ColorMatch | undefined, id: string): void {
  if (!cm) return;
  if (typeof cm.referenceFrame !== 'string' || !cm.referenceFrame) {
    throw new Error(`clip ${id}: colorMatch.referenceFrame must be a non-empty path`);
  }
  if (!existsSync(cm.referenceFrame)) {
    throw new Error(`clip ${id}: colorMatch.referenceFrame missing: ${cm.referenceFrame}`);
  }
  if (cm.strength !== undefined && (typeof cm.strength !== 'number' || Number.isNaN(cm.strength) || cm.strength < 0 || cm.strength > 1)) {
    throw new Error(`clip ${id}: colorMatch.strength ${cm.strength} outside [0, 1]`);
  }
}

/** Per-channel 256-bin histograms of an RGB24 buffer. */
export function channelHistograms(pixels: Buffer): [Uint32Array, Uint32Array, Uint32Array] {
  const h: [Uint32Array, Uint32Array, Uint32Array] = [
    new Uint32Array(256), new Uint32Array(256), new Uint32Array(256),
  ];
  for (let i = 0; i + 2 < pixels.length; i += 3) {
    h[0][pixels[i]]++;
    h[1][pixels[i + 1]]++;
    h[2][pixels[i + 2]]++;
  }
  return h;
}

function cdf(hist: Uint32Array): Float64Array {
  const out = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i];
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    out[i] = total > 0 ? acc / total : i / 255;
  }
  return out;
}

/** Histogram-match map: target level -> reference level, per channel.
 *  For each target level v, the smallest reference level whose CDF
 *  reaches the target CDF at v. */
export function histogramMatchMaps(
  refHist: [Uint32Array, Uint32Array, Uint32Array],
  tgtHist: [Uint32Array, Uint32Array, Uint32Array],
): [Uint8Array, Uint8Array, Uint8Array] {
  const maps: [Uint8Array, Uint8Array, Uint8Array] = [
    new Uint8Array(256), new Uint8Array(256), new Uint8Array(256),
  ];
  for (let c = 0; c < 3; c++) {
    const rc = cdf(refHist[c]);
    const tc = cdf(tgtHist[c]);
    // Matched value at each DISTINCT target level (CDF rule), then
    // linear interpolation between levels, flat outside the range.
    // A bare CDF step map is a discontinuity: a 17^3 LUT's trilinear
    // interpolation smears it — a solid target (100 -> 200) came out
    // as 52 live (probe-p3g: input 100 falls between grid nodes 96
    // and 112, so 0.25 * 200 = 50). Interpolating between distinct
    // levels keeps the map continuous, so the baked LUT reproduces
    // it; a solid target degenerates to a (correct) constant map.
    const levels: number[] = [];
    const matched: number[] = [];
    for (let v = 0; v < 256; v++) {
      if (tgtHist[c][v] === 0) continue;
      let r = 0;
      while (r < 255 && rc[r] < tc[v]) r++;
      levels.push(v);
      matched.push(r);
    }
    if (levels.length === 0) {
      for (let v = 0; v < 256; v++) maps[c][v] = v;
      continue;
    }
    for (let v = 0; v < 256; v++) {
      if (v <= levels[0]) { maps[c][v] = matched[0]; continue; }
      if (v >= levels[levels.length - 1]) { maps[c][v] = matched[matched.length - 1]; continue; }
      let k = 0;
      while (k < levels.length - 2 && levels[k + 1] < v) k++;
      const v0 = levels[k], v1 = levels[k + 1];
      const m0 = matched[k], m1 = matched[k + 1];
      maps[c][v] = v1 === v0 ? m0 : Math.round(m0 + ((m1 - m0) * (v - v0)) / (v1 - v0));
    }
  }
  return maps;
}

/** Bake a histogram-match into a 3D LUT (identity where the two
 *  histograms already agree). `strength` blends matched vs original. */
export function buildColorMatchLut(
  refPixels: Buffer,
  tgtPixels: Buffer,
  strength = 1,
  size = 17,
): BuiltLut {
  if (strength < 0 || strength > 1) throw new Error(`buildColorMatchLut: strength ${strength} outside [0, 1]`);
  const maps = histogramMatchMaps(channelHistograms(refPixels), channelHistograms(tgtPixels));
  const n = size * size * size;
  const data = new Float64Array(n * 3);
  let i = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const r0 = ri / (size - 1);
        const g0 = gi / (size - 1);
        const b0 = bi / (size - 1);
        const rm = maps[0][Math.round(r0 * 255)] / 255;
        const gm = maps[1][Math.round(g0 * 255)] / 255;
        const bm = maps[2][Math.round(b0 * 255)] / 255;
        data[i++] = r0 + (rm - r0) * strength;
        data[i++] = g0 + (gm - g0) * strength;
        data[i++] = b0 + (bm - b0) * strength;
      }
    }
  }
  return { size, data };
}

/** Export prep: bake one match LUT per clip with colorMatch, from the
 *  reference frame and the clip's first frame (both decoded at project
 *  size). Returns clipIdx -> .cube paths. */
export async function prepareColorMatchLuts(
  project: Project,
  outDir: string,
  opts: { ffmpeg?: string; size?: number } = {},
): Promise<Map<number, string[]>> {
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const size = opts.size ?? 17;
  const out = new Map<number, string[]>();
  for (let i = 0; i < project.clips.length; i++) {
    const clip = project.clips[i];
    if (!clip.colorMatch) continue;
    validateColorMatch(clip.colorMatch, clip.id);
    const ref = await decodeFrameRgb24(clip.colorMatch.referenceFrame, project.width, project.height, 0, ffmpeg);
    const tgt = await decodeFrameRgb24(clip.source, project.width, project.height, clip.in, ffmpeg);
    const lut = buildColorMatchLut(ref, tgt, clip.colorMatch.strength ?? 1, size);
    const p = join(outDir, `colormatch-c${i}.cube`);
    writeBuiltLutFile(lut, p, `CatCut colour match clip ${clip.id}`);
    out.set(i, [p]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Node-based grading (M4 line 150)
// ---------------------------------------------------------------------------

export type GradeBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay';
export const GRADE_BLEND_MODES: GradeBlendMode[] = ['normal', 'multiply', 'screen', 'overlay'];

export interface GradeNode {
  id: string;
  /** The grade this node applies (P2a AdvancedColor — same bake). */
  adjust: AdvancedColor;
  /** Node ids this node reads, or 'input' for the timeline picture.
   *  Empty/absent = ['input']. */
  inputs?: string[];
  /** How this node blends over its inputs (default 'normal'). */
  blend?: GradeBlendMode;
  /** Blend opacity 0..1 (default 1). */
  opacity?: number;
  /** Spatial mask: when set, the node is applied as a masked stage in
   *  the graph (not baked into the final LUT) and must feed the graph
   *  output directly — see the module header. */
  mask?: ClipMask;
}

export interface GradeNodeGraph {
  nodes: GradeNode[];
  /** Id of the node whose value is the graph output. */
  output: string;
}

function identityLut(size: number): BuiltLut {
  const n = size * size * size;
  const data = new Float64Array(n * 3);
  let i = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        data[i++] = ri / (size - 1);
        data[i++] = gi / (size - 1);
        data[i++] = bi / (size - 1);
      }
    }
  }
  return { size, data };
}

/** Blend two LUTs per grid node: `over` blended over `base`. */
export function blendLuts(base: BuiltLut, over: BuiltLut, mode: GradeBlendMode, opacity = 1): BuiltLut {
  if (base.size !== over.size) throw new Error('blendLuts: LUT sizes differ');
  if (opacity < 0 || opacity > 1) throw new Error(`blendLuts: opacity ${opacity} outside [0, 1]`);
  const data = new Float64Array(base.data.length);
  for (let i = 0; i < data.length; i++) {
    const b = base.data[i];
    const o = over.data[i];
    let v: number;
    switch (mode) {
      case 'multiply': v = b * o; break;
      case 'screen': v = 1 - (1 - b) * (1 - o); break;
      case 'overlay': v = b < 0.5 ? 2 * b * o : 1 - 2 * (1 - b) * (1 - o); break;
      default: v = o; break;
    }
    data[i] = b + (v - b) * opacity;
  }
  return { size: base.size, data };
}

/** Apply one node's AdvancedColor to every node of a LUT. */
function applyAdjustToLut(lut: BuiltLut, adjust: AdvancedColor): BuiltLut {
  const data = new Float64Array(lut.data.length);
  for (let i = 0; i < data.length; i += 3) {
    const [r, g, b] = applyAdvancedColorToRgb(adjust, lut.data[i], lut.data[i + 1], lut.data[i + 2]);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
  return { size: lut.size, data };
}

/** Topological order of a node graph (Kahn); throws on a cycle,
 *  a dangling input, or a missing output node. */
export function topoSortGradeNodes(graph: GradeNodeGraph): GradeNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  if (!byId.has(graph.output)) {
    throw new Error(`grade nodes: output node "${graph.output}" not found`);
  }
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const inputs = n.inputs ?? ['input'];
    const deps = inputs.filter((x) => x !== 'input');
    for (const d of deps) {
      if (!byId.has(d)) throw new Error(`grade node ${n.id}: input "${d}" not found`);
    }
    indegree.set(n.id, deps.length);
    for (const d of deps) {
      const arr = dependents.get(d) ?? [];
      arr.push(n.id);
      dependents.set(d, arr);
    }
  }
  const queue = graph.nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: GradeNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(byId.get(id) as GradeNode);
    for (const dep of dependents.get(id) ?? []) {
      const left = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, left);
      if (left === 0) queue.push(dep);
    }
  }
  if (order.length !== graph.nodes.length) {
    throw new Error('grade nodes: cycle detected in the node graph');
  }
  return order;
}

export function validateGradeNodes(graph: GradeNodeGraph | undefined, id: string): void {
  if (!graph) return;
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new Error(`clip ${id}: gradeNodes.nodes must be a non-empty array`);
  }
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (typeof n.id !== 'string' || !n.id) throw new Error(`clip ${id}: grade node without an id`);
    if (ids.has(n.id)) throw new Error(`clip ${id}: duplicate grade node id "${n.id}"`);
    ids.add(n.id);
    validateAdvancedColor(n.adjust ?? {}, id);
    if (n.blend !== undefined && !GRADE_BLEND_MODES.includes(n.blend)) {
      throw new Error(`clip ${id}: grade node ${n.id} unknown blend mode "${String(n.blend)}"`);
    }
    if (n.opacity !== undefined && (typeof n.opacity !== 'number' || Number.isNaN(n.opacity) || n.opacity < 0 || n.opacity > 1)) {
      throw new Error(`clip ${id}: grade node ${n.id} opacity ${n.opacity} outside [0, 1]`);
    }
    if (n.mask) validateMask(n.mask);
  }
  // Cycle / dangling-input check (also validates the output id).
  const order = topoSortGradeNodes(graph);
  const masked = new Set(graph.nodes.filter((n) => n.mask).map((n) => n.id));
  if (masked.size > 0) {
    // Check "cannot read another masked node" FIRST: a graph that
    // violates both rules must report the deeper one (a masked node
    // reading a masked node), not the feed-output rule.
    for (const m of masked) {
      const node = graph.nodes.find((n) => n.id === m) as GradeNode;
      for (const inp of node.inputs ?? ['input']) {
        if (masked.has(inp)) {
          throw new Error(`clip ${id}: masked grade node "${m}" cannot read another masked node "${inp}"`);
        }
      }
    }
    const outputNode = graph.nodes.find((n) => n.id === graph.output) as GradeNode;
    const outputInputs = new Set(outputNode.inputs ?? ['input']);
    for (const m of masked) {
      // A masked node may only feed the graph output directly (or be
      // the output itself) — deeper masked sub-graphs cannot be baked
      // into a LUT and are rejected, not silently flattened.
      if (m !== graph.output && !outputInputs.has(m)) {
        throw new Error(`clip ${id}: masked grade node "${m}" must feed the graph output directly`);
      }
    }
    void order;
  }
}

export interface BakedGradeNodes {
  /** The unmasked graph baked into one LUT (masked nodes read as identity). */
  final: BuiltLut;
  /** Masked nodes, each with its own baked LUT (inputs read as identity
   *  where they would be masked). */
  masked: { id: string; lut: BuiltLut; blend: GradeBlendMode; opacity: number }[];
}

/**
 * Bake a node graph into LUTs. A node with several inputs folds them
 * in listed order with the node's own blend mode + opacity; the node's
 * adjust then applies to the folded result. A node with no inputs
 * reads the timeline picture ('input' = identity LUT).
 */
export function bakeGradeNodes(graph: GradeNodeGraph, size = 17): BakedGradeNodes {
  validateGradeNodes(graph, 'bake');
  const order = topoSortGradeNodes(graph);
  const maskedIds = new Set(graph.nodes.filter((n) => n.mask).map((n) => n.id));
  const luts = new Map<string, BuiltLut>();
  const identity = identityLut(size);
  for (const node of order) {
    const inputs = node.inputs ?? ['input'];
    let acc: BuiltLut;
    if (inputs.length === 0) {
      acc = identity;
    } else {
      acc = inputs[0] === 'input' ? identity : (luts.get(inputs[0]) as BuiltLut);
      for (let k = 1; k < inputs.length; k++) {
        const next = inputs[k] === 'input' ? identity : (luts.get(inputs[k]) as BuiltLut);
        acc = blendLuts(acc, next, node.blend ?? 'normal', node.opacity ?? 1);
      }
    }
    // A masked node's own value is baked separately; inside the main
    // bake it reads as identity so later nodes don't inherit a
    // full-frame grade the mask was meant to localise.
    if (maskedIds.has(node.id)) {
      luts.set(node.id, identity);
    } else {
      luts.set(node.id, applyAdjustToLut(acc, node.adjust ?? {}));
    }
  }
  const final = luts.get(graph.output) as BuiltLut;
  // Masked nodes: bake each one on its own (inputs as baked above,
  // with other masked nodes as identity — enforced by validation).
  const masked: BakedGradeNodes['masked'] = [];
  for (const node of graph.nodes) {
    if (!node.mask) continue;
    const inputs = node.inputs ?? ['input'];
    let acc: BuiltLut;
    if (inputs.length === 0) {
      acc = identity;
    } else {
      acc = inputs[0] === 'input' ? identity : (luts.get(inputs[0]) as BuiltLut);
      for (let k = 1; k < inputs.length; k++) {
        const next = inputs[k] === 'input' ? identity : (luts.get(inputs[k]) as BuiltLut);
        acc = blendLuts(acc, next, node.blend ?? 'normal', node.opacity ?? 1);
      }
    }
    masked.push({
      id: node.id,
      lut: applyAdjustToLut(acc, node.adjust ?? {}),
      blend: node.blend ?? 'normal',
      opacity: node.opacity ?? 1,
    });
  }
  return { final, masked };
}

export interface GradeNodeStageFiles {
  /** Baked final LUT (unmasked graph). */
  finalLut: string;
  /** Masked stages in topo order: LUT + mask PNG + blend mode. */
  masked: { lut: string; mask: string; blend: GradeBlendMode; opacity: number }[];
}

/** Export prep: bake a clip's node graph to .cube files + mask PNGs. */
export function writeGradeNodeFiles(
  graph: GradeNodeGraph,
  clipIdx: number,
  outDir: string,
  projectWidth: number,
  projectHeight: number,
  size = 17,
): GradeNodeStageFiles {
  const baked = bakeGradeNodes(graph, size);
  const finalLut = join(outDir, `gradenodes-c${clipIdx}.cube`);
  writeBuiltLutFile(baked.final, finalLut, `CatCut node graph clip ${clipIdx}`);
  const masked: GradeNodeStageFiles['masked'] = [];
  for (const m of baked.masked) {
    const node = graph.nodes.find((n) => n.id === m.id) as GradeNode;
    const lutPath = join(outDir, `gradenodes-c${clipIdx}-${m.id}.cube`);
    writeBuiltLutFile(m.lut, lutPath, `CatCut node ${m.id}`);
    const maskPath = join(outDir, `gradenodes-c${clipIdx}-${m.id}.png`);
    writeFileSync(maskPath, renderFrameMaskPng(node.mask as ClipMask, projectWidth, projectHeight));
    masked.push({ lut: lutPath, mask: maskPath, blend: m.blend, opacity: m.opacity });
  }
  return { finalLut, masked };
}

// ---------------------------------------------------------------------------
// 4. Tracked grading window (M4 line 151)
// ---------------------------------------------------------------------------

export interface TrackedWindow {
  /** Window shape (rect = crop-style box, ellipse/circle = soft mask). */
  shape: 'rect' | 'ellipse' | 'circle';
  /** Window width/height as fractions of frame width/height (0..1). */
  w: number;
  h: number;
  /** Grade applied inside the window only. */
  adjust: AdvancedColor;
  /** Subject track the window centre follows (clip-local time). */
  track: SubjectTrack;
  /** Mask video sample rate, fps (default 5, same as P3b tracking). */
  sampleFps?: number;
}

export function validateTrackedWindow(tw: TrackedWindow | undefined, id: string): void {
  if (!tw) return;
  if (!['rect', 'ellipse', 'circle'].includes(tw.shape)) {
    throw new Error(`clip ${id}: trackedWindow.shape "${String(tw.shape)}" must be rect/ellipse/circle`);
  }
  if (typeof tw.w !== 'number' || tw.w <= 0 || tw.w > 1 || typeof tw.h !== 'number' || tw.h <= 0 || tw.h > 1) {
    throw new Error(`clip ${id}: trackedWindow size (${tw.w}, ${tw.h}) outside (0, 1]`);
  }
  validateAdvancedColor(tw.adjust ?? {}, id);
  if (!tw.track || !Array.isArray(tw.track.points) || tw.track.points.length === 0) {
    throw new Error(`clip ${id}: trackedWindow.track has no points`);
  }
  if (!tw.track.points.some((p) => !p.lost)) {
    throw new Error(`clip ${id}: trackedWindow.track has no located frame`);
  }
  if (tw.sampleFps !== undefined && (tw.sampleFps < 1 || tw.sampleFps > 30)) {
    throw new Error(`clip ${id}: trackedWindow.sampleFps ${tw.sampleFps} outside [1, 30]`);
  }
}

/** Build a grayscale mask video buffer: white window on black, centre
 *  following the track. Pure TS — the caller encodes it with ffmpeg. */
export function buildTrackedWindowMaskBuffer(
  tw: TrackedWindow,
  width: number,
  height: number,
  duration: number,
): Buffer {
  const sampleFps = tw.sampleFps ?? 5;
  const nF = Math.max(1, Math.ceil(duration * sampleFps));
  const buf = Buffer.alloc(width * height * nF);
  for (let f = 0; f < nF; f++) {
    const t = f / sampleFps;
    const c = trackCenterAt(tw.track, t) ?? { x: 0.5, y: 0.5 };
    const cx = c.x * width;
    const cy = c.y * height;
    const hw = (tw.w * width) / 2;
    const hh = (tw.h * height) / 2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let inside = false;
        if (tw.shape === 'rect') {
          inside = Math.abs(x + 0.5 - cx) <= hw && Math.abs(y + 0.5 - cy) <= hh;
        } else {
          const rx = tw.shape === 'circle' ? hw : hw;
          const ry = tw.shape === 'circle' ? hw : hh;
          const dx = (x + 0.5 - cx) / rx;
          const dy = (y + 0.5 - cy) / ry;
          inside = dx * dx + dy * dy <= 1;
        }
        buf[f * width * height + y * width + x] = inside ? 255 : 0;
      }
    }
  }
  return buf;
}

/** Encode a grayscale mask buffer as a yuv420p mask video (luma
 *  carries the mask, like the P1e portrait masks). */
export async function writeMaskVideoFromBuffer(
  buf: Buffer,
  width: number,
  height: number,
  sampleFps: number,
  outPath: string,
  ffmpeg = 'ffmpeg',
): Promise<string> {
  const tmpRaw = `${outPath}.raw`;
  writeFileSync(tmpRaw, buf);
  try {
    await run(ffmpeg, [
      '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray',
      '-s', `${width}x${height}`, '-r', String(sampleFps),
      '-i', tmpRaw, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', outPath,
    ]);
  } finally {
    const { unlinkSync } = await import('node:fs');
    try { unlinkSync(tmpRaw); } catch { /* already gone */ }
  }
  return outPath;
}

export interface TrackedWindowFiles {
  /** Baked window grade LUT. */
  lut: string;
  /** Moving mask video. */
  mask: string;
}

/** Export prep: bake the window LUT + encode the moving mask video. */
export async function prepareTrackedWindow(
  clip: Clip,
  clipIdx: number,
  project: Project,
  outDir: string,
  opts: { ffmpeg?: string; size?: number } = {},
): Promise<TrackedWindowFiles> {
  const tw = clip.trackedWindow as TrackedWindow;
  validateTrackedWindow(tw, clip.id);
  const lutPath = join(outDir, `trackwin-c${clipIdx}.cube`);
  writeBuiltLutFile(buildColorLut(tw.adjust ?? {}, opts.size ?? 17), lutPath, `CatCut tracked window clip ${clip.id}`);
  const duration = clipDuration(clip);
  const buf = buildTrackedWindowMaskBuffer(tw, project.width, project.height, duration);
  const maskPath = join(outDir, `trackwin-c${clipIdx}.mp4`);
  await writeMaskVideoFromBuffer(buf, project.width, project.height, tw.sampleFps ?? 5, maskPath, opts.ffmpeg ?? 'ffmpeg');
  return { lut: lutPath, mask: maskPath };
}

// ---------------------------------------------------------------------------
// 5. LUT library (M4 line 153)
// ---------------------------------------------------------------------------

export interface LutLibraryEntry {
  id: string;
  name: string;
  /** Category, e.g. 'film', 'teal-orange', 'bw', 'log'. */
  category: string;
  /** Path to the .cube file. */
  file: string;
  favorite?: boolean;
  tags?: string[];
}

export type LutLibrary = LutLibraryEntry[];

export function validateLutLibraryEntry(e: LutLibraryEntry): void {
  if (typeof e.id !== 'string' || !e.id) throw new Error('LUT library entry: missing id');
  if (typeof e.name !== 'string' || !e.name) throw new Error(`LUT library entry ${e.id}: missing name`);
  if (typeof e.category !== 'string' || !e.category) throw new Error(`LUT library entry ${e.id}: missing category`);
  if (typeof e.file !== 'string' || !e.file) throw new Error(`LUT library entry ${e.id}: missing file`);
  if (!existsSync(e.file)) throw new Error(`LUT library entry ${e.id}: file missing: ${e.file}`);
  // A bad .cube is a hard error at library time, not at thumbnail time.
  parseCube(readFileSync(e.file, 'utf8'), `LUT library entry ${e.id}`);
}

export function addLutEntry(lib: LutLibrary, e: LutLibraryEntry): LutLibrary {
  validateLutLibraryEntry(e);
  if (lib.some((x) => x.id === e.id)) throw new Error(`LUT library: duplicate entry id "${e.id}"`);
  return [...lib, e];
}

export interface LutLibraryFilter {
  category?: string;
  favorite?: boolean;
  /** Case-insensitive substring over name/category/tags. */
  search?: string;
}

export function filterLutLibrary(lib: LutLibrary, rule: LutLibraryFilter): LutLibrary {
  return lib.filter((e) => {
    if (rule.category !== undefined && e.category !== rule.category) return false;
    if (rule.favorite !== undefined && (e.favorite ?? false) !== rule.favorite) return false;
    if (rule.search !== undefined && rule.search !== '') {
      const q = rule.search.toLowerCase();
      const hay = [e.name, e.category, ...(e.tags ?? [])].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function toggleLutFavorite(lib: LutLibrary, id: string): LutLibrary {
  if (!lib.some((e) => e.id === id)) throw new Error(`LUT library: no entry "${id}"`);
  return lib.map((e) => (e.id === id ? { ...e, favorite: !(e.favorite ?? false) } : e));
}

export function lutLibraryCategories(lib: LutLibrary): string[] {
  return [...new Set(lib.map((e) => e.category))].sort();
}

/**
 * Render a LUT thumbnail: apply the LUT to one frame of `frameFile`
 * and scale it down. Returns the PNG path + size. The thumbnail is
 * the same operation as a direct lut3d render, only smaller — the
 * test compares their frame means.
 */
export async function generateLutThumbnail(
  lutPath: string,
  frameFile: string,
  outPng: string,
  opts: { width?: number; height?: number; ffmpeg?: string; ss?: number } = {},
): Promise<{ file: string; width: number; height: number }> {
  if (!existsSync(lutPath)) throw new Error(`generateLutThumbnail: LUT missing: ${lutPath}`);
  parseCube(readFileSync(lutPath, 'utf8'), `thumbnail LUT ${lutPath}`);
  if (!existsSync(frameFile)) throw new Error(`generateLutThumbnail: frame file missing: ${frameFile}`);
  const w = opts.width ?? 160;
  const h = opts.height ?? 90;
  if (w < 8 || h < 8) throw new Error(`generateLutThumbnail: thumbnail size ${w}x${h} too small`);
  const args: string[] = ['-v', 'error'];
  if (opts.ss !== undefined) args.push('-ss', String(opts.ss));
  args.push('-i', frameFile, '-vf', `lut3d=${escFilterPath(lutPath)},scale=${w}:${h}`, '-frames:v', '1', '-y', outPng);
  await run(opts.ffmpeg ?? 'ffmpeg', args);
  return { file: outPng, width: w, height: h };
}

// ---------------------------------------------------------------------------
// 6. Grade compare + reference stills (M4 line 154)
// ---------------------------------------------------------------------------

export type CompareMode = 'split' | 'wipe';

export interface ReferenceStill {
  /** PNG file of the stored frame. */
  file: string;
  /** Project time the frame was taken at. */
  time: number;
  label: string;
  /** Source file the frame came from. */
  source: string;
  width: number;
  height: number;
  note?: string;
}

/**
 * Render one comparison frame: left = original, right = graded
 * ('split': half/half; 'wipe': the boundary sits at `wipe` of the
 * width). Standalone ffmpeg call — no project render needed.
 */
export async function renderComparisonFrame(
  source: string,
  lutPath: string | null,
  outPng: string,
  opts: { mode?: CompareMode; wipe?: number; ss?: number; ffmpeg?: string } = {},
): Promise<{ file: string; mode: CompareMode; wipe: number }> {
  const mode = opts.mode ?? 'split';
  const wipe = opts.wipe ?? 0.5;
  if (mode !== 'split' && mode !== 'wipe') throw new Error(`renderComparisonFrame: unknown mode "${String(mode)}"`);
  if (wipe <= 0 || wipe >= 1) throw new Error(`renderComparisonFrame: wipe ${wipe} outside (0, 1)`);
  if (!existsSync(source)) throw new Error(`renderComparisonFrame: source missing: ${source}`);
  if (lutPath) {
    if (!existsSync(lutPath)) throw new Error(`renderComparisonFrame: LUT missing: ${lutPath}`);
    parseCube(readFileSync(lutPath, 'utf8'), `compare LUT ${lutPath}`);
  }
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const ss = opts.ss ?? 0;
  const info = await probeVideoInfo(source);
  const w = info.width;
  const leftW = Math.max(2, Math.round(w * wipe));
  const rightW = Math.max(2, w - leftW);
  const bgFilter = lutPath ? `lut3d=${escFilterPath(lutPath)}` : 'null';
  const fc =
    `[0:v]split[a][b];` +
    `[b]${bgFilter}[bg];` +
    `[a]crop=${leftW}:${info.height}:0:0[l];` +
    `[bg]crop=${rightW}:${info.height}:${leftW}:0[r];` +
    `[l][r]hstack,format=yuv420p[vout]`;
  await run(ffmpeg, [
    '-v', 'error', '-ss', String(ss), '-i', source,
    '-filter_complex', fc, '-map', '[vout]', '-frames:v', '1', '-y', outPng,
  ]);
  return { file: outPng, mode, wipe };
}

/** Save one reference still: a PNG frame + a JSON sidecar with its
 *  metadata. The sidecar is the audit record; the PNG is the still. */
export async function saveReferenceStill(
  source: string,
  time: number,
  outPng: string,
  meta: { label: string; note?: string },
  opts: { ffmpeg?: string; ffprobe?: string } = {},
): Promise<ReferenceStill> {
  if (!existsSync(source)) throw new Error(`saveReferenceStill: source missing: ${source}`);
  if (typeof time !== 'number' || Number.isNaN(time) || time < 0) {
    throw new Error(`saveReferenceStill: time ${time} must be >= 0`);
  }
  if (typeof meta.label !== 'string' || !meta.label) {
    throw new Error('saveReferenceStill: label must be non-empty');
  }
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  await run(ffmpeg, [
    '-v', 'error', '-ss', String(time), '-i', source,
    '-frames:v', '1', '-y', outPng,
  ]);
  const info = await probeVideoInfo(outPng, opts.ffprobe ?? 'ffprobe');
  const still: ReferenceStill = {
    file: outPng,
    time,
    label: meta.label,
    source,
    width: info.width,
    height: info.height,
    ...(meta.note !== undefined ? { note: meta.note } : {}),
  };
  writeFileSync(`${outPng}.json`, JSON.stringify(still, null, 2), 'utf8');
  return still;
}

/** Load a stored still back and verify the PNG + sidecar agree. */
export async function loadReferenceStill(pngPath: string, ffprobe = 'ffprobe'): Promise<ReferenceStill> {
  if (!existsSync(pngPath)) throw new Error(`loadReferenceStill: PNG missing: ${pngPath}`);
  const sidecar = `${pngPath}.json`;
  if (!existsSync(sidecar)) throw new Error(`loadReferenceStill: sidecar missing: ${sidecar}`);
  const still = JSON.parse(readFileSync(sidecar, 'utf8')) as ReferenceStill;
  const info = await probeVideoInfo(pngPath, ffprobe);
  if (info.width !== still.width || info.height !== still.height) {
    throw new Error(`loadReferenceStill: PNG is ${info.width}x${info.height} but the sidecar says ${still.width}x${still.height}`);
  }
  if (still.file !== pngPath) {
    throw new Error(`loadReferenceStill: sidecar file "${still.file}" does not match "${pngPath}"`);
  }
  return still;
}

/** List stored stills (PNGs with a .json sidecar) in a directory. */
export function listReferenceStills(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.png') && existsSync(join(dir, `${f}.json`)))
    .map((f) => join(dir, f))
    .sort();
}

// ---------------------------------------------------------------------------
// 7. Object tracking (M4 line 186)
// ---------------------------------------------------------------------------

export interface ObjectTrack {
  /** 'color': centroid of pixels near `color`. 'template': NCC template
   *  match on the `box` patch from the first frame. */
  method: 'color' | 'template';
  /** Target colour [r, g, b] (color method). */
  color?: [number, number, number];
  /** Colour distance tolerance, 0..441 (default 60). */
  tolerance?: number;
  /** Initial box as frame fractions {x, y, w, h} (template method). */
  box?: { x: number; y: number; w: number; h: number };
  /** Tracking sample rate, fps (default 5, same as P3b tracking). */
  sampleFps?: number;
  /** Text sticker that follows the target (drawtext, centre-anchored). */
  stickerText?: string;
  /** Mosaic size as a fraction of frame width (0 = no mosaic). */
  mosaicSize?: number;
}

export function validateObjectTrack(cfg: ObjectTrack | undefined, id: string, clipDurationSec?: number): void {
  if (!cfg) return;
  if (cfg.method !== 'color' && cfg.method !== 'template') {
    throw new Error(`clip ${id}: objectTrack.method "${String(cfg.method)}" must be 'color' or 'template'`);
  }
  if (cfg.method === 'color') {
    if (!cfg.color || cfg.color.length !== 3 || cfg.color.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
      throw new Error(`clip ${id}: objectTrack.color must be [r, g, b] ints in 0..255`);
    }
    if (cfg.tolerance !== undefined && (typeof cfg.tolerance !== 'number' || cfg.tolerance < 0 || cfg.tolerance > 442)) {
      throw new Error(`clip ${id}: objectTrack.tolerance ${cfg.tolerance} outside [0, 442]`);
    }
  }
  if (cfg.method === 'template') {
    const b = cfg.box;
    if (!b) throw new Error(`clip ${id}: objectTrack.template needs a box`);
    if (b.x < 0 || b.y < 0 || b.w <= 0 || b.h <= 0 || b.x + b.w > 1 || b.y + b.h > 1) {
      throw new Error(`clip ${id}: objectTrack.box (${b.x}, ${b.y}, ${b.w}, ${b.h}) is out of frame`);
    }
  }
  if (cfg.sampleFps !== undefined && (cfg.sampleFps < 1 || cfg.sampleFps > 30)) {
    throw new Error(`clip ${id}: objectTrack.sampleFps ${cfg.sampleFps} outside [1, 30]`);
  }
  if (cfg.mosaicSize !== undefined && (typeof cfg.mosaicSize !== 'number' || cfg.mosaicSize < 0 || cfg.mosaicSize > 0.5)) {
    throw new Error(`clip ${id}: objectTrack.mosaicSize ${cfg.mosaicSize} outside [0, 0.5]`);
  }
  if (cfg.stickerText !== undefined && (typeof cfg.stickerText !== 'string' || !cfg.stickerText.trim())) {
    throw new Error(`clip ${id}: objectTrack.stickerText must be non-empty`);
  }
  if (cfg.stickerText === undefined && (cfg.mosaicSize ?? 0) <= 0) {
    throw new Error(`clip ${id}: objectTrack needs a stickerText or a mosaicSize to follow with`);
  }
  void clipDurationSec;
}

/** Decode a video window as RGB24 frames at the given size/fps. */
export async function decodeVideoRgb24(
  file: string,
  width: number,
  height: number,
  sampleFps: number,
  opts: { ffmpeg?: string; ss?: number; dur?: number } = {},
): Promise<{ frames: Buffer[]; width: number; height: number; sampleFps: number }> {
  const args: string[] = ['-v', 'error'];
  if (opts.ss !== undefined) args.push('-ss', String(opts.ss));
  args.push('-i', file);
  if (opts.dur !== undefined) args.push('-t', String(opts.dur));
  args.push('-vf', `fps=fps=${sampleFps},scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  const { stdout } = await run(opts.ffmpeg ?? 'ffmpeg', args, { maxBuffer: 1024 * 1024 * 1024 });
  const fs = width * height * 3;
  const n = Math.floor(stdout.length / fs);
  const frames: Buffer[] = [];
  for (let f = 0; f < n; f++) frames.push(stdout.subarray(f * fs, (f + 1) * fs));
  return { frames, width, height, sampleFps };
}

/** Decode a video window as grayscale frames at the given size/fps. */
export async function decodeVideoGray(
  file: string,
  width: number,
  height: number,
  sampleFps: number,
  opts: { ffmpeg?: string; ss?: number; dur?: number } = {},
): Promise<{ frames: Buffer[]; width: number; height: number; sampleFps: number }> {
  const args: string[] = ['-v', 'error'];
  if (opts.ss !== undefined) args.push('-ss', String(opts.ss));
  args.push('-i', file);
  if (opts.dur !== undefined) args.push('-t', String(opts.dur));
  args.push('-vf', `fps=fps=${sampleFps},scale=${width}:${height},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-');
  const { stdout } = await run(opts.ffmpeg ?? 'ffmpeg', args, { maxBuffer: 1024 * 1024 * 1024 });
  const fs = width * height;
  const n = Math.floor(stdout.length / fs);
  const frames: Buffer[] = [];
  for (let f = 0; f < n; f++) frames.push(stdout.subarray(f * fs, (f + 1) * fs));
  return { frames, width, height, sampleFps };
}

const OBJECT_TRACK_MASS_MIN = 0.005;

/**
 * Colour-centroid tracking: per sampled frame, the centroid of pixels
 * within `tolerance` of the target colour. Probe-measured 2026-11-18:
 * a white disc moving 0.2 -> 0.8 of the frame over 4 s tracks with
 * <= ~1% frame error at 5 fps (probe-p3g2). Lost frames park at the
 * last known position and are flagged, never invented.
 */
export async function trackObjectByColor(
  file: string,
  color: [number, number, number],
  opts: { tolerance?: number; sampleFps?: number; width?: number; height?: number; ffmpeg?: string; ss?: number; dur?: number } = {},
): Promise<SubjectTrack> {
  const tol = opts.tolerance ?? 60;
  const sampleFps = opts.sampleFps ?? 5;
  const width = opts.width ?? 320;
  const height = opts.height ?? 180;
  const { frames } = await decodeVideoRgb24(file, width, height, sampleFps, opts);
  if (frames.length === 0) throw new Error(`trackObjectByColor: no frames decoded from ${file}`);
  const points: TrackPoint[] = [];
  let lastX = 0.5;
  let lastY = 0.5;
  for (let f = 0; f < frames.length; f++) {
    const fr = frames[f];
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 3;
        const dr = fr[o] - color[0];
        const dg = fr[o + 1] - color[1];
        const db = fr[o + 2] - color[2];
        if (dr * dr + dg * dg + db * db <= tol * tol) {
          sx += x;
          sy += y;
          sw++;
        }
      }
    }
    const mass = sw / (width * height);
    const lost = mass < OBJECT_TRACK_MASS_MIN;
    if (!lost) {
      lastX = sx / sw / width;
      lastY = sy / sw / height;
    }
    points.push({ t: f / sampleFps, x: lastX, y: lastY, lost, mass });
  }
  return { points, sampleFps, width, height };
}

/**
 * NCC template tracking: the patch inside `box` on the first frame is
 * matched (normalised cross-correlation) in a window around the last
 * known centre. Runs on a downscaled grayscale copy (default 160x90)
 * — probe-p3g: 40 frames in ~0.2 s. `scores` holds the best NCC per
 * frame; a frame scores < 0.5 counts as lost. The template is taken
 * from the MEASURED first-frame content, never from an assumed
 * position.
 */
export async function trackObjectByTemplate(
  file: string,
  box: { x: number; y: number; w: number; h: number },
  opts: { sampleFps?: number; width?: number; height?: number; searchRadius?: number; ffmpeg?: string; ss?: number; dur?: number } = {},
): Promise<{ track: SubjectTrack; scores: number[] }> {
  const sampleFps = opts.sampleFps ?? 5;
  const width = opts.width ?? 160;
  const height = opts.height ?? 90;
  const radius = opts.searchRadius ?? 25;
  const { frames } = await decodeVideoGray(file, width, height, sampleFps, opts);
  if (frames.length === 0) throw new Error(`trackObjectByTemplate: no frames decoded from ${file}`);
  const tx = Math.round(box.x * width);
  const ty = Math.round(box.y * height);
  const tw = Math.max(4, Math.round(box.w * width));
  const th = Math.max(4, Math.round(box.h * height));
  if (tx < 0 || ty < 0 || tx + tw > width || ty + th > height) {
    throw new Error('trackObjectByTemplate: box is out of frame at the tracking resolution');
  }
  const tpl: number[] = [];
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) tpl.push(frames[0][(ty + y) * width + tx + x]);
  }
  const tMean = tpl.reduce((a, b) => a + b, 0) / tpl.length;
  const tVar = tpl.reduce((a, b) => a + (b - tMean) ** 2, 0);
  if (tVar < 1) throw new Error('trackObjectByTemplate: template patch is uniform — pick a textured box');
  const points: TrackPoint[] = [];
  const scores: number[] = [];
  let cx = tx + tw / 2;
  let cy = ty + th / 2;
  let lastX = cx / width;
  let lastY = cy / height;
  for (let f = 0; f < frames.length; f++) {
    const fr = frames[f];
    let best = -2;
    let bx = Math.round(cx - tw / 2);
    let by = Math.round(cy - th / 2);
    const x0 = Math.max(0, Math.round(cx - tw / 2) - radius);
    const x1 = Math.min(width - tw, Math.round(cx - tw / 2) + radius);
    const y0 = Math.max(0, Math.round(cy - th / 2) - radius);
    const y1 = Math.min(height - th, Math.round(cy - th / 2) + radius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let m = 0;
        for (let yy = 0; yy < th; yy++) {
          for (let xx = 0; xx < tw; xx++) m += fr[(y + yy) * width + x + xx];
        }
        m /= tw * th;
        let num = 0;
        let v = 0;
        for (let yy = 0; yy < th; yy++) {
          for (let xx = 0; xx < tw; xx++) {
            const d = fr[(y + yy) * width + x + xx] - m;
            num += d * (tpl[yy * tw + xx] - tMean);
            v += d * d;
          }
        }
        const ncc = num / Math.sqrt(v * tVar + 1e-9);
        if (ncc > best) { best = ncc; bx = x; by = y; }
      }
    }
    const lost = best < 0.5;
    if (!lost) {
      cx = bx + tw / 2;
      cy = by + th / 2;
      lastX = cx / width;
      lastY = cy / height;
    }
    scores.push(best);
    points.push({ t: f / sampleFps, x: lastX, y: lastY, lost, mass: Math.max(0, best) });
  }
  return { track: { points, sampleFps, width, height }, scores };
}

/** Nested-if lerp expression over track points (<=60 keys), giving a
 *  pixel coordinate on an axis of `sizePx`. Same pattern as the P3b
 *  reframe crop expression. */
export function trackAxisExpr(track: SubjectTrack, axis: 'x' | 'y', sizePx: number): string {
  const pts = track.points.filter((p) => !p.lost);
  const keys = pts.length > 0 ? pts : track.points;
  const use = keys.length > 60 ? keys.filter((_, i) => i % Math.ceil(keys.length / 60) === 0) : keys;
  const val = (p: TrackPoint): string => ((axis === 'x' ? p.x : p.y) * sizePx).toFixed(2);
  const t = (p: TrackPoint): string => p.t.toFixed(3);
  if (use.length === 1) return val(use[0]);
  let expr = val(use[use.length - 1]);
  for (let i = use.length - 2; i >= 0; i--) {
    const k0 = use[i];
    const k1 = use[i + 1];
    expr =
      `if(lt(t,${t(k0)}),${val(k0)},` +
      `if(gt(t,${t(k1)}),${expr},${val(k0)}+(${val(k1)}-${val(k0)})*(t-${t(k0)})/(${t(k1)}-${t(k0)})))`;
  }
  return expr;
}

/** drawtext filter for a sticker that follows the tracked centre
 *  (centre-anchored via text_w/text_h). Probe-verified: drawtext x/y
 *  expressions re-evaluate per frame (probe-p3g2: 'X' sits at x~80 at
 *  t=1 and x~200 at t=3 for x='20+60*t'). */
export function objectTrackDrawtextFilter(
  track: SubjectTrack,
  text: string,
  fontfile: string,
  projectWidth: number,
  projectHeight: number,
  fontsize = 40,
  fontcolor = 'white',
): string {
  const esc = text.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:');
  const xExpr = trackAxisExpr(track, 'x', projectWidth);
  const yExpr = trackAxisExpr(track, 'y', projectHeight);
  return (
    `drawtext=fontfile=${fontfile}:text='${esc}':fontsize=${fontsize}` +
    `:fontcolor=${fontcolor}:x='(${xExpr})-text_w/2':y='(${yExpr})-text_h/2'`
  );
}

/** Rect mask buffer centred on the track (mosaic window). */
export function buildObjectTrackMaskBuffer(
  track: SubjectTrack,
  sizeFrac: number,
  width: number,
  height: number,
  duration: number,
): Buffer {
  const sampleFps = track.sampleFps;
  const nF = Math.max(1, Math.ceil(duration * sampleFps));
  const buf = Buffer.alloc(width * height * nF);
  const half = (sizeFrac * width) / 2;
  for (let f = 0; f < nF; f++) {
    const t = f / sampleFps;
    const c = trackCenterAt(track, t) ?? { x: 0.5, y: 0.5 };
    const cx = c.x * width;
    const cy = c.y * height;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        buf[f * width * height + y * width + x] =
          Math.abs(x + 0.5 - cx) <= half && Math.abs(y + 0.5 - cy) <= half ? 255 : 0;
      }
    }
  }
  return buf;
}

export interface ObjectTrackPrep {
  track: SubjectTrack;
  /** Moving mosaic mask video (only when mosaicSize is set). */
  maskVideo?: string;
  lostFraction: number;
}

/**
 * Export prep: run the tracker for every clip with objectTrack.
 * Speed must be 1 with no reverse/freeze (tracking is in clip-local
 * output time = source time only then). A track that is lost for more
 * than half its frames throws — the target is gone, not followed.
 */
export async function prepareObjectTracks(
  project: Project,
  outDir: string,
  opts: { ffmpeg?: string; ffprobe?: string } = {},
): Promise<Map<number, ObjectTrackPrep>> {
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const out = new Map<number, ObjectTrackPrep>();
  for (let i = 0; i < project.clips.length; i++) {
    const clip = project.clips[i];
    const cfg = clip.objectTrack;
    if (!cfg) continue;
    validateObjectTrack(cfg, clip.id);
    if (clip.speed !== 1 || clip.reverse || clip.freezeAt !== undefined) {
      throw new Error(`clip ${clip.id}: objectTrack needs speed 1, no reverse/freeze`);
    }
    const dur = clipDuration(clip);
    const sampleFps = cfg.sampleFps ?? 5;
    let track: SubjectTrack;
    if (cfg.method === 'color') {
      track = await trackObjectByColor(clip.source, cfg.color as [number, number, number], {
        tolerance: cfg.tolerance,
        sampleFps,
        width: project.width,
        height: project.height,
        ffmpeg,
        ss: clip.in,
        dur: clip.out - clip.in,
      });
    } else {
      const res = await trackObjectByTemplate(clip.source, cfg.box as { x: number; y: number; w: number; h: number }, {
        sampleFps,
        ffmpeg,
        ss: clip.in,
        dur: clip.out - clip.in,
      });
      track = res.track;
    }
    // Re-base to clip-local output time (tracker t is source-window time).
    track = {
      ...track,
      points: track.points.map((p) => ({ ...p, t: Math.max(0, p.t) })),
    };
    const lost = track.points.filter((p) => p.lost).length;
    const lostFraction = track.points.length > 0 ? lost / track.points.length : 1;
    if (track.points.length === 0 || lostFraction > 0.5) {
      throw new Error(
        `clip ${clip.id}: object track lost (${lost}/${track.points.length} frames) — target not found, refusing to follow blindly`,
      );
    }
    let maskVideo: string | undefined;
    if ((cfg.mosaicSize ?? 0) > 0) {
      const buf = buildObjectTrackMaskBuffer(track, cfg.mosaicSize as number, project.width, project.height, dur);
      maskVideo = join(outDir, `objtrack-c${i}.mp4`);
      await writeMaskVideoFromBuffer(buf, project.width, project.height, sampleFps, maskVideo, ffmpeg);
    }
    out.set(i, { track, maskVideo, lostFraction });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 8. Clone (M4 line 187)
// ---------------------------------------------------------------------------

export interface CloneEffect {
  /** 2 = left/right split, 4 = 2x2 grid. */
  lanes: 2 | 4;
  /** Source-time offset per lane in seconds; offsets[0] must be 0. */
  offsets: number[];
  layout?: 'horizontal' | 'grid';
}

export function validateCloneEffect(clone: CloneEffect | undefined, clip: Clip): void {
  if (!clone) return;
  if (clone.lanes !== 2 && clone.lanes !== 4) {
    throw new Error(`clip ${clip.id}: clone.lanes ${clone.lanes} must be 2 or 4`);
  }
  if (!Array.isArray(clone.offsets) || clone.offsets.length !== clone.lanes) {
    throw new Error(`clip ${clip.id}: clone.offsets must have exactly ${clone.lanes} entries`);
  }
  if (clone.offsets[0] !== 0) {
    throw new Error(`clip ${clip.id}: clone.offsets[0] must be 0 (lane 0 is the reference)`);
  }
  for (let k = 1; k < clone.offsets.length; k++) {
    if (!(clone.offsets[k] > clone.offsets[k - 1])) {
      throw new Error(`clip ${clip.id}: clone.offsets must be strictly increasing`);
    }
  }
  if (clone.layout !== undefined && clone.layout !== 'horizontal' && clone.layout !== 'grid') {
    throw new Error(`clip ${clip.id}: clone.layout "${String(clone.layout)}" must be 'horizontal' or 'grid'`);
  }
  if (clone.lanes === 4 && clone.layout === 'horizontal') {
    throw new Error(`clip ${clip.id}: clone with 4 lanes needs layout 'grid'`);
  }
  if (clip.speed !== 1 || clip.reverse || clip.freezeAt !== undefined || clip.reframe || clip.multicam || clip.compound || clip.stabilize) {
    throw new Error(`clip ${clip.id}: clone needs speed 1, no reverse/freeze/reframe/multicam/compound/stabilize`);
  }
}

/** Per-lane frame size for a clone layout (even numbers for yuv420p). */
export function cloneLaneSize(
  clone: CloneEffect,
  projectWidth: number,
  projectHeight: number,
): { laneW: number; laneH: number } {
  if (clone.lanes === 2) {
    return { laneW: 2 * Math.floor(projectWidth / 4), laneH: projectHeight };
  }
  return {
    laneW: 2 * Math.floor(projectWidth / 4),
    laneH: 2 * Math.floor(projectHeight / 4),
  };
}

/** Export prep: the latest lane's source window must fit in the file. */
export async function prepareClone(
  project: Project,
  opts: { ffprobe?: string } = {},
): Promise<void> {
  for (const clip of project.clips) {
    if (!clip.clone) continue;
    validateCloneEffect(clip.clone, clip);
    const info = await probeVideoInfo(clip.source, opts.ffprobe ?? 'ffprobe');
    const maxOff = Math.max(...clip.clone.offsets);
    if (clip.out + maxOff > info.duration + 0.05) {
      throw new Error(
        `clip ${clip.id}: clone latest lane ends at ${clip.out + maxOff}s but the source is only ${info.duration.toFixed(3)}s`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 9. Key outline (M4 line 188)
// ---------------------------------------------------------------------------

export interface KeyOutline {
  /** Outline colour: '#rrggbb' or a name (red/green/blue/white/black/yellow/cyan/magenta). */
  color: string;
  /** Outline thickness in px, 1..10. */
  width: number;
}

const NAMED_OUTLINE_COLORS: Record<string, [number, number, number]> = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  white: [255, 255, 255],
  black: [0, 0, 0],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
};

export function parseOutlineColor(color: string): [number, number, number] {
  const c = color.trim().toLowerCase();
  if (NAMED_OUTLINE_COLORS[c]) return NAMED_OUTLINE_COLORS[c];
  const m = c.match(/^#([0-9a-f]{6})$/);
  if (m) {
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  }
  throw new Error(`unknown outline color "${color}" (use #rrggbb or red/green/blue/white/black/yellow/cyan/magenta)`);
}

export function validateKeyOutline(outline: KeyOutline | undefined, id: string): void {
  if (!outline) return;
  parseOutlineColor(outline.color);
  if (!Number.isInteger(outline.width) || outline.width < 1 || outline.width > 10) {
    throw new Error(`clip ${id}: outline.width ${outline.width} must be an integer in [1, 10]`);
  }
}

/** Dilation chain: one `dilation` pass grows a gray mask by ~1 px
 *  (probe-p3g: r=30 disc 2809 -> 3049 white px after 1 pass, 3553
 *  after 3 passes). Chained `width` times for the outline thickness. */
export function outlineDilationFilter(width: number): string {
  return Array.from({ length: width }, () => 'dilation=threshold0=255').join(',');
}

// ---------------------------------------------------------------------------
// 10. Auto-video: script + images -> film (M4 line 185)
// ---------------------------------------------------------------------------

export interface AutoVideoLine {
  /** Narration sentence (also burned as a text overlay). */
  text: string;
  /** Still image (png/jpg) or video file for this line. */
  image?: string;
}

export interface AutoVideo {
  lines: AutoVideoLine[];
  /** Optional music file: segment boundaries snap to its beat grid. */
  music?: string;
  /** Built-in template id (talking-clean / vlog-film / beat-energetic / interview-duo). */
  templateId?: string;
}

export function validateAutoVideo(auto: AutoVideo | undefined): void {
  if (!auto) return;
  if (!Array.isArray(auto.lines) || auto.lines.length === 0) {
    throw new Error('autoVideo: lines must be a non-empty array');
  }
  for (let i = 0; i < auto.lines.length; i++) {
    const line = auto.lines[i];
    if (typeof line.text !== 'string' || !line.text.trim()) {
      throw new Error(`autoVideo line ${i}: text must be non-empty`);
    }
    if (line.text.length > 2000) {
      throw new Error(`autoVideo line ${i}: text exceeds the 2000-char TTS cap`);
    }
    if (line.image !== undefined && !existsSync(line.image)) {
      throw new Error(`autoVideo line ${i}: image missing: ${line.image}`);
    }
  }
  if (auto.music !== undefined && !existsSync(auto.music)) {
    throw new Error(`autoVideo: music missing: ${auto.music}`);
  }
  if (auto.templateId !== undefined && !(BUILTIN_TEMPLATE_IDS as readonly string[]).includes(auto.templateId)) {
    throw new Error(`autoVideo: unknown template "${auto.templateId}" (expected one of ${BUILTIN_TEMPLATE_IDS.join(', ')})`);
  }
}

export interface AutoVideoSegment {
  text: string;
  /** Synthesised narration length. */
  ttsDuration: number;
  /** Segment start on the timeline. */
  start: number;
  /** Segment duration (TTS length, plus beat snap when music is set). */
  duration: number;
  /** Beat time the boundary snapped to (music only). */
  beat?: number;
}

export interface AutoVideoBuildOptions {
  outDir: string;
  ffmpeg?: string;
  python?: string;
  ttsScript?: string;
  ttsModelDir?: string;
}

const STILL_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

/**
 * Build a film project from a script: each line gets a TTS narration
 * (sherpa-onnx, P3f) muxed with its image into a still-clip, the
 * sentence burned as a text overlay, and — when music is set — each
 * segment boundary (except the first and last) snapped forward to
 * the nearest beat within 0.35 s by extending the previous segment's
 * image hold (the narration itself is never stretched: its length
 * always fits inside its segment).
 */
export async function buildAutoVideoProject(
  auto: AutoVideo,
  project: { width: number; height: number; fps: number },
  opts: AutoVideoBuildOptions,
): Promise<{ project: Project; segments: AutoVideoSegment[] }> {
  validateAutoVideo(auto);
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const outDir = opts.outDir;
  mkdirSync(outDir, { recursive: true });
  let grid: BeatGrid | undefined;
  if (auto.music) {
    grid = await detectBeats(auto.music, { ffmpeg });
    if (grid.beats.length === 0) throw new Error('autoVideo: no beats detected in the music file');
  }
  const segments: AutoVideoSegment[] = [];
  const clips: Clip[] = [];
  let start = 0;
  for (let i = 0; i < auto.lines.length; i++) {
    const line = auto.lines[i];
    // TTS narration for this line.
    const wav = join(outDir, `autovideo-line${i}.wav`);
    const tts = await synthesizeSpeech(line.text, wav, {
      python: opts.python,
      script: opts.ttsScript,
      modelDir: opts.ttsModelDir,
    });
    let duration = tts.duration;
    // Beat snap: the boundary AFTER this segment (not the last one)
    // moves forward to the nearest beat within 0.35 s.
    let beat: number | undefined;
    if (grid && i < auto.lines.length - 1) {
      const boundary = start + duration;
      const next = grid.beats.find((b) => b >= boundary && b - boundary <= 0.35);
      if (next !== undefined) {
        duration += next - boundary;
        beat = next;
      }
    }
    const seg: AutoVideoSegment = { text: line.text, ttsDuration: tts.duration, start, duration, ...(beat !== undefined ? { beat } : {}) };
    segments.push(seg);
    // Still-clip: image (looped) or video (looped) + TTS audio.
    const lineMp4 = join(outDir, `autovideo-line${i}.mp4`);
    const isStill = line.image !== undefined && STILL_EXTS.has(extname(line.image).toLowerCase());
    const imgArgs: string[] = line.image
      ? (isStill
        ? ['-loop', '1', '-i', line.image]
        : ['-stream_loop', '-1', '-i', line.image])
      : ['-f', 'lavfi', '-i', `color=c=black:s=${project.width}x${project.height}:r=${project.fps}:d=${duration.toFixed(3)}`];
    await run(ffmpeg, [
      '-v', 'error',
      ...imgArgs,
      '-i', wav,
      '-t', String(duration),
      '-map', '0:v', '-map', '1:a',
      '-vf', `scale=${project.width}:${project.height}:force_original_aspect_ratio=increase,crop=${project.width}:${project.height},fps=${project.fps}`,
      // Pad the narration with silence to the segment duration — NOT
      // -shortest: when a beat snap extends the segment past the
      // narration, the image hold must fill the whole segment
      // (probe-p3g6 caught -shortest truncating the snapped 0.27 s).
      '-af', `apad=whole_dur=${duration.toFixed(3)}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-y', lineMp4,
    ]);
    const fontsize = Math.max(24, Math.round(project.height * 0.055));
    clips.push({
      id: `line${i}`,
      source: lineMp4,
      in: 0,
      out: duration,
      speed: 1,
      volume: 1,
      text: [{
        text: line.text,
        x: 0.5,
        y: 0.85,
        fontsize,
        fontcolor: 'white',
        start: 0,
        end: duration,
        box: true,
      }],
    });
    start += duration;
  }
  let outProject: Project = {
    version: 1,
    width: project.width,
    height: project.height,
    fps: project.fps,
    clips,
    transitions: new Array(Math.max(0, clips.length - 1)).fill('cut'),
    transitionDuration: 0.5,
    autoVideo: auto,
  };
  if (auto.templateId) {
    const template = loadBuiltInTemplate(auto.templateId);
    outProject = applyTemplateToProject(outProject, template);
  }
  return { project: outProject, segments };
}

// ---------------------------------------------------------------------------
// 11. AI upscaling (M4 line 184)
// ---------------------------------------------------------------------------

export type UpscaleModel = 'realesrgan-x4plus' | 'realesrgan-x2plus';
export const UPSCALE_MODELS: UpscaleModel[] = ['realesrgan-x4plus', 'realesrgan-x2plus'];

export const UPSCALE_SETUP = [
  'AI upscaling needs a Real-ESRGAN ONNX model (BSD-3-Clause code; re-check the model licence before redistributing):',
  '1. Download the official weights: RealESRGAN_x4plus.pth from github.com/xinntao/Real-ESRGAN releases (v0.1.0).',
  '2. Export ONNX with the project script: python scripts/pytorch2onnx.py --model_path RealESRGAN_x4plus.pth --output RealESRGAN_x4plus.onnx',
  '3. Place the .onnx at test/models/RealESRGAN_x4plus.onnx (or pass modelPath).',
  'CPU inference is slow (seconds per frame at 320x180); upscaling is an export-time option only.',
].join('\n');

export interface UpscaleOptions {
  targetWidth: number;
  targetHeight: number;
  model?: UpscaleModel;
  /** Explicit .onnx path (default: test/models/<model>.onnx under the engine root). */
  modelPath?: string;
}

export function upscaleScaleOf(model: UpscaleModel): number {
  return model === 'realesrgan-x2plus' ? 2 : 4;
}

export function validateUpscale(opts: UpscaleOptions | undefined, srcWidth: number, srcHeight: number): void {
  if (!opts) return;
  const model = opts.model ?? 'realesrgan-x4plus';
  if (!UPSCALE_MODELS.includes(model)) {
    throw new Error(`upscale: unknown model "${String(model)}" (expected one of ${UPSCALE_MODELS.join(', ')})`);
  }
  if (!Number.isInteger(opts.targetWidth) || opts.targetWidth <= 0 || opts.targetWidth % 2 !== 0) {
    throw new Error(`upscale: targetWidth ${opts.targetWidth} must be a positive even integer`);
  }
  if (!Number.isInteger(opts.targetHeight) || opts.targetHeight <= 0 || opts.targetHeight % 2 !== 0) {
    throw new Error(`upscale: targetHeight ${opts.targetHeight} must be a positive even integer`);
  }
  if (opts.targetWidth <= srcWidth || opts.targetHeight <= srcHeight) {
    throw new Error(
      `upscale: target ${opts.targetWidth}x${opts.targetHeight} must exceed the source ${srcWidth}x${srcHeight} — upscaling to an equal or smaller size is refused`,
    );
  }
}

export function defaultUpscaleModelPath(engineRoot: string, model: UpscaleModel = 'realesrgan-x4plus'): string {
  return join(engineRoot, 'test', 'models', `${model === 'realesrgan-x2plus' ? 'RealESRGAN_x2plus' : 'RealESRGAN_x4plus'}.onnx`);
}

export function defaultUpscaleScriptPath(engineRoot: string): string {
  return join(engineRoot, 'scripts', 'upscale.py');
}

export interface UpscaleResult {
  file: string;
  width: number;
  height: number;
  duration: number;
  frames: number;
  scale: number;
}

/**
 * Upscale a video file with the Real-ESRGAN ONNX model (frame loop:
 * extract PNGs -> onnxruntime per frame -> re-encode with the original
 * audio). Throws an honest "model not available" error when the .onnx
 * is absent — never a silent lanczos pass dressed up as AI upscaling.
 */
export async function upscaleVideo(
  input: string,
  output: string,
  opts: UpscaleOptions & { ffmpeg?: string; ffprobe?: string; python?: string; script?: string; engineRoot?: string; workDir?: string },
): Promise<UpscaleResult> {
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const ffprobe = opts.ffprobe ?? 'ffprobe';
  const model = opts.model ?? 'realesrgan-x4plus';
  const scale = upscaleScaleOf(model);
  const info = await probeVideoInfo(input, ffprobe);
  validateUpscale(opts, info.width, info.height);
  const engineRoot = opts.engineRoot ?? join(dirname(new URL(import.meta.url).pathname), '..');
  const modelPath = opts.modelPath ?? defaultUpscaleModelPath(engineRoot, model);
  if (!existsSync(modelPath)) {
    throw new Error(`AI upscaling failed: model not available at ${modelPath}\n${UPSCALE_SETUP}`);
  }
  const script = opts.script ?? defaultUpscaleScriptPath(engineRoot);
  if (!existsSync(script)) {
    throw new Error(`AI upscaling failed: helper script missing: ${script}`);
  }
  const workDir = opts.workDir ?? join(dirname(output), 'upscale-work');
  const inDir = join(workDir, 'in');
  const outDir = join(workDir, 'out');
  mkdirSync(inDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const fps = info.fps;
  await run(ffmpeg, [
    '-v', 'error', '-i', input,
    '-vf', `fps=fps=${fps}`, '-y', join(inDir, '%06d.png'),
  ]);
  const inFrames = readdirSync(inDir).filter((f) => f.endsWith('.png')).sort();
  if (inFrames.length === 0) throw new Error(`upscaleVideo: no frames extracted from ${input}`);
  await run(opts.python ?? '.venv/bin/python', [
    script, '--model', modelPath, '--in-dir', inDir, '--out-dir', outDir, '--scale', String(scale),
  ], { maxBuffer: 1024 * 1024 * 1024 });
  const outFrames = readdirSync(outDir).filter((f) => f.endsWith('.png')).sort();
  if (outFrames.length !== inFrames.length) {
    throw new Error(`upscaleVideo: model produced ${outFrames.length} frames for ${inFrames.length} inputs`);
  }
  await run(ffmpeg, [
    '-v', 'error', '-framerate', String(fps), '-i', join(outDir, '%06d.png'),
    ...(info.hasAudio ? ['-i', input] : []),
    '-map', '0:v',
    ...(info.hasAudio ? ['-map', '1:a', '-c:a', 'copy'] : ['-an']),
    '-vf', `scale=${opts.targetWidth}:${opts.targetHeight}:flags=lanczos`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-shortest', '-y', output,
  ]);
  const outInfo = await probeVideoInfo(output, ffprobe);
  if (outInfo.width !== opts.targetWidth || outInfo.height !== opts.targetHeight) {
    throw new Error(`upscaleVideo: output is ${outInfo.width}x${outInfo.height}, expected ${opts.targetWidth}x${opts.targetHeight}`);
  }
  return {
    file: output,
    width: outInfo.width,
    height: outInfo.height,
    duration: outInfo.duration,
    frames: outFrames.length,
    scale,
  };
}

// ---------------------------------------------------------------------------
// Graph inputs (wiring bundle for filtergraph.ts / export.ts)
// ---------------------------------------------------------------------------

export interface GradeNodeStage {
  lut: string;
  mask: string;
  blend: GradeBlendMode;
  opacity: number;
}

export interface P3gGraphInputs {
  /** clipIdx -> input-conversion LUT paths (slog3/srgb path). */
  colorMgmtLuts?: Map<number, string[]>;
  /** clipIdx -> extra LUT paths applied after advancedColour (colour-match + node final LUT). */
  extraLuts?: Map<number, string[]>;
  /** Project output conversion LUT (working -> output space). */
  outputLut?: string;
  /** Project output space (for the setparams tag). */
  outputSpace?: OutputColorSpace;
  /** clipIdx -> tracked-window {lut, mask video}. */
  trackedWindows?: Map<number, TrackedWindowFiles>;
  /** clipIdx -> masked node stages. */
  gradeNodeStages?: Map<number, GradeNodeStage[]>;
  /** clipIdx -> tracked subject track (object tracking / sticker text). */
  objectTracks?: Map<number, SubjectTrack>;
  /** clipIdx -> moving mosaic mask video. */
  objectTrackMasks?: Map<number, string>;
}
