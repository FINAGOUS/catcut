// Project model for the Windows screen-recording editor.
// A project is a list of clips on one video track (v0.1, legacy) OR,
// since the multitrack rewrite, a set of video + audio tracks
// (Project.tracks). Each clip references a source file and a time
// range inside it; speed, text and zoom are per-clip.
// The model mirrors DogSC's concepts (clip in/out, speed, zoom keyframes,
// text overlays, transitions) in a Windows/FFmpeg-native form.
// P0 (M4): transitions extended, generic keyframes (opacity/rotation),
// speed curves, text styles, audio fades/denoise/loudnorm, colour adjust.
// P0b: reverse + freeze frame, subtitles (clip- and project-level).
// Multitrack: Project.tracks (video/audio tracks, see below). A legacy
// project (no tracks) is exactly one video track + linked audio:
// normalizeToTracks (multitrack.ts) converts it, and the legacy render
// path is untouched, so legacy exports are unchanged.

import type { SubtitleItem } from './subtitles.js';
import type { TextStylePreset } from './presets.js';
import type { AdvancedColor } from './color.js';
import type { CompoundRef } from './compound.js';
import type { Multicam } from './multicam.js';
import type { RoleConfig } from './roles.js';
import type { ProxyRef } from './proxy.js';
import type { AudioFx } from './audiofx.js';
import type { DualSubtitles, HdrMode, QueueItem, SubtitleSidecarFormat } from './deliver.js';
import type { BeautyOptions } from './beauty.js';
import type { BeatFlashOptions, BeatSpeedOptions } from './beat.js';
import type { TimelineMarker, AdjustmentLayer, AlternateClip } from './timeline.js';
import type { ClipAudition } from './auditions.js';
import type { SilenceCutOptions } from './silencecut.js';
import type { TextCutOptions } from './textcut.js';
import type { RemixOptions } from './remix.js';
import type { FrameInterpOptions } from './frameinterp.js';
import type { AudioRepair } from './audiorepair.js';
import type { VocalSepOptions } from './vocalsep.js';
import type { OptimizedRef } from './optimized.js';
import type { TtsNarration } from './tts.js';
import type { SurroundLayout } from './surround.js';
import type { MediaItem } from './medialib.js';
import type {
  AutoVideo,
  CloneEffect,
  ColorManagement,
  ColorMatch,
  GradeNodeGraph,
  KeyOutline,
  LutLibrary,
  ObjectTrack,
  ReferenceStill,
  TrackedWindow,
  UpscaleOptions,
} from './p3g.js';

export type {
  AutoVideo,
  AutoVideoLine,
  AutoVideoSegment,
  CloneEffect,
  ColorManagement,
  ColorMatch,
  GradeBlendMode,
  GradeNode,
  GradeNodeGraph,
  InputColorSpace,
  KeyOutline,
  LutLibrary,
  LutLibraryEntry,
  ObjectTrack,
  OutputColorSpace,
  ReferenceStill,
  TrackedWindow,
  UpscaleModel,
  UpscaleOptions,
  WorkingColorSpace,
} from './p3g.js';

export type { AudioRepair } from './audiorepair.js';
export type { VocalSepOptions } from './vocalsep.js';
export type { OptimizedRef } from './optimized.js';
export type { TtsNarration } from './tts.js';
export type { SurroundLayout } from './surround.js';
export type { MediaItem, MediaMetadata, MediaFilterRule } from './medialib.js';

export type { TimelineMarker, AdjustmentLayer, AlternateClip } from './timeline.js';
export type { ClipAudition, ClipAuditionOverride } from './auditions.js';
export type { SilenceCutOptions } from './silencecut.js';
export type { TextCutOptions } from './textcut.js';
export type { RemixOptions } from './remix.js';
export type { FrameInterpOptions } from './frameinterp.js';

export type { CompoundRef } from './compound.js';
export type { Multicam, MulticamCut, MulticamSegment } from './multicam.js';
export type { RoleConfig, ResolvedRoleConfig } from './roles.js';
export type { ProxyRef, ProxyInfo, GenerateProxyOptions } from './proxy.js';

export type { AdvancedColor, ColorWheels, ColorWheelZone, Curves, CurvePoint, HslCurves, HslZoneAdjust, HueZoneName, WhiteBalance } from './color.js';
export type { BeautyOptions, BeautyMode } from './beauty.js';
export type { BeatFlashOptions, BeatSpeedOptions } from './beat.js';

/** Shape-mask (PiP) geometry. All fractions are of the frame (0..1). */
export type MaskShape = 'circle' | 'ellipse' | 'rect' | 'roundedRect';

export interface MaskKeyframe {
  /** Clip-local OUTPUT time in seconds; shape applies from t on. */
  t: number;
  shape: MaskShape;
}

export interface ClipMask {
  /** Base shape (before the first keyframe, if any). */
  shape: MaskShape;
  /** Centre x/y as fractions of frame width/height. */
  x: number;
  y: number;
  /** Box width/height as fractions of frame width/height. For 'circle'
   *  the diameter is w (of frame width) in pixels; h is ignored. */
  w: number;
  h: number;
  /** roundedRect corner radius, fraction of min(pxW, pxH), 0..0.5. */
  radius?: number;
  /** Edge feather in pixels (0 = hard edge). Baked into the PNG alpha. */
  feather?: number;
  /** Blur the background under the PiP box (Gaussian sigma in px, 0 = none). */
  backgroundBlur?: number;
  /** Shape switches over time; same timeline as zoom keyframes. */
  keyframes?: MaskKeyframe[];
}

export interface TextOverlay {
  /** Text to burn in. */
  text: string;
  /** Centre x as a fraction of frame width (0..1). */
  x: number;
  /** Centre y as a fraction of frame height (0..1). */
  y: number;
  fontsize: number;
  fontcolor: string;
  /** Clip-local start/end in seconds. */
  start: number;
  end: number;
  /** drawtext box behind the text. */
  box?: boolean;
  boxcolor?: string;
  /** Width of the box border (drawtext boxborderw). */
  boxborderw?: number;
  /** Text outline width (drawtext borderw). */
  borderw?: number;
  shadowcolor?: string;
  shadowx?: number;
  shadowy?: number;
}

export interface ZoomKeyframe {
  /** Clip-local time in seconds. */
  t: number;
  /** Zoom centre as fractions of frame (0..1). */
  cx: number;
  cy: number;
  /** Zoom factor, 1 = no zoom. */
  scale: number;
}

/** Generic keyframe: value at clip-local output time t, linear between keys. */
export interface Keyframe<T> {
  /** Clip-local time in seconds (output timeline). */
  t: number;
  value: T;
}

/**
 * Speed-curve node. `t` is clip-local SOURCE time in seconds (0 = clip.in);
 * `speed` applies from t until the next node (or the clip end). Before the
 * first node the clip's base `speed` applies; a node at t=0 replaces it.
 */
export interface SpeedCurvePoint {
  t: number;
  /** Playback speed, 0.25..4. */
  speed: number;
}

export interface ColorAdjust {
  /** eq brightness, -1..1. */
  brightness?: number;
  /** eq contrast, 0..2 (1 = unchanged). */
  contrast?: number;
  /** eq saturation, 0..3 (1 = unchanged). */
  saturation?: number;
  /** Warm (+) / cool (-), -1..1; implemented via colorbalance. */
  temperature?: number;
}

/** Chroma-key (green/blue screen) background: solid colour or a video/image file. */
export interface ChromaBackground {
  /** Solid colour, e.g. '0x0000ff' or 'red'. Exactly one of color/source. */
  color?: string;
  /** Path to a background video or still image (looped to the clip length). */
  source?: string;
}

export interface ChromaKey {
  /** Key colour, e.g. '0x00ff00' (green) or '0x0000ff' (blue). */
  color: string;
  /**
   * chromakey similarity, 0..1 (default 0.1). Larger = more aggressive key.
   * Measured 2026-11-17: 0.01 does NOT key at all (corner alpha stays 255
   * and keyed pixels turn black in the composite); 0.1 keys cleanly
   * (corner alpha 0, subject alpha 255). Do not lower the default.
   */
  similarity?: number;
  /** chromakey blend, 0..1 (default 0). Larger = softer keyed edges. */
  blend?: number;
  /** Apply despill after keying (default true): removes green/blue spill
   *  from the subject edges. Type (green/blue) is derived from `color`. */
  despill?: boolean;
  /** What shows through the keyed-out area. No background = solid black. */
  background?: ChromaBackground;
}

export type StabilizeMethod = 'vidstab' | 'deshake';

/**
 * Audio ducking (P1, M4): while the sidechain (voice) is loud, this
 * clip's audio (music) is compressed down. Implemented with FFmpeg
 * sidechaincompress (native libavfilter — LGPL part, but still to be
 * re-checked on the BtbN LGPL 9.0 build at the M2 gate).
 * `source` is the voice audio file; it is used from its own t=0,
 * aligned to the clip-local timeline (v1: the caller aligns it, e.g.
 * the mic track of the same session). The voice is a CONTROL signal
 * only — it is not mixed into the output.
 */
export interface DuckingOptions {
  /** Path to the sidechain (voice) audio file. Required. */
  source: string;
  /**
   * Compressor threshold in dBFS (default -20). Range -60..0.
   * sidechaincompress itself takes a linear threshold (0.00098..1);
   * this dB value is converted with 10^(dB/20).
   */
  thresholdDb?: number;
  /** Compression ratio (default 8). Range 1..20. */
  ratio?: number;
  /** Attack in ms (default 20). Range 1..1000. */
  attackMs?: number;
  /** Release in ms (default 250). Range 10..5000. */
  releaseMs?: number;
  /**
   * Extra duck depth in dB (default 0, range 0..30). Implemented by
   * lowering the effective threshold by duckDb / (1 - 1/ratio): for
   * any sidechain level above threshold that adds exactly duckDb more
   * gain reduction on top of what threshold/ratio alone give. During
   * silence the sidechain sits below threshold and the music is
   * untouched, so duckDb never cuts the music's resting level.
   */
  duckDb?: number;
}

export interface StabilizeOptions {
  /**
   * 'vidstab': two-pass libvidstab (best quality, GPL-only — libvidstab is
   * listed by ffmpeg.org as a GPL library, so BtbN LGPL builds do NOT
   * include vidstabdetect/vidstabtransform; re-check on the LGPL build
   * before shipping). 'deshake': single-pass native libavfilter filter,
   * LGPL-safe, weaker on rotation. Default 'vidstab'.
   */
  method?: StabilizeMethod;
  /** vidstabtransform smoothing, frames*2+1 lowpass window (default 15). */
  smoothing?: number;
  /** vidstabtransform zoom %, 0 = let optzoom decide (default 0). */
  zoom?: number;
  /** vidstabtransform camera-path optimisation: 0 opt / 1 gauss / 2 avg. */
  optalgo?: 0 | 1 | 2;
  /** vidstabdetect shakiness 1..10 (default 5). */
  shakiness?: number;
  /** vidstabdetect accuracy 1..15 (default 15). */
  accuracy?: number;
  /** deshake horizontal search radius px (default 16). */
  deshakeRx?: number;
  /** deshake vertical search radius px (default 16). */
  deshakeRy?: number;
  /** deshake edge fill: 'blank' | 'original' | 'clamp' | 'mirror'. */
  deshakeEdge?: 'blank' | 'original' | 'clamp' | 'mirror';
}

export interface PortraitCutout {
  /** Path to the segmentation .onnx file; default is the bundled MediaPipe
   *  Selfie Segmentation model (models/selfie_segmentation_256x256.onnx). */
  model?: string;
  /** What shows through the cut-out area (colour or video/image file).
   *  No background = solid black. Same shape as ChromaBackground. */
  background?: ChromaBackground;
  /** Soften the mask edge in px (gblur sigma on the mask, default 0). */
  edgeFeather?: number;
  /** Run the model every Nth frame (default 1); the mask video is then
   *  upsampled to full fps in the graph. Use 3-5 for long clips when the
   *  person barely moves. */
  sampleEvery?: number;
}

/**
 * Smart reframe (P3, M4 §8.7): crop the source to a target aspect,
 * following the tracked subject (see smartcut.ts). The crop runs on
 * the SOURCE stream, before scale/pad — a crop after scale/pad would
 * cut the letterbox bars, not the subject.
 */
export interface ReframeOptions {
  /** Target aspect of the crop window (default '9:16'). */
  aspect?: '9:16' | '16:9' | '1:1';
  /** Follow the subject vertically too (default false: the window
   *  stays vertically centred). */
  followY?: boolean;
  /** Shrink the window by this fraction (0..0.2, default 0.02) so the
   *  subject never touches the frame edge. */
  margin?: number;
}

/**
 * Auto-follow zoom (P3, M4 §8.7): zoom keyframes generated from the
 * tracked subject + voice segments (see smartcut.ts). The keys are
 * merged into clip.zoom at export prep (prepareSmartCut) — a clip
 * must not carry manual zoom keys as well.
 */
export interface FollowZoomOptions {
  /** Scale at emphasis, (1, 1.35] (default 1.35 — the task range is
   *  1.0..1.35; autozoom's 1.6 cap does not apply here). */
  maxScale?: number;
  /** Ramp time in/out of emphasis in seconds (default 0.2). The
   *  effective ramp is at least (maxScale-1)/maxRate. */
  ease?: number;
  /** Shortest emphasis plateau in seconds (default 0.5). */
  minHold?: number;
  /** Max scale change per second (default 1.0) — the anti-nausea
   *  rate limit on the ramp. */
  maxRate?: number;
}

/** Video denoise (P3, M4 §8.6 — "视频降噪", FFmpeg hqdn3d).
 *  Separate from Clip.denoise, which is AUDIO noise reduction
 *  (afftdn, P0) — the two must not be merged. Strength 0..100
 *  (default 50); 0 = no filter in the graph. */
export interface VideoDenoiseOptions {
  /** Denoise strength 0..100 (default 50). */
  strength?: number;
}

export interface Clip {
  id: string;
  /** Path to the source media file. */
  source: string;
  /** Source in/out in seconds. */
  in: number;
  out: number;
  /** Playback speed, 0.5..4 (atempo range per step). */
  speed: number;
  /** Audio gain, 1 = unchanged. */
  volume: number;
  text?: TextOverlay[];
  /** Linear-interpolated zoom; 0 or 1 keyframes = no zoom. */
  zoom?: ZoomKeyframe[];
  /** Speed curve (clip-local source time). Splits the clip into constant-speed segments. */
  speedCurve?: SpeedCurvePoint[];
  /** Opacity keyframes, 0..1. Single track: opacity = fade toward black. */
  opacity?: Keyframe<number>[];
  /** Rotation keyframes in degrees, ±15° intended range. */
  rotation?: Keyframe<number>[];
  /** Audio fade-in duration in seconds (output timeline). */
  audioFadeIn?: number;
  /** Audio fade-out duration in seconds (output timeline). */
  audioFadeOut?: number;
  /** Apply afftdn noise reduction. */
  denoise?: boolean;
  /** Apply single-pass loudnorm (I=-16, TP=-1.5, LRA=11). */
  loudnorm?: boolean;
  /** Colour adjustment (eq + colorbalance). */
  color?: ColorAdjust;
  /**
   * Advanced colour grading (P2, M4): HSL zone grading, RGB/master
   * curves, white balance, imported .cube. Baked into a 3D LUT at
   * export prep (prepareColorLuts) and applied with lut3d AFTER the
   * P0 eq/colorbalance stage, so old and new fields compose. An
   * imported .cube applies after the generated LUT.
   */
  advancedColor?: AdvancedColor;
  /** Play the whole clip backwards (video reverse + audio areverse). */
  reverse?: boolean;
  /**
   * Freeze-frame: hold the frame at clip-local OUTPUT time `freezeAt`
   * (i.e. after speed is applied) for `freezeDuration` seconds.
   * The frozen span is SILENT (audio is muted there); the frame itself
   * is the source frame at output time freezeAt.
   */
  freezeAt?: number;
  /** Freeze duration in seconds, default 1. */
  freezeDuration?: number;
  /** Clip-level subtitles, clip-local OUTPUT time, burned with drawtext. */
  subtitles?: SubtitleItem[];
  /** Style used for clip-level subtitle burn-in (default lowerThird). */
  subtitleStyle?: TextStylePreset;
  /** Shape mask / picture-in-picture: the clip picture is shown full-frame
   *  as background, with a masked, scaled copy overlaid at (x, y). */
  mask?: ClipMask;
  /** Green/blue-screen keying (chromakey + despill, optional background). */
  chromaKey?: ChromaKey;
  /**
   * Video stabilisation. `true` = vidstab with defaults.
   * vidstab is two-pass (detect .trf first, then transform) and GPL-only;
   * deshake is single-pass and LGPL-safe. vidstab + reverse is rejected
   * (reversed frame order breaks the .trf alignment).
   */
  stabilize?: boolean | StabilizeOptions;
  /**
   * Audio ducking: while the sidechain voice file is loud, this clip's
   * audio is compressed down (sidechaincompress). The sidechain is a
   * control signal only and is not mixed into the output.
   */
  ducking?: DuckingOptions;
  /**
   * Audio effects (P3, M4): built-in EQ (low/high cut + parametric
   * bands), single-track compressor, voice effects (pitch / reverb /
   * echo / chorus / tremolo / vibrato), one-key voice beautify, clip
   * gain trim -30..+30 dB. See src/audiofx.ts for chain order and
   * measured behaviour. The gain range here is NOT the Roles range
   * (Roles gain stays -60..+12 dB, roles.ts) — the two must not be
   * merged.
   */
  audioFx?: AudioFx;
  /**
   * Audio-visual alignment (P1, M4): shift this clip's audio relative
   * to its video, in OUTPUT seconds (after speed). Positive = audio
   * plays later (delayed), negative = audio plays earlier. Set it from
   * an estimateOffset() result with shiftClipAudioToReference()
   * (audioOffset = −offset). Total duration is unchanged: a positive
   * shift pads silence at the head, a negative shift cuts the head
   * and pads silence at the tail. |audioOffset| must be < clip
   * duration (validateAudioOffset throws otherwise).
   */
  audioOffset?: number;
  /**
   * Smart portrait cutout (P1, M4): ONNX human segmentation, local only.
   * The model runs before export (preparePortraitMasks) and produces a
   * mask video; the graph merges it as alpha and composites the person
   * over `background`. v1 limits (enforced in portrait.ts): speed must
   * be 1, no reverse/freeze, and it cannot combine with chromaKey.
   */
  portraitCutout?: PortraitCutout;
  /**
   * Scene-detection threshold for this clip (P3, M4 §8.7): 0.05..0.95,
   * default 0.4. Analysis only — detectScenes() reads it; it never
   * enters the render graph.
   */
  sceneThreshold?: number;
  /**
   * Vertical reframe (P3): crop the source to `aspect`, following the
   * tracked subject (prepareSubjectTracks). Requires speed 1, no
   * reverse/freeze/multicam/portraitCutout (validateSmartCut).
   */
  reframe?: ReframeOptions;
  /**
   * Auto-follow zoom (P3): zoom keyframes from tracking + voice
   * segments, merged into clip.zoom at export prep. Cannot combine
   * with manual zoom keyframes.
   */
  followZoom?: FollowZoomOptions;
  /**
   * Face beautify (P3, M4 §8.7 + direction doc): skin smoothing +
   * slight brightening, masked to the ONNX person mask (see
   * beauty.ts). Requires speed 1, no reverse/freeze; strength 0 =
   * the stage is skipped (bit-identical to no beauty).
   */
  beauty?: BeautyOptions;
  /**
   * Video denoise (P3, M4 §8.6): hqdn3d spatio-temporal denoise,
   * strength 0..100. NOT the audio `denoise` (afftdn) above.
   */
  videoDenoise?: VideoDenoiseOptions;
  /**
   * Beat-speed (P3, M4 §8.1): alternate slow/fast speeds at the
   * given source-time beats (see beat.ts). Cannot combine with a
   * manual speedCurve, reverse, freeze, portraitCutout, reframe or
   * followZoom.
   */
  beatSpeed?: BeatSpeedOptions;
  /**
   * Beat-flash (P3, M4 §8.1): white the frame for `frames` frames
   * at each output-time beat (see beat.ts). Independent of beatSpeed
   * — the two can combine.
   */
  beatFlash?: BeatFlashOptions;
  /**
   * Compound clip / nested timeline (P2, M4): this clip IS a whole
   * child project, rendered first to an intermediate MP4 (see
   * compound.ts + resolveCompoundClips in export.ts). `source` is
   * ignored for compound clips — pass ''. `in`/`out` select a window
   * on the child timeline. Nesting depth is at most 2
   * (parent -> child -> grandchild).
   */
  compound?: CompoundRef;
  /**
   * Multicam clip (P2, M4): N synchronised angle files, cut between
   * them on the timeline (see multicam.ts). `source` is angle 0 — the
   * main angle — and angles[0] must equal it. Audio comes from one
   * angle only (audioAngle, default 0). v1: 2–4 angles (P2b); P3f
   * widened to 2–16 angles, all the same
   * duration, speed 1, no reverse/freeze/stabilisation/portrait.
   */
  multicam?: Multicam;
  /**
   * Audio role (P2, M4): which role this clip's audio belongs to
   * ('dialogue' / 'music' / 'effects' / 'narration', or a custom role
   * declared in Project.roles). No role = 'dialogue'. The mix applies
   * the role's gain/pan/mute/solo (see roles.ts); the export can also
   * write one stem per role (ExportOptions.roleStems).
   */
  role?: string;
  /**
   * J/L edit (P3, M4 §8.2): audio in/out in SOURCE seconds,
   * independent of the video in/out. audioIn < in = J cut (audio
   * starts before the video), audioOut > out = L cut (audio runs
   * past the video). Unset = audio follows the video window.
   * Rendered in filtergraph.ts (one trim on the audio window, then
   * trim/pad to the video duration); validated by validateJLClip
   * (timeline.ts). v1: constant speed only.
   */
  audioIn?: number;
  /** J/L audio out (source seconds); see audioIn. */
  audioOut?: number;
  /**
   * Audition alternates (P3, M4 §8.2): replacement sources for this
   * slot. switchAlternate (timeline.ts) swaps one in without
   * rebuilding the edit; the current source is parked in its slot.
   */
  alternates?: AlternateClip[];
  /**
   * Per-clip audition versions (W10, M4 §8.2 — extends `alternates`):
   * named备选 versions of this clip (different source and/or edit:
   * in/out, speed, effects — any Clip field except id and the
   * audition bookkeeping itself). `activeAuditionId` selects the
   * version the export renders; unset = the clip itself ("原片").
   * Old projects carry neither field and open unchanged — the clip
   * is its own single audition. See src/auditions.ts.
   */
  auditions?: ClipAudition[];
  /** Id of the live audition in `auditions` (unset = the base clip). */
  activeAuditionId?: string;
  /**
   * Audio-only clip (P3, M4 §8.2): the video was removed with linked
   * selection off (deleteClip, timeline.ts) — the audio keeps its
   * timeline position and the video renders black.
   */
  audioOnly?: boolean;
  /**
   * Music Remix (P3, M4 §8.3): stretch/shrink this clip's music to
   * `targetDuration` by beat-aware splicing (remix.ts). Applied at
   * export prep: the remixed audio is muxed with the clip's video
   * into an intermediate file (video re-encoded libx264 CRF 20) and
   * the clip is re-pointed at it. targetDuration must equal the
   * clip's output duration within 0.05 s (the clip IS the target
   * length — the music is fitted to it, not the other way round).
   */
  remix?: RemixOptions;
  /**
   * Proxy editing (P2, M4): low-resolution stand-in for this clip's
   * source (see proxy.ts). The timeline / preview renders against
   * proxy.file; EXPORT always renders from `source` (the relink) but
   * refuses to export when a declared proxy file is missing or does
   * not match its declared size/duration — it never silently falls
   * back to the original. v1: not supported on compound/multicam clips.
   */
  proxy?: ProxyRef;
  /**
   * Optimized media (P3, M4 §8.6): full-resolution DNxHR
   * intermediate for this clip's source (see optimized.ts). The
   * timeline / preview renders against it; EXPORT always renders
   * from `source` after validateOptimizedMedia confirms the file
   * exists and matches. v1: not supported on compound/multicam
   * clips (same as proxy).
   */
  optimizedMedia?: OptimizedRef;
  /**
   * Audio repair (P3, M4 §8.3): de-click (adeclick), mains-hum
   * removal (highpass), noise reduction (afftdn nr=25:nf=-30).
   * See audiorepair.ts — the default afftdn settings measure ~0.3 dB
   * on steady hiss, the repair settings measure ~25 dB. De-reverb
   * is NOT in v1 (no LGPL de-reverb filter exists).
   */
  audioRepair?: AudioRepair;
  /**
   * Vocal separation (P3, M4 §8.3): replace this clip's audio with
   * the Demucs vocals or accompaniment stem (see vocalsep.ts).
   * Applied at export prep: the stem is muxed with the clip's video
   * into an intermediate file (video re-encoded libx264 CRF 20) and
   * the clip is re-pointed at it. Requires Demucs installed; a
   * missing Demucs/model throws instead of exporting the unseparated
   * mix. v1: speed 1, no reverse/freeze, no compound/multicam.
   */
  vocalSep?: VocalSepOptions;
  /**
   * Colour management input space (P3, M4 §8.4): how this clip's
   * footage is encoded (log/Rec.709/sRGB...). Converted into the
   * project's working space at the head of the clip chain (see
   * p3g.ts). Only inputSpace is meaningful here — working/output
   * spaces belong on the project and throw when set on a clip.
   */
  colorManagement?: ColorManagement;
  /**
   * Shot-to-shot colour match (P3, M4 §8.4): bake a histogram-match
   * LUT from `referenceFrame` onto this clip's first frame (see
   * p3g.ts prepareColorMatchLuts). Applied after the advanced-colour
   * LUTs, before the preset LUT.
   */
  colorMatch?: ColorMatch;
  /**
   * Node-based grading (P3, M4 §8.4): a serial/parallel node graph
   * baked into LUTs (see p3g.ts). Mutually exclusive with
   * advancedColor — a clip carrying both throws at export prep.
   */
  gradeNodes?: GradeNodeGraph;
  /**
   * Tracked grading window (P3, M4 §8.4): a shape mask that follows
   * `track`, graded inside only (see p3g.ts). Complements the P1
   * static shape mask (Clip.mask).
   */
  trackedWindow?: TrackedWindow;
  /**
   * Object tracking (P3, M4 §8.7): track a user-boxed target across
   * frames; a sticker text and/or a mosaic follow it (see p3g.ts).
   * Speed must be 1, no reverse/freeze.
   */
  objectTrack?: ObjectTrack;
  /**
   * Clone effect (P3, M4 §8.7): the same source duplicated into 2
   * (left/right) or 4 (2x2 grid) lanes, each lane a time-offset copy
   * of the clip (see p3g.ts). Speed must be 1, no
   * reverse/freeze/reframe/multicam/compound.
   */
  clone?: CloneEffect;
  /**
   * Key outline (P3, M4 §8.7): a coloured stroke around the cut-out
   * person (see p3g.ts). Requires portraitCutout — the outline is
   * drawn from the P1e mask alpha (dilated ring).
   */
  outline?: KeyOutline;
}

export type TransitionType =
  | 'cut'
  | 'fade'
  | 'dissolve'
  | 'wipeleft'
  | 'wiperight'
  | 'slideleft'
  | 'circleopen'
  | 'fadeblack'
  | 'fadewhite';

// ---------------------------------------------------------------------------
// Multitrack model (true multi-track rewrite).
//
// A video track is a lane of clips placed at explicit track times
// (`start`, seconds from the track head). Same-track clips may
// overlap (the later-starting clip is on top within the track);
// gaps render as black (video) / silence (audio). Tracks
// stack bottom-to-top in array order: video track 0 is the bottom
// layer, the last video track is on top. A clip on a video track
// contributes its video AND its linked audio; a clip on an audio
// track contributes audio only (its video is ignored) — that is
// where music / narration / SFX live. A video track's `visible=false`
// hides its video only; its linked audio still plays.
// Track opacity is a static 0..1 multiplier on the whole track
// (applied to alpha, so lower tracks show through); `blend` is an
// FFmpeg blend mode applied to the track's full-canvas picture
// (opaque sources; alpha is ignored on the blend path — see
// multitrack.ts). `x`/`y` are pixel offsets of the track picture on
// the canvas; `w`/`h` are fractions of the canvas (default 1) so a
// track can be a PiP. `locked` is a UI hint only and never affects
// the render. Audio tracks carry their own gain/pan/mute/solo; when
// any audio track has solo, every non-solo audio track is muted.
// Clip.opacity keyframes in multitrack mode fade toward TRANSPARENT
// (lower tracks show through); in legacy single-track mode they
// still fade toward black (there is nothing underneath).
// ---------------------------------------------------------------------------

/** Blend mode of a whole video track (FFmpeg blend all_mode names). */
export type TrackBlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'add';

/**
 * Cross-track transition: how a video-track clip arrives.
 * Two cases, decided by whether the clip overlaps the previous
 * clip ON THE SAME TRACK:
 * - Overlap (the normalized-legacy case): the clip crossfades with
 *   the previous same-track clip via xfade — all 9 transition types
 *   are supported and the duration is the overlap (or less).
 * - No overlap: the clip arrives over the composite of the LOWER
 *   tracks — only fade/dissolve (alpha ramp 0 -> 1) and
 *   fadeblack/fadewhite (picture fades in from solid black/white)
 *   are supported; wipe/slide/circle need a spatial wipe between
 *   two full composites and are rejected there. transitionIn is
 *   video-only; the clip's audio starts at the clip start.
 */
export interface CrossTrackTransition {
  type: TransitionType;
  /** Transition length in seconds, > 0 and <= the clip's duration
   *  (and <= the same-track overlap when the clip overlaps). */
  duration: number;
}

/** One clip placed on a video track. `start` is track time in seconds. */
export interface VideoTrackClip extends Clip {
  /** Track-local start time in seconds (>= 0). */
  start: number;
  /** How this clip arrives over the composite underneath it. */
  transitionIn?: CrossTrackTransition;
}

export interface VideoTrack {
  /** Track id, non-empty and unique within the project. */
  id: string;
  name?: string;
  clips: VideoTrackClip[];
  /** Static track opacity, 0..1 (default 1). */
  opacity?: number;
  /** Blend mode against the composite below (default 'normal'). */
  blend?: TrackBlendMode;
  /** Pixel offset of the track picture on the canvas (default 0). */
  x?: number;
  /** Pixel offset of the track picture on the canvas (default 0). */
  y?: number;
  /** Track width as a fraction of the canvas width (default 1). */
  w?: number;
  /** Track height as a fraction of the canvas height (default 1). */
  h?: number;
  /** Hidden tracks render nothing (video only; linked audio plays). */
  visible?: boolean;
  /** UI lock hint only; never affects the render. */
  locked?: boolean;
}

/** One clip placed on an audio track. `start` is track time in seconds. */
export interface AudioTrackClip extends Clip {
  /** Track-local start time in seconds (>= 0). */
  start: number;
}

export interface AudioTrack {
  /** Track id, non-empty and unique within the project. */
  id: string;
  name?: string;
  clips: AudioTrackClip[];
  /** Static track gain in dB, -60..+12 (default 0). */
  gainDb?: number;
  /** Stereo balance, -1 (full left) .. +1 (full right). Default 0. */
  pan?: number;
  /** Mute this track in the mix. */
  mute?: boolean;
  /** Solo this track: every audio track WITHOUT solo is muted. */
  solo?: boolean;
}

export interface ProjectTracks {
  video?: VideoTrack[];
  audio?: AudioTrack[];
}

export interface Project {
  version: 1;
  width: number;
  height: number;
  fps: number;
  clips: Clip[];
  /** transitions[i] sits between clips[i] and clips[i+1]; length = clips-1. */
  transitions: TransitionType[];
  /** Transition duration in seconds (used by every non-'cut' transition). */
  transitionDuration: number;
  /**
   * Multitrack timeline. When present and non-empty it IS the
   * timeline: the legacy `clips`/`transitions` list is then ignored
   * by the render (kept only so old readers still see the clips).
   * When absent the project is legacy single-track and renders
   * exactly as before (see normalizeToTracks in multitrack.ts for
   * the equivalent track form).
   */
  tracks?: ProjectTracks;
  /**
   * Project-level subtitles, PROJECT time, burned with the ASS filter
   * (karaoke word highlight) after the timeline is assembled.
   */
  subtitles?: SubtitleItem[];
  /**
   * Role mix config (P2, M4): per-role gain/pan/mute/solo, one entry
   * per role (see roles.ts). An entry may override a built-in role
   * (e.g. { name: 'music', gainDb: -6 }) or declare a custom role
   * that clips reference via Clip.role. Empty/absent = all roles at
   * gain 0 / pan 0 / unmuted.
   */
  roles?: RoleConfig[];
  /**
   * Master output gain in dB, -30..+30 (same range as the clip gain
   * trim, audiofx.ts CLIP_GAIN_DB_MIN/MAX; validated by
   * validateMasterGainDb). Applied to the final mix after assembly
   * and ducking — it is a trim, so it sits after loudnorm by design.
   */
  masterGainDb?: number;
  /**
   * Dual subtitles (P3, M4 §8.5): primary + second-language tracks,
   * burned as two ASS styles (Sub bottom, Sub2 above it). Absent =
   * single-track `subtitles` behaviour. A second language that is
   * missing is fine (one line); a missing primary throws.
   */
  dualSubtitles?: DualSubtitles;
  /**
   * Preferred subtitle sidecar format for this project ('srt' default
   * when unset). The export call's ExportOptions.sidecarFormat wins
   * over this.
   */
  subtitleSidecar?: SubtitleSidecarFormat;
  /**
   * HDR mode (P3): 'off' (default), 'hdr-to-sdr' (10-bit PQ in,
   * tonemap to Rec.709 SDR), 'sdr-to-hdr' (PSEUDO-HDR: SDR lifted
   * into a 10-bit PQ container — adds no highlight information).
   */
  hdrMode?: HdrMode;
  /**
   * Stored export preset NAME (resolved through a PresetStore at
   * queue/export time, deliver.ts). exportProject's ExportOptions.
   * preset is the explicit preset and wins over this.
   */
  exportPreset?: string;
  /** Batch export queue for this project (deliver.ts runExportQueue). */
  queue?: QueueItem[];
  /**
   * Timeline markers (P3, M4 §8.2): time + colour + label; chapter
   * markers are written to the MP4 as chapters on export
   * (markersToFfmetadata, timeline.ts). Validated by
   * validateTimelineProject.
   */
  markers?: TimelineMarker[];
  /**
   * Adjustment layers (P3, M4 §8.2): blank spans carrying a colour
   * adjustment applied to everything underneath in that span
   * (adjustmentLayerFilter, timeline.ts; rendered in filtergraph.ts
   * after assembly).
   */
  adjustmentLayers?: AdjustmentLayer[];
  /**
   * Linked selection (P3, M4 §8.2): true (default) = moving/deleting
   * a video clip moves/deletes its audio with it; false = the video
   * can be deleted on its own (deleteClip leaves an audio-only clip).
   */
  linkSelection?: boolean;
  /**
   * One-click silence cut (P3, M4 §8.6): applied at export prep —
   * silences in each clip are deleted or compressed per these
   * options (silencecut.ts). Subtitles/markers are NOT re-timed by
   * the cut; that is a documented limit.
   */
  silenceCut?: SilenceCutOptions;
  /**
   * Text cut (P3, M4 §8.3): applied at export prep — the listed
   * words/sentences are cut from the named clip (textcut.ts).
   */
  textCut?: TextCutOptions;
  /**
   * Smart frame interpolation (P3, M4 §8.7): raise the assembled
   * timeline to targetFps with minterpolate (frameinterp.ts).
   * targetFps must exceed the project fps.
   */
  frameInterp?: FrameInterpOptions;
  /**
   * TTS narration (P3, M4 §8.3): one local Sherpa-ONNX voice-over
   * mixed over the timeline from `start` (see tts.ts). Synthesized
   * at export prep; missing sherpa-onnx/model throws instead of
   * exporting without the narration.
   */
  narration?: TtsNarration;
  /**
   * Surround layout of the mix bus (P3, M4 §8.3): 'stereo'
   * (default, P2c behaviour), '5.1' or '7.1'. The mix stays stereo
   * through assembly; a single pan upmix at the end widens it
   * (see surround.ts). Surround exports default to AC-3 for 5.1
   * and AAC for 7.1 (AC-3 tops out at 5.1). Role stems stay stereo.
   */
  surroundLayout?: SurroundLayout;
  /**
   * Media library (P3, M4 §8.1): bins, keywords, ratings,
   * favourites, rejected flags, camera tags and per-item metadata
   * (see medialib.ts). The library is metadata only — the clips
   * still reference files by path; subclips store in/out ranges
   * and never copy files.
   */
  mediaLibrary?: MediaItem[];
  /**
   * Colour management (P3, M4 §8.4): timeline working space +
   * delivery space (see p3g.ts). Input spaces live on the clips.
   * Working defaults to 'rec709'; output defaults to the working
   * space. A log clip is converted at the head of its chain; the
   * output conversion runs after assembly, before subtitle burn.
   */
  colorManagement?: ColorManagement;
  /**
   * LUT library (P3, M4 §8.4): managed .cube entries by category /
   * favourite (see p3g.ts). Metadata only — the .cube files live
   * where the entries point; P2a .cube import is unchanged.
   */
  lutLibrary?: LutLibrary;
  /**
   * Reference stills library (P3, M4 §8.4): stored frames for
   * grade comparison (see p3g.ts saveReferenceStill). Each entry
   * points at a PNG + a JSON sidecar next to it.
   */
  referenceStills?: ReferenceStill[];
  /**
   * Auto-video script (P3, M4 §8.7): the script this project was
   * built from, if it was built by buildAutoVideoProject (see
   * p3g.ts). Kept for round-tripping; it never affects the render.
   */
  autoVideo?: AutoVideo;
  /**
   * AI upscaling (P3, M4 §8.7): upscale the finished export to the
   * target size with the Real-ESRGAN ONNX model (see p3g.ts).
   * Export-time option only; a missing model throws instead of
   * exporting un-upscaled.
   */
  upscale?: UpscaleOptions;
}

export interface SpeedSegment {
  /** Clip-local source offset from clip.in, in seconds. */
  start: number;
  end: number;
  speed: number;
}

/** Split a clip into constant-speed source segments from its speed curve. */
export function speedCurveSegments(clip: Clip): SpeedSegment[] {
  const srcDur = clip.out - clip.in;
  // Beat-speed (P3): the beats ARE the speed curve — the nodes are
  // derived here so clipDuration/projectDuration account for them
  // (a beat-speed clip's output is longer/shorter than its source;
  // without this the export's durationError is the whole speed
  // difference, measured 2.500 s on a 4 s clip in probe 2026-11-18).
  const curve = clip.beatSpeed
    ? beatSpeedNodes(clip.beatSpeed.beats, clip.beatSpeed.slowSpeed ?? 0.5, clip.beatSpeed.fastSpeed ?? 2, clip.beatSpeed.startWith ?? 'slow')
    : (clip.speedCurve ?? []).slice().sort((a, b) => a.t - b.t);
  if (curve.length === 0) return [{ start: 0, end: srcDur, speed: clip.speed }];
  const segments: SpeedSegment[] = [];
  let prevT = 0;
  let prevSpeed = clip.speed;
  for (const p of curve) {
    if (p.speed <= 0) throw new Error(`clip ${clip.id}: speedCurve speed must be > 0`);
    const t = Math.min(Math.max(p.t, 0), srcDur);
    if (t > prevT) segments.push({ start: prevT, end: t, speed: prevSpeed });
    prevT = t;
    prevSpeed = p.speed;
  }
  if (prevT < srcDur) segments.push({ start: prevT, end: srcDur, speed: prevSpeed });
  return segments.length > 0 ? segments : [{ start: 0, end: srcDur, speed: clip.speed }];
}

/** Beat-speed curve nodes (pure): alternate slow/fast at each beat,
 *  starting with `startWith` at t=0. The first node is always at
 *  t=0; each beat flips the speed. beat.ts's beatSpeedCurve is a
 *  thin wrapper over this — the nodes live here so
 *  speedCurveSegments (and therefore clipDuration) can use them
 *  without a project.ts -> beat.ts import cycle. */
export function beatSpeedNodes(
  beats: number[],
  slow: number,
  fast: number,
  startWith: 'slow' | 'fast',
): SpeedCurvePoint[] {
  const nodes: SpeedCurvePoint[] = [{ t: 0, speed: startWith === 'slow' ? slow : fast }];
  let cur = startWith;
  for (const b of beats) {
    cur = cur === 'slow' ? 'fast' : 'slow';
    nodes.push({ t: b, speed: cur === 'slow' ? slow : fast });
  }
  return nodes;
}

/** Clip-local duration after speed (or speed curve) is applied. */
export function clipDuration(clip: Clip): number {
  const base = speedCurveSegments(clip).reduce(
    (sum, s) => sum + (s.end - s.start) / s.speed,
    0,
  );
  if (clip.freezeAt === undefined) return base;
  if (clip.freezeAt < 0 || clip.freezeAt >= base) {
    throw new Error(
      `clip ${clip.id}: freezeAt ${clip.freezeAt} outside [0, ${base.toFixed(3)})`,
    );
  }
  const fd = clip.freezeDuration ?? 1;
  if (fd <= 0) throw new Error(`clip ${clip.id}: freezeDuration must be > 0`);
  return base + fd;
}

/** Clip duration WITHOUT the freeze extension (freeze source window). */
export function clipBaseDuration(clip: Clip): number {
  return speedCurveSegments(clip).reduce(
    (sum, s) => sum + (s.end - s.start) / s.speed,
    0,
  );
}

/** True when the project carries a multitrack timeline. */
export function hasTracks(project: Project): boolean {
  return (
    (project.tracks?.video?.length ?? 0) > 0 ||
    (project.tracks?.audio?.length ?? 0) > 0
  );
}

/** End time of the latest clip on a video track (0 when empty). */
export function videoTrackDuration(track: VideoTrack): number {
  let end = 0;
  for (const c of track.clips ?? []) end = Math.max(end, c.start + clipDuration(c));
  return end;
}

/** End time of the latest clip on an audio track (0 when empty). */
export function audioTrackDuration(track: AudioTrack): number {
  let end = 0;
  for (const c of track.clips ?? []) end = Math.max(end, c.start + clipDuration(c));
  return end;
}

/** Total timeline duration, accounting for transition overlaps.
 *  Multitrack: the longest video track (audio tracks only when no
 *  video track has any content). Legacy: the sequential clip list
 *  minus the non-'cut' transition overlaps — unchanged. */
export function projectDuration(project: Project): number {
  if (hasTracks(project)) {
    const vEnds = (project.tracks?.video ?? []).map(videoTrackDuration);
    const vMax = vEnds.length > 0 ? Math.max(...vEnds) : 0;
    if (vMax > 0) return vMax;
    const aEnds = (project.tracks?.audio ?? []).map(audioTrackDuration);
    return aEnds.length > 0 ? Math.max(...aEnds) : 0;
  }
  let total = project.clips.reduce((sum, c) => sum + clipDuration(c), 0);
  // Every non-'cut' transition is an xfade that overlaps transitionDuration.
  const overlaps = project.transitions.filter((t) => t !== 'cut').length;
  return total - overlaps * project.transitionDuration;
}
