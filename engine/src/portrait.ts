// Smart portrait cutout (P1, M4): ONNX human segmentation, local only.
// The bundled model is MediaPipe Selfie Segmentation 256x256 (Apache 2.0,
// see models/README.md). Inference runs in scripts/portrait_segment.py
// (Python + onnxruntime, CPU) — the same pattern as scripts/transcribe.py
// for faster-whisper: the TypeScript engine owns the model + the filter
// graph, the Python script is the Linux reference implementation. On
// Windows the same interface will be served natively by
// Microsoft.ML.OnnxRuntime (NuGet); no cloud, no subscription.
//
// Pipeline: for each portrait clip, the helper decodes the clip range to
// 256x256 RGB frames, runs the model per frame (or every Nth frame with
// sampleEvery), and encodes a grayscale mask VIDEO (libx264 qp 0 =
// lossless luma) at full project size. The export filter graph then
// merges the mask as alpha (alphamerge) and overlays the cut-out person
// over the chosen background — the same composite pattern as the
// chroma-key stage, but the alpha comes from the model, not from a key
// colour. No per-frame geq anywhere.
//
// v1 limits (enforced by validatePortraitCutout, not silently worked
// around): the clip must play at speed 1 with no speed curve, no reverse
// and no freeze — the mask video is computed on source frames at native
// fps, so any resampling would desync masks from pictures. A clip may
// not combine portraitCutout with chromaKey (two foreground extractors).
// LGPL note: alphamerge/overlay/fps/format/gblur are libavfilter filters
// (LGPL part of FFmpeg), but they have only been verified on this
// machine's GPL 8.1.2 build — re-check with `ffmpeg -filters` on the
// BtbN LGPL 9.0 build before shipping (M2 gate).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { clipDuration, type Clip, type PortraitCutout, type Project } from './project.js';

export type { PortraitCutout } from './project.js';

const execFileAsync = promisify(execFile);

export const PORTRAIT_SETUP = [
  'Smart portrait cutout (ONNX, local) setup:',
  '1. python3 -m venv .venv && .venv/bin/pip install onnxruntime',
  '   (MIT licensed CPU wheel; the engine passes that venv python in).',
  '2. The model ships in the repo: models/selfie_segmentation_256x256.onnx',
  '   (MediaPipe Selfie Segmentation, Apache 2.0, 447,658 bytes).',
  '3. On Windows the same interface will be served natively by',
  '   Microsoft.ML.OnnxRuntime (NuGet); the Python script is the Linux',
  '   reference implementation, like scripts/transcribe.py for Whisper.',
].join('\n');

/** Default model file shipped in the repo (next to src/, under models/). */
export function defaultPortraitModelPath(): string {
  return join(fileURLToPath(new URL('../models/', import.meta.url)), 'selfie_segmentation_256x256.onnx');
}

/** Default helper script (engine/scripts/portrait_segment.py). */
export function defaultPortraitScriptPath(): string {
  return join(fileURLToPath(new URL('../scripts/', import.meta.url)), 'portrait_segment.py');
}

export function resolvePortraitModelPath(model?: string, override?: string): string {
  return override ?? model ?? defaultPortraitModelPath();
}

/** Validate a portrait cutout against its clip; throws on anything v1 cannot do. */
export function validatePortraitCutout(cutout: PortraitCutout, clip: Clip): void {
  if (cutout.edgeFeather !== undefined && cutout.edgeFeather < 0) {
    throw new Error(`clip ${clip.id}: portraitCutout.edgeFeather ${cutout.edgeFeather} must be >= 0`);
  }
  if (cutout.sampleEvery !== undefined && (!Number.isInteger(cutout.sampleEvery) || cutout.sampleEvery < 1)) {
    throw new Error(`clip ${clip.id}: portraitCutout.sampleEvery ${cutout.sampleEvery} must be an integer >= 1`);
  }
  if (cutout.background?.color && cutout.background?.source) {
    throw new Error(`clip ${clip.id}: portraitCutout.background takes either color or source, not both`);
  }
  if (clip.chromaKey) {
    throw new Error(`clip ${clip.id}: portraitCutout and chromaKey cannot be combined (two foreground extractors)`);
  }
  if (clip.reverse) {
    throw new Error(`clip ${clip.id}: portraitCutout + reverse is rejected (reversed frame order breaks mask alignment)`);
  }
  if (clip.freezeAt !== undefined) {
    throw new Error(`clip ${clip.id}: portraitCutout + freeze frame is not supported in v1`);
  }
  if (clip.speed !== 1 || (clip.speedCurve ?? []).some((p) => p.speed !== 1)) {
    throw new Error(`clip ${clip.id}: portraitCutout requires speed 1 (v1 masks are computed on source frames)`);
  }
}

/** Mask video path for one clip (kept next to the export as an audit trail). */
export function portraitMaskVideoPath(dir: string, clipIndex: number): string {
  return join(dir, `portrait-c${clipIndex}-mask.mp4`);
}

/** Source fps of a video file (r_frame_rate of stream v:0). */
export async function probeVideoFps(file: string, ffprobe = 'ffprobe'): Promise<number> {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', file,
  ]);
  const [num, den] = stdout.trim().replace(/,+$/, '').split('/').map(Number);
  if (!num || !den) throw new Error(`cannot read fps of ${file} (ffprobe gave ${JSON.stringify(stdout.trim())})`);
  return num / den;
}

/** One JSON summary line printed by scripts/portrait_segment.py. */
export interface PortraitRunSummary {
  frames: number;
  sampled: number;
  model: string;
  medianMs: number;
  meanMs: number;
  maxMs: number;
  width: number;
  height: number;
  fps: number;
  sampleEvery: number;
  out: string;
}

export interface PreparePortraitOptions {
  /** Python binary with onnxruntime installed (venv python). */
  python?: string;
  /** Helper script path (default: engine/scripts/portrait_segment.py). */
  script?: string;
  /** Default model path override (per-clip `model` still wins). */
  model?: string;
  ffmpeg?: string;
  ffprobe?: string;
}

/**
 * Run the segmentation helper for every portrait clip and write one mask
 * video per clip under `dir`. Returns clip index -> mask video path.
 * The mask videos are kept next to the export as an audit trail, like the
 * mask PNGs and the .ass file.
 */
export async function preparePortraitMasks(
  project: Project,
  dir: string,
  opts: PreparePortraitOptions = {},
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const python = opts.python ?? 'python3';
  const script = opts.script ?? defaultPortraitScriptPath();
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < project.clips.length; i++) {
    const clip = project.clips[i];
    const cutout = clip.portraitCutout;
    if (!cutout) continue;
    validatePortraitCutout(cutout, clip);
    const model = resolvePortraitModelPath(cutout.model, opts.model);
    if (!existsSync(model)) {
      throw new Error(
        `clip ${clip.id}: portrait model not found: ${model}\n${PORTRAIT_SETUP}`,
      );
    }
    if (!existsSync(script)) {
      throw new Error(`portrait helper script not found: ${script}`);
    }
    const fps = await probeVideoFps(clip.source, opts.ffprobe);
    const outPath = portraitMaskVideoPath(dir, i);
    const dur = clipDuration(clip);
    const args = [
      script,
      '--video', clip.source,
      '--model', model,
      '--out', outPath,
      '--fps', String(fps),
      '--in', String(clip.in),
      '--dur', String(dur),
      '--width', String(project.width),
      '--height', String(project.height),
      '--sample-every', String(cutout.sampleEvery ?? 1),
      '--ffmpeg', ffmpeg,
    ];
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(python, args, { maxBuffer: 64 * 1024 * 1024 }));
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      throw new Error(
        `clip ${clip.id}: portrait segmentation failed: ${(err.stderr ?? err.message ?? String(e)).toString().trim()}`,
      );
    }
    let summary: PortraitRunSummary;
    try {
      summary = JSON.parse(stdout.trim().split('\n').pop() as string) as PortraitRunSummary;
    } catch {
      throw new Error(`clip ${clip.id}: portrait helper printed unparsable output: ${stdout.trim()}`);
    }
    if (!existsSync(outPath)) {
      throw new Error(`clip ${clip.id}: portrait helper reported success but wrote no mask video: ${outPath}`);
    }
    if (summary.sampled === 0 || summary.frames === 0) {
      throw new Error(`clip ${clip.id}: portrait helper processed 0 frames`);
    }
    out.set(i, outPath);
  }
  return out;
}
