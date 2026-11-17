// Builds an FFmpeg filter_complex graph from a Project.
// Pure string building (no ffmpeg call) so it can be unit-tested.
// Conventions:
// - Inputs are indexed 0..n-1, one per clip, in timeline order.
// - Each clip gets a video chain [v<i>] and an audio chain [a<i>].
// - 'cut' transitions use concat; every other transition uses chained
//   xfade/acrossfade (fadeblack/fadewhite are valid xfade names, verified
//   against ffmpeg 8.1: xfade transitions 12/13).
// - Speed curves split a clip into constant-speed segments that are
//   concatenated back into one [v<i>]/[a<i>] stream before the per-clip
//   filters (zoom/rotation/colour/opacity/text), so those filters all see
//   clip-local OUTPUT time, matching their keyframe `t` semantics.

import {
  clipBaseDuration,
  clipDuration,
  speedCurveSegments,
  type Clip,
  type Keyframe,
  type Project,
  type TransitionType,
  type ZoomKeyframe,
} from './project.js';
import { subtitlesToTextOverlays } from './subtitles.js';
import { TEXT_PRESETS } from './presets.js';
import { maskOverlayPos, maskSegments } from './mask.js';
import {
  deshakeFilter,
  validateStabilize,
  vidstabTransformFilter,
} from './stabilize.js';
import {
  duckingFilter,
  validateDucking,
} from './ducking.js';
import {
  audioShiftFilter,
  validateAudioOffset,
} from './align.js';
import {
  validatePortraitCutout,
} from './portrait.js';
import {
  lut3dFilter,
  validateAdvancedColor,
} from './color.js';
import {
  multicamSegments,
  validateMulticam,
} from './multicam.js';
import {
  effectiveMute,
  resolveRoleConfigs,
  roleFilter,
  roleOfClip,
  rolesInUse,
  validateRoles,
  type ResolvedRoleConfig,
} from './roles.js';
import {
  audioFxFilter,
  validateAudioFx,
  validateMasterGainDb,
} from './audiofx.js';

export interface FilterGraph {
  filterComplex: string;
  videoOut: string;
  audioOut: string;
  /** Still-image inputs (mask PNGs) appended AFTER the clip inputs;
   *  the caller must add them as `-i` args in this exact order. */
  extraInputs: string[];
  /** Role stems (roleStems only): role name -> assembled stem label,
   *  in first-appearance order. Each stem is the full timeline with
   *  every other role replaced by silence. */
  audioStems?: Map<string, string>;
}

/**
 * Assemble one audio timeline from per-clip input labels, mirroring
 * the mix: plain concat when there is no crossfade, otherwise the
 * chained acrossfade/concat walk with the same offsets as the video
 * xfade chain (offset of transition k = accumulated duration before
 * clip k+1, minus the overlaps already applied). `inputs` are the
 * per-clip labels in timeline order; `durations` are the per-clip
 * durations (clipDuration). `tag` prefixes the intermediate labels
 * ('a' for the mix, 's<j>' for a stem) so mix and stems never share a
 * label. Produces byte-identical strings to the pre-refactor inline
 * assembly when called with the mix inputs and tag 'a'.
 */
function audioAssemblyChains(
  inputs: string[],
  transitions: TransitionType[],
  durations: number[],
  transitionDuration: number,
  outLabel: string,
  tag: string,
): string[] {
  const chains: string[] = [];
  const n = inputs.length;
  const hasXfade = transitions.some((t) => t !== 'cut');
  if (!hasXfade) {
    chains.push(`${inputs.join('')}concat=n=${n}:v=0:a=1${outLabel}`);
    return chains;
  }
  const d = transitionDuration;
  let aPrev = inputs[0];
  let acc = durations[0];
  inputs.slice(1).forEach((next, k) => {
    const type = transitions[k];
    const isLast = k === n - 2;
    if (type !== 'cut') {
      const offset = Math.max(0, acc - d);
      const aX = isLast ? outLabel : `[${tag}x${k}]`;
      chains.push(`${aPrev}${next}acrossfade=d=${d}${aX}`);
      aPrev = aX;
      acc = acc + durations[k + 1] - d;
    } else {
      const aC = isLast ? outLabel : `[${tag}c${k}]`;
      chains.push(`${aPrev}${next}concat=n=2:v=0:a=1${aC}`);
      aPrev = aC;
      acc = acc + durations[k + 1];
    }
  });
  return chains;
}

/** Per-clip mask PNG files (segment order) + assigned input indexes. */
interface MaskCtx {
  maskFiles?: Map<number, string[]>;
  /** clipIdx -> portrait mask video path (preparePortraitMasks output). */
  portraitMaskFiles?: Map<number, string>;
  extraInputs: string[];
  /** `${clipIdx}:${segIdx}` -> ffmpeg input index. */
  inputIndex: Map<string, number>;
  /** clipIdx -> ffmpeg input index of its chroma-key background source. */
  bgInputIndex: Map<number, number>;
  /** clipIdx -> ffmpeg input index of its ducking sidechain source. */
  duckInputIndex: Map<number, number>;
  /** clipIdx -> ffmpeg input index of its portrait mask video. */
  portraitInputIndex: Map<number, number>;
  /** `${clipIdx}:${angleIdx}` -> ffmpeg input index of a multicam angle
   *  (angle 0 rides on the clip's own input, so only angles 1.. are here). */
  multicamInputIndex: Map<string, number>;
}

/** ffmpeg input index for one multicam angle: angle 0 is the clip's own input. */
function multicamAngleInputIndex(ctx: MaskCtx, clipIdx: number, angle: number): number {
  if (angle === 0) return clipIdx;
  const i = ctx.multicamInputIndex.get(`${clipIdx}:${angle}`);
  if (i === undefined) {
    throw new Error(`clip ${clipIdx}: no input registered for multicam angle ${angle}`);
  }
  return i;
}

/** despill screen type from the key colour (blue-dominant hex => blue). */
function despillType(color: string): 'green' | 'blue' {
  const c = color.toLowerCase().trim();
  if (c === 'blue' || c === '0x0000ff' || c === '#0000ff') return 'blue';
  const m = c.match(/^(?:0x|#)?([0-9a-f]{6})$/);
  if (m) {
    const v = parseInt(m[1], 16);
    const r = (v >> 16) & 0xff;
    const g = (v >> 8) & 0xff;
    const b = v & 0xff;
    if (b > r && b > g) return 'blue';
  }
  return 'green';
}

function validateChromaKey(key: NonNullable<Clip['chromaKey']>, id: string): void {
  if (key.similarity !== undefined && (key.similarity <= 0 || key.similarity > 1)) {
    throw new Error(`clip ${id}: chromaKey.similarity ${key.similarity} outside (0, 1]`);
  }
  if (key.blend !== undefined && (key.blend < 0 || key.blend > 1)) {
    throw new Error(`clip ${id}: chromaKey.blend ${key.blend} outside [0, 1]`);
  }
  if (key.background?.color && key.background?.source) {
    throw new Error(`clip ${id}: chromaKey.background takes either color or source, not both`);
  }
}

/** xfade transition name per TransitionType (all verified in ffmpeg 8.1). */
export const XFADE_TRANSITIONS: Record<string, string> = {
  fade: 'fade',
  dissolve: 'dissolve',
  wipeleft: 'wipeleft',
  wiperight: 'wiperight',
  slideleft: 'slideleft',
  circleopen: 'circleopen',
  fadeblack: 'fadeblack',
  fadewhite: 'fadewhite',
};

function escText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:');
}

/** Linear interpolation expression for a value across keyframes, driven by
 *  the per-frame time variable (`t` in most filters, `T` in blend). */
function lerpExpr<K extends { t: number }>(
  keys: K[],
  pick: (k: K) => number,
  tv = 't',
): string {
  if (keys.length === 1) return String(pick(keys[0]));
  let expr = String(pick(keys[keys.length - 1]));
  for (let i = keys.length - 2; i >= 0; i--) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    const v0 = pick(k0);
    const v1 = pick(k1);
    expr =
      `if(lt(${tv},${k0.t}),${v0},` +
      `if(gt(${tv},${k1.t}),${expr},${v0}+(${v1}-${v0})*(${tv}-${k0.t})/(${k1.t}-${k0.t})))`;
  }
  return expr;
}

function drawtextFilter(
  t: NonNullable<Clip['text']>[number],
  fontfile: string,
): string {
  let f =
    `drawtext=fontfile=${fontfile}:text='${escText(t.text)}':fontsize=${t.fontsize}` +
    `:fontcolor=${t.fontcolor}:x=(w-text_w)*${t.x}:y=(h-text_h)*${t.y}` +
    `:enable='between(t,${t.start},${t.end})'`;
  if (t.borderw !== undefined) f += `:borderw=${t.borderw}`;
  if (t.box) {
    f += `:box=1:boxcolor=${t.boxcolor ?? 'black@0.6'}:boxborderw=${t.boxborderw ?? 10}`;
  }
  if (t.shadowx !== undefined || t.shadowy !== undefined) {
    f += `:shadowcolor=${t.shadowcolor ?? 'black'}:shadowx=${t.shadowx ?? 0}:shadowy=${t.shadowy ?? 0}`;
  }
  return f;
}

/**
 * Video chains for one clip. Returns one or more filter_complex segments;
 * the clip's final video label is [v<idx>].
 * Order: segment trim/speed (+reverse) -> freeze stage -> scale/pad/fps ->
 * zoom -> rotation -> colour -> LUT -> opacity (split + black branch +
 * blend) -> text (+ clip subtitles).
 * freezeAt is clip-local OUTPUT time (after speed, after reverse).
 */
function clipVideoChains(
  clip: Clip,
  idx: number,
  project: Project,
  fontfile: string,
  lut?: string,
  maskCtx?: MaskCtx,
  stabTrf?: Map<number, string>,
  colorLuts?: Map<number, string[]>,
): string[] {
  const { width, height, fps } = project;
  const chains: string[] = [];

  // Multicam (P2): the [vb] stream is assembled from the angle
  // segments instead of the speed-curve segments below. vidstab,
  // deshake, reverse and freeze are all rejected for multicam clips
  // by validateMulticam, so [vb] is already final here — the scale/
  // pad/fps stage below applies to it directly.
  const mc = validateMulticam(clip);
  let baseLabel: string;
  if (mc) {
    if (!maskCtx) {
      throw new Error(`clip ${clip.id}: multicam needs the graph context`);
    }
    const segs = multicamSegments(clip);
    if (segs.length === 1) {
      const seg = segs[0];
      const inputIdx = multicamAngleInputIndex(maskCtx, idx, seg.angle);
      chains.push(
        `[${inputIdx}:v]trim=start=${clip.in + seg.t0}:end=${clip.in + seg.t1},` +
          `setpts=PTS-STARTPTS[vb${idx}]`,
      );
    } else {
      const outs = segs.map((seg, j) => {
        const inputIdx = multicamAngleInputIndex(maskCtx, idx, seg.angle);
        chains.push(
          `[${inputIdx}:v]trim=start=${clip.in + seg.t0}:end=${clip.in + seg.t1},` +
            `setpts=PTS-STARTPTS[vsm${idx}_${j}]`,
        );
        return `[vsm${idx}_${j}]`;
      });
      chains.push(`${outs.join('')}concat=n=${segs.length}:v=1:a=0[vb${idx}]`);
    }
    baseLabel = `[vb${idx}]`;
  } else {
  // Stabilisation, vidstab path: the transform must see exactly the frames
  // the detect pass saw, in the same order — so build one stabilised
  // full-range stream FIRST ([vstb]), then cut speed segments out of it.
  // (validateStabilize rejects vidstab+reverse for the same reason.)
  const stab = validateStabilize(clip);
  let segInput = `[${idx}:v]`;
  let segBase = clip.in;
  if (stab?.method === 'vidstab') {
    const trf = stabTrf?.get(idx);
    if (!trf) {
      throw new Error(
        `clip ${clip.id}: vidstab .trf not prepared; call prepareStabilization first`,
      );
    }
    chains.push(
      `[${idx}:v]trim=start=${clip.in}:end=${clip.out},setpts=PTS-STARTPTS,` +
        `${vidstabTransformFilter(trf, stab)}[vstb${idx}]`,
    );
    segInput = `[vstb${idx}]`;
    segBase = 0;
  }

  const segments = clip.reverse
    ? speedCurveSegments(clip).slice().reverse()
    : speedCurveSegments(clip);
  const reverseTail = clip.reverse ? ',reverse,setpts=N/FRAME_RATE/TB' : '';
  if (segments.length === 1) {
    const seg = segments[0];
    chains.push(
      `${segInput}trim=start=${segBase + seg.start}:end=${segBase + seg.end},` +
        `setpts=(PTS-STARTPTS)/${seg.speed}${reverseTail}[vb${idx}]`,
    );
  } else {
    const outs = segments.map((seg, j) => {
      chains.push(
        `${segInput}trim=start=${segBase + seg.start}:end=${segBase + seg.end},` +
          `setpts=(PTS-STARTPTS)/${seg.speed}${reverseTail}[vs${idx}_${j}]`,
      );
      return `[vs${idx}_${j}]`;
    });
    chains.push(`${outs.join('')}concat=n=${segments.length}:v=1:a=0[vb${idx}]`);
  }

  // Stabilisation, deshake path (single-pass, no .trf): apply to the
  // assembled clip stream before the freeze stage.
  baseLabel = `[vb${idx}]`;
  if (stab?.method === 'deshake') {
    chains.push(`[vb${idx}]${deshakeFilter(stab)}[vds${idx}]`);
    baseLabel = `[vds${idx}]`;
  }

  // Freeze stage: hold the frame at output time freezeAt for freezeDuration.
  // pre + frozen frame (loop) + post, concatenated back into one stream.
  if (clip.freezeAt !== undefined) {
    const F = clip.freezeAt;
    const fd = clip.freezeDuration ?? 1;
    const D = clipBaseDuration(clip);
    const frames = Math.max(1, Math.round(fd * fps));
    const parts: string[] = [];
    if (F > 0) {
      chains.push(`${baseLabel}trim=start=0:end=${F},setpts=PTS-STARTPTS[vpre${idx}]`);
      parts.push(`[vpre${idx}]`);
    }
    chains.push(
      `${baseLabel}trim=start=${F}:end=${F + 1 / fps},setpts=N/FRAME_RATE/TB,` +
        `loop=loop=${frames - 1}:size=1:start=0,setpts=N/FRAME_RATE/TB[vfrz${idx}]`,
    );
    parts.push(`[vfrz${idx}]`);
    if (D - F > 0.001) {
      chains.push(`${baseLabel}trim=start=${F}:end=${D},setpts=PTS-STARTPTS[vpost${idx}]`);
      parts.push(`[vpost${idx}]`);
    }
    chains.push(`${parts.join('')}concat=n=${parts.length}:v=1:a=0[vbf${idx}]`);
    baseLabel = `[vbf${idx}]`;
  }
  }

  const baseParts: string[] = [
    `${baseLabel}scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${fps}`,
  ];
  chains.push(baseParts.join(',') + `[vbs${idx}]`);

  // Shape-mask PiP (P1): composite first, then zoom/rotation/colour act as
  // camera effects on the composited frame. Without a mask this is a no-op.
  let picLabel = `[vbs${idx}]`;
  if (clip.mask && maskCtx) {
    picLabel = applyMaskStage(chains, picLabel, clip, idx, project, maskCtx);
  }

  // Chroma-key stage (P1): key the foreground to alpha and composite it
  // over the background (colour source, video/image input, or black).
  // Runs after the mask stage so zoom/rotation/colour act as camera
  // effects on the composited frame, same as the mask stage.
  if (clip.chromaKey) {
    picLabel = applyChromaStage(chains, picLabel, clip, idx, project, maskCtx);
  }

  // Smart portrait cutout (P1): same composite pattern as chroma-key,
  // but the alpha comes from the pre-computed ONNX mask video instead of
  // a key colour. Runs after the chroma stage; a clip cannot have both
  // (validatePortraitCutout throws), so the stages never stack.
  if (clip.portraitCutout) {
    picLabel = applyPortraitStage(chains, picLabel, clip, idx, project, maskCtx);
  }

  const parts: string[] = [picLabel];
  const zoom = clip.zoom ?? [];
  if (zoom.length >= 2) {
    // Animated zoom = scale up with a time-varying factor, then crop a
    // fixed-size window whose position follows the zoom centre.
    // (crop w/h cannot be animated — crop has no eval=frame — so the
    // zoom factor lives in scale=eval=frame, and crop x/y animate.)
    const sExpr = lerpExpr(zoom, (k) => k.scale);
    const cxExpr = lerpExpr(zoom, (k) => k.cx);
    const cyExpr = lerpExpr(zoom, (k) => k.cy);
    parts.push(
      `scale=eval=frame:w='iw*(${sExpr})':h='ih*(${sExpr})'`,
      `crop=w=${width}:h=${height}:x='(iw-ow)*(${cxExpr})':y='(ih-oh)*(${cyExpr})'`,
    );
  }
  const rotation = clip.rotation ?? [];
  if (rotation.length >= 1) {
    const degExpr = lerpExpr(rotation, (k: Keyframe<number>) => k.value);
    parts.push(`rotate=angle='(${degExpr})*PI/180':fillcolor=black`);
  }
  const color = clip.color;
  if (color) {
    const eqParts: string[] = [];
    if (color.brightness !== undefined) eqParts.push(`brightness=${color.brightness}`);
    if (color.contrast !== undefined) eqParts.push(`contrast=${color.contrast}`);
    if (color.saturation !== undefined) eqParts.push(`saturation=${color.saturation}`);
    if (eqParts.length > 0) parts.push(`eq=${eqParts.join(':')}`);
    if (color.temperature !== undefined && color.temperature !== 0) {
      const t = Math.max(-1, Math.min(1, color.temperature));
      parts.push(`colorbalance=rs=${t}:gs=0:bs=${-t}`);
    }
  }
  // Advanced colour (P2): baked 3D LUT(s) from export prep, applied
  // after the P0 eq/colorbalance stage. Generated LUT first, imported
  // .cube second; the project preset LUT (param `lut`) still applies
  // last. A clip with advancedColor but no prepared LUT is a hard
  // error — call prepareColorLuts first (export.ts does this).
  if (clip.advancedColor) {
    validateAdvancedColor(clip.advancedColor, clip.id);
    const luts = colorLuts?.get(idx);
    if (!luts) {
      throw new Error(
        `clip ${clip.id}: advanced colour LUT not prepared; call prepareColorLuts first`,
      );
    }
    for (const p of luts) parts.push(lut3dFilter(p));
  }
  if (lut) parts.push(`lut3d=${lut}`);
  const textFilters = (clip.text ?? []).map((t) => drawtextFilter(t, fontfile));
  // Clip-level subtitles (clip-local output time, lower-third style unless
  // the clip carries its own subtitleStyle, e.g. from a talk preset).
  if (clip.subtitles && clip.subtitles.length > 0) {
    textFilters.push(
      ...subtitlesToTextOverlays(
        clip.subtitles,
        clip.subtitleStyle ?? TEXT_PRESETS.lowerThird,
      ).map((t) => drawtextFilter(t, fontfile)),
    );
  }

  // parts[0] is the input label, parts[1..] are the tail filters. A chain
  // with no tail filter still needs a filter (null) between the labels.
  const tailFilters = parts.slice(1);
  const picChain =
    tailFilters.length > 0 ? `${parts[0]}${tailFilters.join(',')}` : `${parts[0]}null`;

  const opacity = clip.opacity ?? [];
  if (opacity.length >= 1) {
    // Single video track: there is nothing underneath to reveal, so opacity
    // is a fade toward black. Implemented with split + black branch + blend:
    // out = A*o + B*(1-o). Verified ffmpeg 8.1 (YAVG 121.5 -> 47.3 at o=0.3,
    // expected 16+(121.5-16)*0.3 = 47.6).
    // Rejected alternatives, all verified: eq's expression is evaluated once
    // at init (no per-frame change) and pivots on mid-grey, not black;
    // colorchannelmixer rejects expressions outright; geq not used per spec.
    chains.push(picChain + `[vo${idx}]`);
    const oExpr = lerpExpr(opacity, (k: Keyframe<number>) => k.value, 'T');
    chains.push(`[vo${idx}]split[va${idx}][vbk${idx}]`);
    chains.push(`[vbk${idx}]drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill[blk${idx}]`);
    chains.push(
      `[va${idx}][blk${idx}]blend=all_expr='A*(${oExpr})+B*(1-(${oExpr}))'[vop${idx}]`,
    );
    if (textFilters.length > 0) {
      chains.push(`[vop${idx}]${textFilters.join(',')}[v${idx}]`);
    } else {
      chains.push(`[vop${idx}]null[v${idx}]`);
    }
    return chains;
  }
  chains.push(
    picChain + (textFilters.length > 0 ? `,${textFilters.join(',')}` : '') + `[v${idx}]`,
  );
  return chains;
}

/**
 * Background chain shared by the chroma-key and portrait stages: a solid
 * colour source, a video/image input, or black. `tag` is 'ck' (chroma) or
 * 'pc' (portrait); the filter strings are identical for both, only the
 * label prefix differs. Returns the background label, e.g. `[ckbg0]`.
 */
function buildBackgroundChain(
  chains: string[],
  bg: { color?: string; source?: string } | undefined,
  idx: number,
  project: Project,
  ctx?: MaskCtx,
  tag = 'ck',
): string {
  const { width, height, fps } = project;
  const dur = clipDuration(project.clips[idx]);
  if (bg?.source) {
    const inputIdx = ctx?.bgInputIndex.get(idx);
    if (inputIdx === undefined) {
      throw new Error(`clip ${project.clips[idx].id}: no input for background source`);
    }
    const isImage = /\.(png|jpe?g|webp|bmp)$/i.test(bg.source);
    const loopPart = isImage ? 'loop=loop=-1:size=1:start=0,' : '';
    chains.push(
      `[${inputIdx}:v]${loopPart}trim=start=0:end=${dur},setpts=PTS-STARTPTS,` +
        `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height},fps=${fps},format=yuv420p[${tag}bg${idx}]`,
    );
  } else {
    const color = bg?.color ?? 'black';
    chains.push(
      `color=c=${color}:s=${width}x${height}:r=${fps}:d=${dur}[${tag}bg${idx}]`,
    );
  }
  return `[${tag}bg${idx}]`;
}

/**
 * Smart portrait cutout stage (P1). Input is the full-frame clip picture;
 * output is the person composited over the background. The alpha comes
 * from the pre-computed mask video (grayscale, full project size):
 * fps brings it to project fps (it may be sampled), format=gray takes
 * the luma as alpha, optional gblur softens the edge. The foreground is
 * made yuva420p and merged with the mask via alphamerge, then overlaid
 * on the background — same composite as the chroma stage.
 */
function applyPortraitStage(
  chains: string[],
  input: string,
  clip: Clip,
  idx: number,
  project: Project,
  ctx?: MaskCtx,
): string {
  const cutout = clip.portraitCutout as NonNullable<Clip['portraitCutout']>;
  validatePortraitCutout(cutout, clip);
  const { fps } = project;
  const maskIdx = ctx?.portraitInputIndex.get(idx);
  if (maskIdx === undefined) {
    throw new Error(
      `clip ${clip.id}: portrait mask video not prepared; call preparePortraitMasks first`,
    );
  }
  const feather = cutout.edgeFeather ?? 0;
  const blurPart = feather > 0 ? `,gblur=sigma=${feather}` : '';
  chains.push(
    `[${maskIdx}:v]fps=fps=${fps},format=gray${blurPart}[pmk${idx}]`,
  );
  chains.push(`${input}format=yuva420p[pcfg${idx}]`);
  chains.push(`[pcfg${idx}][pmk${idx}]alphamerge[pcfm${idx}]`);
  const bgLabel = buildBackgroundChain(chains, cutout.background, idx, project, ctx, 'pc');
  chains.push(`${bgLabel}[pcfm${idx}]overlay=0:0,format=yuv420p[pcout${idx}]`);
  return `[pcout${idx}]`;
}

/**
 * Chroma-key stage (P1). Input is the full-frame clip picture; output is
 * the keyed foreground composited over the background. The keyed area is
 * genuinely transparent (yuva420p) between chromakey and overlay — a
 * standalone chromakey -> PNG check in verify-p1b confirms alpha ~0 in
 * the green area. No background = solid black (MP4 has no alpha channel,
 * so transparency must land on something).
 */
function applyChromaStage(
  chains: string[],
  input: string,
  clip: Clip,
  idx: number,
  project: Project,
  ctx?: MaskCtx,
): string {
  const key = clip.chromaKey as NonNullable<Clip['chromaKey']>;
  validateChromaKey(key, clip.id);
  const similarity = key.similarity ?? 0.1;
  const blend = key.blend ?? 0;
  const despill = key.despill ?? true;
  const despillPart = despill ? `,despill=type=${despillType(key.color)}` : '';
  chains.push(
    `${input}format=yuva420p,` +
      `chromakey=color=${key.color}:similarity=${similarity}:blend=${blend}` +
      `${despillPart}[ckfg${idx}]`,
  );
  const bgLabel = buildBackgroundChain(chains, key.background, idx, project, ctx, 'ck');
  chains.push(`${bgLabel}[ckfg${idx}]overlay=0:0,format=yuv420p[ckout${idx}]`);
  return `[ckout${idx}]`;
}

/**
 * Shape-mask picture-in-picture stage (P1). Input is the full-frame clip
 * picture; output is the same frame with a masked, scaled copy overlaid
 * at the mask position. The background is the clip picture itself
 * (optionally blurred); the foreground is a cropped, scaled copy of it
 * with the pre-generated PNG mask as alpha (alphaextract + alphamerge).
 * Mask PNGs are still images; framesync repeats their last frame, so one
 * PNG covers a whole segment (verified 2026-11-16, mask-test2.mp4).
 * Keyframed masks split the stream at the keyframe times, one PNG per
 * segment, then concat back — same segment pattern as speed curves.
 * Returns the output label. Throws if a needed PNG was not prepared.
 */
function applyMaskStage(
  chains: string[],
  input: string,
  clip: Clip,
  idx: number,
  project: Project,
  ctx: MaskCtx,
): string {
  const mask = clip.mask as NonNullable<Clip['mask']>;
  const files = ctx.maskFiles?.get(idx) ?? [];
  const segments = maskSegments(mask, clipDuration(clip));
  if (files.length < segments.length) {
    throw new Error(
      `clip ${clip.id}: mask PNGs not prepared (${files.length} files for ` +
        `${segments.length} segments); call prepareClipMaskFiles first`,
    );
  }
  const { width, height } = project;

  // Multi-segment (keyframed shape): split the stream once, trim each
  // branch to its segment. Single segment uses the input directly.
  if (segments.length > 1) {
    chains.push(
      `${input}split=${segments.length}${segments.map((_, k) => `[msp${idx}_${k}]`).join('')}`,
    );
  }

  const outs: string[] = [];
  segments.forEach((seg, j) => {
    const inputIdx = ctx.inputIndex.get(`${idx}:${seg.fileIndex}`);
    if (inputIdx === undefined) {
      throw new Error(`clip ${clip.id}: no input for mask segment ${j}`);
    }
    const { x, y, pxW, pxH } = maskOverlayPos(mask, width, height, seg.shape);
    let segIn = input;
    if (segments.length > 1) {
      chains.push(
        `[msp${idx}_${j}]trim=start=${seg.t0}:end=${seg.t1},setpts=PTS-STARTPTS[mseg${idx}_${j}]`,
      );
      segIn = `[mseg${idx}_${j}]`;
    }
    chains.push(`${segIn}split[mbg${idx}_${j}][mfg${idx}_${j}]`);
    if (mask.backgroundBlur !== undefined && mask.backgroundBlur > 0) {
      chains.push(`[mbg${idx}_${j}]gblur=sigma=${mask.backgroundBlur}[mbgF${idx}_${j}]`);
    } else {
      chains.push(`[mbg${idx}_${j}]null[mbgF${idx}_${j}]`);
    }
    chains.push(
      `[mfg${idx}_${j}]scale=${pxW}:${pxH}:force_original_aspect_ratio=increase,` +
        `crop=${pxW}:${pxH},format=yuva420p[mfgF${idx}_${j}]`,
    );
    chains.push(`[${inputIdx}:v]alphaextract[malp${idx}_${j}]`);
    chains.push(`[mfgF${idx}_${j}][malp${idx}_${j}]alphamerge[mfgM${idx}_${j}]`);
    chains.push(
      `[mbgF${idx}_${j}][mfgM${idx}_${j}]overlay=${x}:${y},format=yuv420p[mout${idx}_${j}]`,
    );
    outs.push(`[mout${idx}_${j}]`);
  });
  if (outs.length === 1) return outs[0];
  chains.push(`${outs.join('')}concat=n=${outs.length}:v=1:a=0[vmkc${idx}]`);
  return `[vmkc${idx}]`;
}

function atempoChain(speed: number): string {
  // atempo accepts 0.5..100 per filter; chain for values outside that.
  const factors: number[] = [];
  let s = speed;
  while (s > 2) {
    factors.push(2);
    s /= 2;
  }
  while (s < 0.5) {
    factors.push(0.5);
    s /= 0.5;
  }
  factors.push(Number(s.toFixed(4)));
  return factors.map((f) => `atempo=${f}`).join(',');
}

/**
 * Audio chains for one clip. Final audio label is [a<idx>].
 * Order: segment trim/speed (+areverse) -> freeze stage (silent span)
 * -> audio-shift -> afade in/out -> audioFx (voice -> beautify -> EQ
 * -> compressor) -> afftdn -> loudnorm -> sidechaincompress (ducking)
 * -> volume -> gainDb (clip trim).
 * The freeze span is silence built from a muted 10 ms slice of the clip
 * itself (apad), so sample rate / channel layout always match.
 * Ducking sits AFTER loudnorm on purpose: loudnorm after ducking would
 * re-normalise the ducked passages and undo the effect. The sidechain
 * source is a control signal only (never mixed into the output).
 * gainDb (-30..+30 dB, audiofx.ts) also sits after loudnorm/ducking,
 * next to the static volume: it is a trim, and loudnorm before it
 * would eat it. Voice pitch sits after the speed/reverse segment
 * stage (the audioFx block is downstream of it), so asetrate/atempo
 * never sees a mid-chain sample-rate change.
 */
function clipAudioChains(clip: Clip, idx: number, ctx?: MaskCtx): string[] {
  const chains: string[] = [];
  // Multicam (P2): audio comes from one angle only (audioAngle, default
  // 0) for the whole clip — the angle switches are video-only. Angle 0
  // is the clip's own input; other angles are extra inputs.
  const mc = validateMulticam(clip);
  let audioInputIdx = idx;
  if (mc) {
    if (!ctx) {
      throw new Error(`clip ${clip.id}: multicam needs the graph context`);
    }
    audioInputIdx = multicamAngleInputIndex(ctx, idx, mc.audioAngle ?? 0);
  }
  const segments = clip.reverse
    ? speedCurveSegments(clip).slice().reverse()
    : speedCurveSegments(clip);
  const reverseTail = clip.reverse ? ',areverse,asetpts=PTS-STARTPTS' : '';
  if (segments.length === 1) {
    const seg = segments[0];
    chains.push(
      `[${audioInputIdx}:a]atrim=start=${clip.in + seg.start}:end=${clip.in + seg.end},` +
        `asetpts=PTS-STARTPTS,${atempoChain(seg.speed)}${reverseTail}[ab${idx}]`,
    );
  } else {
    const outs = segments.map((seg, j) => {
      chains.push(
        `[${audioInputIdx}:a]atrim=start=${clip.in + seg.start}:end=${clip.in + seg.end},` +
          `asetpts=PTS-STARTPTS,${atempoChain(seg.speed)}${reverseTail}[as${idx}_${j}]`,
      );
      return `[as${idx}_${j}]`;
    });
    chains.push(`${outs.join('')}concat=n=${segments.length}:v=0:a=1[ab${idx}]`);
  }

  let audioBase = `[ab${idx}]`;
  if (clip.freezeAt !== undefined) {
    const F = clip.freezeAt;
    const fd = clip.freezeDuration ?? 1;
    const D = clipBaseDuration(clip);
    const parts: string[] = [];
    if (F > 0) {
      chains.push(`[ab${idx}]atrim=start=0:end=${F},asetpts=PTS-STARTPTS[apre${idx}]`);
      parts.push(`[apre${idx}]`);
    }
    chains.push(
      `[ab${idx}]atrim=start=0:end=0.01,asetpts=PTS-STARTPTS,` +
        `volume=0,apad=whole_dur=${fd}[asil${idx}]`,
    );
    parts.push(`[asil${idx}]`);
    if (D - F > 0.001) {
      chains.push(`[ab${idx}]atrim=start=${F}:end=${D},asetpts=PTS-STARTPTS[apost${idx}]`);
      parts.push(`[apost${idx}]`);
    }
    chains.push(`${parts.join('')}concat=n=${parts.length}:v=0:a=1[abf${idx}]`);
    audioBase = `[abf${idx}]`;
  }

  const dur = clipDuration(clip);
  // AV alignment shift (P1): applied to the assembled output-time
  // audio, before fades/denoise/loudnorm/ducking — those are defined
  // on the output timeline, so they see the shifted audio. The shift
  // keeps the total duration (adelay+trim for a delay, cut+apad for
  // an advance); see audioShiftFilter in align.ts.
  const shift = validateAudioOffset(clip);
  if (shift !== undefined && shift !== 0) {
    chains.push(`${audioBase}${audioShiftFilter(shift, dur)}[ash${idx}]`);
    audioBase = `[ash${idx}]`;
  }
  const preDuck: string[] = [];
  if (clip.audioFadeIn !== undefined && clip.audioFadeIn > 0) {
    preDuck.push(`afade=t=in:st=0:d=${Math.min(clip.audioFadeIn, dur)}`);
  }
  if (clip.audioFadeOut !== undefined && clip.audioFadeOut > 0) {
    const d = Math.min(clip.audioFadeOut, dur);
    preDuck.push(`afade=t=out:st=${Math.max(0, dur - d)}:d=${d}`);
  }
  // P3 audio effects (audiofx.ts): voice effects first (after
  // speed/reverse by construction), then beautify, EQ, compressor —
  // all before denoise/loudnorm, so the EQ band ratios survive
  // loudnorm (measured 2026-11-17: +6 dB @3000 Hz reads +5.86 dB
  // after loudnorm). gainDb is applied after ducking, with volume.
  const fx = validateAudioFx(clip.audioFx, clip.id);
  const fxChain = fx ? audioFxFilter(fx) : '';
  if (fxChain) preDuck.push(fxChain);
  const gainDb = fx?.gainDb;
  if (clip.denoise) preDuck.push('afftdn');
  // loudnorm single-pass (linear=true is the default); no two-pass measurement.
  if (clip.loudnorm) preDuck.push('loudnorm=I=-16:TP=-1.5:LRA=11:linear=true');
  const duck = validateDucking(clip);
  if (duck) {
    const scIdx = ctx?.duckInputIndex.get(idx);
    if (scIdx === undefined) {
      throw new Error(`clip ${clip.id}: no input for ducking source`);
    }
    chains.push(
      `${audioBase}${preDuck.length > 0 ? preDuck.join(',') : 'anull'}[ad${idx}]`,
    );
    chains.push(`[ad${idx}][${scIdx}:a]${duckingFilter(duck)}[adc${idx}]`);
    chains.push(
      `[adc${idx}]volume=${clip.volume}${gainDb !== undefined ? `,volume=${gainDb}dB` : ''}[a${idx}]`,
    );
    return chains;
  }
  const audioFilters = [...preDuck, `volume=${clip.volume}`];
  if (gainDb !== undefined) audioFilters.push(`volume=${gainDb}dB`);
  chains.push(`${audioBase}${audioFilters.join(',')}[a${idx}]`);
  return chains;
}

export function buildFilterGraph(
  project: Project,
  fontfile: string,
  lut?: string,
  assFile?: string,
  maskFiles?: Map<number, string[]>,
  stabilizeTrf?: Map<number, string>,
  portraitMasks?: Map<number, string>,
  colorLuts?: Map<number, string[]>,
  /** clip index -> probed audio channel count (prepareRoleAudio);
   *  only used when the project uses roles. Absent = stereo variant. */
  roleAudioChannels?: Map<number, number>,
  /** Also assemble one stem per role (in addition to the mix). */
  roleStems?: boolean,
): FilterGraph {
  const n = project.clips.length;
  if (n === 0) throw new Error('project has no clips');
  // A compound clip that reaches the graph unresolved is a caller bug:
  // export.ts resolves them (rendering the child first) before the graph
  // build. Fail here with a clear message instead of emitting a graph
  // that references an empty source path.
  project.clips.forEach((clip) => {
    if (clip.compound) {
      throw new Error(
        `clip ${clip.id}: compound project not resolved; call resolveCompoundClips first`,
      );
    }
  });
  // Assign ffmpeg input indexes to mask PNGs (after the clip inputs),
  // then to chroma-key / portrait background sources.
  const maskCtx: MaskCtx = {
    maskFiles,
    portraitMaskFiles: portraitMasks,
    extraInputs: [],
    inputIndex: new Map(),
    bgInputIndex: new Map(),
    duckInputIndex: new Map(),
    portraitInputIndex: new Map(),
    multicamInputIndex: new Map(),
  };
  project.clips.forEach((clip, i) => {
    if (!clip.mask) return;
    const files = maskFiles?.get(i) ?? [];
    files.forEach((f, j) => {
      maskCtx.inputIndex.set(`${i}:${j}`, n + maskCtx.extraInputs.length);
      maskCtx.extraInputs.push(f);
    });
  });
  project.clips.forEach((clip, i) => {
    const src = clip.chromaKey?.background?.source ?? clip.portraitCutout?.background?.source;
    if (!src) return;
    maskCtx.bgInputIndex.set(i, n + maskCtx.extraInputs.length);
    maskCtx.extraInputs.push(src);
  });
  project.clips.forEach((clip, i) => {
    const src = clip.ducking?.source;
    if (!src) return;
    maskCtx.duckInputIndex.set(i, n + maskCtx.extraInputs.length);
    maskCtx.extraInputs.push(src);
  });
  project.clips.forEach((clip, i) => {
    const file = portraitMasks?.get(i);
    if (!file) return;
    maskCtx.portraitInputIndex.set(i, n + maskCtx.extraInputs.length);
    maskCtx.extraInputs.push(file);
  });
  // Multicam angles: angle 0 is the clip's own input (clip.source), so
  // only angles 1.. are registered here as extra inputs. Shape errors
  // fail fast here, before any chain is built.
  project.clips.forEach((clip, i) => {
    const mc = clip.multicam;
    if (!mc) return;
    validateMulticam(clip);
    mc.angles.slice(1).forEach((a, j) => {
      maskCtx.multicamInputIndex.set(`${i}:${j + 1}`, n + maskCtx.extraInputs.length);
      maskCtx.extraInputs.push(a);
    });
  });
  const chains: string[] = [];
  project.clips.forEach((clip, i) => {
    chains.push(...clipVideoChains(clip, i, project, fontfile, lut, maskCtx, stabilizeTrf, colorLuts));
    chains.push(...clipAudioChains(clip, i, maskCtx));
  });

  // Roles (P2): per-clip gain/pan/mute/solo on the clip audio
  // ([a<i>] -> [ar<i>]), applied after the clip's own audio chain so
  // fades/denoise/loudnorm/ducking/volume all still act first. When no
  // role is used anywhere this whole block is skipped and the graph
  // below is byte-identical to the pre-Roles build.
  const useRoles = rolesInUse(project);
  let roleConfigs: Map<string, ResolvedRoleConfig> | undefined;
  if (useRoles) {
    validateRoles(project);
    roleConfigs = resolveRoleConfigs(project);
    project.clips.forEach((clip, i) => {
      const name = roleOfClip(clip);
      const cfg = roleConfigs?.get(name);
      if (!cfg) {
        throw new Error(`clip ${clip.id}: no config resolved for role "${name}"`);
      }
      const muted = effectiveMute(name, roleConfigs as Map<string, ResolvedRoleConfig>);
      chains.push(`[a${i}]${roleFilter(cfg, muted, roleAudioChannels?.get(i))}[ar${i}]`);
    });
  }
  // Role stems (roleStems only): the role chain above already
  // normalised every [ar<i>] to 48 kHz stereo (see roles.ts). The mix
  // and the stems must NOT share [ar<i>] directly — a filter output
  // feeding two downstream filters without an explicit split costs
  // exactly 3 dB in the second consumer (measured 2026-11-17, see
  // roles.ts header). So each [ar<i>] is split once: [arm<i>] for the
  // mix + one [ars<i>_<j>] per stem. The stem order (first-appearance
  // role order) is computed here because the split count depends on it.
  if (roleStems) {
    if (!useRoles) {
      throw new Error('roleStems requested but the project uses no roles');
    }
    const stemRoles: string[] = [];
    for (const clip of project.clips) {
      const name = roleOfClip(clip);
      if (!stemRoles.includes(name)) stemRoles.push(name);
    }
    project.clips.forEach((clip, i) => {
      // Each clip feeds exactly two consumers: the mix and its own
      // role's stem (other stems use silence for this clip), so the
      // split has exactly 2 outputs — every asplit output must be
      // consumed, or FFmpeg rejects the graph.
      const j = stemRoles.indexOf(roleOfClip(clip));
      chains.push(`[ar${i}]asplit=2[arm${i}][ars${i}_${j}]`);
    });
  }

  const hasXfade = project.transitions.some((t) => t !== 'cut');
  let videoOut = '[vout]';
  let audioOut = '[aout]';
  const durations = project.clips.map((c) => clipDuration(c));
  // Mix inputs: role-processed audio when roles are in use — [arm<i>]
  // (the asplit mix branch) with stems, [ar<i>] without — else the
  // plain clip audio [a<i>] (unchanged from before Roles).
  const mixInputs = project.clips.map((_, i) =>
    useRoles ? (roleStems ? `[arm${i}]` : `[ar${i}]`) : `[a${i}]`,
  );

  if (!hasXfade) {
    const vInputs = project.clips.map((_, i) => `[v${i}]`).join('');
    chains.push(`${vInputs}concat=n=${n}:v=1:a=0[vout]`);
  } else {
  // Chained xfade. Offset of the k-th transition (0-based) is the
  // accumulated timeline duration before clip k+1, minus the overlaps already
  // applied (each non-cut transition overlaps transitionDuration).
  const d = project.transitionDuration;
  let vPrev = '[v0]';
  let acc = clipDuration(project.clips[0]);
  project.clips.slice(1).forEach((_, k) => {
    const type = project.transitions[k];
    const vNext = `[v${k + 1}]`;
    if (type !== 'cut') {
      const offset = Math.max(0, acc - d);
      const vX = k === project.clips.length - 2 ? '[vout]' : `[vx${k}]`;
      chains.push(
        `${vPrev}${vNext}xfade=transition=${XFADE_TRANSITIONS[type]}:duration=${d}:offset=${offset}${vX}`,
      );
      vPrev = vX;
      acc = acc + clipDuration(project.clips[k + 1]) - d;
    } else {
      const vC = k === project.clips.length - 2 ? '[vout]' : `[vc${k}]`;
      chains.push(`${vPrev}${vNext}concat=n=2:v=1:a=0${vC}`);
      vPrev = vC;
      acc = acc + clipDuration(project.clips[k + 1]);
    }
  });
  }
  // Audio assembly (mix): same offsets as the video xfade chain.
  chains.push(
    ...audioAssemblyChains(mixInputs, project.transitions, durations, project.transitionDuration, '[aout]', 'a'),
  );

  // Role stems (roleStems only): one assembled timeline per role, in
  // first-appearance order, with every other role replaced by silence
  // (anullsrc, 48 kHz stereo, same length as the clip it replaces).
  // Silence is emitted per (clip, stem) pair so each label is consumed
  // exactly once.
  let audioStems: Map<string, string> | undefined;
  if (roleStems) {
    audioStems = new Map<string, string>();
    const stemRoles: string[] = [];
    for (const clip of project.clips) {
      const name = roleOfClip(clip);
      if (!stemRoles.includes(name)) stemRoles.push(name);
    }
    stemRoles.forEach((roleName, j) => {
      const stemLabel = `[stem${j}]`;
      audioStems?.set(roleName, stemLabel);
      const inputs = project.clips.map((clip, i) => {
        if (roleOfClip(clip) === roleName) return `[ars${i}_${j}]`;
        chains.push(`anullsrc=r=48000:cl=stereo:d=${durations[i]}[sil${i}_${j}]`);
        return `[sil${i}_${j}]`;
      });
      chains.push(
        ...audioAssemblyChains(
          inputs, project.transitions, durations, project.transitionDuration, stemLabel, `s${j}`,
        ),
      );
    });
  }

  // Master gain (P3, audiofx.ts): a trim on the final MIX only —
  // role stems above are untouched. It sits after assembly (and
  // therefore after loudnorm/ducking), so it cannot be eaten by
  // loudnorm. Range -30..+30 dB, same as the clip gain trim.
  validateMasterGainDb(project.masterGainDb);
  if (project.masterGainDb !== undefined && project.masterGainDb !== 0) {
    chains.push(`[aout]volume=${project.masterGainDb}dB[aoutm]`);
    audioOut = '[aoutm]';
  }

  // Project-level subtitles: karaoke word highlight via the ASS filter,
  // applied once to the assembled timeline (project time).
  if (assFile) {
    const quoted = `'${assFile.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")}'`;
    chains.push(`[vout]ass=${quoted}[vsub]`);
    videoOut = '[vsub]';
  }
  return { filterComplex: chains.join(';'), videoOut, audioOut, extraInputs: maskCtx.extraInputs, audioStems };
}
