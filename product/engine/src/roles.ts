// Audio roles (P2, M4): FCP-style role-based mixing. Every clip's audio
// belongs to one role (dialogue / music / effects / narration, or a
// custom role declared in Project.roles). At export the mix is built
// per role: each role gets its own gain (dB), pan (-1..1), mute and
// solo, and the export can additionally write one audio stem per role
// (a multi-track MP4: mix + one stem per role) — see filtergraph.ts
// and export.ts (roleStems).
//
// Measured behaviour (probe 2026-11-17, FFmpeg 8.1.2, sine sources):
// - `volume=-3dB` drops mean volume by exactly 3.0 dB (-21.1 -> -24.1).
// - Digital silence (anullsrc / volume=0) measures -91.0 dB with
//   volumedetect, NOT -inf — so "muted" asserts use < -60 dB.
// - Mono -> stereo upmix is NOT level-neutral in libavfilter:
//   aformat=channel_layouts=stereo costs 3.0 dB per channel (-21.1 ->
//   -24.1), while pan=stereo|c0=c0|c1=c0 duplicates at full level
//   (-21.1). So the role chain never uses aformat for mono sources:
//   the pan variant is picked from the probed channel count (see
//   prepareRoleAudio): mono uses `pan=stereo|c0=LG*c0|c1=RG*c0`
//   (duplicate the one channel with per-channel gains), stereo uses
//   `pan=stereo|c0=LG*c0|c1=RG*c1`. The chain also resamples to
//   48 kHz, so the mix bus is always 48 kHz stereo when roles are in
//   use — deliberate: left to itself, concat downmixes a stereo clip
//   to mono behind a mono clip, and a hard-panned clip then loses
//   3 dB in the downmix (measured 2026-11-17, p2c-mix-pan.mp4 music
//   window -23.99 dB mono instead of -21.1 dB left). A stereo clip
//   with pan == 0 gets no pan filter at all.
// - Pan gains use the linear balance law: lg = min(1, 1-p),
//   rg = min(1, 1+p). p=-1 => left only, p=+1 => right only.
// - A filter output label may NOT feed two downstream filters without
//   an explicit split: measured 2026-11-17, feeding [ar1] to both the
//   mix concat and a stem concat costs exactly 3.0 dB in the stem
//   (-24.1 vs -21.1, reproduced in PCM with the exact graph; the
//   one-output stem alone is -21.1, and an explicit asplit restores
//   -21.1). The earlier "multi-consumption is fine" note was wrong —
//   it came from a video hstack probe that only checked for errors,
//   never for levels. So the stem path inserts one asplit per clip
//   ([ar<i>] -> [arm<i>] for the mix + [ars<i>_<j>] per stem); see
//   filtergraph.ts. The mix-only path consumes [ar<i>] once and needs
//   no split.
// LGPL note: volume / pan / aresample / anullsrc / amerge-free concat
// and acrossfade are native libavfilter (LGPL part). Only verified on
// the local GPL 8.1.2 build; re-check on the BtbN LGPL 9.0 build at
// the M2 gate — do not claim LGPL verification before then.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Clip, Project } from './project.js';

const execFileAsync = promisify(execFile);

/** The four built-in roles. A clip with no `role` defaults to 'dialogue'. */
export const BUILTIN_ROLES = ['dialogue', 'music', 'effects', 'narration'] as const;

/** Role names are plain strings; validation pins them to the built-ins
 *  or to roles declared in Project.roles (anything else throws). */
export type RoleName = string;

/** Per-role mix settings, declared on the project (Project.roles). */
export interface RoleConfig {
  /** Role name. Must match a clip's `role`, or one of BUILTIN_ROLES. */
  name: string;
  /** Static gain in dB (default 0). Range -60..+12. */
  gainDb?: number;
  /** Stereo balance, -1 (full left) .. +1 (full right). Default 0. */
  pan?: number;
  /** Mute this role in the mix (and in its stem: silence). */
  mute?: boolean;
  /** Solo this role: every role WITHOUT solo is muted. */
  solo?: boolean;
}

/** Resolved per-role config: every field defaulted. */
export interface ResolvedRoleConfig {
  name: string;
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
}

export const ROLE_GAIN_DB_MIN = -60;
export const ROLE_GAIN_DB_MAX = 12;
export const ROLE_PAN_MIN = -1;
export const ROLE_PAN_MAX = 1;

/** Default role for a clip that carries no `role` field. */
export const DEFAULT_ROLE = 'dialogue';

/**
 * Every clip a project carries, legacy list plus all track clips.
 * (Multitrack: the legacy `clips` list is ignored by the render,
 * but a project may still carry it; the track clips are the live
 * ones. prepareRoleAudio deliberately does NOT use this — it is
 * index-based and export.ts passes it a flat project whose `clips`
 * already are the flattened occurrences.)
 */
function allClips(project: Project): Clip[] {
  if (!project.tracks) return project.clips;
  const out: Clip[] = [...project.clips];
  for (const t of project.tracks.video ?? []) out.push(...t.clips);
  for (const t of project.tracks.audio ?? []) out.push(...t.clips);
  return out;
}

/** The role a clip's audio belongs to. */
export function roleOfClip(clip: Clip): string {
  return clip.role ?? DEFAULT_ROLE;
}

/** True when the project uses roles at all (any clip role or any
 *  project-level role config). With no roles the graph is byte-identical
 *  to the pre-Roles build — old tests must not move. */
export function rolesInUse(project: Project): boolean {
  return (
    (project.roles ?? []).length > 0 ||
    allClips(project).some((c) => c.role !== undefined)
  );
}

/**
 * Validate role config + clip role references. Throws on: an unknown
 * role name on a clip, a duplicate role config, a gainDb outside
 * [-60, +12], a pan outside [-1, 1]. A role config may override a
 * built-in name (e.g. { name: 'music', gainDb: -6 }) — that is an
 * override, not a duplicate.
 */
export function validateRoles(project: Project): void {
  const declared = new Set<string>();
  for (const cfg of project.roles ?? []) {
    if (!cfg.name || typeof cfg.name !== 'string') {
      throw new Error(`role config needs a non-empty string name (got ${JSON.stringify(cfg.name)})`);
    }
    if (declared.has(cfg.name)) {
      throw new Error(`duplicate role config for "${cfg.name}"`);
    }
    declared.add(cfg.name);
    if (cfg.gainDb !== undefined && (cfg.gainDb < ROLE_GAIN_DB_MIN || cfg.gainDb > ROLE_GAIN_DB_MAX)) {
      throw new Error(
        `role "${cfg.name}": gainDb ${cfg.gainDb} outside [${ROLE_GAIN_DB_MIN}, ${ROLE_GAIN_DB_MAX}]`,
      );
    }
    if (cfg.pan !== undefined && (cfg.pan < ROLE_PAN_MIN || cfg.pan > ROLE_PAN_MAX)) {
      throw new Error(
        `role "${cfg.name}": pan ${cfg.pan} outside [${ROLE_PAN_MIN}, ${ROLE_PAN_MAX}]`,
      );
    }
  }
  const known = new Set<string>([...BUILTIN_ROLES, ...declared]);
  for (const clip of allClips(project)) {
    if (clip.role === undefined) continue;
    if (typeof clip.role !== 'string' || clip.role.length === 0) {
      throw new Error(`clip ${clip.id}: role must be a non-empty string`);
    }
    if (!known.has(clip.role)) {
      throw new Error(
        `clip ${clip.id}: unknown role "${clip.role}" — use one of ` +
          `${[...BUILTIN_ROLES].join(', ')} or declare it in project.roles`,
      );
    }
  }
}

/**
 * Resolve the effective config for every role used in the project:
 * built-ins start at gain 0 / pan 0 / unmuted / unsoloed, then
 * project.roles entries override field by field. Roles that appear
 * only in project.roles (custom roles) are resolved the same way.
 */
export function resolveRoleConfigs(project: Project): Map<string, ResolvedRoleConfig> {
  const out = new Map<string, ResolvedRoleConfig>();
  const blank = (name: string): ResolvedRoleConfig => ({
    name,
    gainDb: 0,
    pan: 0,
    mute: false,
    solo: false,
  });
  for (const name of BUILTIN_ROLES) out.set(name, blank(name));
  for (const clip of allClips(project)) {
    const name = roleOfClip(clip);
    if (!out.has(name)) out.set(name, blank(name));
  }
  for (const cfg of project.roles ?? []) {
    const cur = out.get(cfg.name) ?? blank(cfg.name);
    out.set(cfg.name, {
      name: cfg.name,
      gainDb: cfg.gainDb ?? cur.gainDb,
      pan: cfg.pan ?? cur.pan,
      mute: cfg.mute ?? cur.mute,
      solo: cfg.solo ?? cur.solo,
    });
  }
  return out;
}

/** A role is effectively muted when muted itself, or when ANY role is
 *  soloed and this one is not. */
export function effectiveMute(name: string, configs: Map<string, ResolvedRoleConfig>): boolean {
  const cfg = configs.get(name);
  if (!cfg) return false;
  if (cfg.mute) return true;
  let anySolo = false;
  for (const c of configs.values()) if (c.solo) anySolo = true;
  return anySolo && !cfg.solo;
}

/** Linear balance-law gains for a pan value: lg = min(1, 1-p),
 *  rg = min(1, 1+p). */
export function panGains(pan: number): { lg: number; rg: number } {
  return { lg: Math.min(1, 1 - pan), rg: Math.min(1, 1 + pan) };
}

function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Filter string for one clip's role processing, applied AFTER the
 * clip's own audio chain ([a<i>] -> [ar<i>]). Muted clips get
 * `aresample=48000` + (mono: a full-level pan duplicate, so the
 * muted stream is still stereo) + `volume=0` (digital silence,
 * measures -91 dB). Otherwise the chain is: resample to 48 kHz, a
 * static volume in dB, then a pan stage that ALSO normalises the
 * layout to stereo — so the mix bus is always
 * 48 kHz stereo when roles are in use, and the concat/acrossfade
 * assembly never has to reconcile mixed mono/stereo inputs (left to
 * itself, concat downmixes a stereo clip to mono behind a mono clip
 * and a hard-panned clip loses 3 dB in the downmix — measured
 * 2026-11-17, p2c-mix-pan.mp4 music window -23.99 dB mono instead of
 * -21.1 dB left). Mono sources are duplicated with pan (full level,
 * NOT aformat, which costs 3 dB per channel — see the header); stereo
 * sources only get a pan filter when pan != 0. `channels` is the
 * probed count (prepareRoleAudio); when unknown it defaults to the
 * stereo variant.
 */
export function roleFilter(
  cfg: ResolvedRoleConfig,
  muted: boolean,
  channels?: number,
): string {
  const parts: string[] = ['aresample=48000'];
  // >2 channels: downmix to stereo first (v1; aformat). Mono is
  // handled by the pan stage below (duplicated at full level).
  if (channels !== undefined && channels > 2) {
    parts.push('aformat=channel_layouts=stereo');
  }
  if (muted) {
    if (channels === 1) parts.push('pan=stereo|c0=c0|c1=c0');
    parts.push('volume=0');
    return parts.join(',');
  }
  parts.push(`volume=${fmt(cfg.gainDb)}dB`);
  const { lg, rg } = panGains(cfg.pan);
  if (channels === 1) {
    parts.push(`pan=stereo|c0=${fmt(lg)}*c0|c1=${fmt(rg)}*c0`);
  } else if (cfg.pan !== 0) {
    parts.push(`pan=stereo|c0=${fmt(lg)}*c0|c1=${fmt(rg)}*c1`);
  }
  return parts.join(',');
}

/** Audio channel count of one file (ffprobe, first audio stream). */
export async function probeAudioChannels(file: string, ffprobe = 'ffprobe'): Promise<number> {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=channels', '-of', 'csv=p=0', file,
  ]);
  const n = Number(stdout.trim());
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`cannot read audio channels of ${file} (ffprobe gave ${JSON.stringify(stdout.trim())})`);
  }
  return n;
}

/**
 * Async part of role validation: probe every clip's audio channel
 * count (needed to pick the mono/stereo pan variant). For multicam
 * clips the probed file is the audio angle's file, not angle 0.
 * Call before the graph build when roles are in use (export.ts does
 * this in exportProjectInner). Returns clip index -> channel count.
 */
export async function prepareRoleAudio(
  project: Project,
  ffprobe = 'ffprobe',
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let i = 0; i < project.clips.length; i++) {
    const clip = project.clips[i];
    let file = clip.source;
    if (clip.multicam) {
      const angle = clip.multicam.audioAngle ?? 0;
      file = clip.multicam.angles[angle];
    }
    out.set(i, await probeAudioChannels(file, ffprobe));
  }
  return out;
}
