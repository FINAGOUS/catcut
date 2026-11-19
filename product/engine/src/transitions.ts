// Per-junction transition model (W10, M4 §2 转场库) — LEGACY path.
//
// The multitrack timeline already has a per-clip model
// (CrossTrackTransition { type, duration } on VideoTrackClip,
// transitionIn — see project.ts): arrivals there are per-clip and
// rendered with xfade/acrossfade. The LEGACY single-track list had
// no equivalent: one global transitionDuration for every junction
// and a type-only array — and a transition longer than its clips
// silently corrupted the export (2.5 s transition on 2 s clips:
// no failure, 0.50 s duration error — probed 2026-11-19). This
// module is the per-junction model for the legacy path: each
// junction carries its own type AND duration, the graph renders
// them, and the validator rejects what FFmpeg would silently
// mangle. normalizeToTracks converts this field into per-clip
// transitionIn, so the durations survive the legacy -> track
// conversion with the total duration preserved exactly.
//
// Library: 5 curated presets (xfade 为主 + 其余 4 种). The engine
// still accepts all 8 verified xfade types (see TransitionType in
// project.ts — wiperight / circleopen / fadeblack keep working);
// the library is the UI-facing preset set, not a restriction.
// M4's "12 常用转场" target is NOT claimed here: 5 in the library,
// 8 in the engine, the other 4 still to be added + verified.

import {
  clipDuration,
  hasTracks,
  resolveTransitionDurations,
  type Project,
  type TransitionType,
} from './project.js';

/** Re-exported for graph builders that only import this module. */
export { resolveTransitionDurations } from './project.js';

/** Per-junction transition duration bounds, seconds (same range the
 *  template validator already used: templates.ts checkNumber 0.1..5). */
export const TRANSITION_DURATION_MIN = 0.1;
export const TRANSITION_DURATION_MAX = 5;

/** Every transition type the engine can render (must match the
 *  TransitionType union in project.ts and XFADE_TRANSITIONS in
 *  filtergraph.ts — the validator below checks against this list). */
export const TRANSITION_TYPES: readonly TransitionType[] = [
  'cut',
  'fade',
  'dissolve',
  'wipeleft',
  'wiperight',
  'slideleft',
  'circleopen',
  'fadeblack',
  'fadewhite',
];

/** One junction of the per-junction model: type + its own duration. */
export interface TransitionSpec {
  type: TransitionType;
  duration: number;
}

/** One entry of the curated 5-type transition library. */
export interface TransitionLibraryEntry {
  /** Project-level id (a TransitionType). */
  id: TransitionType;
  /** Chinese label for the UI. */
  label: string;
  /** FFmpeg xfade transition name (see XFADE_TRANSITIONS). */
  xfade: string;
  /** Default duration in seconds when the user picks this preset. */
  defaultDuration: number;
  description: string;
}

/**
 * The W10 transition library — 5 presets. dissolve is the canonical
 * crossfade and the recommended default (xfade 为主); fade is the
 * classic fade in/out; wipeleft is the 划像 wipe; slideleft is the
 * 推入 push; fadewhite is the 闪白 flash (M4 lists 闪白 explicitly).
 * All five are frame-proven in test/verify-transitions.mjs — midpoint
 * frame differs from a hard cut in the expected direction.
 */
export const TRANSITION_LIBRARY: readonly TransitionLibraryEntry[] = [
  {
    id: 'dissolve',
    label: '溶解',
    xfade: 'dissolve',
    defaultDuration: 0.5,
    description: '前后画面交叉淡化，最通用的转场；xfade 的标准交叉溶解，主推。',
  },
  {
    id: 'fade',
    label: '淡入淡出',
    xfade: 'fade',
    defaultDuration: 0.5,
    description: '旧画面淡出、新画面淡入，节奏舒缓，适合段落切换。',
  },
  {
    id: 'wipeleft',
    label: '划像',
    xfade: 'wipeleft',
    defaultDuration: 0.5,
    description: '分界线扫过画面，新画面从一侧划入，干脆利落。',
  },
  {
    id: 'slideleft',
    label: '推入',
    xfade: 'slideleft',
    defaultDuration: 0.5,
    description: '新画面把旧画面横向推出去，动感强，适合卡点。',
  },
  {
    id: 'fadewhite',
    label: '闪白',
    xfade: 'fadewhite',
    defaultDuration: 0.5,
    description: '经白色闪过再切到新画面，闪白转场，适合高光/换场。',
  },
];

export const TRANSITION_LIBRARY_IDS: readonly TransitionType[] =
  TRANSITION_LIBRARY.map((e) => e.id);

/** Library entry by id, or undefined for a non-library type. */
export function libraryEntry(id: TransitionType): TransitionLibraryEntry | undefined {
  return TRANSITION_LIBRARY.find((e) => e.id === id);
}

/**
 * Zip a project into per-junction specs (type + resolved duration).
 * Length = transitions.length. A 'cut' spec keeps its listed duration
 * for display, but the render ignores it (a cut never overlaps).
 */
export function transitionSpecs(project: Project): TransitionSpec[] {
  const durs = resolveTransitionDurations(project);
  return project.transitions.map((type, k) => ({ type, duration: durs[k] }));
}

/**
 * Validate a legacy project's transitions. Multitrack projects are
 * skipped: their legacy transitions are validateMultitrackProject's
 * business (it rejects any non-'cut' entry). Throws on the first
 * problem:
 * - transitions.length !== clips.length - 1
 * - transitionDurations present with the wrong length, or a
 *   non-finite entry
 * - unknown transition type
 * - a non-'cut' junction whose duration is outside 0.1..5 s, or
 *   longer than the shorter of its two adjacent clips (xfade would
 *   silently corrupt the export past that point — see module header).
 * A 'cut' junction's duration is never range/length-checked: a cut
 * ignores duration entirely, so a stale value there must not fail a
 * project that renders fine. Called by buildFilterGraph on the legacy
 * path before any chain is built, so bad transitions fail fast
 * instead of producing a wrong-length file.
 */
export function validateTransitions(project: Project): void {
  if (hasTracks(project)) return;
  const n = project.clips.length;
  const want = Math.max(0, n - 1);
  if (project.transitions.length !== want) {
    throw new Error(
      `project has ${n} clips but ${project.transitions.length} transitions (want ${want})`,
    );
  }
  if (project.transitionDurations !== undefined) {
    if (project.transitionDurations.length !== project.transitions.length) {
      throw new Error(
        `project has ${project.transitions.length} transitions but ` +
          `${project.transitionDurations.length} transitionDurations`,
      );
    }
    for (let k = 0; k < project.transitionDurations.length; k++) {
      const d = project.transitionDurations[k];
      if (!Number.isFinite(d)) {
        throw new Error(`transition ${k}: transitionDurations[${k}] is not a finite number`);
      }
    }
  }
  const durs = resolveTransitionDurations(project);
  const known = new Set<string>(TRANSITION_TYPES);
  project.transitions.forEach((type, k) => {
    if (!known.has(type)) {
      throw new Error(`transition ${k}: unknown transition type ${JSON.stringify(type)}`);
    }
    if (type === 'cut') return;
    const d = durs[k];
    if (d < TRANSITION_DURATION_MIN || d > TRANSITION_DURATION_MAX) {
      throw new Error(
        `transition ${k} (${type}): duration ${d} outside ` +
          `[${TRANSITION_DURATION_MIN}, ${TRANSITION_DURATION_MAX}] seconds`,
      );
    }
    const shorter = Math.min(clipDuration(project.clips[k]), clipDuration(project.clips[k + 1]));
    if (d > shorter) {
      throw new Error(
        `transition ${k} (${type}): duration ${d} longer than the shorter ` +
          `adjacent clip (${shorter.toFixed(3)}s); xfade would corrupt the export`,
      );
    }
  });
}
