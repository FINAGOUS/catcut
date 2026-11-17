// Project & media management (P3 batch 6, M4 §8.1, lines 107-112):
// media bins + smart selection + keywords/favourites/rejected,
// metadata panel + ALE export, subclips, autosave + crash recovery,
// archive/consolidate + offline relink, ingest (copy/transcode/
// watch folder). Engine layer only — the WPF side owns the media
// pool panel, the metadata editor UI, the autosave timer and the
// crash-recovery prompt at startup.
//
// What the engine does here is the model + the file work. Nothing
// in this file touches the network, the registry, or the UI.
// - A MediaItem is one source file in the library. A subclip is a
//   MediaItem with kind 'subclip' that references its parent by
//   `parentId` and stores in/out — it never copies the file.
// - ALE (Avid Log Exchange) is a plain-text interchange format: the
//   exporter writes one line per item (name, tape, start/end,
//   duration, scene, take, keywords, comments). It is deliberately
//   minimal — ALE has many columns, and the columns emitted here are
//   the ones Resolve/Premiere read for a basic relink. A missing
//   required field (name or file) throws instead of writing a bad
//   line.
// - Autosave: writeAutosaveBackup() writes a timestamped
//   project-autosave-<ts>.json next to the project; markUncleanExit()
//   writes a `.unclean` flag file (the WPF side calls it when the
//   process exits abnormally — the engine cannot detect its own
//   crash); detectCrashRecovery() reports { crashed, backup } when
//   the flag exists AND a backup exists. clearUncleanExit() removes
//   the flag after a clean start or a successful recovery.
// - Archive: archiveProject() copies every used source file (+ its
//   proxy / optimized media, when present) and the project JSON into
//   one folder, rewriting the project copy's paths to relative ones
//   so the folder opens on its own. Files outside the project are
//   left alone.
// - Relink: relinkOfflineMedia() scans a folder for files whose
//   basename matches a missing source (and whose duration matches
//   within 0.1 s when the original duration is known) and rewrites
//   the clip sources. An ambiguous match (two files, same name)
//   throws instead of guessing.
// - Ingest: ingestMedia() either copies a file into the project
//   media folder or transcodes it to DNxHR (optimized.ts) / a 720p
//   proxy (proxy.ts); scanWatchFolder() lists files in a folder that
//   are not yet in the library (by basename), so the WPF watcher can
//   offer them for import.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Clip, Project } from './project.js';

const execFileAsync = promisify(execFile);

/** One item in the media library. */
export interface MediaItem {
  /** Stable id (caller-assigned, e.g. `m1`). */
  id: string;
  /** Display name (defaults to the file basename when unset). */
  name?: string;
  /** Path to the source file. Subclips share their parent's file. */
  file: string;
  /** 'media' = a real file, 'subclip' = an in/out range of a parent. */
  kind: 'media' | 'subclip';
  /** Parent item id (subclips only). */
  parentId?: string;
  /** Subclip in/out in SOURCE seconds (subclips only). */
  in?: number;
  out?: number;
  /** Bin / folder name (e.g. 'A-cam', 'B-roll'). */
  bin?: string;
  /** Keywords for search / smart bins. */
  keywords?: string[];
  /** Rating 0..5 (0 = unrated). */
  rating?: number;
  /** Favourite flag (starred in the pool). */
  favorite?: boolean;
  /** Rejected flag (Resolve-style "rejected" — hidden from smart
   *  bins unless the rule asks for it). */
  rejected?: boolean;
  /** Camera / device the footage came from (e.g. 'XT4', 'iPhone'). */
  camera?: string;
  /** Media type, derived from the extension when unset. */
  mediaType?: 'video' | 'audio' | 'image' | 'other';
  /** Duration in seconds (probed at ingest when known). */
  duration?: number;
  /** Free-form metadata (scene / take / notes). */
  metadata?: MediaMetadata;
}

/** Clip-level metadata, stored in project.json (ALE-exportable). */
export interface MediaMetadata {
  /** Scene number / name. */
  scene?: string;
  /** Take number. */
  take?: string;
  /** Free-form notes. */
  notes?: string;
  /** Extra keywords (merged with item.keywords on ALE export). */
  keywords?: string[];
}

/** Smart-bin / filter rule: every set field must match. */
export interface MediaFilterRule {
  bin?: string;
  keyword?: string;
  /** Minimum rating (inclusive). */
  minRating?: number;
  favorite?: boolean;
  rejected?: boolean;
  mediaType?: MediaItem['mediaType'];
  camera?: string;
}

export const MEDIA_RATING_MIN = 0;
export const MEDIA_RATING_MAX = 5;
/** Relink duration tolerance (seconds). */
export const RELINK_DURATION_TOLERANCE = 0.1;

/** Derive the media type from a file extension. */
export function mediaTypeOf(file: string): MediaItem['mediaType'] {
  const ext = extname(file).toLowerCase();
  if (['.mp4', '.mov', '.mkv', '.avi', '.webm'].includes(ext)) return 'video';
  if (['.wav', '.mp3', '.aac', '.flac', '.m4a'].includes(ext)) return 'audio';
  if (['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) return 'image';
  return 'other';
}

/** Validate one media item. Throws on a missing id/file, a bad
 *  rating, a subclip without parent/in/out, or an in >= out range. */
export function validateMediaItem(item: MediaItem): MediaItem {
  if (!item.id || typeof item.id !== 'string') {
    throw new Error('media item needs a non-empty string id');
  }
  if (!item.file || typeof item.file !== 'string') {
    throw new Error(`media item ${item.id}: file is required`);
  }
  if (item.kind !== 'media' && item.kind !== 'subclip') {
    throw new Error(`media item ${item.id}: kind must be "media" or "subclip"`);
  }
  if (item.kind === 'subclip') {
    if (!item.parentId) throw new Error(`media item ${item.id}: subclip needs a parentId`);
    if (item.in === undefined || item.out === undefined) {
      throw new Error(`media item ${item.id}: subclip needs in/out`);
    }
    if (item.in < 0 || item.out <= item.in) {
      throw new Error(`media item ${item.id}: subclip in/out [${item.in}, ${item.out}) is empty or negative`);
    }
  }
  if (item.rating !== undefined && (item.rating < MEDIA_RATING_MIN || item.rating > MEDIA_RATING_MAX || !Number.isInteger(item.rating))) {
    throw new Error(`media item ${item.id}: rating ${item.rating} outside [${MEDIA_RATING_MIN}, ${MEDIA_RATING_MAX}] (integer)`);
  }
  return item;
}

/** Validate a whole library (duplicate ids throw). */
export function validateMediaLibrary(items: MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  for (const item of items ?? []) {
    validateMediaItem(item);
    if (seen.has(item.id)) throw new Error(`duplicate media item id "${item.id}"`);
    seen.add(item.id);
  }
  return items;
}

/** Filter a library by a smart-bin rule. Returns the matching items
 *  in library order. An empty rule matches everything. */
export function filterMediaLibrary(items: MediaItem[], rule: MediaFilterRule): MediaItem[] {
  return (items ?? []).filter((item) => {
    if (rule.bin !== undefined && item.bin !== rule.bin) return false;
    if (rule.keyword !== undefined) {
      const keys = [...(item.keywords ?? []), ...(item.metadata?.keywords ?? [])];
      if (!keys.includes(rule.keyword)) return false;
    }
    if (rule.minRating !== undefined && (item.rating ?? 0) < rule.minRating) return false;
    if (rule.favorite !== undefined && (item.favorite ?? false) !== rule.favorite) return false;
    if (rule.rejected !== undefined && (item.rejected ?? false) !== rule.rejected) return false;
    if (rule.mediaType !== undefined && (item.mediaType ?? mediaTypeOf(item.file)) !== rule.mediaType) return false;
    if (rule.camera !== undefined && item.camera !== rule.camera) return false;
    return true;
  });
}

/**
 * Create a subclip from a library item: a new MediaItem that
 * references the parent's file with an in/out range. The file is
 * NOT copied — the subclip only stores the reference. Throws when
 * the parent is missing, is itself a subclip (no subclip-of-subclip
 * in v1), or the range is empty / outside the parent's duration
 * (when the parent duration is known).
 */
export function createSubclip(
  items: MediaItem[],
  parentId: string,
  id: string,
  name: string,
  start: number,
  end: number,
): MediaItem {
  const parent = (items ?? []).find((i) => i.id === parentId);
  if (!parent) throw new Error(`subclip: parent media item "${parentId}" not found`);
  if (parent.kind === 'subclip') {
    throw new Error(`subclip: parent "${parentId}" is itself a subclip — subclip-of-subclip is not supported in v1`);
  }
  if ((items ?? []).some((i) => i.id === id)) {
    throw new Error(`subclip: id "${id}" is already used in the library`);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error(`subclip: range [${start}, ${end}) is empty or negative`);
  }
  if (parent.duration !== undefined && end > parent.duration + 0.05) {
    throw new Error(
      `subclip: end ${end}s exceeds parent duration ${parent.duration.toFixed(3)}s`,
    );
  }
  return {
    id,
    name,
    file: parent.file,
    kind: 'subclip',
    parentId,
    in: start,
    out: end,
    bin: parent.bin,
    keywords: parent.keywords ? [...parent.keywords] : undefined,
    camera: parent.camera,
    mediaType: parent.mediaType ?? mediaTypeOf(parent.file),
    duration: end - start,
  };
}

/** Format a duration as ALE timecode-ish "HH:MM:SS:FF" at 30 fps
 *  (ALE timecode is frame-based; the frame count here is derived
 *  from the seconds value, not from a real timecode track). */
export function aleTimecode(seconds: number, fps = 30): string {
  const totalFrames = Math.round(seconds * fps);
  const ff = totalFrames % fps;
  const s = Math.floor(totalFrames / fps) % 60;
  const m = Math.floor(totalFrames / (fps * 60)) % 60;
  const h = Math.floor(totalFrames / (fps * 3600));
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(ff)}`;
}

const ALE_HEADER = [
  'Heading',
  'FIELD_DELIM\tTABS',
  'VIDEO_FORMAT\t1080',
  'AUDIO_FORMAT\t48kHz',
  '',
  'Column',
  'Name\tTape\tStart\tEnd\tDuration\tScene\tTake\tKeywords\tComments',
  '',
  'Data',
].join('\n');

/**
 * Export the library as ALE text (Avid Log Exchange, tab-delimited).
 * One line per item; subclips export their in/out range, media items
 * export 00:00:00:00 to their duration (or 00:00:00:00 when the
 * duration is unknown). Throws when an item has no name/file — a bad
 * line would break the receiving app's import.
 */
export function toALE(items: MediaItem[]): string {
  const lines: string[] = [ALE_HEADER];
  for (const item of items ?? []) {
    validateMediaItem(item);
    const name = item.name ?? basename(item.file);
    const tape = item.camera ?? '';
    const start = item.kind === 'subclip' ? aleTimecode(item.in ?? 0) : '00:00:00:00';
    const end = item.kind === 'subclip'
      ? aleTimecode(item.out ?? 0)
      : (item.duration !== undefined ? aleTimecode(item.duration) : '00:00:00:00');
    const dur = item.duration !== undefined ? aleTimecode(item.duration) : '';
    const keywords = [...(item.keywords ?? []), ...(item.metadata?.keywords ?? [])].join(';');
    const comments = item.metadata?.notes ?? '';
    lines.push([
      name, tape, start, end, dur,
      item.metadata?.scene ?? '', item.metadata?.take ?? '',
      keywords, comments,
    ].join('\t'));
  }
  lines.push('');
  return lines.join('\n');
}

// ------------------------------------------------------------------
// Autosave + crash recovery
// ------------------------------------------------------------------

export const AUTOSAVE_PREFIX = 'project-autosave-';
export const UNCLEAN_FLAG = '.unclean';

/** Write a timestamped autosave backup of the project JSON into
 *  `dir`. Returns the backup path. The caller (WPF timer) decides
 *  the cadence; the engine only writes the file. */
export function writeAutosaveBackup(project: Project, dir: string, now = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${AUTOSAVE_PREFIX}${ts}.json`);
  writeFileSync(file, JSON.stringify(project, null, 2), 'utf8');
  return file;
}

/** Mark the session as uncleanly exited (the WPF side writes this
 *  when the process dies without a clean shutdown — the engine
 *  cannot detect its own crash). */
export function markUncleanExit(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const flag = join(dir, UNCLEAN_FLAG);
  writeFileSync(flag, new Date().toISOString(), 'utf8');
  return flag;
}

/** Remove the unclean flag (clean start, or after a recovery). */
export function clearUncleanExit(dir: string): void {
  const flag = join(dir, UNCLEAN_FLAG);
  if (existsSync(flag)) rmSync(flag);
}

/** Latest autosave backup in `dir`, or undefined when there is none. */
export function latestAutosaveBackup(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const names = readdirSync(dir)
    .filter((n) => n.startsWith(AUTOSAVE_PREFIX) && n.endsWith('.json'))
    .sort();
  return names.length > 0 ? join(dir, names[names.length - 1]) : undefined;
}

/** Crash-recovery check at startup: crashed is true only when the
 *  unclean flag exists AND a backup exists. A flag with no backup
 *  (or a backup with no flag) is not a recovery — the caller must
 *  not offer to restore from nothing. */
export function detectCrashRecovery(dir: string): { crashed: boolean; backup?: string } {
  const flag = existsSync(join(dir, UNCLEAN_FLAG));
  const backup = latestAutosaveBackup(dir);
  if (flag && backup) return { crashed: true, backup };
  return { crashed: false };
}

/** Read a backup file back into a Project (validates the JSON parses
 *  and looks like a project). */
export function readAutosaveBackup(file: string): Project {
  const data = JSON.parse(readFileSync(file, 'utf8')) as Project;
  if (!data || typeof data !== 'object' || !Array.isArray((data as Project).clips)) {
    throw new Error(`autosave backup ${file} is not a project (no clips array)`);
  }
  return data;
}

// ------------------------------------------------------------------
// Archive / consolidate + offline relink
// ------------------------------------------------------------------

export interface ArchiveResult {
  /** Destination folder. */
  dir: string;
  /** Files copied (sources + proxies + optimized media). */
  copied: string[];
  /** Path of the rewritten project JSON in the archive. */
  projectFile: string;
}

/** Copy a file, creating the destination directory as needed. */
function copyInto(src: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, basename(src));
  copyFileSync(src, dest);
  return dest;
}

/**
 * Archive a project: copy every used source file (+ each clip's
 * proxy and optimized media, when present) and the project JSON into
 * `destDir`, rewriting the archived project's paths to relative
 * ones so the folder opens on its own. Missing sources throw
 * (an archive with holes is worse than no archive). Returns the
 * copied files and the archived project path.
 */
export function archiveProject(project: Project, destDir: string): ArchiveResult {
  mkdirSync(destDir, { recursive: true });
  const mediaDir = join(destDir, 'media');
  const copied: string[] = [];
  const remap = new Map<string, string>();
  const copyOnce = (file: string): string => {
    if (remap.has(file)) return remap.get(file) as string;
    if (!existsSync(file)) {
      throw new Error(`archive: source file missing: ${file} — refusing to archive with holes`);
    }
    const dest = copyInto(file, mediaDir);
    copied.push(dest);
    const rel = relative(destDir, dest);
    remap.set(file, rel);
    return rel;
  };
  const clips: Clip[] = project.clips.map((clip) => {
    const next: Clip = { ...clip, source: copyOnce(clip.source) };
    if (clip.proxy) next.proxy = { ...clip.proxy, file: copyOnce(clip.proxy.file) };
    if (clip.optimizedMedia) {
      next.optimizedMedia = { ...clip.optimizedMedia, file: copyOnce(clip.optimizedMedia.file) };
    }
    if (clip.multicam) {
      next.multicam = {
        ...clip.multicam,
        angles: clip.multicam.angles.map((a) => copyOnce(a)),
      };
    }
    return next;
  });
  const archived: Project = { ...project, clips };
  const projectFile = join(destDir, 'project.json');
  writeFileSync(projectFile, JSON.stringify(archived, null, 2), 'utf8');
  return { dir: destDir, copied, projectFile };
}

async function probeDuration(file: string, ffprobe: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
    ]);
    const d = Number(stdout.trim());
    return Number.isFinite(d) ? d : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Relink offline media: for every clip whose source file is missing,
 * scan `searchDir` for a file with the same basename; when the
 * library knows the original duration, the candidate's duration
 * must match within 0.1 s. Returns the relinked project + a report.
 * An ambiguous match (two files with the same basename in the
 * folder) throws instead of guessing; a clip with no match is left
 * missing and listed in `unmatched` (the caller decides whether to
 * keep looking).
 */
export async function relinkOfflineMedia(
  project: Project,
  searchDir: string,
  opts: { ffprobe?: string; library?: MediaItem[] } = {},
): Promise<{ project: Project; relinked: { clipId: string; from: string; to: string }[]; unmatched: string[] }> {
  const ffprobe = opts.ffprobe ?? 'ffprobe';
  const durations = new Map<string, number>();
  for (const item of opts.library ?? []) {
    if (item.duration !== undefined) durations.set(basename(item.file), item.duration);
  }
  const names = existsSync(searchDir) ? readdirSync(searchDir) : [];
  const byName = new Map<string, string[]>();
  for (const name of names) {
    const list = byName.get(name) ?? [];
    list.push(join(searchDir, name));
    byName.set(name, list);
  }
  const relinked: { clipId: string; from: string; to: string }[] = [];
  const unmatched: string[] = [];
  const clips: Clip[] = [];
  for (const clip of project.clips) {
    if (existsSync(clip.source)) {
      clips.push(clip);
      continue;
    }
    const base = basename(clip.source);
    const candidates = byName.get(base) ?? [];
    if (candidates.length === 0) {
      unmatched.push(clip.id);
      clips.push(clip);
      continue;
    }
    if (candidates.length > 1) {
      throw new Error(
        `relink: ambiguous match for clip ${clip.id} (${base}): ${candidates.length} files named ${base} in ${searchDir} — refusing to guess`,
      );
    }
    const candidate = candidates[0];
    const expected = durations.get(base);
    if (expected !== undefined) {
      const actual = await probeDuration(candidate, ffprobe);
      if (actual !== undefined && Math.abs(actual - expected) > RELINK_DURATION_TOLERANCE) {
        throw new Error(
          `relink: candidate ${candidate} duration ${actual.toFixed(3)}s does not match expected ${expected.toFixed(3)}s for clip ${clip.id} — refusing to relink the wrong file`,
        );
      }
    }
    relinked.push({ clipId: clip.id, from: clip.source, to: candidate });
    clips.push({ ...clip, source: candidate });
  }
  return { project: { ...project, clips }, relinked, unmatched };
}

// ------------------------------------------------------------------
// Ingest (copy / transcode / watch folder)
// ------------------------------------------------------------------

export interface IngestOptions {
  /** Copy the file into the media folder (default true). */
  copy?: boolean;
  /** Transcode on ingest: 'dnxhr' = DNxHR optimized media,
   *  'proxy' = 720p proxy, 'none' = no transcode. */
  transcode?: 'dnxhr' | 'proxy' | 'none';
  ffmpeg?: string;
  ffprobe?: string;
}

export interface IngestResult {
  item: MediaItem;
  /** Path of the copied/transcoded file in the media folder. */
  file: string;
  /** Transcoded sidecar file (optimized media / proxy), if any. */
  transcoded?: string;
}

/**
 * Ingest one file into the project media folder: copy it in (or
 * reference it in place when copy is false), optionally transcode
 * it to DNxHR optimized media or a 720p proxy, and return the
 * library item. The duration is probed when possible (unknown when
 * the probe fails — the item is still returned, duration undefined).
 */
export async function ingestMedia(
  source: string,
  mediaDir: string,
  id: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  if (!existsSync(source)) {
    throw new Error(`ingest: source file missing: ${source}`);
  }
  mkdirSync(mediaDir, { recursive: true });
  const doCopy = opts.copy ?? true;
  const dest = doCopy ? copyInto(source, mediaDir) : source;
  let transcoded: string | undefined;
  const transcode = opts.transcode ?? 'none';
  if (transcode === 'dnxhr') {
    const { generateOptimizedMedia } = await import('./optimized.js');
    const info = await generateOptimizedMedia(dest, join(mediaDir, `${basename(dest, extname(dest))}.optimized.mov`), {
      ffmpeg: opts.ffmpeg,
      ffprobe: opts.ffprobe,
    });
    transcoded = info.file;
  } else if (transcode === 'proxy') {
    const { generateProxy } = await import('./proxy.js');
    const info = await generateProxy(dest, join(mediaDir, `${basename(dest, extname(dest))}.proxy.mp4`), {
      ffmpeg: opts.ffmpeg,
      ffprobe: opts.ffprobe,
    });
    transcoded = info.file;
  } else if (transcode !== 'none') {
    throw new Error(`ingest: unknown transcode "${transcode}" — use "dnxhr", "proxy" or "none"`);
  }
  let duration: number | undefined;
  try {
    duration = await probeDuration(dest, opts.ffprobe ?? 'ffprobe');
  } catch {
    duration = undefined;
  }
  const item: MediaItem = {
    id,
    name: basename(dest),
    file: dest,
    kind: 'media',
    mediaType: mediaTypeOf(dest),
    duration,
  };
  validateMediaItem(item);
  return { item, file: dest, transcoded };
}

/**
 * Scan a watch folder for files not yet in the library (matched by
 * basename). Returns the new file paths — the WPF watcher calls
 * ingestMedia() on each one the user accepts. Pure directory scan;
 * no files are imported by this call.
 */
export function scanWatchFolder(watchDir: string, known: MediaItem[]): string[] {
  if (!existsSync(watchDir)) return [];
  const knownNames = new Set((known ?? []).map((i) => basename(i.file)));
  return readdirSync(watchDir)
    .map((n) => join(watchDir, n))
    .filter((p) => {
      try {
        return statSync(p).isFile() && !knownNames.has(basename(p));
      } catch {
        return false;
      }
    });
}

export function mediaLibraryDir(projectDir: string): string {
  return join(projectDir, 'media');
}
