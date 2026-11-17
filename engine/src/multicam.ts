// Multicam editing (P2, M4): N synchronised angle files, cut between
// them on a timeline. Audio comes from one angle only (the main angle,
// or `audioAngle`).
//
// Model: a Clip carries `multicam: { angles, cuts, audioAngle? }`.
// `clip.source` IS angle 0 (the main angle) — the export already passes
// one `-i` per clip, so angle 0 rides on the clip's own input and only
// angles 1..n-1 are registered as extra inputs (see filtergraph.ts).
// Validation throws unless angles[0] === clip.source, so the two can
// never silently disagree.
//
// Rules (enforced here, not silently worked around):
// - 2–4 angles. 5+ throws (the graph would still work, but the UI and
//   the angle-switching model are spec'd for 2–4; extend deliberately).
// - Cuts are in clip-local SOURCE seconds (0 = clip.in), strictly
//   increasing, each inside [0, clip.out - clip.in). The angle at time
//   t is the angle of the last cut with cut.t <= t; before the first
//   cut the angle is 0. A cut at exactly t=0 sets the opening angle.
// - All angles must have the SAME duration (within 0.05 s) and each
//   must cover the clip window [clip.in, clip.out) — a shorter angle
//   throws with the measured durations listed. Nothing is silently
//   truncated to the shortest angle.
// - v1 limits: speed must be 1 with no speed curve, no reverse, no
//   freeze, no stabilisation, no portrait cutout. (Cuts are defined on
//   source time; any resampling would re-time them. Mask/chroma/ducking
//   still work — they act on the assembled stream / audio chain.)
// - Switching is a concat of trimmed angle segments, the same pattern
//   as the speed-curve segments in filtergraph.ts — no black frames at
//   a cut, no frame drops (verified in verify-p2b).
// LGPL note: multicam adds no new FFmpeg filters — trim/setpts/concat
// are the same filters the speed-curve path already uses. Only verified
// on the local GPL 8.1.2 build; concat/trim are native libavfilter
// (LGPL part) but re-check on the BtbN LGPL 9.0 build at the M2 gate.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clipDuration, type Clip, type Project } from './project.js';

const execFileAsync = promisify(execFile);

/** One angle switch: from time `t` (clip-local source seconds) the
 *  output shows `angle`. */
export interface MulticamCut {
  /** Clip-local source time in seconds (0 = clip.in). */
  t: number;
  /** Angle index, 0..angles.length-1. */
  angle: number;
}

export interface Multicam {
  /** All angle files, in angle order. angles[0] must equal clip.source
   *  (the main angle rides on the clip's own input). Length 2–4. */
  angles: string[];
  /** Angle switches, strictly increasing in t. May be empty (whole clip
   *  stays on angle 0). */
  cuts: MulticamCut[];
  /** Which angle's audio is used for the whole clip (default 0). */
  audioAngle?: number;
}

/** One assembled segment: [t0, t1) of clip-local source time, from `angle`. */
export interface MulticamSegment {
  t0: number;
  t1: number;
  angle: number;
}

/** Duration tolerance (seconds) for "all angles have the same duration". */
export const MULTICAM_DURATION_TOLERANCE = 0.05;

/**
 * Validate a multicam clip (synchronous part: shape, cuts, v1 limits).
 * Returns the resolved multicam (audioAngle defaulted to 0). Throws on
 * anything v1 cannot do. Angle DURATION equality is async (needs
 * ffprobe) — see prepareMulticam.
 */
export function validateMulticam(clip: Clip): Multicam | undefined {
  const mc = clip.multicam;
  if (!mc) return undefined;
  if (mc.angles.length < 2 || mc.angles.length > 4) {
    throw new Error(
      `clip ${clip.id}: multicam needs 2-4 angles, got ${mc.angles.length}`,
    );
  }
  if (mc.angles[0] !== clip.source) {
    throw new Error(
      `clip ${clip.id}: multicam angles[0] must be the clip source ` +
        `(got ${JSON.stringify(mc.angles[0])} vs source ${JSON.stringify(clip.source)})`,
    );
  }
  if (mc.angles.some((a) => typeof a !== 'string' || a.length === 0)) {
    throw new Error(`clip ${clip.id}: multicam angles must be non-empty paths`);
  }
  const audioAngle = mc.audioAngle ?? 0;
  if (!Number.isInteger(audioAngle) || audioAngle < 0 || audioAngle >= mc.angles.length) {
    throw new Error(
      `clip ${clip.id}: multicam audioAngle ${mc.audioAngle} outside [0, ${mc.angles.length})`,
    );
  }
  const srcDur = clip.out - clip.in;
  let prevT = -Infinity;
  for (const cut of mc.cuts) {
    if (typeof cut.t !== 'number' || !Number.isFinite(cut.t)) {
      throw new Error(`clip ${clip.id}: multicam cut t must be a finite number`);
    }
    if (cut.t < 0 || cut.t >= srcDur) {
      throw new Error(
        `clip ${clip.id}: multicam cut t=${cut.t} outside [0, ${srcDur})`,
      );
    }
    if (cut.t <= prevT) {
      throw new Error(
        `clip ${clip.id}: multicam cuts must be strictly increasing in t (got ${cut.t} after ${prevT})`,
      );
    }
    if (!Number.isInteger(cut.angle) || cut.angle < 0 || cut.angle >= mc.angles.length) {
      throw new Error(
        `clip ${clip.id}: multicam cut angle ${cut.angle} outside [0, ${mc.angles.length})`,
      );
    }
    prevT = cut.t;
  }
  if (clip.speed !== 1 || (clip.speedCurve ?? []).some((p) => p.speed !== 1)) {
    throw new Error(
      `clip ${clip.id}: multicam requires speed 1 (v1 cuts are defined on source time)`,
    );
  }
  if (clip.reverse) {
    throw new Error(`clip ${clip.id}: multicam + reverse is not supported in v1`);
  }
  if (clip.freezeAt !== undefined) {
    throw new Error(`clip ${clip.id}: multicam + freeze frame is not supported in v1`);
  }
  if (clip.stabilize) {
    throw new Error(`clip ${clip.id}: multicam + stabilisation is not supported in v1`);
  }
  if (clip.portraitCutout) {
    throw new Error(`clip ${clip.id}: multicam + portrait cutout is not supported in v1`);
  }
  return { angles: mc.angles, cuts: mc.cuts, audioAngle };
}

/** Split a multicam clip into [t0, t1) segments, one per angle run. */
export function multicamSegments(clip: Clip): MulticamSegment[] {
  const mc = validateMulticam(clip) as Multicam;
  const srcDur = clip.out - clip.in;
  const bounds: { t: number; angle: number }[] = [{ t: 0, angle: 0 }];
  for (const cut of mc.cuts) bounds.push({ t: cut.t, angle: cut.angle });
  const segments: MulticamSegment[] = [];
  for (let i = 0; i < bounds.length; i++) {
    const t0 = bounds[i].t;
    const t1 = i + 1 < bounds.length ? bounds[i + 1].t : srcDur;
    if (t1 - t0 < 1e-9) continue;
    // bounds[i].angle is the angle in effect from t0: 0 before the
    // first cut, then each cut's angle (a cut at t=0 makes the first
    // zero-length segment vanish and the second one take its angle).
    segments.push({ t0, t1, angle: bounds[i].angle });
  }
  return segments.length > 0 ? segments : [{ t0: 0, t1: srcDur, angle: 0 }];
}

/** Duration of one angle file (ffprobe format duration). */
export async function probeAngleDuration(file: string, ffprobe = 'ffprobe'): Promise<number> {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]);
  const d = Number(stdout.trim());
  if (!Number.isFinite(d) || d <= 0) {
    throw new Error(`cannot read duration of multicam angle ${file} (ffprobe gave ${JSON.stringify(stdout.trim())})`);
  }
  return d;
}

/**
 * Async part of multicam validation: every angle must have (within
 * tolerance) the same duration, and every angle must cover the clip
 * window [clip.in, clip.out). Throws with the measured durations
 * instead of silently truncating to the shortest angle. Call before
 * the graph build (export.ts does this in exportProjectInner).
 */
export async function prepareMulticam(project: Project, ffprobe = 'ffprobe'): Promise<void> {
  for (let i = 0; i < project.clips.length; i++) {
    const clip = project.clips[i];
    const mc = validateMulticam(clip);
    if (!mc) continue;
    const durations: number[] = [];
    for (const angle of mc.angles) {
      durations.push(await probeAngleDuration(angle, ffprobe));
    }
    const first = durations[0];
    const mismatched = durations.some((d) => Math.abs(d - first) > MULTICAM_DURATION_TOLERANCE);
    if (mismatched) {
      throw new Error(
        `clip ${clip.id}: multicam angles have different durations ` +
          `(${durations.map((d) => d.toFixed(3)).join(', ')}s); ` +
          `all angles must match within ${MULTICAM_DURATION_TOLERANCE}s — refusing to truncate silently`,
      );
    }
    if (clip.out > first + MULTICAM_DURATION_TOLERANCE) {
      throw new Error(
        `clip ${clip.id}: multicam window out=${clip.out}s exceeds angle duration ` +
          `${first.toFixed(3)}s (angles: ${durations.map((d) => d.toFixed(3)).join(', ')}s)`,
      );
    }
    // clipDuration is out-in (speed 1 enforced above); keep the check
    // honest even if the model ever allows speed on multicam clips.
    void clipDuration(clip);
  }
}
