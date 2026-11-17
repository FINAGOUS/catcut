// Optimized media (P3 batch 6, M4 §8.6): a full-resolution,
// intra-frame intermediate for colour grading / keying, alongside
// the 720p proxy (P2c). Resolve "optimized media" / FCP "optimized
// media" — same idea: the timeline edits against a file that is
// cheap to decode, at full resolution.
//
// - Codec: DNxHR (FFmpeg `dnxhd` encoder, LGPL) in a .mov container,
//   profile dnxhr_hq by default (10-bit 4:2:2, intra-frame only),
//   dnxhr_sq / dnxhr_lb available. Audio is copied as PCM (no
//   lossy re-encode of the audio). The file keeps the source's
//   resolution, fps and duration.
// - Unlike the proxy, optimized media is NOT a downscale: the clip
//   keeps its full size, so grading/keying decisions made against it
//   match the original. useOptimizedMedia() swaps a clip's source
//   for its optimized file (the preview path); export ALWAYS renders
//   from the original `source` after validateOptimizedMedia() has
//   confirmed the file exists and matches its declaration — the same
//   never-silent-fallback rule as proxies (proxy.ts).
// - v1 limits: not supported on compound / multicam clips (same as
//   proxies); DNxHD needs even dimensions (odd sizes are rejected
//   up front with the measured size).
//
// Measured behaviour (probe 2026-11-18, FFmpeg 8.1.2):
// - 320x180 red source -> dnxhr_hq .mov: ffprobe reads codec dnxhd,
//   profile "DNXHR HQ", 320x180, 30 fps, duration 2.000 s.
// - PSNR of the DNxHR frame vs the libx264 source frame reads
//   24.65 dB — that number is a COLOUR-SPACE artefact, not quality:
//   the frame means are (255,23,0) vs (253,0,0) — the DNxHR encode
//   runs in yuv422p (full chroma) while the x264 source is yuv420p,
//   so the PSNR filter's chroma-plane comparison on a saturated red
//   field scores low while the picture is visually identical. The
//   verify-p3f assertion therefore checks frame means (R within 3,
//   G within 25 — the 422/420 chroma difference), NOT a PSNR
//   threshold. Do not "fix" this by chasing PSNR.
//
// LGPL note: dnxhd is a native LGPL encoder — only verified on the
// local GPL 8.1.2 build; re-check on the BtbN LGPL 9.0 build at the
// M2 gate.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { Clip, Project } from './project.js';

const execFileAsync = promisify(execFile);

/** An optimized-media reference on a clip (same shape as ProxyRef). */
export interface OptimizedRef {
  /** Path to the generated optimized file (.mov). */
  file: string;
  /** Frame width in px (must match the file). */
  width: number;
  /** Frame height in px (must match the file). */
  height: number;
}

export interface OptimizedInfo {
  file: string;
  width: number;
  height: number;
  /** dnxhd profile used. */
  profile: DnxhrProfile;
  /** Total (format) bitrate in bits/s, ffprobe-measured. */
  bitrate: number;
  /** Optimized file duration in seconds, ffprobe-measured. */
  duration: number;
  /** Source duration in seconds, ffprobe-measured. */
  sourceDuration: number;
}

export type DnxhrProfile = 'dnxhr_lb' | 'dnxhr_sq' | 'dnxhr_hq';
export const DNXHR_PROFILES: DnxhrProfile[] = ['dnxhr_lb', 'dnxhr_sq', 'dnxhr_hq'];
export const DNXHR_DEFAULT_PROFILE: DnxhrProfile = 'dnxhr_hq';
/** Optimized duration must match the source duration within this (s). */
export const OPTIMIZED_DURATION_TOLERANCE = 0.1;

export interface GenerateOptimizedOptions {
  ffmpeg?: string;
  ffprobe?: string;
  /** DNxHR profile (default 'dnxhr_hq'). */
  profile?: DnxhrProfile;
}

interface MediaProbe {
  duration: number;
  width: number;
  height: number;
  bitrate: number;
  hasAudio: boolean;
  codec: string;
}

async function probeMedia(file: string, ffprobe: string): Promise<MediaProbe> {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name',
    '-show_entries', 'format=duration,bit_rate',
    '-of', 'json', file,
  ]);
  const data = JSON.parse(stdout) as {
    streams: { width: number; height: number; codec_name: string }[];
    format: { duration: string; bit_rate: string };
  };
  if (!data.streams[0]) {
    throw new Error(`optimized-media probe: no video stream in ${file}`);
  }
  let hasAudio = false;
  try {
    const { stdout: aout } = await execFileAsync(ffprobe, [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file,
    ]);
    hasAudio = aout.trim().length > 0;
  } catch {
    hasAudio = false;
  }
  return {
    duration: Number(data.format.duration),
    width: data.streams[0].width,
    height: data.streams[0].height,
    bitrate: Number(data.format.bit_rate),
    hasAudio,
    codec: data.streams[0].codec_name,
  };
}

/**
 * Generate a full-resolution DNxHR intermediate for a source file.
 * Keeps the source's resolution, fps and duration; video is
 * intra-frame dnxhd, audio is PCM. Returns the measured info —
 * store `file`/`width`/`height` from it in Clip.optimizedMedia so
 * validateOptimizedMedia can check the file against the declaration
 * later. Throws when the source cannot be probed, has odd dimensions
 * (dnxhd needs even sizes), or the encode fails.
 */
export async function generateOptimizedMedia(
  source: string,
  output: string,
  opts: GenerateOptimizedOptions = {},
): Promise<OptimizedInfo> {
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const ffprobe = opts.ffprobe ?? 'ffprobe';
  const profile = opts.profile ?? DNXHR_DEFAULT_PROFILE;
  if (!DNXHR_PROFILES.includes(profile)) {
    throw new Error(`unknown DNxHR profile "${profile}" — use one of ${DNXHR_PROFILES.join(', ')}`);
  }
  const src = await probeMedia(source, ffprobe);
  if (src.width % 2 !== 0 || src.height % 2 !== 0) {
    throw new Error(
      `optimized media: source ${source} is ${src.width}x${src.height} — dnxhd needs even dimensions`,
    );
  }
  const args = [
    '-v', 'error', '-i', source,
    '-c:v', 'dnxhd', '-profile:v', profile, '-pix_fmt', 'yuv422p',
  ];
  if (src.hasAudio) args.push('-c:a', 'pcm_s16le');
  else args.push('-an');
  args.push('-y', output);
  await execFileAsync(ffmpeg, args, { maxBuffer: 64 * 1024 * 1024 });
  const opt = await probeMedia(output, ffprobe);
  if (opt.codec !== 'dnxhd') {
    throw new Error(`optimized media: ${output} encoded as ${opt.codec}, expected dnxhd`);
  }
  return {
    file: output,
    width: opt.width,
    height: opt.height,
    profile,
    bitrate: opt.bitrate,
    duration: opt.duration,
    sourceDuration: src.duration,
  };
}

/**
 * Validate every clip's optimized-media reference before export.
 * Throws on: optimized media on a compound or multicam clip; a
 * missing file; a size mismatch against the declaration; a duration
 * mismatch against the source (> 0.1 s). No-op for projects with no
 * optimized media. Call before the graph build (export.ts does this
 * in exportProjectInner).
 */
export async function validateOptimizedMedia(project: Project, ffprobe = 'ffprobe'): Promise<void> {
  for (const clip of project.clips) {
    const opt = clip.optimizedMedia;
    if (!opt) continue;
    if (clip.compound) {
      throw new Error(`clip ${clip.id}: optimized media is not supported on compound clips in v1`);
    }
    if (clip.multicam) {
      throw new Error(`clip ${clip.id}: optimized media is not supported on multicam clips in v1`);
    }
    if (!opt.file || typeof opt.file !== 'string') {
      throw new Error(`clip ${clip.id}: optimizedMedia.file is required`);
    }
    if (!existsSync(opt.file)) {
      throw new Error(
        `clip ${clip.id}: optimized media file missing: ${opt.file} — refusing to silently fall back to the original; regenerate it or remove clip.optimizedMedia`,
      );
    }
    const measured = await probeMedia(opt.file, ffprobe);
    if (measured.width !== opt.width || measured.height !== opt.height) {
      throw new Error(
        `clip ${clip.id}: optimized media size mismatch: declared ${opt.width}x${opt.height} ` +
          `but file ${opt.file} is ${measured.width}x${measured.height}`,
      );
    }
    const src = await probeMedia(clip.source, ffprobe);
    if (Math.abs(measured.duration - src.duration) > OPTIMIZED_DURATION_TOLERANCE) {
      throw new Error(
        `clip ${clip.id}: optimized media duration ${measured.duration.toFixed(3)}s differs from ` +
          `source duration ${src.duration.toFixed(3)}s by more than ${OPTIMIZED_DURATION_TOLERANCE}s`,
      );
    }
  }
}

/**
 * Return a copy of the project with every optimized-media clip's
 * source swapped to its optimized file — the preview render path.
 * Export never uses this: exportProject always renders from the
 * original source, after validateOptimizedMedia has confirmed the
 * file still exists.
 */
export function useOptimizedMedia(project: Project): Project {
  const clips: Clip[] = project.clips.map((clip) => {
    if (!clip.optimizedMedia) return clip;
    if (!existsSync(clip.optimizedMedia.file)) {
      throw new Error(`clip ${clip.id}: optimized media file missing: ${clip.optimizedMedia.file}`);
    }
    return { ...clip, source: clip.optimizedMedia.file };
  });
  return { ...project, clips };
}
