// Background render + render cache (P3 batch 6, M4 §8.6): heavy
// effects segments are pre-rendered once into the project cache
// directory; playback reads the cache file instead of re-rendering.
// Engine layer only — the WPF side owns the background worker
// scheduling and the cache-progress UI.
//
// Design (deliberately boring, reuses the export pipeline):
// - A cache task is one project-time span [start, end) of a project
//   whose transitions are all 'cut' (an xfade span would need the
//   overlap logic re-derived; cache spans are cut-only in v1).
// - renderCacheSegment() slices the project to the span (clips are
//   re-windowed to their overlap with the span; clips outside it are
//   dropped) and exports the slice with exportProject() into
//   <cacheDir>/<hash>.mp4, where <hash> is a stable hash of the span
//   + the sliced project JSON. A second call with the same project
//   and span finds the file, probes its duration, and returns
//   { hit: true } WITHOUT re-rendering — the mtime is untouched, so
//   the test can prove the second call did no work.
// - The cache file is a plain MP4 (libx264 CRF 20, same as the
//   Remix intermediate); playback just opens it. clearRenderCache()
//   deletes the cache files (and only the cache files — it never
//   touches anything outside the cache dir).
// - "Background" here means: the render is a separate export call
//   the caller runs off the UI thread (WPF Task.Run / a worker).
//   The engine does not spawn threads; it provides the unit of work
//   (one segment) and the hit check that makes skipping cheap.
// - Stale detection: the hash covers the sliced project JSON, so any
//   edit inside the span changes the hash and the old file is simply
//   not hit (and is left on disk until clearRenderCache).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Clip, Project } from './project.js';
import { clipDuration, projectDuration } from './project.js';

/** One render-cache task: a project span + its state. */
export interface RenderCacheTask {
  /** Cache key (hash of span + sliced project JSON). */
  id: string;
  /** Project-time span start in seconds. */
  start: number;
  /** Project-time span end in seconds. */
  end: number;
  /** 'pending' = not rendered yet, 'ready' = cache file on disk,
   *  'stale' = a file exists under an old key (kept, not hit). */
  status: 'pending' | 'ready' | 'stale';
  /** Cache file path (set once rendered). */
  file?: string;
}

/** Result of a renderCacheSegment call. */
export interface RenderCacheResult {
  /** True when the file was already on disk and matched (no render). */
  hit: boolean;
  task: RenderCacheTask;
  /** Rendered span duration in seconds (ffprobe-measured). */
  duration: number;
}

/** Cache duration tolerance (seconds) for a hit. */
export const RENDER_CACHE_DURATION_TOLERANCE = 0.05;

export interface RenderCacheOptions {
  ffmpeg?: string;
  ffprobe?: string;
  /** Font file for drawtext (burned-in text). Passed to exportProject. */
  fontfile: string;
  /** Export preset (passed to exportProject). */
  preset: import('./export.js').ExportPreset;
  /** Python binary (portrait/beauty prep only). */
  python?: string;
}

/** Validate a cache span against the project duration. Throws on an
 *  empty, negative, or out-of-range span. */
export function validateCacheSegment(project: Project, start: number, end: number): void {
  const dur = projectDuration(project);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error(`render cache: span [${start}, ${end}) is empty or negative`);
  }
  if (end > dur + 0.05) {
    throw new Error(
      `render cache: span end ${end}s exceeds project duration ${dur.toFixed(3)}s`,
    );
  }
  if (project.transitions.some((t) => t !== 'cut')) {
    throw new Error('render cache: cached spans require all-cut transitions in v1 (xfade overlaps are not sliced)');
  }
}

/** Slice a project to [start, end): keep only the clips overlapping
 *  the span, re-windowed to the overlap. Pure (no I/O). Transition
 *  overlaps are cut-only by validateCacheSegment, so clip boundaries
 *  in the slice are the same as in the project. */
export function sliceProjectForCache(project: Project, start: number, end: number): Project {
  validateCacheSegment(project, start, end);
  // Clip boundaries on the project timeline (cut-only: no overlap).
  const clips: Clip[] = [];
  let t = 0;
  for (const clip of project.clips) {
    const d = clipDuration(clip);
    const cs = t;
    const ce = t + d;
    t = ce;
    const os = Math.max(cs, start);
    const oe = Math.min(ce, end);
    if (oe - os < 1e-6) continue;
    // Map the overlap back to source time. Speed curves / beat-speed
    // make this non-linear in general; v1 slices constant-speed
    // clips only (speedCurve/beatSpeed clips throw — the caller can
    // cache the whole clip instead).
    if ((clip.speedCurve ?? []).length > 0 || clip.beatSpeed) {
      throw new Error(
        `render cache: clip ${clip.id} has a speed curve / beat-speed — slice needs a constant speed in v1`,
      );
    }
    if (clip.reverse || clip.freezeAt !== undefined) {
      throw new Error(
        `render cache: clip ${clip.id} uses reverse/freeze — slicing is not supported for it in v1`,
      );
    }
    const srcStart = clip.in + (os - cs) * clip.speed;
    const srcEnd = clip.in + (oe - cs) * clip.speed;
    clips.push({ ...clip, in: srcStart, out: srcEnd });
  }
  if (clips.length === 0) {
    throw new Error(`render cache: span [${start}, ${end}) covers no clip`);
  }
  return {
    ...project,
    clips,
    transitions: new Array(Math.max(0, clips.length - 1)).fill('cut') as Project['transitions'],
  };
}

/** Stable cache key for a span: hash of the sliced project JSON +
 *  the span. Any edit inside the span changes the key. */
export function renderCacheKey(project: Project, start: number, end: number): string {
  const sliced = sliceProjectForCache(project, start, end);
  const hash = createHash('sha256');
  hash.update(JSON.stringify({ start, end, project: sliced }));
  return hash.digest('hex').slice(0, 16);
}

export function renderCacheFile(cacheDir: string, key: string): string {
  return join(cacheDir, `${key}.mp4`);
}

/**
 * Render one span into the cache (or hit it). The export is done by
 * dynamically importing exportProject — rendercache.ts must not be
 * imported by export.ts (no cycle: export -> rendercache is one-way
 * in the other direction at the call site; the dynamic import keeps
 * this module loadable on its own).
 */
export async function renderCacheSegment(
  project: Project,
  start: number,
  end: number,
  cacheDir: string,
  opts: RenderCacheOptions,
): Promise<RenderCacheResult> {
  const key = renderCacheKey(project, start, end);
  const file = renderCacheFile(cacheDir, key);
  mkdirSync(cacheDir, { recursive: true });
  if (existsSync(file)) {
    const { probe } = await import('./export.js');
    const actual = await probe(file, opts.ffprobe);
    if (Math.abs(actual.duration - (end - start)) <= RENDER_CACHE_DURATION_TOLERANCE) {
      return {
        hit: true,
        task: { id: key, start, end, status: 'ready', file },
        duration: actual.duration,
      };
    }
    // Duration mismatch: the file is stale (wrong content under this
    // key — should not happen, but never serve a wrong-length cache).
    return {
      hit: false,
      task: { id: key, start, end, status: 'stale', file },
      duration: actual.duration,
    };
  }
  const sliced = sliceProjectForCache(project, start, end);
  const { exportProject } = await import('./export.js');
  const report = await exportProject(sliced, file, {
    fontfile: opts.fontfile,
    preset: opts.preset,
    ffmpeg: opts.ffmpeg,
    ffprobe: opts.ffprobe,
    python: opts.python,
  });
  return {
    hit: false,
    task: { id: key, start, end, status: 'ready', file },
    duration: report.actual.duration,
  };
}

/** Delete every cache file in the cache dir (only *.mp4 files the
 *  cache owns). Returns the number of files removed. */
export function clearRenderCache(cacheDir: string): number {
  if (!existsSync(cacheDir)) return 0;
  let removed = 0;
  for (const name of readdirSync(cacheDir)) {
    if (!name.endsWith('.mp4')) continue;
    rmSync(join(cacheDir, name));
    removed++;
  }
  return removed;
}
