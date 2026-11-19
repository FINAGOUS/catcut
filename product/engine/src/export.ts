// Export runner: presets, ffprobe inspection, ffmpeg execution.
// Drives the ffmpeg/ffprobe CLIs found on PATH (Windows build bundles
// static ffmpeg/ffprobe binaries; same CLI surface, same commands).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildFilterGraph } from './filtergraph.js';
import { clipDuration, hasTracks, projectDuration, type Clip, type Project } from './project.js';
import {
  flatClips,
  flattenProject,
  mapTrackClips,
  rebuildTracksFromFlat,
  type FlatClip,
} from './multitrack.js';
import { prepareClipMaskFiles } from './mask.js';
import {
  cleanupStabilization,
  prepareStabilization,
} from './stabilize.js';
import {
  preparePortraitMasks,
} from './portrait.js';
import {
  prepareBeautyMasks,
} from './beauty.js';
import { dirname, join } from 'node:path';
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
  prepareSmartCut,
  type SubjectTrack,
} from './smartcut.js';
import {
  DEFAULT_ASS_STYLE,
  subtitlesToASS,
  type SubtitleItem,
} from './subtitles.js';
import {
  resolveEncoderArgs,
  subtitlesToDualASS,
  validateHdrMode,
  writeDualSubtitleSidecar,
  writeSubtitleSidecar,
  type ExportOnlyMode,
  type HdrMode,
  type SubtitleSidecarFormat,
} from './deliver.js';
import {
  markersToFfmetadata,
  deleteClip as deleteClipLinked,
  replaceClipWithSplits,
  validateTimelineProject,
} from './timeline.js';
import {
  compressSilences,
  cutSilences,
  detectSilencesForClip,
  validateSilenceCut,
} from './silencecut.js';
import { cutClipByText } from './textcut.js';
import { remixAudio } from './remix.js';
import {
  separateVocals,
  validateVocalsep,
} from './vocalsep.js';
import {
  synthesizeSpeech,
  validateTtsNarration,
} from './tts.js';
import {
  validateOptimizedMedia,
} from './optimized.js';
import {
  SURROUND_AC3_BITRATE,
  surroundAudioCodec,
  validateSurroundLayout,
} from './surround.js';
import {
  prepareClone,
  prepareColorManagementLuts,
  prepareColorMatchLuts,
  prepareObjectTracks,
  prepareOutputLut,
  prepareTrackedWindow,
  upscaleVideo,
  validateProjectColorManagement,
  validateUpscale,
  writeGradeNodeFiles,
  type GradeNodeStage,
  type P3gGraphInputs,
} from './p3g.js';
import { renameSync } from 'node:fs';
import { basename } from 'node:path';
import { resolveExportFrameInterp, type FrameInterpOptions } from './frameinterp.js';

const execFileAsync = promisify(execFile);

export { TEXT_PRESETS, COLOR_PRESETS, TALK_PRESETS, applyTalkPreset, serializeTalkPreset, parseTalkPreset } from './presets.js';
export type { TextStylePreset, TalkPreset, SubtitleMode } from './presets.js';
export { generateAutoZoom, generateAutoZoomWithSilences, detectSilences, zoomScaleAt, countScalePushes, emphasisPlateaus } from './autozoom.js';
export type { AutoZoomOptions, SilenceInterval } from './autozoom.js';
export { renderMaskPng, renderFrameMaskPng, maskPixelSize, maskOverlayPos, maskSegments, maskAlpha, prepareClipMaskFiles, validateMask } from './mask.js';
export type { MaskSegment } from './mask.js';
export type { MaskShape, MaskKeyframe, ClipMask } from './project.js';
export { toSRT, parseSRT, subtitlesToASS, subtitlesToTextOverlays, countBoundaryErrors, validateWordTimes, formatSrtTime } from './subtitles.js';
export type { SubtitleItem, SubtitleWord } from './subtitles.js';
export {
  subtitlesToDualASS, dualSubtitlesToTextOverlays,
  formatVttTime, toVTT, parseVTT, writeVTT,
  writeSubtitleSidecar, writeAssSidecar, writeDualSubtitleSidecar,
  validateExportPreset, parseExportPreset, serializeExportPreset,
  createPresetStore, getPreset, addCustomPreset, listPresets,
  hdrToSdrFilter, sdrToHdrFilter, hdrVideoFilter,
  resolveEncoderArgs, resolveExportOnlyMode, validateHdrMode,
  validateQueueItem, queueAdd, queueRemove, queueMove, runExportQueue,
  HDR_BT2020_PQ, X264_PRESET_NAMES,
} from './deliver.js';
export type {
  HdrMode, SubtitleSidecarFormat, ExportOnlyMode, TonemapOperator, ExportOnlyFlags,
  DualSubtitles, HdrSourceSpace, EncoderPlan, QueueItem, QueueItemResult,
  PresetStore, RunQueueOptions, AssSidecarOptions,
} from './deliver.js';
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
  audioFxFilter,
  BEAUTY_COMP_RATIO,
  BEAUTY_COMP_THRESHOLD_DB,
  BEAUTY_DEESSER_F,
  BEAUTY_HIGHPASS_HZ,
  BEAUTY_PRESENCE_DB,
  BEAUTY_PRESENCE_HZ,
  CLIP_GAIN_DB_MAX,
  CLIP_GAIN_DB_MIN,
  compressorFilter,
  enhanceFilter,
  eqFilter,
  validateAudioFx,
  validateMasterGainDb,
  voiceFilter,
} from './audiofx.js';
export type { AudioCompressor, AudioEq, AudioFx, EqBand, VoiceEffect, VoiceEffectKind } from './audiofx.js';
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
  colorWheelWeight,
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
export type { AdvancedColor, BuiltLut, ColorWheels, ColorWheelZone, Curves, CurvePoint, HslCurves, HslZoneAdjust, HueZoneName, ParsedCube, WhiteBalance } from './color.js';
export {
  adjustmentLayerFilter,
  deleteClip,
  MARKER_COLORS,
  markersToFfmetadata,
  pasteAttributes,
  PASTEABLE_FIELDS,
  replaceClipSource,
  replaceClipWithSplits,
  searchTimeline,
  switchAlternate,
  threePointInsert,
  threePointOverwrite,
  validateJLClip,
  validateTimelineProject,
} from './timeline.js';
export type { AdjustmentLayer, AlternateClip, PasteableField, TimelineHit, TimelineMarker } from './timeline.js';
export {
  clampSilences,
  compressSilences,
  cutSilences,
  detectSilencesForClip,
  SILENCE_CUT_DEFAULTS,
  totalSilence,
  validateSilenceCut,
} from './silencecut.js';
export type { SilenceCutOptions } from './silencecut.js';
export {
  annotateSpeakers,
  cutClipByText,
  hasWordTimestamps,
  PyannoteDiarizer,
  PYANNOTE_SETUP,
} from './textcut.js';
export type { SpeakerSegment, TextCutOptions, TextCutResult } from './textcut.js';
export {
  buildRemixAudio,
  planRemix,
  remixAudio,
  remixBars,
  validateRemix,
} from './remix.js';
export type { RemixOptions, RemixPlan, RemixSegment } from './remix.js';
export {
  minterpolateFilter,
  resolveExportFrameInterp,
  validateFrameInterp,
} from './frameinterp.js';
export type { FrameInterpOptions } from './frameinterp.js';
export {
  generateOptimizedMedia,
  DNXHR_DEFAULT_PROFILE,
  DNXHR_PROFILES,
  OPTIMIZED_DURATION_TOLERANCE,
  useOptimizedMedia,
  validateOptimizedMedia,
} from './optimized.js';
export type { DnxhrProfile, GenerateOptimizedOptions, OptimizedInfo, OptimizedRef } from './optimized.js';
export {
  DEMUCS_DEFAULT_MODEL,
  DEMUCS_MODELS,
  DEMUCS_SETUP,
  separateVocals,
  validateVocalsep,
  vocalsepStemDir,
} from './vocalsep.js';
export type { DemucsModel, SeparateVocalsOptions, VocalSepOptions, VocalsepResult } from './vocalsep.js';
export {
  synthesizeSpeech,
  TTS_MAX_CHARS,
  TTS_MAX_SEC_PER_CHAR,
  TTS_MIN_SEC_PER_CHAR,
  TTS_SETUP,
  validateTtsNarration,
} from './tts.js';
export type { SynthesizeOptions, TtsNarration } from './tts.js';
export {
  repairFilter,
  REPAIR_AFFTDN_NF_DB,
  REPAIR_AFFTDN_NR,
  REPAIR_HUM_CUTOFF_DEFAULT,
  REPAIR_HUM_CUTOFF_MAX,
  REPAIR_HUM_CUTOFF_MIN,
  validateAudioRepair,
} from './audiorepair.js';
export type { AudioRepair } from './audiorepair.js';
export {
  SURROUND_AC3_BITRATE,
  SURROUND_CHANNELS,
  SURROUND_LAYOUTS,
  surroundAudioCodec,
  surroundUpmixFilter,
  validateSurroundLayout,
} from './surround.js';
export {
  UPSCALE_MODELS,
  UPSCALE_SETUP,
  addLutEntry,
  bakeGradeNodes,
  blendLuts,
  buildAutoVideoProject,
  buildColorMatchLut,
  buildObjectTrackMaskBuffer,
  buildTrackedWindowMaskBuffer,
  buildTransferLut,
  channelHistograms,
  cloneLaneSize,
  decodeFrameRgb24,
  decodeVideoGray,
  decodeVideoRgb24,
  defaultUpscaleModelPath,
  defaultUpscaleScriptPath,
  filterLutLibrary,
  generateLutThumbnail,
  histogramMatchMaps,
  inputColorConversion,
  listReferenceStills,
  loadReferenceStill,
  lutLibraryCategories,
  objectTrackDrawtextFilter,
  outlineDilationFilter,
  outputColorTag,
  outputSpaceOf,
  parseOutlineColor,
  prepareClone,
  prepareColorManagementLuts,
  prepareColorMatchLuts,
  prepareObjectTracks,
  prepareOutputLut,
  prepareTrackedWindow,
  probeVideoInfo,
  rec709Oetf,
  rec709OetfInv,
  renderComparisonFrame,
  saveReferenceStill,
  slog3Decode,
  slog3Encode,
  srgbOetf,
  srgbOetfInv,
  topoSortGradeNodes,
  toggleLutFavorite,
  trackAxisExpr,
  trackObjectByColor,
  trackObjectByTemplate,
  upscaleScaleOf,
  upscaleVideo,
  validateAutoVideo,
  validateClipColorManagement,
  validateCloneEffect,
  validateColorMatch,
  validateGradeNodes,
  validateKeyOutline,
  validateLutLibraryEntry,
  validateObjectTrack,
  validateProjectColorManagement,
  validateTrackedWindow,
  validateUpscale,
  workingSpaceOf,
  writeBuiltLutFile,
  writeGradeNodeFiles,
  writeMaskVideoFromBuffer,
} from './p3g.js';
export type {
  AutoVideo,
  AutoVideoLine,
  AutoVideoSegment,
  BakedGradeNodes,
  CloneEffect,
  ColorManagement,
  ColorMatch,
  CompareMode,
  GradeBlendMode,
  GradeNode,
  GradeNodeGraph,
  GradeNodeStage,
  GradeNodeStageFiles,
  InputColorSpace,
  KeyOutline,
  LutLibrary,
  LutLibraryEntry,
  LutLibraryFilter,
  ObjectTrack,
  ObjectTrackPrep,
  OutputColorSpace,
  P3gGraphInputs,
  ReferenceStill,
  TrackedWindow,
  TrackedWindowFiles,
  UpscaleModel,
  UpscaleOptions,
  UpscaleResult,
  VideoInfo,
  WorkingColorSpace,
} from './p3g.js';
export type { SurroundLayout } from './surround.js';
export {
  clearRenderCache,
  renderCacheFile,
  renderCacheKey,
  renderCacheSegment,
  RENDER_CACHE_DURATION_TOLERANCE,
  sliceProjectForCache,
  validateCacheSegment,
} from './rendercache.js';
export type { RenderCacheOptions, RenderCacheResult, RenderCacheTask } from './rendercache.js';
export {
  aleTimecode,
  archiveProject,
  clearUncleanExit,
  createSubclip,
  detectCrashRecovery,
  filterMediaLibrary,
  ingestMedia,
  latestAutosaveBackup,
  markUncleanExit,
  MEDIA_RATING_MAX,
  MEDIA_RATING_MIN,
  mediaLibraryDir,
  mediaTypeOf,
  readAutosaveBackup,
  RELINK_DURATION_TOLERANCE,
  relinkOfflineMedia,
  scanWatchFolder,
  toALE,
  validateMediaItem,
  validateMediaLibrary,
  writeAutosaveBackup,
} from './medialib.js';
export type { IngestOptions, IngestResult, ArchiveResult, MediaFilterRule, MediaItem, MediaMetadata } from './medialib.js';
export {
  beatSpeedNodes,
  clipBaseDuration,
  clipDuration,
  hasTracks,
  projectDuration,
  speedCurveSegments,
} from './project.js';
export type { AudioTrack, AudioTrackClip, CrossTrackTransition, ProjectTracks, TrackBlendMode, VideoTrack, VideoTrackClip } from './project.js';
export {
  flatClips,
  flattenProject,
  mapTrackClips,
  multitrackDuration,
  normalizeToTracks,
  rebuildTracksFromFlat,
  resolveAudioTrackMute,
  validateMultitrackProject,
} from './multitrack.js';
export type { FlatClip } from './multitrack.js';
export {
  beautyFilter,
  countComponents,
  defaultBeautyScriptPath,
  hqdn3dFilter,
  prepareBeautyMasks,
  validateBeauty,
} from './beauty.js';
export type { BeautyMaskInfo, BeautyMaskSummary, BeautyMode, BeautyOptions, MaskComponents, PrepareBeautyOptions } from './beauty.js';
export {
  beatFlashFilters,
  beatSpeedCurve,
  validateBeatFlash,
  validateBeatSpeed,
} from './beat.js';
export type { BeatFlashOptions, BeatSpeedOptions } from './beat.js';
export {
  volumeKeysFilter,
} from './audiofx.js';
export type { VolumeKeyframe } from './audiofx.js';
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
export {
  analyzeAudioSegments,
  audioSegmentFeatures,
  classifyFeatures,
  decodeAudioMonoF32,
  DEFAULT_SCENE_THRESHOLD,
  detectScenes,
  FOLLOW_ZOOM_MAX_SCALE,
  followZoomKeys,
  hasAudio,
  MAX_REFRAME_KEYS,
  prepareSmartCut,
  prepareSubjectTracks,
  reframeCropFilter,
  scenesToSegments,
  smartcutMaskVideoPath,
  smoothTrack,
  TRACK_MASS_MIN,
  TRACK_SAMPLE_FPS,
  trackCenterAt,
  trackFromMaskVideo,
  validateSceneThreshold,
  validateSmartCut,
} from './smartcut.js';
export type {
  AudioClass,
  ClassifiedSegment,
  DetectScenesOptions,
  ReframeAspect,
  SceneCut,
  SceneSegment,
  SmartCutPrepOptions,
  SubjectTrack,
  TrackFromMaskOptions,
  TrackPoint,
} from './smartcut.js';
export type { FollowZoomOptions, ReframeOptions } from './project.js';

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
  /**
   * Video codec (P3). Default libx264. 'libx265' is GPL — the 8K preset
   * uses it, and SDR->HDR forces it (a 10-bit PQ container cannot be
   * written with 8-bit libx264). The BtbN LGPL 9.0 build has NO libx265,
   * so these presets need another encode route before public LGPL
   * distribution (M2 gate).
   */
  codec?: 'libx264' | 'libx265';
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
  // P3 (M4 §8.5): 8K. libx265 is GPL (see ExportPreset.codec) — local
  // GPL 8.1.2 build only until the M2 LGPL re-check finds a route.
  '8k30': { name: '8k30', width: 7680, height: 4320, fps: 30, crf: 22, preset: 'veryfast', audioBitrate: '192k', codec: 'libx265' },
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
  /**
   * Export-only switch (P3): 'video' = video without audio, 'audio' =
   * audio only, 'subtitle' = subtitle sidecar file only, no video is
   * rendered. 'none' (default) = normal export. The three are mutually
   * exclusive (resolveExportOnlyMode enforces it for the flag form).
   */
  exportOnly?: ExportOnlyMode;
  /**
   * Whole-film frame-interp switch (W10, see frameinterp.ts): the
   * export-level on/off for smart frame interpolation
   * (minterpolate). `undefined` (default) = follow the project's
   * own `frameInterp`; `null` = force OFF even when the project
   * sets it; `{ targetFps }` = force ON at that target, overriding
   * the project. The switch is orthogonal to export presets: it
   * never changes a preset, and a preset never turns it on — the
   * encoder's -r follows the resolved target, not the preset fps,
   * so a 30 fps preset cannot silently drop 24->60 interpolated
   * frames. Audio-only exports suppress it (no video is rendered).
   */
  frameInterp?: FrameInterpOptions | null;
  /**
   * Subtitle sidecar format for opts.srtPath (P3): 'srt' (default),
   * 'vtt', or 'ass'. Falls back to Project.subtitleSidecar when unset.
   */
  sidecarFormat?: SubtitleSidecarFormat;
  /**
   * Audio codec override (P3): 'aac' (default) or 'ac3'. A surround
   * project (5.1/7.1) defaults to AC-3 unless this says otherwise
   * (see surroundAudioCodec in surround.ts).
   */
  audioCodec?: 'aac' | 'ac3';
  /** TTS helper script override (default scripts/tts.py). */
  ttsScript?: string;
  /** TTS model dir override (default test/models/vits-icefall-zh-aishell3). */
  ttsModelDir?: string;
  /** Vocal-separation helper script override (default scripts/vocalsep.py). */
  vocalsepScript?: string;
}

export interface ExportReport {
  output: string;
  expectedDuration: number;
  actual: ProbeResult;
  durationError: number;
  /** Role stem names in output stream order (roleStems only): the mix
   *  is audio stream 0, stems are streams 1..N in this order. */
  audioStems?: string[];
  /** Export-only mode that was applied (omitted for a normal export). */
  exportOnly?: ExportOnlyMode;
  /** Frame interpolation that was actually applied (omitted when off). */
  frameInterp?: FrameInterpOptions;
  /** Sidecar files written (subtitle-only export, or opts.srtPath). */
  sidecarFiles?: string[];
}

/** Probe an audio-only file: format duration + first audio stream codec. */
async function probeAudio(file: string, ffprobe = 'ffprobe'): Promise<ProbeResult> {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_name', '-select_streams', 'a:0',
    '-of', 'json', file,
  ]);
  const data = JSON.parse(stdout) as {
    streams: { codec_name: string }[];
    format: { duration: string };
  };
  return {
    duration: Number(data.format.duration),
    width: 0,
    height: 0,
    fps: 0,
    hasAudio: true,
    codec: data.streams[0]?.codec_name ?? 'aac',
  };
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
  if (hasTracks(project)) {
    if (!flatClips(project).some((c) => c.compound)) return project;
    let slot = 0;
    const resolveOne = async <T extends Clip>(clip: T): Promise<T> => {
      if (!clip.compound) return clip;
      const i = slot++;
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
      const childOpts: ExportOptions = {
        ...opts,
        preset: { ...opts.preset, fps: project.fps },
      };
      await renderProjectWithStab(childProject, intermediate, childOpts, ffmpeg, depth + 1);
      return { ...clip, source: intermediate, compound: undefined };
    };
    const video = [];
    for (const track of project.tracks?.video ?? []) {
      const clips = [];
      for (const c of track.clips) clips.push(await resolveOne(c));
      video.push({ ...track, clips });
    }
    const audio = [];
    for (const track of project.tracks?.audio ?? []) {
      const clips = [];
      for (const c of track.clips) clips.push(await resolveOne(c));
      audio.push({ ...track, clips });
    }
    return { ...project, tracks: { video, audio } };
  }
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
 * P3e export prep (timeline ops that rewrite the project before the
 * graph build): project-level silence cut, text cut, and per-clip
 * music Remix. Runs after compound resolution (so it only ever sees
 * ordinary clips with real source files) and before stabilization
 * prep (so the .trf pass sees the final clips). Returns a new
 * project; the input is untouched.
 *
 * - silenceCut: each clip's silences are detected on its source
 *   window (silencedetect) and deleted (split) or compressed
 *   (speed curve). Subtitles/markers are NOT re-timed — documented
 *   limit; a project that needs both should cut first, subtitle
 *   after. Compound/multicam clips are refused (their audio does
 *   not come from a single source window).
 * - textCut: the named clip is split by the transcript; an empty
 *   result deletes the clip.
 * - clip.remix: the clip's music is remixed to the clip's own output
 *   duration (beat-aware splice, remixAudio) and muxed with the
 *   clip's video into an intermediate MP4 (video re-encoded libx264
 *   CRF 20 — the remix audio cannot ride on the original file, the
 *   graph has no per-clip external audio input); the clip is then
 *   re-pointed at the intermediate with in=0/out=duration.
 */
async function applyTimelinePrep(
  project: Project,
  dir: string,
  opts: ExportOptions,
  ffmpeg: string,
): Promise<Project> {
  // Multitrack prep limits (v1): silence cut, text cut, Remix and
  // vocal separation rewrite the legacy sequential clip list; they
  // have no track-aware equivalent yet, so a multitrack project
  // carrying any of them is refused instead of silently rendering
  // the un-cut / un-remixed timeline.
  if (hasTracks(project)) {
    if (project.silenceCut || project.textCut) {
      throw new Error('silenceCut/textCut are not supported on multitrack projects yet');
    }
    if (flatClips(project).some((c) => c.remix || c.vocalSep)) {
      throw new Error('remix/vocalSep are not supported on multitrack projects yet');
    }
  }
  let p: Project = project;
  if (p.silenceCut) {
    validateSilenceCut(p.silenceCut);
    const mode = p.silenceCut.mode ?? 'delete';
    const factor = p.silenceCut.compressFactor ?? 0.3;
    // Reverse order: replacing/deleting clip i never shifts the
    // indexes of clips before it.
    for (let i = p.clips.length - 1; i >= 0; i--) {
      const clip = p.clips[i];
      if (clip.compound || clip.multicam) {
        throw new Error(`clip ${clip.id}: silenceCut does not support compound/multicam clips yet`);
      }
      const sil = await detectSilencesForClip(clip, {
        ...p.silenceCut,
        ffmpeg,
      });
      if (mode === 'compress') {
        const next = compressSilences(clip, sil, factor);
        p = { ...p, clips: p.clips.map((c, j) => (j === i ? next : c)) };
      } else {
        const kept = cutSilences(clip, sil);
        p = kept.length === 0
          ? deleteClipLinked(p, i, true)
          : replaceClipWithSplits(p, i, kept);
      }
    }
  }
  if (p.textCut) {
    const tc = p.textCut;
    const idx = p.clips.findIndex((c) => c.id === tc.clipId);
    if (idx < 0) {
      throw new Error(`textCut: clip "${tc.clipId}" not found in the project`);
    }
    const clip = p.clips[idx];
    if (clip.compound || clip.multicam) {
      throw new Error(`clip ${clip.id}: textCut does not support compound/multicam clips yet`);
    }
    const res = cutClipByText(clip, tc.subtitles, tc.remove, { speaker: tc.speaker });
    if (res.unmatched.length > 0) {
      throw new Error(`textCut: no match for ${res.unmatched.map((u) => `"${u}"`).join(', ')}`);
    }
    p = res.clips.length === 0
      ? deleteClipLinked(p, idx, true)
      : replaceClipWithSplits(p, idx, res.clips);
  }
  for (let i = 0; i < p.clips.length; i++) {
    const clip = p.clips[i];
    if (!clip.remix) continue;
    if (clip.compound || clip.multicam) {
      throw new Error(`clip ${clip.id}: remix does not support compound/multicam clips yet`);
    }
    if (clip.speed !== 1 || clip.reverse || clip.freezeAt !== undefined ||
      (clip.speedCurve ?? []).length > 0 || clip.beatSpeed) {
      throw new Error(`clip ${clip.id}: remix needs speed 1, no reverse/freeze/speedCurve/beatSpeed`);
    }
    const dur = clipDuration(clip);
    const target = clip.remix.targetDuration;
    if (Math.abs(target - dur) > 0.05) {
      throw new Error(
        `clip ${clip.id}: remix.targetDuration ${target} must equal the clip duration ${dur.toFixed(3)} (±0.05s) — the clip IS the target length`,
      );
    }
    const wav = join(dir, `remix-c${i}.wav`);
    await remixAudio(clip.source, { ...clip.remix, ffmpeg }, wav);
    const intermediate = join(dir, `remix-c${i}.mp4`);
    await execFileAsync(ffmpeg, [
      '-v', 'error',
      '-ss', String(clip.in), '-i', clip.source,
      '-t', String(dur), '-i', wav,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-shortest', '-y', intermediate,
    ]);
    const next: Clip = { ...clip, source: intermediate, in: 0, out: dur, remix: undefined };
    p = { ...p, clips: p.clips.map((c, j) => (j === i ? next : c)) };
  }
  // Vocal separation (P3): each clip with vocalSep is separated with
  // Demucs and re-pointed at an intermediate whose audio is the
  // chosen stem (same pattern as the Remix intermediate above).
  for (let i = 0; i < p.clips.length; i++) {
    const clip = p.clips[i];
    if (!clip.vocalSep) continue;
    validateVocalsep(clip.vocalSep, clip.id);
    if (clip.compound || clip.multicam) {
      throw new Error(`clip ${clip.id}: vocalSep does not support compound/multicam clips yet`);
    }
    if (clip.speed !== 1 || clip.reverse || clip.freezeAt !== undefined ||
      (clip.speedCurve ?? []).length > 0 || clip.beatSpeed) {
      throw new Error(`clip ${clip.id}: vocalSep needs speed 1, no reverse/freeze/speedCurve/beatSpeed`);
    }
    const dur = clipDuration(clip);
    const stems = await separateVocals(clip.source, join(dir, `vocalsep-c${i}`), {
      python: opts.python,
      model: clip.vocalSep.model,
      script: opts.vocalsepScript,
    });
    const stemFile = clip.vocalSep.mode === 'vocals' ? stems.vocals : stems.accompaniment;
    const intermediate = join(dir, `vocalsep-c${i}.mp4`);
    await execFileAsync(ffmpeg, [
      '-v', 'error',
      '-ss', String(clip.in), '-i', clip.source,
      '-ss', String(clip.in), '-i', stemFile,
      '-t', String(dur),
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-shortest', '-y', intermediate,
    ]);
    const next: Clip = { ...clip, source: intermediate, in: 0, out: dur, vocalSep: undefined };
    p = { ...p, clips: p.clips.map((c, j) => (j === i ? next : c)) };
  }
  return p;
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
  // P3e prep (silence cut / text cut / remix) runs on the resolved
  // project, before stabilization prep sees the clips.
  const prepped = await applyTimelinePrep(resolved, outDir, opts, ffmpeg);
  // Vidstab pass 1: run vidstabdetect for every vidstab clip BEFORE the
  // main export, writing one .trf per clip next to the output. The .trf
  // files are deleted after a successful export; on failure they are kept
  // and their paths logged, so the failed run can be debugged/re-run.
  // The flat clip list is passed (index = global input index); for a
  // legacy project it is the project's own clip list.
  const stabTrf = await prepareStabilization({ ...prepped, clips: flatClips(prepped) }, outDir, ffmpeg);
  let ok = false;
  try {
    let report = await exportProjectInner(prepped, output, opts, ffmpeg, stabTrf);
    // AI upscaling (P3, export-time option only, depth 0): the finished
    // export is upscaled with the Real-ESRGAN ONNX model and the
    // upscaled file replaces the export. A missing model throws here
    // instead of shipping the un-upscaled file as "upscaled".
    if (depth === 0 && project.upscale) {
      const upscaled = join(outDir, `upscaled-${basename(output)}`);
      await upscaleVideo(output, upscaled, {
        ...project.upscale,
        ffmpeg,
        ffprobe: opts.ffprobe,
        python: opts.python,
      });
      renameSync(upscaled, output);
      const actual = await probe(output, opts.ffprobe);
      report = {
        ...report,
        output,
        actual,
        durationError: Math.abs(actual.duration - report.expectedDuration),
      };
    }
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
  // P3 export-only mode + HDR mode (deliver.ts): validated up front so
  // a bad value fails before any ffmpeg work starts.
  const exportOnly: ExportOnlyMode = opts.exportOnly ?? 'none';
  if (!['none', 'video', 'audio', 'subtitle'].includes(exportOnly)) {
    throw new Error(`unknown exportOnly: ${String(exportOnly)}`);
  }
  const hdrMode: HdrMode = validateHdrMode(project.hdrMode);
  // Flat view of the timeline for every prep pass that iterates
  // clips by index (multicam/proxy/optimized/roles/masks/portrait/
  // beauty/colour/smart-cut): legacy projects flatten to their own
  // clip list, so this is a no-op for them; multitrack projects
  // flatten to video-track clips then audio-track clips, in the
  // same order buildFilterGraph uses for its ffmpeg input indexes.
  const flatProj: Project = { ...project, clips: flatClips(project) };

  // Subtitle-only export: NO video is rendered and NO ffmpeg run
  // happens. The sidecar is written from the project subtitles (dual
  // track when set) and the report points at it. `actual` is a probe
  // of the first clip's source (real data, not invented); durationError
  // is 0 because no render was performed, so there is no duration
  // error to measure.
  if (exportOnly === 'subtitle') {
    const format = opts.sidecarFormat ?? project.subtitleSidecar ?? 'srt';
    const sidecarPath = opts.srtPath ?? `${output}.${format}`;
    if (project.dualSubtitles?.primary.length) {
      writeDualSubtitleSidecar(project.dualSubtitles, sidecarPath, format, {
        playResX: project.width,
        playResY: project.height,
      });
    } else if (project.subtitles?.length) {
      writeSubtitleSidecar(project.subtitles, sidecarPath, format, {
        playResX: project.width,
        playResY: project.height,
      });
    } else {
      throw new Error('subtitle-only export requested but the project has no subtitles');
    }
    const actual = await probe(flatProj.clips[0].source, opts.ffprobe);
    return {
      output: sidecarPath,
      expectedDuration: projectDuration(project),
      actual,
      durationError: 0,
      exportOnly,
      sidecarFiles: [sidecarPath],
    };
  }

  // Multicam angles: validate durations BEFORE the graph build (async
  // ffprobe; a mismatched/short angle throws instead of truncating).
  // Compound clips are already resolved by renderProjectWithStab, so
  // every clip here has a real source file.
  await prepareMulticam(flatProj, opts.ffprobe);
  // Proxy editing: a declared proxy must exist and match its
  // declaration, or the export is refused — never silently render the
  // original in place of a lost proxy. The export itself always uses
  // clip.source (the relink); the proxy is only validated here.
  await validateProxies(flatProj, opts.ffprobe);
  // Optimized media (P3): a declared DNxHR file must exist and
  // match its declaration, or the export is refused — never silently
  // render the original in place of a lost intermediate. The export
  // itself always uses clip.source; the optimized file is only
  // validated here (same rule as proxies).
  await validateOptimizedMedia(flatProj, opts.ffprobe);
  // Surround layout (P3): fail fast on a bad value, and probe the
  // mix-bus channel count — the upmix mapping depends on it (a mono
  // bus upmixed with the stereo mapping reads a non-existent c1 as
  // silence: FC -6 dB, BR silent — measured 2026-11-18). All clips
  // must agree (all mono or all stereo); a mixed timeline is
  // rejected instead of silently dropping one side.
  // Roles / multitrack: probe every clip's audio channel count
  // BEFORE the graph build (the pan variant depends on it — mono
  // duplicates the single channel, stereo pans two; see roles.ts).
  // Multitrack projects always probe: the amix normalisation needs
  // the per-clip channel count even with no roles in use. Index =
  // global input index (flat clip order).
  const roleAudioChannels = (rolesInUse(project) || hasTracks(project))
    ? await prepareRoleAudio(flatProj, opts.ffprobe)
    : undefined;
  const surroundLayoutChecked = validateSurroundLayout(project.surroundLayout);
  let surroundInputChannels: number | undefined;
  if (surroundLayoutChecked && surroundLayoutChecked !== 'stereo') {
    // Channel counts are probed on the flat clip list (index =
    // global input index). Multitrack projects always probe, even
    // without roles — the multitrack amix normalisation needs the
    // per-clip channel count (see buildFilterGraph).
    const channels = roleAudioChannels ?? (await prepareRoleAudio(flatProj, opts.ffprobe));
    const uniq = [...new Set(channels.values())];
    if (uniq.length !== 1 || (uniq[0] !== 1 && uniq[0] !== 2)) {
      throw new Error(
        `surround ${surroundLayoutChecked}: all clips must have the same audio channel count (1 or 2), got ${[...channels.values()].join(', ')}`,
      );
    }
    surroundInputChannels = uniq[0];
  }
  // TTS narration (P3): synthesize the voice-over BEFORE the graph
  // build; the WAV is registered as an extra input and mixed over
  // the assembled timeline. A missing sherpa-onnx/model throws here
  // instead of exporting without the narration.
  let narrationFile: string | undefined;
  if (project.narration) {
    validateTtsNarration(project.narration);
    narrationFile = join(dirname(output), 'narration.wav');
    await synthesizeSpeech(project.narration.text, narrationFile, {
      python: opts.python,
      speed: project.narration.speed,
      script: opts.ttsScript,
      modelDir: opts.ttsModelDir,
    });
  }
  // (roleAudioChannels was probed above, before the surround block,
  // so the surround upmix and the graph build share one probe pass.)
  // Project-level subtitles: write the .ass karaoke file next to the output
  // and burn it with the ASS filter; clip-level subtitles are already in
  // the per-clip chains (drawtext). Keep the .ass file: it is the audit
  // trail for what was burned, and the WPF side can reuse it for preview.
  // Dual subtitles (P3) burn two styles (Sub bottom, Sub2 above it);
  // the sidecar is written in the requested format (default srt).
  let assFile: string | undefined;
  const sidecarFormat = opts.sidecarFormat ?? project.subtitleSidecar ?? 'srt';
  const sidecarFiles: string[] = [];
  const assStyle = {
    ...DEFAULT_ASS_STYLE,
    fontname: opts.assFont ?? DEFAULT_ASS_STYLE.fontname,
    fontsize: Math.max(24, Math.round(project.height * 0.055)),
  };
  if (project.dualSubtitles?.primary.length) {
    assFile = `${output}.ass`;
    writeFileSync(
      assFile,
      subtitlesToDualASS(project.dualSubtitles, assStyle, project.width, project.height),
      'utf8',
    );
    if (opts.srtPath) {
      writeDualSubtitleSidecar(project.dualSubtitles, opts.srtPath, sidecarFormat, {
        style: assStyle,
        playResX: project.width,
        playResY: project.height,
      });
      sidecarFiles.push(opts.srtPath);
    }
  } else if (project.subtitles && project.subtitles.length > 0) {
    assFile = `${output}.ass`;
    writeFileSync(
      assFile,
      subtitlesToASS(project.subtitles, assStyle, project.width, project.height),
      'utf8',
    );
    if (opts.srtPath) {
      writeSubtitleSidecar(project.subtitles, opts.srtPath, sidecarFormat, {
        style: assStyle,
        playResX: project.width,
        playResY: project.height,
      });
      sidecarFiles.push(opts.srtPath);
    }
  }
  // Shape masks: bake one PNG per mask segment next to the output and pass
  // them as extra inputs (after the clip inputs, in segment order).
  const maskFiles = flatProj.clips.some((c) => c.mask)
    ? prepareClipMaskFiles(flatProj, dirname(output))
    : undefined;
  // Smart portrait cutout: run the ONNX helper for every portrait clip
  // BEFORE the main export; the mask videos go in as extra inputs. The
  // videos are kept next to the output as an audit trail (like the mask
  // PNGs and the .ass file).
  const portraitMasks = flatProj.clips.some((c) => c.portraitCutout)
    ? await preparePortraitMasks(flatProj, dirname(output), {
        python: opts.python,
        script: opts.portraitScript,
        model: opts.portraitModel,
        ffmpeg,
        ffprobe: opts.ffprobe,
      })
    : undefined;
  // Face beautify (P3): same ONNX mask, filtered to the largest
  // component (single) or all components (multi) by beauty_mask.py.
  // Strength-0 clips are skipped inside prepareBeautyMasks. A clip
  // with no person at all throws there ("no face") instead of
  // exporting an unretouched clip as "beautified".
  const beautyMasks = flatProj.clips.some((c) => c.beauty && (c.beauty.strength ?? 50) > 0)
    ? await prepareBeautyMasks(flatProj, dirname(output), {
        python: opts.python,
        portraitScript: opts.portraitScript,
        model: opts.portraitModel,
        ffmpeg,
        ffprobe: opts.ffprobe,
      })
    : undefined;
  // Advanced colour (P2): bake HSL/curves/white-balance into a .cube
  // per clip BEFORE the main export; the .cube files are kept next to
  // the output as an audit trail (like the mask PNGs). Imported .cube
  // files are validated here too — a bad file throws at prep time.
  const colorLuts = flatProj.clips.some((c) => c.advancedColor)
    ? prepareColorLuts(flatProj, dirname(output))
    : undefined;
  // Smart cut (P3): subject tracks (reframe/followZoom) + follow-zoom
  // keyframe merge. Runs before the graph build; the tracking mask
  // videos are kept next to the output as an audit trail. A clip that
  // also has portraitCutout reuses that mask video for tracking
  // (passed in as existingMasks) instead of running the model twice.
  // The graph below is built from smartProject (followZoom clips carry
  // their merged zoom keys); mask/portrait/colour preps above ran on
  // `resolved` and stay valid — smart prep only adds zoom keys.
  // smartFlat is the flat view of smartProject: the P3g prep below
  // iterates clips by flat index, while the graph build takes the
  // tracks project. Legacy: smartFlat.clips === smartProject.clips.
  let smartcutTracks: Map<number, SubjectTrack> | undefined;
  let smartProject = project;
  let smartFlat: Project = flatProj;
  if (flatProj.clips.some((c) => c.reframe || c.followZoom)) {
    const prep = await prepareSmartCut(flatProj, dirname(output), {
      python: opts.python,
      script: opts.portraitScript,
      model: opts.portraitModel,
      ffmpeg,
      ffprobe: opts.ffprobe,
    }, portraitMasks);
    smartcutTracks = prep.tracks;
    smartFlat = prep.project;
    smartProject = rebuildTracksFromFlat(project, prep.project.clips);
  }
  // P3g prep (colour management / match / node graphs / tracked
  // windows / object tracks / clone). All of it runs on smartFlat
  // (followZoom keys merged) and is keyed by clip index, like the
  // colour/portrait/beauty preps above. A clip with both advancedColor
  // and gradeNodes throws here, before any ffmpeg work starts.
  if (project.upscale && exportOnly !== 'none') {
    throw new Error('upscale cannot combine with an export-only switch');
  }
  if (project.upscale) validateUpscale(project.upscale, project.width, project.height);
  if (project.colorManagement?.outputSpace !== undefined && hdrMode !== 'off') {
    throw new Error('colorManagement.outputSpace cannot combine with hdrMode — pick one output transform');
  }
  validateProjectColorManagement(smartFlat.colorManagement);
  for (const clip of smartFlat.clips) {
    if (clip.advancedColor && clip.gradeNodes) {
      throw new Error(
        `clip ${clip.id}: advancedColor and gradeNodes are mutually exclusive — use one grading model per clip`,
      );
    }
  }
  const p3gInputs: P3gGraphInputs = {};
  p3gInputs.colorMgmtLuts = prepareColorManagementLuts(smartFlat, dirname(output));
  const outputLut = prepareOutputLut(smartFlat, dirname(output));
  if (outputLut) {
    p3gInputs.outputLut = outputLut;
    p3gInputs.outputSpace = smartFlat.colorManagement?.outputSpace ?? smartFlat.colorManagement?.workingSpace ?? 'rec709';
  } else if (smartFlat.colorManagement?.outputSpace !== undefined || smartFlat.colorManagement?.workingSpace === 'srgb') {
    // No LUT needed (output == working) but the file still gets tagged
    // with its space — ffprobe reads it back (probe-p3g).
    p3gInputs.outputSpace = smartFlat.colorManagement?.outputSpace ?? smartFlat.colorManagement?.workingSpace ?? 'rec709';
  }
  const colorMatchLuts = await prepareColorMatchLuts(smartFlat, dirname(output), { ffmpeg });
  const extraLuts = new Map<number, string[]>();
  const gradeNodeStages = new Map<number, GradeNodeStage[]>();
  for (let i = 0; i < smartFlat.clips.length; i++) {
    const clip = smartFlat.clips[i];
    const merged: string[] = [...(colorMatchLuts.get(i) ?? [])];
    if (clip.gradeNodes) {
      const staged = writeGradeNodeFiles(clip.gradeNodes, i, dirname(output), smartFlat.width, smartFlat.height);
      merged.push(staged.finalLut);
      if (staged.masked.length > 0) gradeNodeStages.set(i, staged.masked);
    }
    if (merged.length > 0) extraLuts.set(i, merged);
  }
  if (extraLuts.size > 0) p3gInputs.extraLuts = extraLuts;
  if (gradeNodeStages.size > 0) p3gInputs.gradeNodeStages = gradeNodeStages;
  if (smartFlat.clips.some((c) => c.trackedWindow)) {
    const tw = new Map<number, { lut: string; mask: string }>();
    for (let i = 0; i < smartFlat.clips.length; i++) {
      const clip = smartFlat.clips[i];
      if (!clip.trackedWindow) continue;
      tw.set(i, await prepareTrackedWindow(clip, i, smartFlat, dirname(output), { ffmpeg }));
    }
    p3gInputs.trackedWindows = tw;
  }
  if (smartFlat.clips.some((c) => c.objectTrack)) {
    const tracked = await prepareObjectTracks(smartFlat, dirname(output), { ffmpeg, ffprobe: opts.ffprobe });
    const tracks = new Map<number, import('./smartcut.js').SubjectTrack>();
    const masks = new Map<number, string>();
    for (const [i, prep] of tracked) {
      tracks.set(i, prep.track);
      if (prep.maskVideo) masks.set(i, prep.maskVideo);
    }
    p3gInputs.objectTracks = tracks;
    if (masks.size > 0) p3gInputs.objectTrackMasks = masks;
  }
  await prepareClone(smartFlat, { ffprobe: opts.ffprobe });
  // Whole-film frame-interp switch (W10): resolved here, after every
  // prep pass (so a bad target still fails before any ffmpeg work)
  // and applied by overriding the project's own frameInterp on the
  // project handed to the graph build — the graph itself is
  // untouched. Audio-only exports suppress it: the video chain is
  // sunk to nullsink there, so minterpolate would burn its 3-5x
  // cost on frames nobody sees. Compound children inherit the
  // switch through resolveCompoundClips (childOpts spreads opts).
  const frameInterp = exportOnly === 'audio'
    ? undefined
    : resolveExportFrameInterp(project.frameInterp, opts.frameInterp, project.fps);
  const { filterComplex: graphComplex, videoOut, audioOut, extraInputs, audioStems } = buildFilterGraph(
    { ...smartProject, frameInterp },
    opts.fontfile,
    opts.preset.lut,
    assFile,
    maskFiles,
    stabTrf,
    portraitMasks,
    colorLuts,
    roleAudioChannels,
    opts.roleStems,
    smartcutTracks,
    hdrMode,
    beautyMasks ? new Map([...beautyMasks].map(([k, v]) => [k, v.mask] as [number, string])) : undefined,
    narrationFile,
    project.narration,
    project.surroundLayout,
    surroundInputChannels,
    p3gInputs,
  );
  // Export-only switches: an output that is not mapped MUST still be
  // consumed, or FFmpeg rejects the graph ("output unconnected").
  // Sink the unused side (videoOnly sinks audio + stems, audioOnly
  // sinks video). The sunk chain still runs — wasted work, but the
  // graph stays one shape for all three modes.
  let filterComplex = graphComplex;
  if (exportOnly === 'video') {
    filterComplex += `;${audioOut}anullsink`;
    if (audioStems) for (const [, label] of audioStems) filterComplex += `;${label}anullsink`;
  } else if (exportOnly === 'audio') {
    filterComplex += `;${videoOut}nullsink`;
  }
  const args: string[] = [];
  // One -i per clip occurrence, in flat order (the same order
  // buildFilterGraph used for its input indexes).
  flatClips(smartProject).forEach((clip) => args.push('-i', clip.source));
  extraInputs.forEach((p) => args.push('-i', p));
  // Chapters (P3): chapter markers are written to an ffmetadata file
  // and muxed in as an extra input; -map_metadata copies the global
  // tags, -map_chapters copies the chapter table (probe-verified
  // 2026-11-18: ffprobe reads the titles + times back). The .ffmeta
  // file is kept next to the output as an audit trail (like .ass).
  let chapterInputIdx = -1;
  if ((project.markers ?? []).some((m) => m.chapter)) {
    validateTimelineProject(project);
    const metaFile = `${output}.ffmeta`;
    writeFileSync(metaFile, markersToFfmetadata(project), 'utf8');
    chapterInputIdx = flatClips(smartProject).length + extraInputs.length;
    args.push('-i', metaFile);
  }
  args.push('-filter_complex', filterComplex);
  // Export-only switches (P3): video-only drops the audio map (+ -an),
  // audio-only drops the video map (+ -vn). Role stems are audio too —
  // they are only mapped when the audio survives.
  if (exportOnly !== 'audio') args.push('-map', videoOut);
  if (exportOnly !== 'video') args.push('-map', audioOut);
  if (chapterInputIdx >= 0) {
    args.push('-map_metadata', String(chapterInputIdx), '-map_chapters', String(chapterInputIdx));
  }
  // Role stems (roleStems only): one extra audio stream per role, in
  // first-appearance order (mix is audio stream 0, stems are 1..N).
  const stemRoles: string[] = [];
  if (audioStems && exportOnly !== 'video') {
    for (const [roleName, label] of audioStems) {
      args.push('-map', label);
      stemRoles.push(roleName);
    }
  }
  // Encoder plan (P3, deliver.ts): SDR->HDR forces libx265 + 10-bit +
  // BT.2020/PQ tags; HDR->SDR keeps the preset codec at yuv420p;
  // otherwise the preset codec (default libx264).
  const enc = resolveEncoderArgs(opts.preset, hdrMode);
  if (exportOnly !== 'audio') {
    // -r follows the resolved interpolation target, NOT the preset
    // fps: minterpolate emits targetFps frames, and a stale preset
    // -r would drop them again at encode time (pre-W10, a 30 fps
    // preset silently ate a 24->60 interpolation).
    args.push(
      '-c:v', enc.codec, '-preset', opts.preset.preset, '-crf', String(opts.preset.crf),
      '-pix_fmt', enc.pixFmt, '-r', String(frameInterp?.targetFps ?? opts.preset.fps),
    );
  }
  if (exportOnly !== 'video') {
    // Audio codec (P3): surround layouts default to the built-in
    // AC-3 encoder (patents expired); stereo stays AAC. An explicit
    // opts.audioCodec wins. AC-3 bitrate follows the layout
    // (384k for 5.1, 448k for 7.1); AAC keeps the preset bitrate.
    const audioCodec = surroundAudioCodec(project.surroundLayout, opts.audioCodec);
    const audioBitrate = audioCodec === 'ac3' && project.surroundLayout
      ? SURROUND_AC3_BITRATE[project.surroundLayout]
      : (project.surroundLayout && project.surroundLayout !== 'stereo' ? '320k' : opts.preset.audioBitrate);
    args.push('-c:a', audioCodec, '-b:a', audioBitrate);
  }
  if (exportOnly === 'video') args.push('-an');
  if (exportOnly === 'audio') args.push('-vn');
  args.push('-movflags', '+faststart', ...enc.extraArgs, '-y', output);
  await execFileAsync(ffmpeg, args, { maxBuffer: 64 * 1024 * 1024 });
  // Audio-only output has no video stream, so probe() (video-first)
  // would fail — probe the audio side instead.
  const actual = exportOnly === 'audio'
    ? await probeAudio(output, opts.ffprobe)
    : await probe(output, opts.ffprobe);
  const expectedDuration = projectDuration(project);
  return {
    output,
    expectedDuration,
    actual,
    durationError: Math.abs(actual.duration - expectedDuration),
    ...(stemRoles.length > 0 ? { audioStems: stemRoles } : {}),
    ...(exportOnly !== 'none' ? { exportOnly } : {}),
    ...(frameInterp ? { frameInterp } : {}),
    ...(sidecarFiles.length > 0 ? { sidecarFiles } : {}),
  };
}
