// Project model for the Windows screen-recording editor.
// A project is a list of clips on one video track (v0.1). Each clip references
// a source file and a time range inside it; speed, text and zoom are per-clip.
// The model mirrors DogSC's concepts (clip in/out, speed, zoom keyframes,
// text overlays, transitions) in a Windows/FFmpeg-native form.
// P0 (M4): transitions extended, generic keyframes (opacity/rotation),
// speed curves, text styles, audio fades/denoise/loudnorm, colour adjust.
// P0b: reverse + freeze frame, subtitles (clip- and project-level).

import type { SubtitleItem } from './subtitles.js';
import type { TextStylePreset } from './presets.js';

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
   * Project-level subtitles, PROJECT time, burned with the ASS filter
   * (karaoke word highlight) after the timeline is assembled.
   */
  subtitles?: SubtitleItem[];
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
  const curve = (clip.speedCurve ?? []).slice().sort((a, b) => a.t - b.t);
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

/** Total timeline duration, accounting for transition overlaps. */
export function projectDuration(project: Project): number {
  let total = project.clips.reduce((sum, c) => sum + clipDuration(c), 0);
  // Every non-'cut' transition is an xfade that overlaps transitionDuration.
  const overlaps = project.transitions.filter((t) => t !== 'cut').length;
  return total - overlaps * project.transitionDuration;
}
