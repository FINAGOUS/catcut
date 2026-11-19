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
  hasTracks,
  projectDuration,
  resolveTransitions,
  speedCurveSegments,
  type Clip,
  type Keyframe,
  type Project,
  type TransitionType,
  type ZoomKeyframe,
} from './project.js';
import {
  TRACK_BLEND_MODES,
  flattenProject,
  resolveAudioTrackMute,
  validateMultitrackProject,
  type FlatClip,
} from './multitrack.js';
import { subtitlesToTextOverlays } from './subtitles.js';
import { hdrVideoFilter, type HdrMode } from './deliver.js';
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
  panGains,
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
  volumeKeysFilter,
} from './audiofx.js';
import {
  reframeCropFilter,
  validateSmartCut,
  type SubjectTrack,
} from './smartcut.js';
import {
  resolveTransitionDurations,
  validateTransitions,
} from './transitions.js';
import {
  beatFlashFilters,
  validateBeatFlash,
  validateBeatSpeed,
} from './beat.js';
import {
  beautyFilter,
  hqdn3dFilter,
  validateBeauty,
} from './beauty.js';
import {
  adjustmentLayerFilter,
  validateJLClip,
  validateTimelineProject,
} from './timeline.js';
import {
  minterpolateFilter,
  validateFrameInterp,
} from './frameinterp.js';
import {
  repairFilter,
  validateAudioRepair,
} from './audiorepair.js';
import {
  cloneLaneSize,
  inputColorConversion,
  objectTrackDrawtextFilter,
  outlineDilationFilter,
  outputColorTag,
  parseOutlineColor,
  validateClipColorManagement,
  validateCloneEffect,
  validateColorMatch,
  validateGradeNodes,
  validateKeyOutline,
  validateObjectTrack,
  validateProjectColorManagement,
  validateTrackedWindow,
  type GradeNodeStage,
  type P3gGraphInputs,
  type TrackedWindowFiles,
} from './p3g.js';
import {
  surroundUpmixFilter,
  validateSurroundLayout,
  type SurroundLayout,
} from './surround.js';
import type { TtsNarration } from './tts.js';

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
  transitionDurations: number[],
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
  let aPrev = inputs[0];
  let acc = durations[0];
  inputs.slice(1).forEach((next, k) => {
    const type = transitions[k];
    const isLast = k === n - 2;
    if (type !== 'cut') {
      // W10: per-junction duration — the acrossfade overlap matches the
      // video xfade overlap for this junction (same offset math).
      const d = transitionDurations[k];
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

/**
 * Multitrack assembly (video + audio). Video: each track's own
 * timeline is assembled first (sequential walk with concat/xfade
 * — the same walk as the legacy assembly — with transparent gaps),
 * then the tracks are composited bottom-to-top onto a black canvas
 * of the project duration, one overlay/blend per track (track
 * opacity/geometry apply to the whole assembled track). The
 * composite is normalised to yuv420p at [vout]: nothing downstream
 * needs the alpha anymore.
 * Audio: each track's clips are assembled the same way (silence
 * gaps, acrossfade for overlapping clips with a transitionIn),
 * audio tracks then get their gain/pan/mute/solo, and all track
 * mixes are amixed together (normalize=0). A single track mix is
 * passed through with anull; no audio at all yields an anullsrc
 * of the project duration. Clip audio is normalised to 48 kHz
 * stereo before assembly (mono duplicated at full level — the
 * roles.ts measurement: aformat would cost 3 dB); role-processed
 * audio is already stereo and skips that step. All filters used
 * here (concat/xfade/acrossfade/geq/fade/overlay/blend/
 * colorchannelmixer/apad/amix/pan/volume) are native libavfilter
 * — only verified on the local GPL 8.1.2 build; re-check each on
 * the BtbN LGPL 9.0 build at the M2 gate.
 */
function assembleMultitrack(
  chains: string[],
  project: Project,
  flat: FlatClip[],
  audioLabel: (g: number) => string,
  roleAudioChannels: Map<number, number> | undefined,
  audioNormalized: boolean,
): { videoOut: string; audioOut: string } {
  const { width, height, fps } = project;
  const projDur = projectDuration(project);
  const byKey = new Map<string, FlatClip>();
  for (const f of flat) byKey.set(`${f.kind}:${f.trackIndex}:${f.clipIndex}`, f);

  // ---- video ----
  let videoOut = '[vout]';
  // Invisible video tracks render nothing, but their per-clip video
  // chains were still built — sink each [v<i>] or FFmpeg rejects
  // the graph ("output unconnected"). Their linked audio still
  // plays (audio assembly below includes every video track).
  (project.tracks?.video ?? []).forEach((track, ti) => {
    if (track.visible === false) {
      track.clips.forEach((clip, clipIndex) => {
        const f = byKey.get(`video:${ti}:${clipIndex}`);
        if (f) chains.push(`[v${f.globalIndex}]nullsink`);
      });
    }
  });
  const videoTracks = (project.tracks?.video ?? []).filter((t) => t.visible !== false);
  if (videoTracks.length === 0) {
    chains.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${projDur}[vout]`);
  } else {
    chains.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${projDur}[mtbase]`);
    let base = '[mtbase]';
    videoTracks.forEach((track, ti) => {
      base = compositeVideoTrack(chains, project, track, ti, byKey, base, projDur);
    });
    chains.push(`${base}format=yuv420p[vout]`);
  }

  // ---- audio ----
  const trackAudioLabels: string[] = [];
  (project.tracks?.video ?? []).forEach((track, ti) => {
    const label = assembleTrackAudio(
      chains, track.clips, 'video', ti, byKey, audioLabel,
      roleAudioChannels, audioNormalized, projDur,
    );
    if (label) trackAudioLabels.push(label);
  });
  const muteMap = resolveAudioTrackMute(project);
  (project.tracks?.audio ?? []).forEach((track, ti) => {
    const label = assembleTrackAudio(
      chains, track.clips, 'audio', ti, byKey, audioLabel,
      roleAudioChannels, audioNormalized, projDur,
      {
        gainDb: track.gainDb ?? 0,
        pan: track.pan ?? 0,
        muted: muteMap.get(track.id) ?? false,
      },
    );
    if (label) trackAudioLabels.push(label);
  });
  let audioOut = '[aout]';
  if (trackAudioLabels.length === 0) {
    chains.push(`anullsrc=r=48000:cl=stereo:d=${projDur}[aout]`);
  } else if (trackAudioLabels.length === 1) {
    chains.push(`${trackAudioLabels[0]}anull[aout]`);
  } else {
    chains.push(
      `${trackAudioLabels.join('')}amix=inputs=${trackAudioLabels.length}:duration=first:normalize=0[aout]`,
    );
  }
  return { videoOut, audioOut };
}

/** Composite one video track onto `base`; returns the new base label.
 * The track's own timeline is assembled first (sequential walk with
 * concat/xfade — see assembleVideoTrackTimeline), then the whole
 * track is scaled/offset per its geometry and overlaid (normal) or
 * blended (blend modes, full-canvas only) onto the composite. The
 * assembled track is yuva420p with transparent gaps, so lower
 * tracks show through where this track has nothing. */
function compositeVideoTrack(
  chains: string[],
  project: Project,
  track: import('./project.js').VideoTrack,
  ti: number,
  byKey: Map<string, FlatClip>,
  base: string,
  projDur: number,
): string {
  const { width, height } = project;
  const opacity = track.opacity ?? 1;
  const blend = track.blend ?? 'normal';
  const x = track.x ?? 0;
  const y = track.y ?? 0;
  const wFrac = track.w ?? 1;
  const hFrac = track.h ?? 1;
  const trackLabel = assembleVideoTrackTimeline(chains, project, track, ti, byKey, projDur);
  let label = trackLabel;
  if (opacity < 1) {
    chains.push(`${label}colorchannelmixer=aa=${opacity}[mto${ti}]`);
    label = `[mto${ti}]`;
  }
  if (wFrac !== 1 || hFrac !== 1) {
    const sw = Math.max(1, Math.round(width * wFrac));
    const sh = Math.max(1, Math.round(height * hFrac));
    chains.push(`${label}scale=${sw}:${sh}[mts${ti}]`);
    label = `[mts${ti}]`;
  }
  if (blend === 'normal') {
    // No format= option: overlay's `format` only takes family
    // names (yuv420/yuv422/yuv444/rgb) — 'yuv420p' is rejected
    // ("Undefined constant"). Format negotiation keeps yuva420p
    // when the overlay input has alpha, which the chain needs.
    chains.push(`${base}${label}overlay=x=${x}:y=${y}:eof_action=pass[mtv${ti}]`);
    return `[mtv${ti}]`;
  }
  // Blend modes are RGB operations — blend runs on the pixel
  // format's planes, so on yuv420p 'multiply' multiplies luma/
  // chroma and red-over-green reads (0,89,0) instead of black
  // (measured 2026-11-19). Convert both sides to gbrp, blend,
  // convert back to yuva420p (opaque) for the next overlay.
  // Alpha is ignored on the blend path (documented).
  chains.push(`${base}format=gbrp[mtbg${ti}]`);
  chains.push(`${label}format=gbrp[mtcg${ti}]`);
  chains.push(`[mtbg${ti}][mtcg${ti}]blend=all_mode=${TRACK_BLEND_MODES[blend]}[mtbl${ti}]`);
  chains.push(`[mtbl${ti}]format=yuva420p[mtv${ti}]`);
  return `[mtv${ti}]`;
}

/**
 * Assemble one video track's own timeline to a single yuva420p
 * stream of the project duration. The walk mirrors the legacy
 * sequential assembly (concat for gaps/adjacent clips, xfade for
 * overlapping clips with a transitionIn, trim+concat hard cut for
 * overlapping clips without one), so a normalized legacy project
 * reproduces the legacy render exactly — including wipes and
 * fadeblack, which an overlay-only assembly cannot express. Gaps
 * are transparent black (alpha 0), so lower tracks show through.
 * A clip with a transitionIn that does NOT overlap the previous
 * same-track clip arrives over the LOWER tracks instead: its
 * alpha (fade/dissolve) or picture (fadeblack/fadewhite) is faded
 * in on clip-local time before assembly. Every clip stream is
 * normalised to yuva420p first — concat/xfade need matching
 * formats. `T` in the arrival geq is clip-local time (0 at the
 * clip start); `p(X,Y)` reads the current plane's pixel (the
 * input alpha in the alpha expression — geq has no `a(X,Y)`
 * accessor, probe 2026-11-19).
 */
function assembleVideoTrackTimeline(
  chains: string[],
  project: Project,
  track: import('./project.js').VideoTrack,
  ti: number,
  byKey: Map<string, FlatClip>,
  projDur: number,
): string {
  const { width, height, fps } = project;
  const clips = track.clips
    .map((clip, clipIndex) => ({ clip, clipIndex }))
    .sort((a, b) => a.clip.start - b.clip.start || a.clipIndex - b.clipIndex);
  const gapLabel = (dur: number, tag: string): string => {
    chains.push(`color=c=black@0:s=${width}x${height}:r=${fps}:d=${dur},format=yuva420p[${tag}]`);
    return `[${tag}]`;
  };
  if (clips.length === 0) return gapLabel(projDur, `mttr${ti}`);
  let acc = '';
  let accEnd = -Infinity;
  clips.forEach(({ clip, clipIndex }, k) => {
    const f = byKey.get(`video:${ti}:${clipIndex}`);
    if (!f) throw new Error(`video track "${track.id}": clip ${clip.id} not flattened`);
    const g = f.globalIndex;
    const dur = clipDuration(clip);
    const start = clip.start;
    chains.push(`[v${g}]format=yuva420p[mtn${g}]`);
    let label = `[mtn${g}]`;
    const overlaps = start < accEnd - 1e-9;
    const tr = clip.transitionIn;
    if (tr && !overlaps) {
      // Arrival over the lower tracks (no same-track neighbour to
      // crossfade with).
      if (tr.type === 'fadeblack' || tr.type === 'fadewhite') {
        const color = tr.type === 'fadeblack' ? 'black' : 'white';
        chains.push(`${label}fade=t=in:st=0:d=${tr.duration}:color=${color}[mtf${g}]`);
        label = `[mtf${g}]`;
      } else {
        chains.push(
          `${label}geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='p(X,Y)*min(1,max(0,T/${tr.duration}))'[mtf${g}]`,
        );
        label = `[mtf${g}]`;
      }
    }
    if (k === 0) {
      if (start > 1e-9) {
        const gap = gapLabel(start, `mtgap${g}`);
        chains.push(`${gap}${label}concat=n=2:v=1:a=0[mtacc${ti}_${k}]`);
        acc = `[mtacc${ti}_${k}]`;
      } else {
        acc = label;
      }
    } else if (!overlaps) {
      const gap = start - accEnd;
      if (gap > 1e-9) {
        const gapL = gapLabel(gap, `mtgap${g}`);
        chains.push(`${acc}${gapL}${label}concat=n=3:v=1:a=0[mtacc${ti}_${k}]`);
      } else {
        chains.push(`${acc}${label}concat=n=2:v=1:a=0[mtacc${ti}_${k}]`);
      }
      acc = `[mtacc${ti}_${k}]`;
    } else {
      const overlap = accEnd - start;
      if (tr) {
        // Same-track crossfade: xfade's offset is the clip's start
        // in the accumulated stream's timeline; the transition runs
        // [start, start+d]. The accumulated tail past start+d is
        // discarded by xfade — it sits under the new clip anyway.
        const d = Math.min(tr.duration, overlap);
        chains.push(
          `${acc}${label}xfade=transition=${XFADE_TRANSITIONS[tr.type]}:duration=${d}:offset=${start}[mtacc${ti}_${k}]`,
        );
      } else {
        // Hard cut: drop the overlapped tail of the accumulated
        // stream, then concat the new clip.
        chains.push(`${acc}trim=start=0:end=${start},setpts=PTS-STARTPTS[mttr${ti}_${k}]`);
        chains.push(`[mttr${ti}_${k}]${label}concat=n=2:v=1:a=0[mtacc${ti}_${k}]`);
      }
      acc = `[mtacc${ti}_${k}]`;
    }
    accEnd = start + dur;
  });
  if (projDur - accEnd > 1e-9) {
    const tail = gapLabel(projDur - accEnd, `mttail${ti}`);
    chains.push(`${acc}${tail}concat=n=2:v=1:a=0[mtt${ti}]`);
    acc = `[mtt${ti}]`;
  }
  return acc;
}

/**
 * Assemble one track's audio to a single label (project-duration
 * long, 48 kHz stereo) or undefined when the track has no clips.
 * The walk mirrors the video walk: silence gaps (anullsrc),
 * concat for adjacent clips, acrossfade for overlapping clips
 * with a transitionIn (video tracks only — the acrossfade takes
 * the tail of the first input, so the accumulated stream is
 * pre-trimmed to [0, start+d]), trim+concat hard cut for
 * overlapping clips without one. Same-track audio overlaps
 * hard-cut by design — to layer sounds, use separate tracks
 * (they mix in the global amix). `trackOpts` (audio tracks only):
 * gain/pan/mute — applied after the clips are mixed, so they act
 * on the whole track. Clip audio is normalised to 48 kHz stereo
 * before assembly (mono duplicated at full level — the roles.ts
 * measurement: aformat would cost 3 dB); role-processed audio is
 * already stereo and skips that step. Direct buildFilterGraph
 * callers without a channel map get the stereo variant (same
 * default as the role chain); export.ts always probes the map
 * for multitrack projects.
 */
function assembleTrackAudio(
  chains: string[],
  clips: (import('./project.js').VideoTrackClip | import('./project.js').AudioTrackClip)[],
  kind: 'video' | 'audio',
  ti: number,
  byKey: Map<string, FlatClip>,
  audioLabel: (g: number) => string,
  roleAudioChannels: Map<number, number> | undefined,
  audioNormalized: boolean,
  projDur: number,
  trackOpts?: { gainDb: number; pan: number; muted: boolean },
): string | undefined {
  const sorted = clips
    .map((clip, clipIndex) => ({ clip, clipIndex }))
    .sort((a, b) => a.clip.start - b.clip.start || a.clipIndex - b.clipIndex);
  if (sorted.length === 0) return undefined;
  const gapLabel = (dur: number, tag: string): string => {
    chains.push(`anullsrc=r=48000:cl=stereo:d=${dur}[${tag}]`);
    return `[${tag}]`;
  };
  let acc = '';
  let accEnd = -Infinity;
  sorted.forEach(({ clip, clipIndex }, k) => {
    const f = byKey.get(`${kind}:${ti}:${clipIndex}`);
    if (!f) throw new Error(`${kind} track ${ti}: clip ${clip.id} not flattened`);
    const g = f.globalIndex;
    const dur = clipDuration(clip);
    const start = clip.start;
    let label = audioLabel(g);
    if (!audioNormalized) {
      const ch = roleAudioChannels?.get(g);
      if (ch === 1) {
        chains.push(`${label}aresample=48000,pan=stereo|c0=c0|c1=c0[mtn${g}]`);
      } else {
        chains.push(`${label}aresample=48000[mtn${g}]`);
      }
      label = `[mtn${g}]`;
    }
    const overlaps = start < accEnd - 1e-9;
    const tr = (clip as import('./project.js').VideoTrackClip).transitionIn;
    if (k === 0) {
      if (start > 1e-9) {
        const gapL = gapLabel(start, `mtagap${g}`);
        chains.push(`${gapL}${label}concat=n=2:v=0:a=1[mtacc${kind}${ti}_${k}]`);
        acc = `[mtacc${kind}${ti}_${k}]`;
      } else {
        acc = label;
      }
    } else if (!overlaps) {
      const gap = start - accEnd;
      if (gap > 1e-9) {
        const gapL = gapLabel(gap, `mtagap${g}`);
        chains.push(`${acc}${gapL}${label}concat=n=3:v=0:a=1[mtacc${kind}${ti}_${k}]`);
      } else {
        chains.push(`${acc}${label}concat=n=2:v=0:a=1[mtacc${kind}${ti}_${k}]`);
      }
      acc = `[mtacc${kind}${ti}_${k}]`;
    } else {
      const overlap = accEnd - start;
      if (tr) {
        const d = Math.min(tr.duration, overlap);
        chains.push(`${acc}atrim=start=0:end=${start + d},asetpts=PTS-STARTPTS[mtatr${kind}${ti}_${k}]`);
        chains.push(`[mtatr${kind}${ti}_${k}]${label}acrossfade=d=${d}[mtacc${kind}${ti}_${k}]`);
      } else {
        chains.push(`${acc}atrim=start=0:end=${start},asetpts=PTS-STARTPTS[mtatr${kind}${ti}_${k}]`);
        chains.push(`[mtatr${kind}${ti}_${k}]${label}concat=n=2:v=0:a=1[mtacc${kind}${ti}_${k}]`);
      }
      acc = `[mtacc${kind}${ti}_${k}]`;
    }
    accEnd = start + dur;
  });
  // Pad the tail to the project duration (head gaps were concatted).
  chains.push(`${acc}apad=whole_dur=${projDur}[mtatail${kind}${ti}]`);
  let out = `[mtatail${kind}${ti}]`;
  if (trackOpts) {
    if (trackOpts.muted) {
      chains.push(`${out}volume=0[mtt${kind}${ti}]`);
      out = `[mtt${kind}${ti}]`;
    } else {
      const parts: string[] = [];
      if (trackOpts.gainDb !== 0) parts.push(`volume=${trackOpts.gainDb}dB`);
      if (trackOpts.pan !== 0) {
        const { lg, rg } = panGains(trackOpts.pan);
        parts.push(`pan=stereo|c0=${lg}*c0|c1=${rg}*c1`);
      }
      if (parts.length > 0) {
        chains.push(`${out}${parts.join(',')}[mtt${kind}${ti}]`);
        out = `[mtt${kind}${ti}]`;
      }
    }
  }
  return out;
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
  /** clipIdx -> ffmpeg input index of its beauty mask video. */
  beautyInputIndex: Map<number, number>;
  /** `${clipIdx}:${angleIdx}` -> ffmpeg input index of a multicam angle
   *  (angle 0 rides on the clip's own input, so only angles 1.. are here). */
  multicamInputIndex: Map<string, number>;
  /** clipIdx -> ffmpeg input index of its tracked-window mask video. */
  trackedWindowInputIndex: Map<number, number>;
  /** `${clipIdx}:${stageIdx}` -> ffmpeg input index of a masked node mask PNG. */
  gradeNodeMaskIndex: Map<string, number>;
  /** clipIdx -> ffmpeg input index of its object-track mosaic mask video. */
  objectTrackMaskIndex: Map<number, number>;
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
 * Order: segment trim/speed (+reverse) -> freeze stage -> smart reframe
 * (crop on the SOURCE stream, before scale/pad) -> scale/pad/fps ->
 * zoom -> rotation -> colour -> LUT -> opacity (split + black branch +
 * blend) -> text (+ clip subtitles).
 * freezeAt is clip-local OUTPUT time (after speed, after reverse).
 * The reframe crop sits BEFORE scale/pad on purpose: scale/pad
 * letterboxes a landscape source into a vertical project, so a crop
 * after it would cut the padded bars, not the subject. The trajectory
 * is in source fractions and clip-local time (speed 1, no
 * reverse/freeze — enforced by validateSmartCut), so the crop
 * expression uses the stream's t directly. Mask/zoom/colour still run
 * after it, on the reframed frame.
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
  /** clipIdx -> smoothed subject track (prepareSubjectTracks output). */
  tracks?: Map<number, SubjectTrack>,
  /** P3g wiring bundle (colour management / node LUTs / tracked
   *  windows / object tracks / clone / outline). */
  p3g?: P3gGraphInputs,
  /**
   * Multitrack opacity: when true the clip's opacity keyframes fade
   * toward TRANSPARENT (geq on the alpha plane, RGB untouched) so
   * lower tracks show through; when false (legacy single track)
   * they fade toward black, as before. Verified ffmpeg 8.1: geq
   * re-evaluates `T` per frame and `p(X,Y)` reads the current
   * plane's pixel (the input alpha in the alpha expression; 255
   * after format=yuva420p on an opaque stream).
   */
  opacityToAlpha?: boolean,
): string[] {
  const { width, height, fps } = project;
  const chains: string[] = [];

  // P3g validation (fail fast, before any chain is built): a clip may
  // use EITHER the P2a linear advancedColor stack OR a grade-node
  // graph — mixing the two is a modelling error, not a blend.
  if (clip.advancedColor && clip.gradeNodes) {
    throw new Error(
      `clip ${clip.id}: advancedColor and gradeNodes are mutually exclusive — use one grading model per clip`,
    );
  }
  if (clip.colorManagement) validateClipColorManagement(clip.colorManagement, clip.id);
  if (clip.colorMatch) validateColorMatch(clip.colorMatch, clip.id);
  if (clip.gradeNodes) validateGradeNodes(clip.gradeNodes, clip.id);
  if (clip.trackedWindow) validateTrackedWindow(clip.trackedWindow, clip.id);
  if (clip.objectTrack) validateObjectTrack(clip.objectTrack, clip.id);
  if (clip.clone) validateCloneEffect(clip.clone, clip);
  if (clip.outline) validateKeyOutline(clip.outline, clip.id);

  // Beat-speed (P3): validate the block here; the nodes themselves
  // are derived inside speedCurveSegments (project.ts), so the
  // segment work, clipDuration and the audio chain all see the same
  // curve without any local clip replacement.
  if (clip.beatSpeed) {
    validateBeatSpeed(clip);
  }

  // Multicam (P2): the [vb] stream is assembled from the angle
  // segments instead of the speed-curve segments below. vidstab,
  // deshake, reverse and freeze are all rejected for multicam clips
  // by validateMulticam, so [vb] is already final here — the scale/
  // pad/fps stage below applies to it directly.
  const mc = validateMulticam(clip);
  let baseLabel: string;
  if (clip.clone) {
    // Clone (P3): the same source duplicated into lanes, each lane a
    // time-offset copy. Lanes are built from the RAW input (a trim on
    // the assembled stream could not show different source times),
    // scaled to lane size, then hstacked/vstacked to project size.
    // The scale/pad stage below is then a no-op (already project size).
    const { laneW, laneH } = cloneLaneSize(clip.clone, width, height);
    const laneLabels = clip.clone.offsets.map((off, k) => {
      chains.push(
        `[${idx}:v]trim=start=${clip.in + off}:end=${clip.out + off},` +
          `setpts=PTS-STARTPTS,scale=${laneW}:${laneH},fps=${fps}[vcl${idx}_${k}]`,
      );
      return `[vcl${idx}_${k}]`;
    });
    if (clip.clone.lanes === 2) {
      chains.push(`${laneLabels.join('')}hstack=inputs=2[vb${idx}]`);
    } else {
      chains.push(`${laneLabels[0]}${laneLabels[1]}hstack=inputs=2[vclt${idx}_0]`);
      chains.push(`${laneLabels[2]}${laneLabels[3]}hstack=inputs=2[vclt${idx}_1]`);
      chains.push(`[vclt${idx}_0][vclt${idx}_1]vstack=inputs=2[vb${idx}]`);
    }
    baseLabel = `[vb${idx}]`;
  } else if (clip.audioOnly) {
    // Linked selection off (P3): the video was deleted but the audio
    // kept — the video renders black for the clip's duration. No
    // visual effect can apply to a black frame, so they are rejected.
    if (clip.mask || clip.chromaKey || clip.portraitCutout || clip.reframe || clip.beauty || clip.stabilize) {
      throw new Error(`clip ${clip.id}: audio-only clip cannot carry mask/chromaKey/portraitCutout/reframe/beauty/stabilize`);
    }
    chains.push(
      `color=c=black:s=${width}x${height}:r=${fps}:d=${clipDuration(clip)}[vb${idx}]`,
    );
    baseLabel = `[vb${idx}]`;
  } else if (mc) {
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

  // Smart reframe (P3): crop the source to the target aspect,
  // following the tracked subject. Runs on the source-resolution
  // stream (see the order comment above) — before scale/pad.
  if (clip.reframe) {
    validateSmartCut(clip);
    const track = tracks?.get(idx);
    if (!track) {
      throw new Error(
        `clip ${clip.id}: reframe subject track not prepared; call prepareSubjectTracks first`,
      );
    }
    chains.push(`${baseLabel}${reframeCropFilter(track, clip.reframe)}[vrf${idx}]`);
    baseLabel = `[vrf${idx}]`;
  }

  const baseParts: string[] = [
    `${baseLabel}scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${fps}`,
  ];
  chains.push(baseParts.join(',') + `[vbs${idx}]`);

  // Colour management input conversion (P3): the clip's footage is
  // brought into the project's working space FIRST, before beauty /
  // mask / chroma / portrait see it (those stages assume working-space
  // values). zscale path (log100/hlg/pq) and/or a baked transfer LUT
  // (slog3/srgb) — both prepared by export.ts.
  let picLabel = `[vbs${idx}]`;
  if (clip.colorManagement?.inputSpace) {
    const working = project.colorManagement?.workingSpace ?? 'rec709';
    const conv = inputColorConversion(clip.colorManagement.inputSpace, working);
    const cmFilters: string[] = [];
    if (conv.filter) cmFilters.push(conv.filter);
    for (const lutPath of p3g?.colorMgmtLuts?.get(idx) ?? []) cmFilters.push(lut3dFilter(lutPath));
    if (cmFilters.length > 0) {
      chains.push(`${picLabel}${cmFilters.join(',')}[vcm${idx}]`);
      picLabel = `[vcm${idx}]`;
    }
  }

  // Shape-mask PiP (P1): composite first, then zoom/rotation/colour act as
  // camera effects on the composited frame. Without a mask this is a no-op.
  // Face beautify (P3): retouch the person region before the mask /
  // chroma / portrait stages (they all still see a normal picture).
  // Strength 0 skips the stage (bit-identical to no beauty) but the
  // validation above still ran — a bad strength throws either way.
  if (clip.beauty) {
    validateBeauty(clip.beauty, clip);
    if ((clip.beauty.strength ?? 50) > 0) {
      picLabel = applyBeautyStage(chains, picLabel, clip, idx, project, maskCtx);
    }
  }
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
  // Video denoise (P3): hqdn3d right after scale/pad, before
  // zoom/rotation/colour — the noise is removed before any camera
  // effect magnifies it. Strength 0 = no filter in the graph.
  if (clip.videoDenoise) {
    const s = clip.videoDenoise.strength ?? 50;
    if (typeof s !== 'number' || Number.isNaN(s) || s < 0 || s > 100) {
      throw new Error(`clip ${clip.id}: videoDenoise.strength ${clip.videoDenoise.strength} outside [0, 100]`);
    }
    if (s > 0) parts.push(hqdn3dFilter(s));
  }
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
  // P3g extra LUTs: colour-match LUT, then the baked node-graph final
  // LUT (unmasked graph). The project preset LUT still applies last.
  for (const p of p3g?.extraLuts?.get(idx) ?? []) parts.push(lut3dFilter(p));
  if (lut) parts.push(`lut3d=${lut}`);
  const textFilters = (clip.text ?? []).map((t) => drawtextFilter(t, fontfile));
  // Object-tracking sticker (P3): a text that follows the tracked
  // centre (drawtext x/y re-evaluate per frame — probe-p3g2).
  const objTrack = p3g?.objectTracks?.get(idx);
  if (objTrack && clip.objectTrack?.stickerText) {
    textFilters.push(
      objectTrackDrawtextFilter(
        objTrack,
        clip.objectTrack.stickerText,
        fontfile,
        width,
        height,
        40,
        'white',
      ),
    );
  }
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

  // Beat-flash (P3): white the frame for `frames` frames at each
  // output-time beat (drawbox with enable=between — probe 2026-11-18:
  // fade=t=in whites everything BEFORE the beat, drawbox does not).
  // Applied last, after text, so the flash covers the whole final
  // frame including subtitles.
  const flashFilters: string[] = [];
  if (clip.beatFlash) {
    validateBeatFlash(clip);
    const dur = clipDuration(clip);
    for (const b of clip.beatFlash.beats) {
      if (b > dur) {
        throw new Error(`clip ${clip.id}: beatFlash beat ${b} outside clip duration [0, ${dur.toFixed(3)}]`);
      }
    }
    flashFilters.push(...beatFlashFilters(clip.beatFlash.beats, fps, clip.beatFlash.frames ?? 2));
  }

  const opacity = clip.opacity ?? [];
  let cur: string;
  if (opacity.length >= 1 && opacityToAlpha) {
    // Multitrack: opacity is an alpha ramp, not a fade to black.
    // geq keeps RGB (lum/cb/cr read back) and scales only alpha by
    // the keyframed value, so the composite underneath shows through
    // where this clip is transparent. `T` is clip-local time here
    // (the chain starts at PTS 0), matching the keyframe `t`.
    chains.push(picChain + `[vo${idx}]`);
    const oExpr = lerpExpr(opacity, (k: Keyframe<number>) => k.value, 'T');
    chains.push(
      `[vo${idx}]format=yuva420p,` +
        `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='p(X,Y)*(${oExpr})'[vop${idx}]`,
    );
    cur = `[vop${idx}]`;
  } else if (opacity.length >= 1) {
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
    cur = `[vop${idx}]`;
  } else {
    chains.push(picChain + `[vpic${idx}]`);
    cur = `[vpic${idx}]`;
  }
  // P3g post stages (in order): tracked grading window -> object mosaic
  // -> masked node stages -> key outline. Each consumes its input label
  // exactly once (split where a label feeds two filters). Text and
  // beat-flash are applied last, on top of all of them.
  const twFiles = p3g?.trackedWindows?.get(idx);
  if (twFiles) {
    if (!maskCtx) throw new Error(`clip ${clip.id}: tracked window needs the graph context`);
    cur = applyTrackedWindowStage(chains, cur, idx, twFiles, maskCtx);
  }
  const objMaskIdx = maskCtx?.objectTrackMaskIndex.get(idx);
  if (objMaskIdx !== undefined && clip.objectTrack?.mosaicSize) {
    cur = applyMosaicStage(chains, cur, idx, objMaskIdx, clip.objectTrack.mosaicSize, width);
  }
  const nodeStages = p3g?.gradeNodeStages?.get(idx);
  if (nodeStages && nodeStages.length > 0) {
    if (!maskCtx) throw new Error(`clip ${clip.id}: grade node stages need the graph context`);
    cur = applyGradeNodeStages(chains, cur, idx, nodeStages, maskCtx);
  }
  if (clip.outline) {
    cur = applyOutlineStage(chains, cur, clip, idx, project, maskCtx);
  }
  if (textFilters.length > 0 || flashFilters.length > 0) {
    chains.push(`${cur}${[...textFilters, ...flashFilters].join(',')}[v${idx}]`);
  } else {
    chains.push(`${cur}null[v${idx}]`);
  }
  return chains;
}

/**
 * Face beautify stage (P3). Input is the full-frame clip picture;
 * output is the same frame with the person region retouched. The
 * beautified branch (hqdn3d + slight brightness + unsharp) is
 * alphamerged with the filtered ONNX mask video and overlaid back
 * onto the untouched original — outside the mask the frame is
 * bit-identical to the input (the overlay only writes where the
 * mask is non-zero). Same composite pattern as the portrait stage,
 * but the foreground is a FILTERED copy of the picture, not a
 * cut-out. Runs before the mask/chroma/portrait stages, so those
 * still see a normal picture.
 */
function applyBeautyStage(
  chains: string[],
  input: string,
  clip: Clip,
  idx: number,
  project: Project,
  ctx?: MaskCtx,
): string {
  const beauty = clip.beauty as NonNullable<Clip['beauty']>;
  validateBeauty(beauty, clip);
  const { fps } = project;
  const maskIdx = ctx?.beautyInputIndex.get(idx);
  if (maskIdx === undefined) {
    throw new Error(
      `clip ${clip.id}: beauty mask video not prepared; call prepareBeautyMasks first`,
    );
  }
  const strength = beauty.strength ?? 50;
  const feather = beauty.edgeFeather ?? 1;
  const blurPart = feather > 0 ? `,gblur=sigma=${feather}` : '';
  chains.push(`${input}split[btO${idx}][btI${idx}]`);
  chains.push(`[btI${idx}]${beautyFilter(strength)}[btB${idx}]`);
  chains.push(
    `[${maskIdx}:v]fps=fps=${fps},format=gray${blurPart}[btMk${idx}]`,
  );
  chains.push(`[btB${idx}]format=yuva420p[btBf${idx}]`);
  chains.push(`[btBf${idx}][btMk${idx}]alphamerge[btBm${idx}]`);
  chains.push(`[btO${idx}][btBm${idx}]overlay=0:0,format=yuv420p[btOut${idx}]`);
  return `[btOut${idx}]`;
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

/**
 * Tracked grading window stage (P3). The graded copy (lut3d) is
 * merged back through the moving mask video with maskedmerge — the
 * mask video's framesync repeats its last frame, so a 5 fps mask
 * covers a 30 fps timeline (same pattern as the P1e portrait masks).
 */
function applyTrackedWindowStage(
  chains: string[],
  input: string,
  idx: number,
  files: TrackedWindowFiles,
  ctx: MaskCtx,
): string {
  const maskIdx = ctx.trackedWindowInputIndex.get(idx);
  if (maskIdx === undefined) {
    throw new Error(`clip ${idx}: tracked-window mask input not registered`);
  }
  chains.push(`${input}split[twb${idx}][twg${idx}]`);
  chains.push(`[twg${idx}]${lut3dFilter(files.lut)}[twgl${idx}]`);
  chains.push(`[twb${idx}][twgl${idx}][${maskIdx}:v]maskedmerge,format=yuv420p[twout${idx}]`);
  return `[twout${idx}]`;
}

/**
 * Object-tracking mosaic stage (P3). The blurred copy is merged back
 * through the moving mask video — same maskedmerge pattern as the
 * tracked window. Radius scales with the mosaic size.
 */
function applyMosaicStage(
  chains: string[],
  input: string,
  idx: number,
  maskIdx: number,
  mosaicSize: number,
  projectWidth: number,
): string {
  const radius = Math.max(2, Math.round((mosaicSize * projectWidth) / 8));
  chains.push(`${input}split[omb${idx}][omg${idx}]`);
  chains.push(`[omg${idx}]boxblur=luma_radius=${radius}:luma_power=2[ombl${idx}]`);
  chains.push(`[omb${idx}][ombl${idx}][${maskIdx}:v]maskedmerge,format=yuv420p[omout${idx}]`);
  return `[omout${idx}]`;
}

/**
 * Masked node-graph stages (P3). Each masked node: split the stream
 * into three (base for the blend, base for the merge, graded copy),
 * apply the node's baked LUT, blend with its blend mode / opacity,
 * then maskedmerge through the node's mask PNG. Every label is
 * consumed exactly once.
 */
function applyGradeNodeStages(
  chains: string[],
  input: string,
  idx: number,
  stages: GradeNodeStage[],
  ctx: MaskCtx,
): string {
  let cur = input;
  stages.forEach((st, k) => {
    const maskIdx = ctx.gradeNodeMaskIndex.get(`${idx}:${k}`);
    if (maskIdx === undefined) {
      throw new Error(`clip ${idx}: grade-node mask ${k} input not registered`);
    }
    // Split outputs by role, in order: [gna] base for the mode blend,
    // [gnb] graded copy, [gnc] base for the maskedmerge, [gnd] base
    // for the opacity blend (only when both blends run). Every output
    // is consumed exactly once.
    const needMode = st.blend !== 'normal';
    const needOpacity = st.opacity < 1;
    const outs =
      needMode && needOpacity ? ['gna', 'gnb', 'gnc', 'gnd']
      : needMode || needOpacity ? ['gna', 'gnb', 'gnc']
      : ['gnb', 'gnc'];
    chains.push(`${cur}split=${outs.length}${outs.map((o) => `[${o}${idx}_${k}]`).join('')}`);
    chains.push(`[gnb${idx}_${k}]${lut3dFilter(st.lut)}[gnl${idx}_${k}]`);
    let graded = `[gnl${idx}_${k}]`;
    if (needMode) {
      chains.push(`[gna${idx}_${k}]${graded}blend=all_mode=${st.blend}[gnbl${idx}_${k}]`);
      graded = `[gnbl${idx}_${k}]`;
    }
    if (needOpacity) {
      const o = st.opacity;
      const base = needMode ? `[gnd${idx}_${k}]` : `[gna${idx}_${k}]`;
      chains.push(
        `${base}${graded}blend=all_expr='A*(${1 - o})+B*(${o})'[gno${idx}_${k}]`,
      );
      graded = `[gno${idx}_${k}]`;
    }
    // The node mask is an RGBA PNG (mask in ALPHA, RGB white — same
    // as the P1 clip masks): maskedmerge reads luma, so extract the
    // alpha first, or the grade leaks to the whole frame (verify-p3g:
    // corner G 49 instead of 0 with the mask applied everywhere).
    chains.push(`[${maskIdx}:v]alphaextract[gnm${idx}_${k}]`);
    chains.push(`[gnc${idx}_${k}]${graded}[gnm${idx}_${k}]maskedmerge,format=yuv420p[gnout${idx}_${k}]`);
    cur = `[gnout${idx}_${k}]`;
  });
  return cur;
}

/**
 * Key outline stage (P3). The ring is the portrait mask dilated by
 * `width` minus the mask itself (blend difference — the dilated mask
 * is a superset, so |D-M| = D-M). The ring becomes the alpha of a
 * solid-colour frame, overlaid on the cut-out composite. Requires
 * portraitCutout — the outline is drawn from the P1e mask alpha.
 */
function applyOutlineStage(
  chains: string[],
  input: string,
  clip: Clip,
  idx: number,
  project: Project,
  ctx?: MaskCtx,
): string {
  const outline = clip.outline as NonNullable<Clip['outline']>;
  validateKeyOutline(outline, clip.id);
  if (!clip.portraitCutout) {
    throw new Error(`clip ${clip.id}: outline needs portraitCutout (no alpha to stroke)`);
  }
  const maskIdx = ctx?.portraitInputIndex.get(idx);
  if (maskIdx === undefined) {
    throw new Error(
      `clip ${clip.id}: portrait mask video not prepared; call preparePortraitMasks first`,
    );
  }
  const { width, height, fps } = project;
  const [r, g, b] = parseOutlineColor(outline.color);
  const hex = `0x${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  const dur = clipDuration(clip);
  chains.push(
    `[${maskIdx}:v]fps=fps=${fps},format=gray,${outlineDilationFilter(outline.width)}[odil${idx}]`,
  );
  chains.push(`[${maskIdx}:v]fps=fps=${fps},format=gray[omsk${idx}]`);
  chains.push(`[odil${idx}][omsk${idx}]blend=all_mode=difference[oring${idx}]`);
  chains.push(`color=c=${hex}:s=${width}x${height}:r=${fps}:d=${dur},format=yuva420p[ocol${idx}]`);
  chains.push(`[ocol${idx}][oring${idx}]alphamerge[ocolm${idx}]`);
  chains.push(`${input}[ocolm${idx}]overlay=0:0,format=yuv420p[olout${idx}]`);
  return `[olout${idx}]`;
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
  // Beat-speed (P3): same validation as the video chain — the nodes
  // are derived inside speedCurveSegments, so audio and video stay
  // in sync with no local replacement.
  if (clip.beatSpeed) {
    validateBeatSpeed(clip);
  }
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
  // J/L edit (P3): the audio comes from its own source window
  // [audioIn, audioOut] instead of the video window, then is fitted
  // to the video duration — longer audio is trimmed, shorter audio
  // is padded with silence (apad). Total duration never changes.
  const jl = validateJLClip(clip);
  if (jl) {
    const vDur = clipDuration(clip);
    chains.push(
      `[${audioInputIdx}:a]atrim=start=${jl.audioIn}:end=${jl.audioOut},` +
        `asetpts=PTS-STARTPTS,${atempoChain(clip.speed)},` +
        `atrim=start=0:end=${vDur},apad=whole_dur=${vDur}[ab${idx}]`,
    );
  } else if (segments.length === 1) {
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
  // Audio repair (P3): adeclick -> highpass (hum) -> afftdn
  // (nr=25:nf=-30). It sits after the audioFx block and before the
  // plain `denoise` afftdn — when repair.denoise is set the repair
  // afftdn IS the denoise, so the plain one is skipped (two afftdn
  // stages would double-process the same noise estimate).
  const repair = validateAudioRepair(clip.audioRepair, clip.id);
  const repairChain = repair ? repairFilter(repair) : '';
  if (repairChain) preDuck.push(repairChain);
  const gainDb = fx?.gainDb;
  // Volume keyframes (P3): after loudnorm/ducking/volume/gainDb, so
  // they are a trim loudnorm cannot eat. The last key must sit inside
  // the clip (checked here — validateAudioFx only knows the shape).
  const volKeys = fx?.volumeKeys;
  if (volKeys && volKeys.length > 0) {
    const lastT = volKeys[volKeys.length - 1].t;
    if (lastT > dur) {
      throw new Error(`clip ${clip.id}: audioFx.volumeKeys last key t=${lastT} outside clip duration [0, ${dur.toFixed(3)}]`);
    }
  }
  const volKeysFilterStr = volumeKeysFilter(volKeys);
  if (clip.denoise && !(repair?.denoise)) preDuck.push('afftdn');
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
      `[adc${idx}]volume=${clip.volume}${gainDb !== undefined ? `,volume=${gainDb}dB` : ''}${volKeysFilterStr ? `,${volKeysFilterStr}` : ''}[a${idx}]`,
    );
    return chains;
  }
  const audioFilters = [...preDuck, `volume=${clip.volume}`];
  if (gainDb !== undefined) audioFilters.push(`volume=${gainDb}dB`);
  if (volKeysFilterStr) audioFilters.push(volKeysFilterStr);
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
  /** clipIdx -> smoothed subject track (prepareSubjectTracks output);
   *  required by any clip with reframe. */
  smartcutTracks?: Map<number, SubjectTrack>,
  /** HDR mode (P3, deliver.ts): 'hdr-to-sdr' tonemaps the assembled
   *  timeline to Rec.709 SDR, 'sdr-to-hdr' lifts it into a 10-bit PQ
   *  container (pseudo-HDR). Applied AFTER subtitle burn, so the
   *  subtitles are tone-mapped with the picture. 'off' = no filter. */
  hdrMode?: HdrMode,
  /** clipIdx -> beauty mask video path (prepareBeautyMasks output);
   *  required by any clip with beauty (strength > 0). */
  beautyMasks?: Map<number, string>,
  /** TTS narration (P3): synthesized WAV file + its options. The
   *  file is registered as an extra input and mixed over the
   *  assembled timeline (after assembly, before master gain). */
  narrationFile?: string,
  narration?: TtsNarration,
  /** Surround layout (P3): 'stereo' (default) or '5.1'/'7.1'. The
   *  upmix is applied to the mix only, after master gain; role
   *  stems stay stereo. */
  surroundLayout?: SurroundLayout,
  /** Mix-bus input channel count for the surround upmix (1 = mono,
   *  2 = stereo; probed by export.ts). Defaults to 2 (stereo). */
  surroundInputChannels?: number,
  /** P3g wiring bundle (colour management / node LUTs / tracked
   *  windows / object tracks / clone / outline). */
  p3g?: P3gGraphInputs,
): FilterGraph {
  // Multitrack projects (Project.tracks) render through the
  // multitrack assembly below; legacy projects (no tracks) render
  // through the original concat/xfade assembly, byte-identical to
  // before. Both paths share the per-clip chains, the role block
  // and the post-assembly tail (adjustment layers, frame interp,
  // narration, master gain, surround, subtitles, HDR, output LUT).
  // `flat` is the clip list in render order (legacy: project.clips
  // in order; multitrack: video-track clips, then audio-track
  // clips); `flatProject` is the project with that list as `clips`,
  // so per-clip helpers that index project.clips[idx] (mask
  // backgrounds, portrait stages) resolve against the global index.
  if (hasTracks(project)) validateMultitrackProject(project);
  const flat: FlatClip[] = flattenProject(project);
  const flatProject: Project = { ...project, clips: flat.map((f) => f.clip) };
  const n = flat.length;
  if (n === 0) throw new Error('project has no clips');
  // Project colour management: inputSpace belongs on clips, not the
  // project — fail here so a direct graph build (not just the export
  // prep) rejects it.
  validateProjectColorManagement(project.colorManagement);
  // Timeline markers / adjustment layers (P3): fail fast on an
  // out-of-range marker or layer span instead of rendering a project
  // whose chapters point past the end.
  validateTimelineProject(project);
  // A compound clip that reaches the graph unresolved is a caller bug:
  // export.ts resolves them (rendering the child first) before the graph
  // build. Fail here with a clear message instead of emitting a graph
  // that references an empty source path.
  flatProject.clips.forEach((clip) => {
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
    beautyInputIndex: new Map(),
    multicamInputIndex: new Map(),
    trackedWindowInputIndex: new Map(),
    gradeNodeMaskIndex: new Map(),
    objectTrackMaskIndex: new Map(),
  };
  flatProject.clips.forEach((clip, i) => {
    if (!clip.mask) return;
    const files = maskFiles?.get(i) ?? [];
    files.forEach((f, j) => {
      maskCtx.inputIndex.set(`${i}:${j}`, n + maskCtx.extraInputs.length);
      maskCtx.extraInputs.push(f);
    });
  });
  flatProject.clips.forEach((clip, i) => {
    const src = clip.chromaKey?.background?.source ?? clip.portraitCutout?.background?.source;
    if (!src) return;
    maskCtx.bgInputIndex.set(i, n + maskCtx.extraInputs.length);
    maskCtx.extraInputs.push(src);
  });
  flatProject.clips.forEach((clip, i) => {
    const src = clip.ducking?.source;
    if (!src) return;
    maskCtx.duckInputIndex.set(i, n + maskCtx.extraInputs.length);
    maskCtx.extraInputs.push(src);
  });
  flatProject.clips.forEach((clip, i) => {
    const file = portraitMasks?.get(i);
    if (!file) return;
    maskCtx.portraitInputIndex.set(i, n + maskCtx.extraInputs.length);
    maskCtx.extraInputs.push(file);
  });
  // Beauty masks (P3): same registration pattern as the portrait masks.
  flatProject.clips.forEach((clip, i) => {
    const file = beautyMasks?.get(i);
    if (!file) return;
    maskCtx.beautyInputIndex.set(i, n + maskCtx.extraInputs.length);
    maskCtx.extraInputs.push(file);
  });
  // P3g inputs: tracked-window mask videos, masked node-graph mask
  // PNGs, object-track mosaic mask videos — same registration pattern.
  flatProject.clips.forEach((clip, i) => {
    const f = p3g?.trackedWindows?.get(i);
    if (!f) return;
    maskCtx.trackedWindowInputIndex.set(i, n + maskCtx.extraInputs.length);
    maskCtx.extraInputs.push(f.mask);
  });
  flatProject.clips.forEach((clip, i) => {
    const stages = p3g?.gradeNodeStages?.get(i) ?? [];
    stages.forEach((st, k) => {
      maskCtx.gradeNodeMaskIndex.set(`${i}:${k}`, n + maskCtx.extraInputs.length);
      maskCtx.extraInputs.push(st.mask);
    });
  });
  flatProject.clips.forEach((clip, i) => {
    const m = p3g?.objectTrackMasks?.get(i);
    if (!m) return;
    maskCtx.objectTrackMaskIndex.set(i, n + maskCtx.extraInputs.length);
    maskCtx.extraInputs.push(m);
  });
  // Multicam angles: angle 0 is the clip's own input (clip.source), so
  // only angles 1.. are registered here as extra inputs. Shape errors
  // fail fast here, before any chain is built.
  flatProject.clips.forEach((clip, i) => {
    const mc = clip.multicam;
    if (!mc) return;
    validateMulticam(clip);
    mc.angles.slice(1).forEach((a, j) => {
      maskCtx.multicamInputIndex.set(`${i}:${j + 1}`, n + maskCtx.extraInputs.length);
      maskCtx.extraInputs.push(a);
    });
  });
  // TTS narration (P3): one extra audio input, registered after all
  // clip/multicam inputs so export.ts can map it by index.
  let narrationInputIdx = -1;
  if (narrationFile) {
    if (!narration) {
      throw new Error('narrationFile given but no narration options');
    }
    const start = narration.start ?? 0;
    if (start >= projectDuration(project)) {
      throw new Error(
        `narration start ${start}s is past the project duration ${projectDuration(project).toFixed(3)}s — the narration would never be heard`,
      );
    }
    narrationInputIdx = n + maskCtx.extraInputs.length;
    maskCtx.extraInputs.push(narrationFile);
  }
  const chains: string[] = [];
  const isMt = hasTracks(project);
  // Audio-track clips contribute audio only — building a video chain
  // for one would leave an unconnected [v<i>] output and FFmpeg
  // would reject the graph. Video-track clips build both chains
  // (linked audio). Multitrack clip opacity fades to transparent
  // (opacityToAlpha), so lower tracks show through.
  flat.forEach((f) => {
    const clip = f.clip;
    const i = f.globalIndex;
    if (f.kind === 'video') {
      chains.push(...clipVideoChains(clip, i, flatProject, fontfile, lut, maskCtx, stabilizeTrf, colorLuts, smartcutTracks, p3g, isMt));
    }
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
    flat.forEach((f) => {
      const clip = f.clip;
      const i = f.globalIndex;
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
  // Multitrack has no stem support yet: stems are assembled from the
  // sequential legacy timeline, which a multitrack project does not
  // have — request them on a legacy project instead.
  if (roleStems) {
    if (isMt) {
      throw new Error('roleStems is not supported on multitrack projects yet');
    }
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

  let videoOut = '[vout]';
  let audioOut = '[aout]';
  // Per-clip durations in flat order (legacy: the clip list order).
  // The role-stem tail below reads this; the multitrack branch does
  // not use it (stems throw for multitrack projects).
  const durations = flat.map((f) => clipDuration(f.clip));
  // W10: per-junction durations for the legacy video xfade chain, the
  // audio acrossfade chain and the role stems below (all share this
  // array; the multitrack branch never reads it). `transitions` is
  // the padded type array (missing junctions are 'cut' — the
  // engine's established convention, see resolveTransitions).
  const durs = resolveTransitionDurations(project);
  const transitions = resolveTransitions(project);
  if (isMt) {
    // Multitrack assembly: video tracks composited bottom-to-top
    // onto a black canvas (gaps stay black), audio tracks mixed
    // with amix (normalize=0). The legacy transitions array is
    // ignored here (validateMultitrackProject already rejected any
    // non-'cut' entry); cross-track arrivals are per-clip
    // transitionIn. Role-processed audio ([ar<i>]) feeds the mix
    // when roles are in use, else the plain clip audio [a<i>].
    const audioLabel = (g: number): string => (useRoles ? `[ar${g}]` : `[a${g}]`);
    const assembled = assembleMultitrack(chains, project, flat, audioLabel, roleAudioChannels, useRoles);
    videoOut = assembled.videoOut;
    audioOut = assembled.audioOut;
  } else {
  // W10: per-junction transition model — length / type / duration are
  // validated here, before any legacy chain is built, so a bad
  // transition fails fast instead of silently corrupting the export.
  // (Multitrack projects never reach this branch; their arrivals are
  // validated by validateMultitrackProject above.)
  validateTransitions(project);
  const hasXfade = transitions.some((t) => t !== 'cut');
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
  // applied (each non-cut transition overlaps its OWN per-junction
  // duration — W10; the legacy form just repeats the global duration).
  let vPrev = '[v0]';
  let acc = clipDuration(project.clips[0]);
  project.clips.slice(1).forEach((_, k) => {
    const type = transitions[k];
    const vNext = `[v${k + 1}]`;
    if (type !== 'cut') {
      const d = durs[k];
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
  // Adjustment layers (P3): each layer's colour adjustment is gated
  // to its span with enable=between on the assembled timeline.
  // Applied here, after assembly and before subtitles/HDR, so the
  // layer covers everything underneath it in that span.
  if ((project.adjustmentLayers ?? []).length > 0) {
    project.adjustmentLayers?.forEach((layer, n) => {
      const out = `[vadj${n}]`;
      chains.push(`${videoOut}${adjustmentLayerFilter(layer)}${out}`);
      videoOut = out;
    });
  }
  // Smart frame interpolation (P3): raise the assembled timeline to
  // targetFps with minterpolate (motion-compensated). Duration does
  // not change; the encoder's -r (preset fps) should match the
  // target, or the extra frames are dropped again at encode time.
  const frameInterp = validateFrameInterp(project.frameInterp, project.fps);
  if (frameInterp) {
    chains.push(`${videoOut}${minterpolateFilter(frameInterp.targetFps)}[vint]`);
    videoOut = '[vint]';
  }
  // Audio assembly (mix): same per-junction offsets as the video xfade chain.
  chains.push(
    ...audioAssemblyChains(mixInputs, transitions, durations, durs, '[aout]', 'a'),
  );
  }

  // TTS narration (P3): the synthesized voice is resampled to the
  // 48 kHz mix bus, duplicated to stereo, delayed to its project
  // start, and mixed over the assembled timeline with amix
  // (duration=first keeps the timeline length; normalize=0 keeps
  // the mix level — amix's default normalisation would halve it).
  // Role stems below are untouched: the narration rides the mix only.
  if (narrationFile && narration && narrationInputIdx >= 0) {
    const startMs = Math.round((narration.start ?? 0) * 1000);
    const gain = narration.gainDb ?? 0;
    chains.push(
      `[${narrationInputIdx}:a]aresample=48000,pan=stereo|c0=c0|c1=c0,` +
        `adelay=${startMs}|${startMs}` +
        (gain !== 0 ? `,volume=${gain}dB` : '') +
        `[narr]`,
    );
    chains.push('[aout][narr]amix=inputs=2:duration=first:normalize=0[aoutn]');
    audioOut = '[aoutn]';
  }

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
          inputs, transitions, durations, durs, stemLabel, `s${j}`,
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
    chains.push(`[${audioOut.slice(1, -1)}]volume=${project.masterGainDb}dB[aoutm]`);
    audioOut = '[aoutm]';
  }

  // Surround upmix (P3): the mix bus widens to 5.1/7.1 at the very
  // end, after master gain and after the narration mix. Role stems
  // stay stereo. The LFE is silent by design (see surround.ts).
  const surround = validateSurroundLayout(surroundLayout ?? project.surroundLayout);
  const surroundFilter = surround ? surroundUpmixFilter(surround, surroundInputChannels ?? 2) : '';
  if (surroundFilter) {
    chains.push(`[${audioOut.slice(1, -1)}]${surroundFilter}[asur]`);
    audioOut = '[asur]';
  }

  // Project-level subtitles: karaoke word highlight via the ASS filter,
  // applied once to the assembled timeline (project time). Uses the
  // current videoOut label (after adjustment layers / frame interp),
  // not a hardcoded [vout].
  if (assFile) {
    const quoted = `'${assFile.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")}'`;
    chains.push(`${videoOut}ass=${quoted}[vsub]`);
    videoOut = '[vsub]';
  }

  // HDR <-> SDR (P3, deliver.ts): appended at the END of the video
  // chain, after subtitle burn. Known limit: clips that use a mask /
  // chroma-key / portrait cutout composite path force yuv420p inside
  // their own chain, so those clips reach the tonemap already 8-bit;
  // plain clips keep 10-bit all the way to the tonemap.
  const hdrFilter = hdrVideoFilter(hdrMode ?? 'off');
  if (hdrFilter) {
    chains.push(`[${videoOut.slice(1, -1)}]${hdrFilter}[vhdr]`);
    videoOut = '[vhdr]';
  }
  // Colour management output conversion (P3): working -> delivery
  // space, applied last (after subtitle burn and HDR, like the HDR
  // block), with a setparams tag so the file carries the space.
  if (p3g?.outputLut) {
    chains.push(`[${videoOut.slice(1, -1)}]${lut3dFilter(p3g.outputLut)}[voutc]`);
    videoOut = '[voutc]';
  }
  if (p3g?.outputSpace) {
    chains.push(`[${videoOut.slice(1, -1)}]${outputColorTag(p3g.outputSpace)}[voutt]`);
    videoOut = '[voutt]';
  }
  return { filterComplex: chains.join(';'), videoOut, audioOut, extraInputs: maskCtx.extraInputs, audioStems };
}
