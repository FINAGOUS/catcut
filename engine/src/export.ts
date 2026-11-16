// Export runner: presets, ffprobe inspection, ffmpeg execution.
// Drives the ffmpeg/ffprobe CLIs found on PATH (Windows build bundles
// static ffmpeg/ffprobe binaries; same CLI surface, same commands).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { buildFilterGraph } from './filtergraph.js';
import { projectDuration, type Project } from './project.js';
import { prepareClipMaskFiles } from './mask.js';
import { dirname } from 'node:path';
import {
  DEFAULT_ASS_STYLE,
  subtitlesToASS,
  writeSRT,
  type SubtitleItem,
} from './subtitles.js';

const execFileAsync = promisify(execFile);

export { TEXT_PRESETS, COLOR_PRESETS, TALK_PRESETS, applyTalkPreset, serializeTalkPreset, parseTalkPreset } from './presets.js';
export type { TextStylePreset, TalkPreset, SubtitleMode } from './presets.js';
export { generateAutoZoom, generateAutoZoomWithSilences, detectSilences, zoomScaleAt, countScalePushes, emphasisPlateaus } from './autozoom.js';
export type { AutoZoomOptions, SilenceInterval } from './autozoom.js';
export { renderMaskPng, maskPixelSize, maskOverlayPos, maskSegments, maskAlpha, prepareClipMaskFiles, validateMask } from './mask.js';
export type { MaskSegment } from './mask.js';
export type { MaskShape, MaskKeyframe, ClipMask } from './project.js';
export { toSRT, parseSRT, subtitlesToASS, subtitlesToTextOverlays, countBoundaryErrors, validateWordTimes, formatSrtTime } from './subtitles.js';
export type { SubtitleItem, SubtitleWord } from './subtitles.js';
export { FasterWhisperTranscriber, StubTranscriber, FASTER_WHISPER_SETUP } from './transcribe.js';
export type { Transcriber, TranscribeOptions } from './transcribe.js';

export interface ExportPreset {
  name: string;
  /** Suggested frame size; the PROJECT's width/height/fps still govern the
   *  actual output — a preset never resizes the project behind its back. */
  width: number;
  height: number;
  fps: number;
  crf: number;
  preset: string;
  audioBitrate: string;
  /** Optional .cube LUT file applied with lut3d (only when the file exists). */
  lut?: string;
}

export const PRESETS: Record<string, ExportPreset> = {
  '720p30': { name: '720p30', width: 1280, height: 720, fps: 30, crf: 20, preset: 'veryfast', audioBitrate: '160k' },
  '1080p30': { name: '1080p30', width: 1920, height: 1080, fps: 30, crf: 20, preset: 'veryfast', audioBitrate: '160k' },
  '1080p60': { name: '1080p60', width: 1920, height: 1080, fps: 60, crf: 20, preset: 'veryfast', audioBitrate: '192k' },
  '4k30': { name: '4k30', width: 3840, height: 2160, fps: 30, crf: 22, preset: 'veryfast', audioBitrate: '192k' },
  // P0 (M4): vertical / platform presets. Width/height are the suggested
  // canvas; set the project to the same size when using them.
  'douyin-9x16': { name: 'douyin-9x16', width: 1080, height: 1920, fps: 30, crf: 20, preset: 'veryfast', audioBitrate: '160k' },
  'bilibili-16x9-1080p60': { name: 'bilibili-16x9-1080p60', width: 1920, height: 1080, fps: 60, crf: 20, preset: 'veryfast', audioBitrate: '192k' },
  'vertical-720x1280': { name: 'vertical-720x1280', width: 720, height: 1280, fps: 30, crf: 20, preset: 'veryfast', audioBitrate: '160k' },
};

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  codec: string;
}

export async function probe(file: string, ffprobe = 'ffprobe'): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name,r_frame_rate,duration',
    '-show_entries', 'format=duration',
    '-of', 'json', file,
  ]);
  const data = JSON.parse(stdout) as {
    streams: { width: number; height: number; codec_name: string; r_frame_rate: string }[];
    format: { duration: string };
  };
  const v = data.streams[0];
  const [num, den] = v.r_frame_rate.split('/').map(Number);
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
    width: v.width,
    height: v.height,
    fps: den ? num / den : 0,
    hasAudio,
    codec: v.codec_name,
  };
}

export interface ExportOptions {
  ffmpeg?: string;
  ffprobe?: string;
  /** Font file for drawtext (burned-in text). */
  fontfile: string;
  preset: ExportPreset;
  onProgress?: (line: string) => void;
  /** When set, project-level subtitles are also written here as .srt. */
  srtPath?: string;
  /** Font name for the ASS karaoke burn (project subtitles). */
  assFont?: string;
}

export interface ExportReport {
  output: string;
  expectedDuration: number;
  actual: ProbeResult;
  durationError: number;
}

/** Render a project to an MP4 file and verify the result with ffprobe. */
export async function exportProject(
  project: Project,
  output: string,
  opts: ExportOptions,
): Promise<ExportReport> {
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  // Project-level subtitles: write the .ass karaoke file next to the output
  // and burn it with the ASS filter; clip-level subtitles are already in
  // the per-clip chains (drawtext). Keep the .ass file: it is the audit
  // trail for what was burned, and the WPF side can reuse it for preview.
  let assFile: string | undefined;
  if (project.subtitles && project.subtitles.length > 0) {
    assFile = `${output}.ass`;
    const style = {
      ...DEFAULT_ASS_STYLE,
      fontname: opts.assFont ?? DEFAULT_ASS_STYLE.fontname,
      fontsize: Math.max(24, Math.round(project.height * 0.055)),
    };
    writeFileSync(
      assFile,
      subtitlesToASS(project.subtitles, style, project.width, project.height),
      'utf8',
    );
    if (opts.srtPath) writeSRT(project.subtitles, opts.srtPath);
  }
  // Shape masks: bake one PNG per mask segment next to the output and pass
  // them as extra inputs (after the clip inputs, in segment order).
  const maskFiles = project.clips.some((c) => c.mask)
    ? prepareClipMaskFiles(project, dirname(output))
    : undefined;
  const { filterComplex, videoOut, audioOut, extraInputs } = buildFilterGraph(
    project,
    opts.fontfile,
    opts.preset.lut,
    assFile,
    maskFiles,
  );
  const args: string[] = [];
  project.clips.forEach((clip) => args.push('-i', clip.source));
  extraInputs.forEach((p) => args.push('-i', p));
  args.push(
    '-filter_complex', filterComplex,
    '-map', videoOut, '-map', audioOut,
    '-c:v', 'libx264', '-preset', opts.preset.preset, '-crf', String(opts.preset.crf),
    '-pix_fmt', 'yuv420p', '-r', String(opts.preset.fps),
    '-c:a', 'aac', '-b:a', opts.preset.audioBitrate,
    '-movflags', '+faststart', '-y', output,
  );
  await execFileAsync(ffmpeg, args, { maxBuffer: 64 * 1024 * 1024 });
  const actual = await probe(output, opts.ffprobe);
  const expectedDuration = projectDuration(project);
  return {
    output,
    expectedDuration,
    actual,
    durationError: Math.abs(actual.duration - expectedDuration),
  };
}
