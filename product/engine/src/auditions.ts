// Per-clip audition alternates (W10, M4 §8.2 — extends Clip.alternates).
//
// A clip can hold several named audition versions ("备选"): different
// source material and/or a different edit of the same slot (in/out,
// speed, volume, effects — any Clip field except the identity /
// audition bookkeeping itself). `activeAuditionId` selects which
// version is live; unset means the clip itself is live ("原片").
// Switching never rebuilds the edit: the base clip and every other
// audition are kept verbatim, so switching back is exact.
//
// Model rules (all failures throw with the clip id in the message;
// nothing here silently repairs or silently falls back):
// - Audition ids are unique within a clip; names are non-empty.
// - Every override needs a non-empty source and out > in; speed,
//   when present, must be in (0, 4]; volume, when present, >= 0.
// - An override must not carry id / auditions / activeAuditionId /
//   start / transitionIn: the resolved clip keeps the base clip's
//   id and (for track clips) its track position / arrival.
// - `activeAuditionId` must name a stored audition; a dangling id
//   throws at validate/resolve/export time instead of exporting the
//   base clip as if nothing were selected.
// - Old projects have no `auditions` field at all: they resolve to
//   themselves (the clip is its own single audition) and open
//   unchanged — see normalizeProjectAuditions.
// - Export resolution (resolveProjectAuditions) runs FIRST in
//   renderProjectWithStab, before compound resolution and timeline
//   prep, so every prep pass and the filter-graph build see the
//   ACTIVE version. The resolved clips have the audition fields
//   stripped, so re-resolving is a no-op and nothing downstream can
//   double-apply an override. Durations follow the active version
//   only after resolution — callers that need the effective duration
//   must resolve first (projectDuration on an unresolved project
//   still measures the base clips).
// - Legacy `alternates` (timeline.ts switchAlternate) are untouched
//   by this file and keep working; migrateAlternatesToAuditions
//   converts them into named auditions on request (opt-in, never
//   automatic at load or export).

import type {
  AudioTrack,
  Clip,
  Project,
  VideoTrack,
} from './project.js';

/**
 * One audition version: a full Clip override. Every Clip field may
 * be overridden except the clip identity and the audition bookkeeping
 * (id / auditions / activeAuditionId) and, for track clips, the track
 * placement (start / transitionIn). `source` / `in` / `out` are
 * required — an audition always points at real media.
 */
export type ClipAuditionOverride = Partial<
  Omit<Clip, 'id' | 'auditions' | 'activeAuditionId'>
> & {
  source: string;
  in: number;
  out: number;
};

/** One named audition version of a clip. */
export interface ClipAudition {
  /** Unique within the clip; referenced by Clip.activeAuditionId. */
  id: string;
  /** Display name, e.g. "备选 1 · 绿幕版". Non-empty. */
  name: string;
  /** The version's clip fields (applied over the base clip). */
  override: ClipAuditionOverride;
}

/** Override keys that are never allowed inside an audition override. */
const FORBIDDEN_OVERRIDE_KEYS = [
  'id',
  'auditions',
  'activeAuditionId',
  'start',
  'transitionIn',
] as const;

/** Validate one audition override (pure; throws on the first problem). */
export function validateAuditionOverride(
  clipId: string,
  auditionId: string,
  override: ClipAuditionOverride,
): void {
  const where = `clip ${clipId}: audition "${auditionId}"`;
  for (const k of FORBIDDEN_OVERRIDE_KEYS) {
    if ((override as unknown as Record<string, unknown>)[k] !== undefined) {
      throw new Error(`${where}: override must not carry "${k}"`);
    }
  }
  if (typeof override.source !== 'string' || override.source.length === 0) {
    throw new Error(`${where}: override needs a non-empty source path`);
  }
  if (
    !Number.isFinite(override.in) ||
    !Number.isFinite(override.out) ||
    override.out <= override.in
  ) {
    throw new Error(
      `${where}: override has empty range [${override.in}, ${override.out}]`,
    );
  }
  if (override.speed !== undefined) {
    if (!Number.isFinite(override.speed) || override.speed <= 0 || override.speed > 4) {
      throw new Error(`${where}: override speed ${override.speed} outside (0, 4]`);
    }
  }
  if (override.volume !== undefined) {
    if (!Number.isFinite(override.volume) || override.volume < 0) {
      throw new Error(`${where}: override volume ${override.volume} must be >= 0`);
    }
  }
}

/** Validate one stored audition (id / name / override). */
export function validateAudition(clipId: string, audition: ClipAudition): void {
  if (typeof audition.id !== 'string' || audition.id.length === 0) {
    throw new Error(`clip ${clipId}: audition needs a non-empty string id`);
  }
  if (typeof audition.name !== 'string' || audition.name.trim().length === 0) {
    throw new Error(`clip ${clipId}: audition "${audition.id}" needs a non-empty name`);
  }
  if (!audition.override || typeof audition.override !== 'object') {
    throw new Error(`clip ${clipId}: audition "${audition.id}" has no override`);
  }
  validateAuditionOverride(clipId, audition.id, audition.override);
}

/**
 * Validate a clip's whole audition set: unique ids, every audition
 * valid, and `activeAuditionId` (when set) naming a stored audition.
 * A clip with no auditions is always valid — that is the old format.
 */
export function validateAuditions(clip: Clip): void {
  const auditions = clip.auditions ?? [];
  const seen = new Set<string>();
  for (const a of auditions) {
    validateAudition(clip.id, a);
    if (seen.has(a.id)) {
      throw new Error(`clip ${clip.id}: duplicate audition id "${a.id}"`);
    }
    seen.add(a.id);
  }
  if (clip.activeAuditionId !== undefined && !seen.has(clip.activeAuditionId)) {
    throw new Error(
      `clip ${clip.id}: activeAuditionId "${clip.activeAuditionId}" names no stored audition`,
    );
  }
}

/** The clip's stored auditions (a copy; [] for old clips). */
export function listAuditions(clip: Clip): ClipAudition[] {
  return (clip.auditions ?? []).map((a) => ({
    ...a,
    override: { ...a.override },
  }));
}

/** The currently active audition, or undefined when the base clip is live. */
export function getActiveAudition(clip: Clip): ClipAudition | undefined {
  if (clip.activeAuditionId === undefined) return undefined;
  return (clip.auditions ?? []).find((a) => a.id === clip.activeAuditionId);
}

/**
 * Add one audition version. The base clip is never mutated and the
 * active selection is unchanged (a newly added version is inert
 * until setActiveAudition picks it). Throws on a duplicate id or an
 * invalid audition.
 */
export function addAudition(clip: Clip, audition: ClipAudition): Clip {
  validateAudition(clip.id, audition);
  const auditions = clip.auditions ?? [];
  if (auditions.some((a) => a.id === audition.id)) {
    throw new Error(`clip ${clip.id}: duplicate audition id "${audition.id}"`);
  }
  return {
    ...clip,
    auditions: [
      ...auditions,
      { ...audition, override: { ...audition.override } },
    ],
  };
}

/**
 * Remove one audition version. Removing the ACTIVE version clears
 * the selection, so the base clip becomes live again (never a
 * dangling activeAuditionId). Throws on an unknown id.
 */
export function removeAudition(clip: Clip, auditionId: string): Clip {
  const auditions = clip.auditions ?? [];
  if (!auditions.some((a) => a.id === auditionId)) {
    throw new Error(`clip ${clip.id}: no audition "${auditionId}" to remove`);
  }
  const next = auditions.filter((a) => a.id !== auditionId);
  const out: Clip = { ...clip, auditions: next };
  if (clip.activeAuditionId === auditionId) delete out.activeAuditionId;
  return out;
}

/** Rename one audition version. Throws on an unknown id or empty name. */
export function renameAudition(clip: Clip, auditionId: string, name: string): Clip {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error(`clip ${clip.id}: rename needs a non-empty name`);
  }
  const auditions = clip.auditions ?? [];
  if (!auditions.some((a) => a.id === auditionId)) {
    throw new Error(`clip ${clip.id}: no audition "${auditionId}" to rename`);
  }
  return {
    ...clip,
    auditions: auditions.map((a) => (a.id === auditionId ? { ...a, name } : a)),
  };
}

/**
 * Patch one audition version: `name` and/or `override` fields are
 * merged over the stored version (override fields merge one level —
 * the stored source/in/out survive a patch that only changes speed).
 * The merged version is revalidated, so a bad patch throws and the
 * clip is returned unchanged. Throws on an unknown id.
 */
export function updateAudition(
  clip: Clip,
  auditionId: string,
  patch: { name?: string; override?: Partial<ClipAuditionOverride> },
): Clip {
  const auditions = clip.auditions ?? [];
  const cur = auditions.find((a) => a.id === auditionId);
  if (!cur) {
    throw new Error(`clip ${clip.id}: no audition "${auditionId}" to update`);
  }
  const next: ClipAudition = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    override: { ...cur.override, ...(patch.override ?? {}) },
  };
  validateAudition(clip.id, next);
  return {
    ...clip,
    auditions: auditions.map((a) => (a.id === auditionId ? next : a)),
  };
}

/**
 * Switch the live version. `null` (or undefined) selects the base
 * clip itself; a string must name a stored audition. Returns a new
 * clip — the base clip and every audition are kept verbatim, so
 * switching back restores the previous version exactly.
 */
export function setActiveAudition(clip: Clip, auditionId: string | null): Clip {
  if (auditionId === null || auditionId === undefined) {
    const out: Clip = { ...clip };
    delete out.activeAuditionId;
    return out;
  }
  if (!(clip.auditions ?? []).some((a) => a.id === auditionId)) {
    throw new Error(`clip ${clip.id}: no audition "${auditionId}" to switch to`);
  }
  return { ...clip, activeAuditionId: auditionId };
}

/**
 * Resolve a clip to its LIVE version: the base clip with the active
 * audition's override applied (or the base clip itself when no
 * audition is active). The result has the audition fields stripped,
 * so it is render-ready and re-resolving is a no-op. The base id is
 * always kept, and track placement (start / transitionIn) survives
 * because overrides cannot carry those keys. Throws when the
 * audition set is invalid (e.g. a dangling activeAuditionId).
 */
export function resolveClip<T extends Clip>(clip: T): T {
  validateAuditions(clip);
  const active = getActiveAudition(clip);
  const { auditions: _auditions, activeAuditionId: _active, ...base } =
    clip as T & { auditions?: ClipAudition[]; activeAuditionId?: string };
  if (!active) return base as T;
  return { ...base, ...active.override } as T;
}

/**
 * Resolve a whole project to its live versions: every legacy clip
 * and every video/audio track clip is resolved (input untouched).
 * Old projects (no auditions anywhere) come back equal in content.
 */
export function resolveProjectAuditions(project: Project): Project {
  if (
    (project.tracks?.video?.length ?? 0) > 0 ||
    (project.tracks?.audio?.length ?? 0) > 0
  ) {
    const video: VideoTrack[] = (project.tracks?.video ?? []).map((t) => ({
      ...t,
      clips: t.clips.map((c) => resolveClip(c)),
    }));
    const audio: AudioTrack[] = (project.tracks?.audio ?? []).map((t) => ({
      ...t,
      clips: t.clips.map((c) => resolveClip(c)),
    }));
    return { ...project, tracks: { video, audio } };
  }
  return { ...project, clips: project.clips.map((c) => resolveClip(c)) };
}

/**
 * Load-time gate for the audition format: validates every clip's
 * audition set (legacy list + all tracks) and returns the project
 * unchanged. An old project — no `auditions` field on any clip —
 * passes through as-is and opens normally; that IS the compat
 * contract (the clip is its own single audition). Throws on any
 * invalid audition set instead of silently repairing it.
 */
export function normalizeProjectAuditions(project: Project): Project {
  for (const c of project.clips ?? []) validateAuditions(c);
  for (const t of project.tracks?.video ?? []) {
    for (const c of t.clips) validateAuditions(c);
  }
  for (const t of project.tracks?.audio ?? []) {
    for (const c of t.clips) validateAuditions(c);
  }
  return project;
}

/**
 * Convert legacy `alternates` (timeline.ts) into named auditions:
 * each alternate becomes "备选 N" with its source/in/out, the base
 * clip stays live, and `alternates` is cleared. Opt-in only — load
 * and export never call this. Throws when the clip already carries
 * auditions (the two mechanisms must not be merged silently). A
 * clip with no alternates is returned unchanged.
 */
export function migrateAlternatesToAuditions(clip: Clip): Clip {
  if ((clip.auditions ?? []).length > 0) {
    throw new Error(
      `clip ${clip.id}: already has auditions — refusing to merge alternates into them`,
    );
  }
  const alts = clip.alternates ?? [];
  if (alts.length === 0) return { ...clip };
  const auditions: ClipAudition[] = alts.map((alt, i) => ({
    id: `aud-${i + 1}`,
    name: `备选 ${i + 1}`,
    override: { source: alt.source, in: alt.in, out: alt.out },
  }));
  for (const a of auditions) validateAudition(clip.id, a);
  const out: Clip = { ...clip, auditions };
  delete out.alternates;
  return out;
}
