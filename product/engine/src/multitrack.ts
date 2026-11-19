// True multi-track timeline model (multitrack rewrite).
// Pure helpers only — no ffmpeg, no I/O. The render side lives in
// filtergraph.ts (buildFilterGraph, multitrack branch) and the
// export prep in export.ts.
//
// Model recap (see project.ts for the field docs):
// - VideoTrack[] stack bottom-to-top in array order. Clips sit at
//   explicit `start` times; gaps render black (video) / silence
//   (audio). Same-track clips MAY overlap — the later-starting clip
//   is on top within the track (that is how a normalized legacy
//   xfade is represented: the later clip starts transitionDuration
//   before the earlier one ends and fades in over it).
// - A video-track clip contributes video AND linked audio; an
//   audio-track clip contributes audio only.
// - Legacy projects (no tracks) are exactly one video track with
//   linked audio — normalizeToTracks converts them, preserving the
//   transition overlaps as per-clip `transitionIn` on the later clip.
// - Timeline edit ops in timeline.ts (three-point, delete, splits)
//   still operate on the legacy single-track list; they do NOT
//   understand tracks. Multitrack edits go through these helpers
//   (mapTrackClips) or the WPF side's own track editing.
//
// Validation failures throw with a message naming the track/clip;
// nothing here silently repairs a bad timeline.

import {
  audioTrackDuration,
  clipDuration,
  hasTracks,
  projectDuration,
  resolveTransitionDurations,
  videoTrackDuration,
  type AudioTrack,
  type AudioTrackClip,
  type Clip,
  type CrossTrackTransition,
  type Project,
  type TrackBlendMode,
  type VideoTrack,
  type VideoTrackClip,
} from './project.js';

export type { AudioTrack, AudioTrackClip, CrossTrackTransition, ProjectTracks, TrackBlendMode, VideoTrack, VideoTrackClip } from './project.js';

/** FFmpeg blend `all_mode` name per TrackBlendMode ('normal' = overlay, no blend filter). */
export const TRACK_BLEND_MODES: Record<Exclude<TrackBlendMode, 'normal'>, string> = {
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  add: 'addition',
};

const BLEND_MODES: TrackBlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'add',
];
const CROSSFADE_TYPES: CrossTrackTransition['type'][] = [
  'fade', 'dissolve', 'fadeblack', 'fadewhite',
];
/** All legacy transition types — allowed only when the clip
 *  overlaps the previous same-track clip (xfade path). */
const ALL_TRANSITION_TYPES: CrossTrackTransition['type'][] = [
  'cut', 'fade', 'dissolve', 'wipeleft', 'wiperight', 'slideleft',
  'circleopen', 'fadeblack', 'fadewhite',
];

/** One flattened clip occurrence: a clip + where it lives. */
export interface FlatClip {
  /** The clip itself (same object reference as in the track). */
  clip: Clip;
  /** Global ffmpeg input index (0-based over all occurrences). */
  globalIndex: number;
  /** 'video' occurrences render video + linked audio; 'audio' audio only. */
  kind: 'video' | 'audio';
  /** Index of the track inside its kind's array. */
  trackIndex: number;
  /** Track id. */
  trackId: string;
  /** Index of the clip inside its track. */
  clipIndex: number;
}

/**
 * Flatten a project to its clip occurrences in render order: all
 * video-track clips first (track order, then start order), then all
 * audio-track clips. The global index is the ffmpeg input index.
 * Legacy projects flatten to their plain clip list (kind 'video').
 */
export function flattenProject(project: Project): FlatClip[] {
  if (!hasTracks(project)) {
    return project.clips.map((clip, i) => ({
      clip,
      globalIndex: i,
      kind: 'video' as const,
      trackIndex: 0,
      trackId: 'v0',
      clipIndex: i,
    }));
  }
  const out: FlatClip[] = [];
  let g = 0;
  (project.tracks?.video ?? []).forEach((track, ti) => {
    const sorted = track.clips
      .map((clip, clipIndex) => ({ clip, clipIndex }))
      .sort((a, b) => a.clip.start - b.clip.start || a.clipIndex - b.clipIndex);
    for (const { clip, clipIndex } of sorted) {
      out.push({ clip, globalIndex: g++, kind: 'video', trackIndex: ti, trackId: track.id, clipIndex });
    }
  });
  (project.tracks?.audio ?? []).forEach((track, ti) => {
    const sorted = track.clips
      .map((clip, clipIndex) => ({ clip, clipIndex }))
      .sort((a, b) => a.clip.start - b.clip.start || a.clipIndex - b.clipIndex);
    for (const { clip, clipIndex } of sorted) {
      out.push({ clip, globalIndex: g++, kind: 'audio', trackIndex: ti, trackId: track.id, clipIndex });
    }
  });
  return out;
}

/** All clips as a plain list (flatten order) — for export prep. */
export function flatClips(project: Project): Clip[] {
  return flattenProject(project).map((f) => f.clip);
}

/**
 * Apply `fn` to every clip in a project and return a new project
 * with the results written back into their tracks (same shape, same
 * order). Legacy projects map over `clips`. Used by export prep
 * (compound resolution, smart-cut zoom merge) so those passes stay
 * track-aware.
 */
export function mapTrackClips(project: Project, fn: (clip: Clip, flat: FlatClip) => Clip): Project {
  if (!hasTracks(project)) {
    return { ...project, clips: project.clips.map((clip, i) => fn(clip, {
      clip, globalIndex: i, kind: 'video', trackIndex: 0, trackId: 'v0', clipIndex: i,
    })) };
  }
  const flat = flattenProject(project);
  const byKey = new Map<string, Clip>();
  for (const f of flat) byKey.set(`${f.kind}:${f.trackIndex}:${f.clipIndex}`, fn(f.clip, f));
  const video = (project.tracks?.video ?? []).map((track, ti) => ({
    ...track,
    clips: track.clips.map((clip, ci) => byKey.get(`video:${ti}:${ci}`) as VideoTrackClip),
  }));
  const audio = (project.tracks?.audio ?? []).map((track, ti) => ({
    ...track,
    clips: track.clips.map((clip, ci) => byKey.get(`audio:${ti}:${ci}`) as AudioTrackClip),
  }));
  return { ...project, tracks: { video, audio } };
}

/**
 * Rebuild a tracks project from a flat clip list in flatten order
 * (e.g. after a prep pass that rewrote clips by flat index). The
 * flat list must have exactly flattenProject(project).length entries.
 */
export function rebuildTracksFromFlat(project: Project, flatList: Clip[]): Project {
  const flat = flattenProject(project);
  if (flatList.length !== flat.length) {
    throw new Error(
      `rebuildTracksFromFlat: flat list has ${flatList.length} clips, project has ${flat.length}`,
    );
  }
  // Legacy projects have no tracks: the flat list IS the clip list.
  if (!hasTracks(project)) return { ...project, clips: flatList };
  const byKey = new Map<string, Clip>();
  flat.forEach((f, i) => byKey.set(`${f.kind}:${f.trackIndex}:${f.clipIndex}`, flatList[i]));
  const video = (project.tracks?.video ?? []).map((track, ti) => ({
    ...track,
    clips: track.clips.map((clip, ci) => byKey.get(`video:${ti}:${ci}`) as VideoTrackClip),
  }));
  const audio = (project.tracks?.audio ?? []).map((track, ti) => ({
    ...track,
    clips: track.clips.map((clip, ci) => byKey.get(`audio:${ti}:${ci}`) as AudioTrackClip),
  }));
  return { ...project, tracks: { video, audio } };
}

/**
 * Convert a legacy single-track project to its equivalent track
 * form: one video track, clips placed sequentially with the
 * transition overlaps applied (a clip after a non-'cut' transition
 * starts its junction's duration before the previous clip ends), and
 * that transition carried as the clip's `transitionIn`. The legacy
 * `clips` field is kept verbatim on the returned project so old
 * readers still see them; `transitions` is neutralised to all
 * 'cut' (the overlap is now in the `start` times). Duration is
 * preserved exactly (projectDuration is identical before/after).
 */
export function normalizeToTracks(project: Project): Project {
  if (hasTracks(project)) return project;
  const clips: VideoTrackClip[] = [];
  // W10: per-junction durations — each transitionIn carries its own
  // junction's duration (not the global one), so the conversion
  // preserves the total duration exactly under mixed durations.
  const durs = resolveTransitionDurations(project);
  let t = 0;
  project.clips.forEach((clip, i) => {
    const tc: VideoTrackClip = { ...clip, start: t };
    if (i > 0 && project.transitions[i - 1] !== 'cut') {
      // Any non-'cut' legacy transition becomes the clip's
      // transitionIn; the overlap is already in `start` (the clip
      // starts durs[i-1] before the previous clip ends),
      // so the track assembly reproduces the legacy xfade exactly.
      tc.transitionIn = { type: project.transitions[i - 1], duration: durs[i - 1] };
    }
    clips.push(tc);
    t += clipDuration(clip);
    if (i < project.transitions.length && project.transitions[i] !== 'cut') {
      t -= durs[i];
    }
  });
  return {
    ...project,
    // The legacy `clips` list is kept verbatim (old readers still
    // see the clips), but `transitions` is neutralised to all 'cut':
    // the overlaps now live in the track `start` times and the
    // transition types in per-clip `transitionIn`. Keeping a
    // non-'cut' legacy transition would make the project ambiguous
    // (validateMultitrackProject rejects it).
    transitions: clips.length > 1 ? Array<string>(clips.length - 1).fill('cut') as Project['transitions'] : [],
    tracks: { video: [{ id: 'v0', name: 'Video 1', clips }], audio: [] },
  };
}

/**
 * Validate a multitrack timeline. Throws on: bad/duplicate track
 * ids, bad opacity/blend/geometry, bad gain/pan, clips with a bad
 * start (negative, NaN) or a non-positive duration,
 * transitionIn with a bad type/duration (duration must be > 0 and
 * <= the clip's duration — and <= the same-track overlap when the
 * clip overlaps the previous same-track clip; wipe/slide/circle
 * types are only allowed on an overlapping clip, where they run
 * as an xfade — over lower tracks only fade/dissolve/fadeblack/
 * fadewhite are supported), a blend mode combined with a non-zero
 * track offset/scale (the blend path has no offset stage), or a
 * project that mixes tracks with a non-empty legacy `transitions`
 * array that would be silently ignored (legacy transitions only
 * apply to the legacy list). Same-track overlap is LEGAL (later
 * start wins within the track). Legacy projects (no tracks) always
 * pass here — their own validation lives elsewhere. An empty track
 * (no clips) is legal and contributes nothing.
 */
export function validateMultitrackProject(project: Project): void {
  if (!hasTracks(project)) return;
  if ((project.transitions ?? []).some((t) => t !== 'cut')) {
    throw new Error(
      'multitrack project carries non-cut legacy transitions, which the multitrack render ignores — move them to per-clip transitionIn',
    );
  }
  const ids = new Set<string>();
  for (const track of project.tracks?.video ?? []) {
    checkTrackId(track.id, ids, 'video');
    if (track.opacity !== undefined && (typeof track.opacity !== 'number' || Number.isNaN(track.opacity) || track.opacity < 0 || track.opacity > 1)) {
      throw new Error(`video track "${track.id}": opacity ${track.opacity} outside [0, 1]`);
    }
    if (track.blend !== undefined && !BLEND_MODES.includes(track.blend)) {
      throw new Error(`video track "${track.id}": unknown blend mode "${track.blend}"`);
    }
    if (track.blend !== undefined && track.blend !== 'normal' && ((track.x ?? 0) !== 0 || (track.y ?? 0) !== 0 || (track.w ?? 1) !== 1 || (track.h ?? 1) !== 1)) {
      throw new Error(
        `video track "${track.id}": blend mode "${track.blend}" cannot combine with a track offset/scale (x/y/w/h) — the blend path has no offset stage`,
      );
    }
    for (const axis of ['x', 'y'] as const) {
      const v = track[axis];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) {
        throw new Error(`video track "${track.id}": ${axis} ${v} is not a finite number`);
      }
    }
    for (const axis of ['w', 'h'] as const) {
      const v = track[axis];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1)) {
        throw new Error(`video track "${track.id}": ${axis} ${v} outside (0, 1]`);
      }
    }
    checkClips(track.id, track.clips);
  }
  for (const track of project.tracks?.audio ?? []) {
    checkTrackId(track.id, ids, 'audio');
    if (track.gainDb !== undefined && (typeof track.gainDb !== 'number' || Number.isNaN(track.gainDb) || track.gainDb < -60 || track.gainDb > 12)) {
      throw new Error(`audio track "${track.id}": gainDb ${track.gainDb} outside [-60, 12]`);
    }
    if (track.pan !== undefined && (typeof track.pan !== 'number' || Number.isNaN(track.pan) || track.pan < -1 || track.pan > 1)) {
      throw new Error(`audio track "${track.id}": pan ${track.pan} outside [-1, 1]`);
    }
    checkClips(track.id, track.clips);
  }
}

function checkTrackId(id: string, ids: Set<string>, kind: string): void {
  if (!id || typeof id !== 'string') {
    throw new Error(`${kind} track needs a non-empty string id (got ${JSON.stringify(id)})`);
  }
  if (ids.has(id)) throw new Error(`duplicate track id "${id}"`);
  ids.add(id);
}

function checkClips(trackId: string, clips: { start: number; id: string; transitionIn?: CrossTrackTransition }[] & { length: number }): void {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  let prevEnd = -Infinity;
  for (const c of sorted) {
    if (typeof c.start !== 'number' || !Number.isFinite(c.start) || c.start < 0) {
      throw new Error(`track "${trackId}" clip ${c.id}: start ${c.start} must be a finite number >= 0`);
    }
    const dur = clipDuration(c as unknown as Clip);
    if (!(dur > 0)) {
      throw new Error(`track "${trackId}" clip ${c.id}: duration ${dur} must be > 0`);
    }
    if (c.transitionIn !== undefined) {
      const tr = c.transitionIn;
      const overlaps = c.start < prevEnd - 1e-9;
      const overlap = overlaps ? prevEnd - c.start : 0;
      const allowed = overlaps ? ALL_TRANSITION_TYPES : CROSSFADE_TYPES;
      if (!allowed.includes(tr.type)) {
        throw new Error(
          overlaps
            ? `track "${trackId}" clip ${c.id}: transitionIn type "${(tr as { type: string }).type}" is not a transition type`
            : `track "${trackId}" clip ${c.id}: transitionIn type "${(tr as { type: string }).type}" is not supported over lower tracks (use fade/dissolve/fadeblack/fadewhite — wipe/slide/circle need a same-track overlap)`,
        );
      }
      if (tr.type === 'cut') {
        throw new Error(`track "${trackId}" clip ${c.id}: transitionIn type "cut" is not a transition (omit transitionIn for a hard cut)`);
      }
      const maxDur = overlaps ? Math.min(dur, overlap) : dur;
      if (typeof tr.duration !== 'number' || !Number.isFinite(tr.duration) || tr.duration <= 0 || tr.duration > maxDur + 1e-9) {
        throw new Error(
          `track "${trackId}" clip ${c.id}: transitionIn duration ${tr.duration} must be in (0, ${maxDur.toFixed(3)}]${overlaps ? ' (the same-track overlap)' : ''}`,
        );
      }
    }
    prevEnd = Math.max(prevEnd, c.start + dur);
  }
}

/**
 * Effective mute per audio track id: a track is muted when its own
 * mute is set, or when any audio track has solo and this one does
 * not. Video-track linked audio is never muted by track solo (it
 * has no track-level mute/solo; clip roles still apply).
 */
export function resolveAudioTrackMute(project: Project): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const audio = project.tracks?.audio ?? [];
  const anySolo = audio.some((t) => t.solo);
  for (const t of audio) {
    out.set(t.id, Boolean(t.mute) || (anySolo && !t.solo));
  }
  return out;
}

/** True when any audio track is soloed. */
export function hasSoloAudioTrack(project: Project): boolean {
  return (project.tracks?.audio ?? []).some((t) => t.solo);
}

/** Duration of the whole multitrack timeline (== projectDuration when tracks are present). */
export function multitrackDuration(project: Project): number {
  return projectDuration(project);
}

export { audioTrackDuration, videoTrackDuration };
