// Timeline advanced model (P3 batch 5, M4 §8.2 rows 118-125).
// Engine layer only — the WPF side owns the timeline UI (source
// monitor in/out, J/L trim handles, marker lane, audition switcher,
// paste-attributes menu, adjustment-layer lane).
//
// What lives here (all pure, no ffmpeg, no I/O, except
// markersToFfmetadata which only formats text):
// - TimelineMarker: time + colour + label; chapter markers export
//   to MP4 chapters via an ffmetadata file (export.ts writes it and
//   passes -map_metadata / -map_chapters; the ffmetadata chapter
//   layout was probe-verified 2026-11-18: ffprobe reads back
//   Intro 0-2s / Main 2-4s with titles intact).
// - Three-point edit: source in/out + timeline point -> insert or
//   overwrite (single-track model: the clip under the point is split).
// - Replace footage: swap clip.source, keep in/out and every effect.
// - J/L edit: Clip.audioIn/audioOut (source seconds, independent of
//   the video in/out) — see project.ts; the render side is in
//   filtergraph.ts clipAudioChains. validateJLClip is the gate.
// - Linked selection: Project.linkSelection (default true). Delete
//   with linking on removes the whole clip (video + its audio);
//   with linking off the video is removed but the audio is kept as
//   an audio-only clip (Clip.audioOnly — renders black video).
// - Timeline index search: full-text search over clip ids / sources,
//   marker labels and role names, returning project times.
// - Auditions: Clip.alternates — swap a clip's source with one of
//   its alternates without rebuilding the edit (the old source is
//   parked in the alternate slot, so switching back is exact).
// - Paste attributes: copy colour / effects / speed from one clip to
//   another through the existing Clip fields; incompatible combos
//   (speedCurve onto a beatSpeed clip) throw instead of silently
//   dropping the field.
// - Adjustment layer: a blank span carrying a colour adjustment that
//   applies to everything underneath it in that span (rendered with
//   eq/colorbalance + enable=between — probe-verified 2026-11-18:
//   grey-128 source reads 76 outside the span, 224 inside at
//   brightness +0.5).
// - replaceClipWithSplits: shared helper for silence-cut / text-cut
//   (they replace one clip by several and must keep the transitions
//   array in sync).
//
// Licence: no new FFmpeg filter is introduced by this file itself;
// eq/colorbalance/minterpolate/adelay etc. are native libavfilter —
// only verified on the local GPL 8.1.2 build; re-check each on the
// BtbN LGPL 9.0 build at the M2 gate.

import {
  clipDuration,
  projectDuration,
  type Clip,
  type ColorAdjust,
  type Project,
} from './project.js';

/** One timeline marker: a time, a colour and a label. */
export interface TimelineMarker {
  /** Project time in seconds. */
  t: number;
  /** Marker colour (any CSS-ish name or hex; stored, not rendered). */
  color?: string;
  /** Marker text. */
  label?: string;
  /** Chapter markers are written to the MP4 as chapters on export. */
  chapter?: boolean;
}

/** One blank adjustment-layer span on the timeline. */
export interface AdjustmentLayer {
  /** Project time span the layer covers. */
  start: number;
  end: number;
  /** Colour adjustment applied to everything under the layer. */
  color?: ColorAdjust;
}

/** Marker colours the UI offers (stored verbatim; no rendering here). */
export const MARKER_COLORS = ['red', 'green', 'blue', 'yellow', 'purple', 'orange'] as const;

/** Validate a project's markers + adjustment layers against its duration. */
export function validateTimelineProject(project: Project): void {
  const dur = projectDuration(project);
  (project.markers ?? []).forEach((m, i) => {
    if (typeof m.t !== 'number' || !Number.isFinite(m.t) || m.t < 0 || m.t > dur) {
      throw new Error(`marker[${i}]: t ${m.t} outside timeline [0, ${dur.toFixed(3)}]`);
    }
    if (m.color !== undefined && typeof m.color !== 'string') {
      throw new Error(`marker[${i}]: color must be a string`);
    }
  });
  (project.adjustmentLayers ?? []).forEach((l, i) => {
    if (typeof l.start !== 'number' || typeof l.end !== 'number' ||
      !Number.isFinite(l.start) || !Number.isFinite(l.end) ||
      l.start < 0 || l.end <= l.start || l.end > dur) {
      throw new Error(
        `adjustmentLayer[${i}]: span [${l.start}, ${l.end}] outside timeline [0, ${dur.toFixed(3)}]`,
      );
    }
    if (!l.color) {
      throw new Error(`adjustmentLayer[${i}]: no color adjustment set`);
    }
  });
}

/**
 * ffmetadata text for the project's chapter markers. Chapters run
 * from each chapter marker to the next chapter marker (or the end of
 * the timeline). Non-chapter markers are not written. Times are
 * milliseconds (TIMEBASE=1/1000).
 */
export function markersToFfmetadata(project: Project): string {
  const dur = projectDuration(project);
  const chapters = (project.markers ?? [])
    .filter((m) => m.chapter)
    .slice()
    .sort((a, b) => a.t - b.t);
  const lines = [';FFMETADATA1'];
  chapters.forEach((m, i) => {
    const start = Math.round(m.t * 1000);
    const end = Math.round(
      (i + 1 < chapters.length ? chapters[i + 1].t : dur) * 1000,
    );
    if (end <= start) return;
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`);
    if (m.label) lines.push(`title=${m.label.replace(/\n/g, ' ')}`);
  });
  return lines.join('\n') + '\n';
}

/** One search hit: what matched, where it is on the timeline. */
export interface TimelineHit {
  type: 'clip' | 'marker' | 'role';
  /** Clip id / marker label / role name. */
  id: string;
  /** Project time in seconds. */
  t: number;
  /** Human-readable match context. */
  label: string;
}

/**
 * Full-text index search over the project: clip ids and source file
 * names, marker labels, and role names (clip.role / project.roles).
 * Case-insensitive substring match. Hits are in timeline order.
 */
export function searchTimeline(project: Project, query: string): TimelineHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: TimelineHit[] = [];
  let t = 0;
  const transitions = project.transitions;
  project.clips.forEach((clip, i) => {
    const dur = clipDuration(clip);
    const hay = `${clip.id} ${clip.source} ${clip.role ?? ''}`.toLowerCase();
    if (hay.includes(q)) {
      hits.push({ type: 'clip', id: clip.id, t, label: `${clip.id} (${clip.source})` });
    }
    if (clip.role && clip.role.toLowerCase().includes(q)) {
      hits.push({ type: 'role', id: clip.role, t, label: `role ${clip.role} on ${clip.id}` });
    }
    t += dur;
    if (i < transitions.length && transitions[i] !== 'cut') t -= project.transitionDuration;
  });
  (project.markers ?? []).forEach((m) => {
    if ((m.label ?? '').toLowerCase().includes(q)) {
      hits.push({ type: 'marker', id: m.label ?? '', t: m.t, label: m.label ?? '' });
    }
  });
  return hits.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------------------
// Three-point edit + replace footage
// ---------------------------------------------------------------------------

/** Split one clip at a clip-local OUTPUT time (after speed). Returns
 *  [head, tail]; a split at the very edge returns the clip alone. */
function splitClipAtTime(clip: Clip, localT: number): Clip[] {
  const dur = clipDuration(clip);
  if (localT <= 0.001 || localT >= dur - 0.001) return [clip];
  // v1: only constant-speed clips split exactly (speed curves make
  // output-time -> source-time mapping piecewise; the caller splits
  // plain clips — the same limit as splitClipByBeats in beat.ts).
  if ((clip.speedCurve ?? []).length > 0 || clip.beatSpeed || clip.reverse || clip.freezeAt !== undefined) {
    throw new Error(`clip ${clip.id}: three-point split does not support speedCurve/beatSpeed/reverse/freeze yet`);
  }
  const srcT = clip.in + localT * clip.speed;
  const head: Clip = { ...clip, id: `${clip.id}-a`, out: srcT };
  const tail: Clip = { ...clip, id: `${clip.id}-b`, in: srcT };
  // J/L audio windows split with the video (the audio window is in
  // source seconds, so it splits at the same source time).
  if (clip.audioIn !== undefined || clip.audioOut !== undefined) {
    const aIn = clip.audioIn ?? clip.in;
    const aOut = clip.audioOut ?? clip.out;
    head.audioIn = aIn;
    head.audioOut = Math.min(aOut, srcT);
    tail.audioIn = Math.max(aIn, srcT);
    tail.audioOut = aOut;
  }
  return [head, tail];
}

/** Clip spans on the project timeline: [{clip, start, end}]. */
function clipSpans(project: Project): { clip: Clip; index: number; start: number; end: number }[] {
  const spans: { clip: Clip; index: number; start: number; end: number }[] = [];
  let t = 0;
  project.clips.forEach((clip, i) => {
    const dur = clipDuration(clip);
    spans.push({ clip, index: i, start: t, end: t + dur });
    t += dur;
    if (i < project.transitions.length && project.transitions[i] !== 'cut') {
      t -= project.transitionDuration;
    }
  });
  return spans;
}

/**
 * Derive the transitions array for a rebuilt clip list. Each new clip
 * carries its origin: the original clip index it came from, or -1 for
 * a freshly inserted clip. A boundary is 'cut' when either side is
 * inserted or both sides came from the same original clip (a split);
 * otherwise it keeps the original transition between the two origins.
 */
function deriveTransitions(
  origins: number[],
  originalTransitions: Project['transitions'],
): Project['transitions'] {
  const out: Project['transitions'] = [];
  for (let j = 0; j + 1 < origins.length; j++) {
    const a = origins[j];
    const b = origins[j + 1];
    if (a < 0 || b < 0 || a === b) {
      out.push('cut');
    } else if (b === a + 1) {
      out.push(originalTransitions[a] ?? 'cut');
    } else {
      // Origins jumped (a clip was dropped in between, e.g. an
      // overwrite): the boundary keeps the later origin's incoming
      // transition when it exists, else 'cut'.
      out.push(originalTransitions[b - 1] ?? 'cut');
    }
  }
  return out;
}

/**
 * Three-point INSERT: source in/out + a timeline point. The new clip
 * is inserted at `atTime`; the clip under the point is split there and
 * everything after it shifts right. `sourceClip` carries the source
 * in/out (its own in/out are the source range); its id is kept.
 * Inserting exactly at a clip boundary does not split (the clip goes
 * before / after the boundary clip).
 */
export function threePointInsert(project: Project, sourceClip: Clip, atTime: number): Project {
  const dur = projectDuration(project);
  if (atTime < 0 || atTime > dur) {
    throw new Error(`three-point insert: atTime ${atTime} outside timeline [0, ${dur.toFixed(3)}]`);
  }
  if (sourceClip.out <= sourceClip.in) {
    throw new Error(`three-point insert: source clip ${sourceClip.id} has empty range [${sourceClip.in}, ${sourceClip.out}]`);
  }
  if (project.clips.length === 0) {
    return { ...project, clips: [{ ...sourceClip }], transitions: [] };
  }
  const spans = clipSpans(project);
  const hit = spans.find((s) => atTime >= s.start && atTime < s.end);
  if (!hit) {
    // atTime == duration: append at the end.
    const clips = [...project.clips, { ...sourceClip }];
    const origins = project.clips.map((_, i) => i).concat([-1]);
    return { ...project, clips, transitions: deriveTransitions(origins, project.transitions) };
  }
  const localT = atTime - hit.start;
  const hitDur = clipDuration(hit.clip);
  const clips: Clip[] = [];
  const origins: number[] = [];
  project.clips.forEach((c, i) => {
    if (i === hit.index) {
      if (localT <= 0.001) {
        clips.push({ ...sourceClip });
        origins.push(-1);
        clips.push(c);
        origins.push(i);
      } else if (localT >= hitDur - 0.001) {
        clips.push(c);
        origins.push(i);
        clips.push({ ...sourceClip });
        origins.push(-1);
      } else {
        const parts = splitClipAtTime(c, localT);
        clips.push(parts[0]);
        origins.push(i);
        clips.push({ ...sourceClip });
        origins.push(-1);
        if (parts[1]) {
          clips.push(parts[1]);
          origins.push(i);
        }
      }
    } else {
      clips.push(c);
      origins.push(i);
    }
  });
  return { ...project, clips, transitions: deriveTransitions(origins, project.transitions) };
}

/**
 * Three-point OVERWRITE: the new clip covers [atTime, atTime+dur] on
 * the timeline; whatever was there is replaced (overlapped clips are
 * split at the edges, the covered middle is dropped). Total duration
 * is unchanged.
 */
export function threePointOverwrite(project: Project, sourceClip: Clip, atTime: number): Project {
  const total = projectDuration(project);
  const insDur = clipDuration(sourceClip);
  if (atTime < 0 || atTime + insDur > total + 1e-6) {
    throw new Error(
      `three-point overwrite: [${atTime}, ${atTime + insDur}] outside timeline [0, ${total.toFixed(3)}]`,
    );
  }
  if (sourceClip.out <= sourceClip.in) {
    throw new Error(`three-point overwrite: source clip ${sourceClip.id} has empty range`);
  }
  const spans = clipSpans(project);
  const end = atTime + insDur;
  const clips: Clip[] = [];
  const origins: number[] = [];
  let inserted = false;
  spans.forEach((s) => {
    if (s.end <= atTime + 1e-9 || s.start >= end - 1e-9) {
      // Untouched clip — insert the new clip before the first clip
      // that starts at/after the overwrite end.
      if (s.start >= end - 1e-9 && !inserted) {
        clips.push({ ...sourceClip });
        origins.push(-1);
        inserted = true;
      }
      clips.push(s.clip);
      origins.push(s.index);
    } else if (s.start < atTime - 1e-9 && s.end > end + 1e-9) {
      // The new clip sits inside one clip: head + new + tail.
      const [head] = splitClipAtTime(s.clip, atTime - s.start);
      const [, tail] = splitClipAtTime(s.clip, end - s.start);
      clips.push(head);
      origins.push(s.index);
      clips.push({ ...sourceClip });
      origins.push(-1);
      if (tail) {
        clips.push(tail);
        origins.push(s.index);
      }
      inserted = true;
    } else if (s.start < atTime - 1e-9) {
      // Head survives.
      const [head] = splitClipAtTime(s.clip, atTime - s.start);
      clips.push(head);
      origins.push(s.index);
    } else if (s.end > end + 1e-9) {
      // Tail survives.
      const [, tail] = splitClipAtTime(s.clip, end - s.start);
      if (!inserted) {
        clips.push({ ...sourceClip });
        origins.push(-1);
        inserted = true;
      }
      if (tail) {
        clips.push(tail);
        origins.push(s.index);
      }
    }
    // Fully covered clips are dropped; the insert happens before the
    // next surviving clip (or at the end, handled below).
  });
  if (!inserted) {
    clips.push({ ...sourceClip });
    origins.push(-1);
  }
  return { ...project, clips, transitions: deriveTransitions(origins, project.transitions) };
}

/**
 * Replace footage: swap a clip's source file, keeping its in/out and
 * every effect (colour, speed, audioFx, mask, ...). The new source
 * must be a non-empty path.
 */
export function replaceClipSource(clip: Clip, newSource: string): Clip {
  if (!newSource || typeof newSource !== 'string') {
    throw new Error(`clip ${clip.id}: replaceClipSource needs a non-empty source path`);
  }
  return { ...clip, source: newSource };
}

// ---------------------------------------------------------------------------
// J/L edit (audio in/out independent of video)
// ---------------------------------------------------------------------------

/**
 * Validate a clip's J/L audio window (Clip.audioIn/audioOut).
 * The audio window is in SOURCE seconds and may extend beyond the
 * video window [in, out] — that is the whole point of a J/L cut
 * (audio starts before the video / runs past it). It must overlap
 * the video window, and v1 only supports it on constant-speed clips
 * (no speedCurve/beatSpeed/reverse/freeze — the audio chain builds
 * one trim for the window, and a speed curve would need the window
 * split per segment).
 */
export function validateJLClip(clip: Clip): { audioIn: number; audioOut: number } | undefined {
  if (clip.audioIn === undefined && clip.audioOut === undefined) return undefined;
  const aIn = clip.audioIn ?? clip.in;
  const aOut = clip.audioOut ?? clip.out;
  if (!Number.isFinite(aIn) || aIn < 0) {
    throw new Error(`clip ${clip.id}: audioIn ${clip.audioIn} must be >= 0`);
  }
  if (!Number.isFinite(aOut) || aOut <= aIn) {
    throw new Error(`clip ${clip.id}: audioOut ${clip.audioOut} must be > audioIn ${aIn}`);
  }
  if (aOut <= clip.in || aIn >= clip.out) {
    throw new Error(
      `clip ${clip.id}: J/L audio window [${aIn}, ${aOut}] does not overlap video window [${clip.in}, ${clip.out}]`,
    );
  }
  if ((clip.speedCurve ?? []).length > 0 || clip.beatSpeed) {
    throw new Error(`clip ${clip.id}: J/L audio window does not support speedCurve/beatSpeed yet`);
  }
  if (clip.reverse) {
    throw new Error(`clip ${clip.id}: J/L audio window does not support reverse yet`);
  }
  if (clip.freezeAt !== undefined) {
    throw new Error(`clip ${clip.id}: J/L audio window does not support freeze yet`);
  }
  if (clip.multicam) {
    throw new Error(`clip ${clip.id}: J/L audio window does not support multicam yet`);
  }
  return { audioIn: aIn, audioOut: aOut };
}

// ---------------------------------------------------------------------------
// Linked selection: delete (and the audio-only clip it can leave)
// ---------------------------------------------------------------------------

/**
 * Delete a clip. Linking on (project.linkSelection !== false, the
 * default) removes the whole clip — video and its audio together.
 * Linking off removes only the video: the clip stays as an
 * audio-only clip (Clip.audioOnly — black video, audio untouched),
 * so the audio keeps its timeline position.
 */
export function deleteClip(project: Project, index: number, linked?: boolean): Project {
  if (!Number.isInteger(index) || index < 0 || index >= project.clips.length) {
    throw new Error(`deleteClip: index ${index} outside 0..${project.clips.length - 1}`);
  }
  const link = linked ?? project.linkSelection ?? true;
  const clips = project.clips.map((c) => ({ ...c }));
  const transitions = [...project.transitions];
  if (link) {
    clips.splice(index, 1);
    // Drop the transition after the removed clip (or the one before
    // it when it was last); the rest keep their positions.
    if (index < transitions.length) transitions.splice(index, 1);
    else if (transitions.length > 0) transitions.splice(transitions.length - 1, 1);
  } else {
    const clip = clips[index];
    if (clip.audioOnly) {
      throw new Error(`clip ${clip.id}: already audio-only (video already removed)`);
    }
    clips[index] = { ...clip, audioOnly: true };
  }
  return { ...project, clips, transitions };
}

// ---------------------------------------------------------------------------
// Auditions (alternates)
// ---------------------------------------------------------------------------

/** One audition alternate: a replacement source + its in/out. */
export interface AlternateClip {
  source: string;
  in: number;
  out: number;
}

/**
 * Switch a clip to one of its alternates. The current source/in/out
 * is parked in that alternate's slot, so switching back restores it
 * exactly and the rest of the edit (effects, timing) never moves.
 * Throws on an empty alternates list or an out-of-range index.
 */
export function switchAlternate(clip: Clip, index: number): Clip {
  const alts = clip.alternates ?? [];
  if (alts.length === 0) {
    throw new Error(`clip ${clip.id}: no alternates to switch to (alternates is empty)`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= alts.length) {
    throw new Error(`clip ${clip.id}: alternate index ${index} outside 0..${alts.length - 1}`);
  }
  const alt = alts[index];
  if (alt.out <= alt.in) {
    throw new Error(`clip ${clip.id}: alternate[${index}] has empty range [${alt.in}, ${alt.out}]`);
  }
  const next = alts.slice();
  next[index] = { source: clip.source, in: clip.in, out: clip.out };
  return { ...clip, source: alt.source, in: alt.in, out: alt.out, alternates: next };
}

// ---------------------------------------------------------------------------
// Paste attributes
// ---------------------------------------------------------------------------

/** Clip fields paste-attributes copies (all already exist on Clip). */
export const PASTEABLE_FIELDS = [
  'color', 'advancedColor', 'speed', 'speedCurve', 'volume',
  'audioFx', 'beauty', 'videoDenoise', 'audioFadeIn', 'audioFadeOut',
] as const;

export type PasteableField = (typeof PASTEABLE_FIELDS)[number];

/**
 * Copy attributes from `source` to `target`. Only the listed fields
 * are copied; everything else on the target (source file, in/out,
 * text, mask, ...) is untouched, and the source is never mutated.
 * Incompatible combos throw instead of silently dropping a field:
 * pasting a speedCurve onto a beatSpeed clip (or pasting onto a clip
 * whose beatSpeed would collide with the source's speedCurve).
 */
export function pasteAttributes(
  source: Clip,
  target: Clip,
  fields: PasteableField[] = [...PASTEABLE_FIELDS],
): Clip {
  if (fields.length === 0) throw new Error('pasteAttributes: no fields selected');
  for (const f of fields) {
    if (!PASTEABLE_FIELDS.includes(f)) {
      throw new Error(`pasteAttributes: unknown field "${f}"`);
    }
  }
  if (fields.includes('speedCurve') && target.beatSpeed) {
    throw new Error(
      `pasteAttributes: cannot paste speedCurve onto clip ${target.id} (it has beatSpeed — the beats ARE the curve)`,
    );
  }
  if (fields.includes('speedCurve') && source.speedCurve && target.speedCurve === undefined && target.beatSpeed) {
    throw new Error(`pasteAttributes: speedCurve collides with beatSpeed on clip ${target.id}`);
  }
  const next: Clip = { ...target };
  for (const f of fields) {
    const v = (source as unknown as Record<string, unknown>)[f];
    if (v === undefined) {
      delete (next as unknown as Record<string, unknown>)[f];
    } else {
      (next as unknown as Record<string, unknown>)[f] =
        typeof v === 'object' && v !== null ? JSON.parse(JSON.stringify(v)) : v;
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Adjustment layer (render helper)
// ---------------------------------------------------------------------------

/**
 * Filter string for one adjustment layer's colour adjustment, gated
 * to its span with enable=between. The caller applies it to the
 * assembled timeline ([vout] -> [vadjN]); the eq/colorbalance math
 * is the same as Clip.color in filtergraph.ts.
 */
export function adjustmentLayerFilter(layer: AdjustmentLayer): string {
  const color = layer.color as ColorAdjust;
  const parts: string[] = [];
  const eqParts: string[] = [];
  if (color.brightness !== undefined) eqParts.push(`brightness=${color.brightness}`);
  if (color.contrast !== undefined) eqParts.push(`contrast=${color.contrast}`);
  if (color.saturation !== undefined) eqParts.push(`saturation=${color.saturation}`);
  if (eqParts.length > 0) parts.push(`eq=${eqParts.join(':')}`);
  if (color.temperature !== undefined && color.temperature !== 0) {
    const t = Math.max(-1, Math.min(1, color.temperature));
    parts.push(`colorbalance=rs=${t}:gs=0:bs=${-t}`);
  }
  if (parts.length === 0) {
    throw new Error(`adjustmentLayer [${layer.start}, ${layer.end}]: color has no set field`);
  }
  const enable = `enable='between(t,${layer.start},${layer.end})'`;
  return parts.map((p) => `${p}:${enable}`).join(',');
}

// ---------------------------------------------------------------------------
// Shared helper: replace one clip by several (silence/text cut)
// ---------------------------------------------------------------------------

/**
 * Replace clip `index` by `replacements` (e.g. the kept segments
 * after a silence/text cut). Transitions: the boundary transitions
 * around the clip are kept; 'cut' is inserted between the new
 * sub-clips. The replacements must be non-empty and each must have
 * a positive duration.
 */
export function replaceClipWithSplits(
  project: Project,
  index: number,
  replacements: Clip[],
): Project {
  if (!Number.isInteger(index) || index < 0 || index >= project.clips.length) {
    throw new Error(`replaceClipWithSplits: index ${index} outside 0..${project.clips.length - 1}`);
  }
  if (replacements.length === 0) {
    throw new Error('replaceClipWithSplits: replacements is empty (use deleteClip to remove a clip)');
  }
  for (const r of replacements) {
    if (r.out <= r.in) {
      throw new Error(`replaceClipWithSplits: replacement clip ${r.id} has empty range [${r.in}, ${r.out}]`);
    }
  }
  const clips: Clip[] = [];
  const transitions: Project['transitions'] = [];
  project.clips.forEach((c, i) => {
    if (i === index) {
      replacements.forEach((r, j) => {
        clips.push(r);
        if (j < replacements.length - 1) transitions.push('cut');
      });
    } else {
      clips.push(c);
    }
    if (i < project.transitions.length) transitions.push(project.transitions[i]);
  });
  while (transitions.length > clips.length - 1) transitions.pop();
  while (transitions.length < clips.length - 1) transitions.push('cut');
  return { ...project, clips, transitions };
}
