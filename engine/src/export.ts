// Export runner: presets, ffprobe inspection, ffmpeg execution.
// Drives the ffmpeg/ffprobe CLIs found on PATH (Windows build bundles
// static ffmpeg/ffprobe binaries; same CLI surface, same commands).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildFilterGraph } from './filtergraph.js';
import { projectDuration, type Clip, type Project } from './project.js';
import { prepareClipMaskFiles } from './mask.js';
import {
  cleanupStabilization,
  prepareStabilization,
} from './stabilize.js';
import {
  preparePortraitMasks,
} from './portrait.js';
import { dirname } from 'node:path';
import { prepareColorLuts } from './color.js';
import {
  compoundChildDuration,
  compoundIntermediatePath,
  compoundRenderDir,
  MAX_COMPOUND_DEPTH,
  validateCompoundClip,
} from './compound.js';
import {
  prepareMulticam,
} from './multicam.js';
import {
  prepareRoleAudio,
  rolesInUse,
} from './roles.js';
import {
  generateProxy,
  useProxies,
  validateProxies,
} from './proxy.js';
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
export {
  cleanupStabilization,
  deshakeFilter,
  prepareStabilization,
  resolveStabilize,
  runStabilizeDetect,
  validateStabilize,
  vidstabTransformFilter,
} from './stabilize.js';
export type { ChromaBackground, ChromaKey, StabilizeMethod, StabilizeOptions } from './project.js';
export {
  applyBeatPulse,
  beatPulseKeys,
  decodeAudioMono,
  detectBeats,
  detectBeatsFromSamples,
  splitClipByBeats,
} from './beat.js';
export type { BeatCutOptions, BeatDetectOptions, BeatGrid, BeatPulseOptions } from './beat.js';
export {
  duckingEffectiveThresholdDb,
  duckingFilter,
  resolveDucking,
  validateDucking,
} from './ducking.js';
export type { DuckingOptions } from './project.js';
export {
  audioShiftFilter,
  estimateOffset,
  estimateOffsetFromSamples,
  shiftClipAudioToReference,
  validateAudioOffset,
} from './align.js';
export type { AlignOptions, AlignResult } from './align.js';
export {
  applyTemplateToClip,
  applyTemplateToProject,
  BUILTIN_TEMPLATE_IDS,
  loadAllBuiltInTemplates,
  loadBuiltInTemplate,
  parseTemplate,
  serializeTemplate,
  templatesDir,
  TRANSITIONS,
  validateTemplate,
} from './templates.js';
export type { ApplyTemplateOptions, Template } from './templates.js';
export {
  defaultPortraitModelPath,
  defaultPortraitScriptPath,
  PORTRAIT_SETUP,
  preparePortraitMasks,
  probeVideoFps,
  resolvePortraitModelPath,
  validatePortraitCutout,
} from './portrait.js';
export type { PortraitCutout, PortraitRunSummary, PreparePortraitOptions } from './portrait.js';
export {
  analyzeFrame,
  analyzeFrames,
  analyzeRgbFrame,
  renderScopeImage,
} from './scopes.js';
export type { AnalyzeFrameOptions, ChannelStats, LumaStats, ScopeAggregate, ScopeImageKind, ScopeResult } from './scopes.js';
export {
  applyAdvancedColorToRgb,
  applyCurve,
  buildColorLut,
  hslToRgb,
  HSL_ZONE_HALF_WIDTH,
  HUE_ZONE_CENTER,
  lut3dFilter,
  lutToCube,
  parseCube,
  prepareColorLuts,
  rgbToHsl,
  validateAdvancedColor,
  writeColorLutFile,
} from './color.js';
export type { AdvancedColor, BuiltLut, Curves, CurvePoint, HslZoneAdjust, HueZoneName, ParsedCube, WhiteBalance } from './color.js';
export {
  compoundChildDuration,
  compoundIntermediatePath,
  compoundRenderDir,
  MAX_COMPOUND_DEPTH,
  validateCompoundClip,
} from './compound.js';
export type { CompoundRef } from './compound.js';
export {
  MULTICAM_DURATION_TOLERANCE,
  multicamSegments,
  prepareMulticam,
  probeAngleDuration,
  validateMulticam,
} from './multicam.js';
export type { Multicam, MulticamCut, MulticamSegment } from './multicam.js';
export {
  BUILTIN_ROLES,
  DEFAULT_ROLE,
  effectiveMute,
  panGains,
  prepareRoleAudio,
  probeAudioChannels,
  resolveRoleConfigs,
  ROLE_GAIN_DB_MAX,
  ROLE_GAIN_DB_MIN,
  ROLE_PAN_MAX,
  ROLE_PAN_MIN,
  roleFilter,
  roleOfClip,
  rolesInUse,
  validateRoles,
} from './roles.js';
export type { ResolvedRoleConfig, RoleConfig, RoleName } from './roles.js';
export {
  generateProxy,
  PROXY_DEFAULT_CRF,
  PROXY_DEFAULT_HEIGHT,
  PROXY_DEFAULT_WIDTH,
  PROXY_DURATION_TOLERANCE,
  useProxies,
  validateProxies,
} from './proxy.js';
export type { GenerateProxyOptions, ProxyInfo, ProxyRef } from './proxy.js';

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
  /** Python binary with onnxruntime installed (portrait cutout only). */
  python?: string;
  /** Portrait model path override (default: bundled model in models/). */
  portraitModel?: string;
  /** Portrait helper script override (default: scripts/portrait_segment.py). */
  portraitScript?: string;
  /**
   * Role stems (P2): also write one audio stem per used role after the
   * mix (output stream order: video, mix, stem 1..N in first-appearance
   * role order; see ExportReport.audioStems). Throws when the project
   * uses no roles.
   */
  roleStems?: boolean;
}

export interface ExportReport {
  output: string;
  expectedDuration: number;
  actual: ProbeResult;
  durationError: number;
  /** Role stem names in output stream order (roleStems only): the mix
   *  is audio stream 0, stems are streams 1..N in this order. */
  audioStems?: string[];
}

/** Render a project to an MP4 file and verify the result with ffprobe. */
export async function exportProject(
  project: Project,
  output: string,
  opts: ExportOptions,
): Promise<ExportReport> {
  return renderProjectWithStab(project, output, opts, opts.ffmpeg ?? 'ffmpeg', 0);
}

/**
 * Resolve compound clips: render each child project to its own
 * intermediate MP4 (in its own subdirectory — see compound.ts) and
 * return a new project with the compound clip's source replaced by
 * that file (compound stripped). Clips without compound pass through
 * unchanged. The child is rendered at the PARENT's width/height/fps
 * (resampling rule) and the child render recurses through
 * renderProjectWithStab at depth+1, so grandchildren resolve the same
 * way and a 3rd level throws in validateCompoundClip. Idempotent: a
 * project with no compound clips is returned as-is.
 */
export async function resolveCompoundClips(
  project: Project,
  dir: string,
  opts: ExportOptions,
  ffmpeg: string,
  depth: number,
): Promise<Project> {
  if (!project.clips.some((c) => c.compound)) return project;
  const clips: Clip[] = [];
  for (let i = 0; i < project.clips.length; i++) {
    const clip = project.clips[i];
    if (!clip.compound) {
      clips.push(clip);
      continue;
    }
    const child = clip.compound.project;
    const childDuration = compoundChildDuration(child);
    validateCompoundClip(clip, child, childDuration, depth);
    const childProject: Project = {
      ...child,
      width: project.width,
      height: project.height,
      fps: project.fps,
    };
    const renderDir = compoundRenderDir(dir, depth, i);
    mkdirSync(renderDir, { recursive: true });
    const intermediate = compoundIntermediatePath(dir, depth, i);
    // The child render inherits the export preset (including any preset
    // LUT) but its output fps is forced to the parent's fps, so the
    // intermediate's frame rate matches the parent's timeline.
    const childOpts: ExportOptions = {
      ...opts,
      preset: { ...opts.preset, fps: project.fps },
    };
    await renderProjectWithStab(childProject, intermediate, childOpts, ffmpeg, depth + 1);
    clips.push({ ...clip, source: intermediate, compound: undefined });
  }
  return { ...project, clips };
}

/**
 * Render one project with its own vidstab pass. Compound clips are
 * resolved FIRST (their child renders recurse through this same
 * function at depth+1), so prepareStabilization only ever sees
 * ordinary clips with real source files.
 */
async function renderProjectWithStab(
  project: Project,
  output: string,
  opts: ExportOptions,
  ffmpeg: string,
  depth: number,
): Promise<ExportReport> {
  const outDir = dirname(output);
  const resolved = await resolveCompoundClips(project, outDir, opts, ffmpeg, depth);
  // Vidstab pass 1: run vidstabdetect for every vidstab clip BEFORE the
  // main export, writing one .trf per clip next to the output. The .trf
  // files are deleted after a successful export; on failure they are kept
  // and their paths logged, so the failed run can be debugged/re-run.
  const stabTrf = await prepareStabilization(resolved, outDir, ffmpeg);
  let ok = false;
  try {
    const report = await exportProjectInner(resolved, output, opts, ffmpeg, stabTrf);
    ok = true;
    return report;
  } catch (e) {
    if (stabTrf.size > 0) {
      console.error(
        `export failed; vidstab .trf files kept for debugging: ${[...stabTrf.values()].join(', ')}`,
      );
    }
    throw e;
  } finally {
    if (ok) cleanupStabilization(stabTrf.values());
  }
}

/** Inner export: graph build + single ffmpeg invocation + ffprobe check. */
async function exportProjectInner(
  project: Project,
  output: string,
  opts: ExportOptions,
  ffmpeg: string,
  stabTrf: Map<number, string>,
): Promise<ExportReport> {
  // Multicam angles: validate durations BEFORE the graph build (async
  // ffprobe; a mismatched/short angle throws instead of truncating).
  // Compound clips are already resolved by renderProjectWithStab, so
  // every clip here has a real source file.
  await prepareMulticam(project, opts.ffprobe);
  // Proxy editing: a declared proxy must exist and match its
  // declaration, or the export is refused — never silently render the
  // original in place of a lost proxy. The export itself always uses
  // clip.source (the relink); the proxy is only validated here.
  await validateProxies(project, opts.ffprobe);
  // Roles: probe every clip's audio channel count BEFORE the graph
  // build (the pan variant depends on it — mono duplicates the single
  // channel, stereo pans two; see roles.ts).
  const roleAudioChannels = rolesInUse(project)
    ? await prepareRoleAudio(project, opts.ffprobe)
    : undefined;
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
  // Smart portrait cutout: run the ONNX helper for every portrait clip
  // BEFORE the main export; the mask videos go in as extra inputs. The
  // videos are kept next to the output as an audit trail (like the mask
  // PNGs and the .ass file).
  const portraitMasks = project.clips.some((c) => c.portraitCutout)
    ? await preparePortraitMasks(project, dirname(output), {
        python: opts.python,
        script: opts.portraitScript,
        model: opts.portraitModel,
        ffmpeg,
        ffprobe: opts.ffprobe,
      })
    : undefined;
  // Advanced colour (P2): bake HSL/curves/white-balance into a .cube
  // per clip BEFORE the main export; the .cube files are kept next to
  // the output as an audit trail (like the mask PNGs). Imported .cube
  // files are validated here too — a bad file throws at prep time.
  const colorLuts = project.clips.some((c) => c.advancedColor)
    ? prepareColorLuts(project, dirname(output))
    : undefined;
  const { filterComplex, videoOut, audioOut, extraInputs, audioStems } = buildFilterGraph(
    project,
    opts.fontfile,
    opts.preset.lut,
    assFile,
    maskFiles,
    stabTrf,
    portraitMasks,
    colorLuts,
    roleAudioChannels,
    opts.roleStems,
  );
  const args: string[] = [];
  project.clips.forEach((clip) => args.push('-i', clip.source));
  extraInputs.forEach((p) => args.push('-i', p));
  args.push(
    '-filter_complex', filterComplex,
    '-map', videoOut, '-map', audioOut,
  );
  // Role stems (roleStems only): one extra audio stream per role, in
  // first-appearance order (mix is audio stream 0, stems are 1..N).
  const stemRoles: string[] = [];
  if (audioStems) {
    for (const [roleName, label] of audioStems) {
      args.push('-map', label);
      stemRoles.push(roleName);
    }
  }
  args.push(
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
    ...(stemRoles.length > 0 ? { audioStems: stemRoles } : {}),
  };
}
