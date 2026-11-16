// Video stabilisation (P1, M4): two-pass vidstab (GPL, best quality) and
// single-pass deshake (native libavfilter, LGPL-safe).
// Licence facts (ffmpeg.org/legal.html): libvidstab is listed under "The
// following libraries are under GPL", so BtbN LGPL builds do NOT ship
// vidstabdetect/vidstabtransform — re-check with `ffmpeg -filters` on the
// BtbN LGPL 9.0 build before shipping (M2 gate). deshake, chromakey and
// despill are native libavfilter filters (LGPL part of FFmpeg); they were
// verified present only on this machine's GPL 8.1.2 build so far.
// .trf lifecycle: prepareStabilization() writes one .trf per vidstab clip
// next to the export output; exportProject() deletes them after a
// successful export and keeps them (logging the path) if the export fails.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Clip, Project, StabilizeOptions } from './project.js';

const execFileAsync = promisify(execFile);

/** Normalise `stabilize` (boolean shorthand or options) to full options. */
export function resolveStabilize(
  v: boolean | StabilizeOptions | undefined,
): StabilizeOptions | undefined {
  if (v === undefined || v === false) return undefined;
  if (v === true) return { method: 'vidstab' };
  return { method: 'vidstab', ...v };
}

export function validateStabilize(clip: Clip): StabilizeOptions | undefined {
  const o = resolveStabilize(clip.stabilize);
  if (!o) return undefined;
  if (o.method !== 'vidstab' && o.method !== 'deshake') {
    throw new Error(`clip ${clip.id}: stabilize.method must be 'vidstab' or 'deshake'`);
  }
  if (o.method === 'vidstab' && clip.reverse) {
    // The detect pass reads frames in forward order; reversing the clip
    // afterwards would apply each transform to the wrong frame.
    throw new Error(`clip ${clip.id}: vidstab stabilization cannot be combined with reverse`);
  }
  const range = (name: string, v: number | undefined, lo: number, hi: number) => {
    if (v !== undefined && (v < lo || v > hi)) {
      throw new Error(`clip ${clip.id}: stabilize.${name} ${v} outside [${lo}, ${hi}]`);
    }
  };
  range('smoothing', o.smoothing, 0, 1000);
  range('zoom', o.zoom, -100, 100);
  range('shakiness', o.shakiness, 1, 10);
  range('accuracy', o.accuracy, 1, 15);
  range('deshakeRx', o.deshakeRx, 0, 64);
  range('deshakeRy', o.deshakeRy, 0, 64);
  if (o.optalgo !== undefined && ![0, 1, 2].includes(o.optalgo)) {
    throw new Error(`clip ${clip.id}: stabilize.optalgo must be 0, 1 or 2`);
  }
  return o;
}

/** vidstabtransform filter string for a prepared .trf file. */
export function vidstabTransformFilter(trfPath: string, o: StabilizeOptions): string {
  const quoted = `'${trfPath.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")}'`;
  const parts = [
    `input=${quoted}`,
    `smoothing=${o.smoothing ?? 15}`,
    `optalgo=${o.optalgo ?? 0}`,
  ];
  if (o.zoom !== undefined && o.zoom !== 0) parts.push(`zoom=${o.zoom}`);
  return `vidstabtransform=${parts.join(':')}`;
}

/** deshake filter string (single-pass, no .trf). */
export function deshakeFilter(o: StabilizeOptions): string {
  const edgeMap = { blank: 0, original: 1, clamp: 2, mirror: 3 } as const;
  return (
    `deshake=rx=${o.deshakeRx ?? 16}:ry=${o.deshakeRy ?? 16}` +
    `:edge=${edgeMap[o.deshakeEdge ?? 'mirror']}`
  );
}

/**
 * Pass 1 (vidstabdetect) for one clip: analyse the trimmed source range
 * [clip.in, clip.out) at native fps and write the transforms to `trfPath`.
 * The transform pass later reads exactly these frames in the same order,
 * so the detect input must be the same trimmed range (no speed change,
 * no fps filter here).
 */
export async function runStabilizeDetect(
  clip: Clip,
  trfPath: string,
  o: StabilizeOptions,
  ffmpeg = 'ffmpeg',
): Promise<void> {
  const quoted = `'${trfPath.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")}'`;
  const filter =
    `trim=start=${clip.in}:end=${clip.out},setpts=PTS-STARTPTS,` +
    `vidstabdetect=result=${quoted}:shakiness=${o.shakiness ?? 5}:accuracy=${o.accuracy ?? 15}`;
  await execFileAsync(ffmpeg, [
    '-i', clip.source,
    '-vf', filter,
    '-f', 'null', '-',
  ], { maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Run the detect pass for every vidstab clip in the project.
 * Returns clip index -> .trf path. Files land in `dir` (next to the
 * export output) as `stab-c<i>.trf`.
 */
export async function prepareStabilization(
  project: Project,
  dir: string,
  ffmpeg = 'ffmpeg',
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (let i = 0; i < project.clips.length; i++) {
    const clip = project.clips[i];
    const o = validateStabilize(clip);
    if (!o || o.method !== 'vidstab') continue;
    const trf = join(dir, `stab-c${i}.trf`);
    await runStabilizeDetect(clip, trf, o, ffmpeg);
    out.set(i, trf);
  }
  return out;
}

/** Delete .trf files after a successful export (best-effort). */
export function cleanupStabilization(trfPaths: Iterable<string>): void {
  for (const p of trfPaths) {
    try {
      unlinkSync(p);
    } catch {
      // Already gone or never written — not fatal.
    }
  }
}
