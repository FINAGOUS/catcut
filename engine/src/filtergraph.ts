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
  type ZoomKeyframe,
} from './project.js';
import { subtitlesToTextOverlays } from './subtitles.js';
import { TEXT_PRESETS } from './presets.js';

export interface FilterGraph {
  filterComplex: string;
  videoOut: string;
  audioOut: string;
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
): string[] {
  const { width, height, fps } = project;
  const chains: string[] = [];
  const segments = clip.reverse
    ? speedCurveSegments(clip).slice().reverse()
    : speedCurveSegments(clip);
  const reverseTail = clip.reverse ? ',reverse,setpts=N/FRAME_RATE/TB' : '';
  if (segments.length === 1) {
    const seg = segments[0];
    chains.push(
      `[${idx}:v]trim=start=${clip.in + seg.start}:end=${clip.in + seg.end},` +
        `setpts=(PTS-STARTPTS)/${seg.speed}${reverseTail}[vb${idx}]`,
    );
  } else {
    const outs = segments.map((seg, j) => {
      chains.push(
        `[${idx}:v]trim=start=${clip.in + seg.start}:end=${clip.in + seg.end},` +
          `setpts=(PTS-STARTPTS)/${seg.speed}${reverseTail}[vs${idx}_${j}]`,
      );
      return `[vs${idx}_${j}]`;
    });
    chains.push(`${outs.join('')}concat=n=${segments.length}:v=1:a=0[vb${idx}]`);
  }

  // Freeze stage: hold the frame at output time freezeAt for freezeDuration.
  // pre + frozen frame (loop) + post, concatenated back into one stream.
  let baseLabel = `[vb${idx}]`;
  if (clip.freezeAt !== undefined) {
    const F = clip.freezeAt;
    const fd = clip.freezeDuration ?? 1;
    const D = clipBaseDuration(clip);
    const frames = Math.max(1, Math.round(fd * fps));
    const parts: string[] = [];
    if (F > 0) {
      chains.push(`[vb${idx}]trim=start=0:end=${F},setpts=PTS-STARTPTS[vpre${idx}]`);
      parts.push(`[vpre${idx}]`);
    }
    chains.push(
      `[vb${idx}]trim=start=${F}:end=${F + 1 / fps},setpts=N/FRAME_RATE/TB,` +
        `loop=loop=${frames - 1}:size=1:start=0,setpts=N/FRAME_RATE/TB[vfrz${idx}]`,
    );
    parts.push(`[vfrz${idx}]`);
    if (D - F > 0.001) {
      chains.push(`[vb${idx}]trim=start=${F}:end=${D},setpts=PTS-STARTPTS[vpost${idx}]`);
      parts.push(`[vpost${idx}]`);
    }
    chains.push(`${parts.join('')}concat=n=${parts.length}:v=1:a=0[vbf${idx}]`);
    baseLabel = `[vbf${idx}]`;
  }

  const parts: string[] = [
    `${baseLabel}scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${fps}`,
  ];
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
  if (lut) parts.push(`lut3d=${lut}`);
  const textFilters = (clip.text ?? []).map((t) => drawtextFilter(t, fontfile));
  // Clip-level subtitles (clip-local output time, lower-third style).
  if (clip.subtitles && clip.subtitles.length > 0) {
    textFilters.push(
      ...subtitlesToTextOverlays(clip.subtitles, TEXT_PRESETS.lowerThird).map((t) =>
        drawtextFilter(t, fontfile),
      ),
    );
  }

  const opacity = clip.opacity ?? [];
  if (opacity.length >= 1) {
    // Single video track: there is nothing underneath to reveal, so opacity
    // is a fade toward black. Implemented with split + black branch + blend:
    // out = A*o + B*(1-o). Verified ffmpeg 8.1 (YAVG 121.5 -> 47.3 at o=0.3,
    // expected 16+(121.5-16)*0.3 = 47.6).
    // Rejected alternatives, all verified: eq's expression is evaluated once
    // at init (no per-frame change) and pivots on mid-grey, not black;
    // colorchannelmixer rejects expressions outright; geq not used per spec.
    chains.push(parts.join(',') + `[vo${idx}]`);
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
  chains.push([...parts, ...textFilters].join(',') + `[v${idx}]`);
  return chains;
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
 * -> afade in/out -> afftdn -> loudnorm -> volume.
 * The freeze span is silence built from a muted 10 ms slice of the clip
 * itself (apad), so sample rate / channel layout always match.
 */
function clipAudioChains(clip: Clip, idx: number): string[] {
  const chains: string[] = [];
  const segments = clip.reverse
    ? speedCurveSegments(clip).slice().reverse()
    : speedCurveSegments(clip);
  const reverseTail = clip.reverse ? ',areverse,asetpts=PTS-STARTPTS' : '';
  if (segments.length === 1) {
    const seg = segments[0];
    chains.push(
      `[${idx}:a]atrim=start=${clip.in + seg.start}:end=${clip.in + seg.end},` +
        `asetpts=PTS-STARTPTS,${atempoChain(seg.speed)}${reverseTail}[ab${idx}]`,
    );
  } else {
    const outs = segments.map((seg, j) => {
      chains.push(
        `[${idx}:a]atrim=start=${clip.in + seg.start}:end=${clip.in + seg.end},` +
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
  const parts: string[] = [audioBase];
  const audioFilters: string[] = [];
  if (clip.audioFadeIn !== undefined && clip.audioFadeIn > 0) {
    audioFilters.push(`afade=t=in:st=0:d=${Math.min(clip.audioFadeIn, dur)}`);
  }
  if (clip.audioFadeOut !== undefined && clip.audioFadeOut > 0) {
    const d = Math.min(clip.audioFadeOut, dur);
    audioFilters.push(`afade=t=out:st=${Math.max(0, dur - d)}:d=${d}`);
  }
  if (clip.denoise) audioFilters.push('afftdn');
  // loudnorm single-pass (linear=true is the default); no two-pass measurement.
  if (clip.loudnorm) audioFilters.push('loudnorm=I=-16:TP=-1.5:LRA=11:linear=true');
  audioFilters.push(`volume=${clip.volume}`);
  parts.push(audioFilters.join(','));
  chains.push(parts.join('') + `[a${idx}]`);
  return chains;
}

export function buildFilterGraph(
  project: Project,
  fontfile: string,
  lut?: string,
  assFile?: string,
): FilterGraph {
  const n = project.clips.length;
  if (n === 0) throw new Error('project has no clips');
  const chains: string[] = [];
  project.clips.forEach((clip, i) => {
    chains.push(...clipVideoChains(clip, i, project, fontfile, lut));
    chains.push(...clipAudioChains(clip, i));
  });

  const hasXfade = project.transitions.some((t) => t !== 'cut');
  let videoOut = '[vout]';
  let audioOut = '[aout]';

  if (!hasXfade) {
    const vInputs = project.clips.map((_, i) => `[v${i}]`).join('');
    const aInputs = project.clips.map((_, i) => `[a${i}]`).join('');
    chains.push(`${vInputs}concat=n=${n}:v=1:a=0[vout]`);
    chains.push(`${aInputs}concat=n=${n}:v=0:a=1[aout]`);
  } else {
  // Chained xfade / acrossfade. Offset of the k-th transition (0-based) is the
  // accumulated timeline duration before clip k+1, minus the overlaps already
  // applied (each non-cut transition overlaps transitionDuration).
  const d = project.transitionDuration;
  let vPrev = '[v0]';
  let aPrev = '[a0]';
  let acc = clipDuration(project.clips[0]);
  project.clips.slice(1).forEach((_, k) => {
    const type = project.transitions[k];
    const vNext = `[v${k + 1}]`;
    const aNext = `[a${k + 1}]`;
    if (type !== 'cut') {
      const offset = Math.max(0, acc - d);
      const vX = k === project.clips.length - 2 ? '[vout]' : `[vx${k}]`;
      const aX = k === project.clips.length - 2 ? '[aout]' : `[ax${k}]`;
      chains.push(
        `${vPrev}${vNext}xfade=transition=${XFADE_TRANSITIONS[type]}:duration=${d}:offset=${offset}${vX}`,
      );
      chains.push(`${aPrev}${aNext}acrossfade=d=${d}${aX}`);
      vPrev = vX;
      aPrev = aX;
      acc = acc + clipDuration(project.clips[k + 1]) - d;
    } else {
      const vC = k === project.clips.length - 2 ? '[vout]' : `[vc${k}]`;
      const aC = k === project.clips.length - 2 ? '[aout]' : `[ac${k}]`;
      chains.push(`${vPrev}${vNext}concat=n=2:v=1:a=0${vC}`);
      chains.push(`${aPrev}${aNext}concat=n=2:v=0:a=1${aC}`);
      vPrev = vC;
      aPrev = aC;
      acc = acc + clipDuration(project.clips[k + 1]);
    }
  });
  }

  // Project-level subtitles: karaoke word highlight via the ASS filter,
  // applied once to the assembled timeline (project time).
  if (assFile) {
    const quoted = `'${assFile.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")}'`;
    chains.push(`[vout]ass=${quoted}[vsub]`);
    videoOut = '[vsub]';
  }
  return { filterComplex: chains.join(';'), videoOut, audioOut };
}
