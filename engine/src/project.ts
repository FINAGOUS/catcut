// Project model for the Windows screen-recording editor.
// A project is a list of clips on one video track (v0.1). Each clip references
// a source file and a time range inside it; speed, text and zoom are per-clip.
// The model mirrors DogSC's concepts (clip in/out, speed, zoom keyframes,
// text overlays, transitions) in a Windows/FFmpeg-native form.
// P0 (M4): transitions extended, generic keyframes (opacity/rotation),
// speed curves, text styles, audio fades/denoise/loudnorm, colour adjust.

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
  return speedCurveSegments(clip).reduce((sum, s) => sum + (s.end - s.start) / s.speed, 0);
}

/** Total timeline duration, accounting for transition overlaps. */
export function projectDuration(project: Project): number {
  let total = project.clips.reduce((sum, c) => sum + clipDuration(c), 0);
  // Every non-'cut' transition is an xfade that overlaps transitionDuration.
  const overlaps = project.transitions.filter((t) => t !== 'cut').length;
  return total - overlaps * project.transitionDuration;
}
