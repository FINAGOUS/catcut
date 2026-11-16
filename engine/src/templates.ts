// Local template store (P1, M4): "贴纸/音效/转场模板商店（本地包）".
// A template is a named bundle of clip + project settings — transition,
// text style, colour, mask, auto-zoom, beat pulse, audio fades —
// packed as one JSON file so it can be exported, shared and re-applied.
// Applying a template writes PLAIN VALUES into the project model
// (same as applyTalkPreset in presets.ts): after that every item is
// individually editable, the template itself is not a black box.
// Built-in templates live as JSON files in engine/templates/ and are
// the source of truth — this module loads and validates them; it does
// not hard-code their contents (so a bad edit to a JSON file fails
// loudly at load time instead of silently applying a half template).
// Scope, stated plainly: this is a LOCAL template pack. It deliberately
// does NOT include a licensed music / stock-footage library — music and
// fonts in templates are either the project's own files or open
// licensed; nothing is lifted from CapCut/Jianying/FCP (no decompiling,
// no copied UI, music libraries or font packs — M4 §五). A template
// that references a named preset that does not exist (text style,
// colour) is REJECTED at parse time, never silently skipped.
// LGPL: templates add no new filters — they only recombine filters
// already in the engine (xfade, eq/colorbalance, drawtext, zoom
// keyframes, afade); each of those is still to be re-checked on the
// BtbN LGPL 9.0 build at the M2 gate, like every other filter.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  COLOR_PRESETS,
  TEXT_PRESETS,
  type TextStylePreset,
} from './presets.js';
import { generateAutoZoom, type AutoZoomOptions } from './autozoom.js';
import { applyBeatPulse, type BeatGrid, type BeatPulseOptions } from './beat.js';
import type {
  Clip,
  ClipMask,
  ColorAdjust,
  Project,
  TransitionType,
} from './project.js';
import type { SubtitleItem } from './subtitles.js';

export const TRANSITIONS: readonly TransitionType[] = [
  'cut', 'fade', 'dissolve', 'wipeleft', 'wiperight', 'slideleft',
  'circleopen', 'fadeblack', 'fadewhite',
];

const TEXT_STYLE_NAMES = Object.keys(TEXT_PRESETS);
const COLOR_NAMES = Object.keys(COLOR_PRESETS);
const MASK_SHAPES = ['circle', 'ellipse', 'rect', 'roundedRect'];

export interface Template {
  id: string;
  /** Display name, e.g. '口播·干净'. */
  label: string;
  description: string;
  /** Schema version of the template file (current: 1). */
  version?: number;
  /** Transition between clips (applied to every project transition). */
  transition?: TransitionType;
  /** Duration of the transition in seconds (default: keep the project's). */
  transitionDuration?: number;
  /** Named text style preset (title / lowerThird / emphasis). */
  textStylePreset?: string;
  /** Inline text style (used when no named preset is given). */
  textStyle?: TextStylePreset;
  /** Named colour preset (warm / cool). */
  colorPreset?: string;
  /** Inline colour adjustment (used when no named preset is given). */
  color?: ColorAdjust;
  /** Shape-mask PiP (same model as Clip.mask). */
  mask?: ClipMask;
  /** Auto-zoom driven by subtitles (needs subtitles at apply time). */
  autoZoom?: AutoZoomOptions;
  /** Beat pulse on the zoom track (needs a BeatGrid at apply time). */
  beatPulse?: BeatPulseOptions;
  /** Audio fade-in/out in seconds. */
  audioFadeIn?: number;
  audioFadeOut?: number;
  /** Suggested canvas; the project still governs the real output size
   *  — a template never resizes the project behind its back. */
  canvas?: { width: number; height: number };
}

const KNOWN_KEYS = new Set([
  'id', 'label', 'description', 'version', 'transition',
  'transitionDuration', 'textStylePreset', 'textStyle', 'colorPreset',
  'color', 'mask', 'autoZoom', 'beatPulse', 'audioFadeIn',
  'audioFadeOut', 'canvas',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkNumber(
  v: unknown,
  name: string,
  id: string,
  min: number,
  max: number,
): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`template ${id}: ${name} ${String(v)} outside [${min}, ${max}]`);
  }
}

/** Validate a parsed template object; throws on the first problem. */
export function validateTemplate(t: unknown): asserts t is Template {
  if (!isRecord(t)) throw new Error('template: not an object');
  for (const k of Object.keys(t)) {
    if (!KNOWN_KEYS.has(k)) throw new Error(`template ${String(t.id ?? '?')}: unknown field ${k}`);
  }
  if (typeof t.id !== 'string' || !t.id) throw new Error('template: missing id');
  if (typeof t.label !== 'string' || !t.label) {
    throw new Error(`template ${t.id}: missing label`);
  }
  if (typeof t.description !== 'string' || !t.description) {
    throw new Error(`template ${t.id}: missing description`);
  }
  if (t.version !== undefined && t.version !== 1) {
    throw new Error(`template ${t.id}: unsupported version ${String(t.version)}`);
  }
  if (t.transition !== undefined && !TRANSITIONS.includes(t.transition as TransitionType)) {
    throw new Error(`template ${t.id}: unknown transition ${String(t.transition)}`);
  }
  if (t.transitionDuration !== undefined) {
    checkNumber(t.transitionDuration, 'transitionDuration', t.id, 0.1, 5);
  }
  if (t.textStylePreset !== undefined && !TEXT_STYLE_NAMES.includes(t.textStylePreset as string)) {
    throw new Error(
      `template ${t.id}: unknown text style preset ${String(t.textStylePreset)} ` +
        `(known: ${TEXT_STYLE_NAMES.join(', ')})`,
    );
  }
  if (t.textStylePreset !== undefined && t.textStyle !== undefined) {
    throw new Error(`template ${t.id}: textStylePreset and textStyle both set — pick one`);
  }
  if (t.colorPreset !== undefined && !COLOR_NAMES.includes(t.colorPreset as string)) {
    throw new Error(
      `template ${t.id}: unknown colour preset ${String(t.colorPreset)} ` +
        `(known: ${COLOR_NAMES.join(', ')})`,
    );
  }
  if (t.colorPreset !== undefined && t.color !== undefined) {
    throw new Error(`template ${t.id}: colorPreset and color both set — pick one`);
  }
  if (t.mask !== undefined) {
    if (!isRecord(t.mask) || !MASK_SHAPES.includes(String((t.mask as Record<string, unknown>).shape))) {
      throw new Error(`template ${t.id}: bad mask shape ${String((t.mask as Record<string, unknown>)?.shape)}`);
    }
  }
  if (t.beatPulse !== undefined) {
    const bp = t.beatPulse as Record<string, unknown>;
    if (bp.pulseScale !== undefined) checkNumber(bp.pulseScale, 'beatPulse.pulseScale', t.id, 1, 1.6);
    if (bp.baseScale !== undefined) checkNumber(bp.baseScale, 'beatPulse.baseScale', t.id, 0.5, 1.6);
    if (bp.attack !== undefined) checkNumber(bp.attack, 'beatPulse.attack', t.id, 0.01, 1);
    if (bp.release !== undefined) checkNumber(bp.release, 'beatPulse.release', t.id, 0.01, 1);
  }
  if (t.autoZoom !== undefined) {
    const az = t.autoZoom as Record<string, unknown>;
    if (az.emphasisScale !== undefined) checkNumber(az.emphasisScale, 'autoZoom.emphasisScale', t.id, 1, 1.6);
    if (az.baseScale !== undefined) checkNumber(az.baseScale, 'autoZoom.baseScale', t.id, 0.5, 1.6);
    if (az.minHold !== undefined) checkNumber(az.minHold, 'autoZoom.minHold', t.id, 0, 5);
    if (az.ease !== undefined) checkNumber(az.ease, 'autoZoom.ease', t.id, 0, 1);
  }
  if (t.audioFadeIn !== undefined) checkNumber(t.audioFadeIn, 'audioFadeIn', t.id, 0, 10);
  if (t.audioFadeOut !== undefined) checkNumber(t.audioFadeOut, 'audioFadeOut', t.id, 0, 10);
  if (t.canvas !== undefined) {
    const c = t.canvas as Record<string, unknown>;
    if (typeof c.width !== 'number' || typeof c.height !== 'number' || c.width <= 0 || c.height <= 0) {
      throw new Error(`template ${t.id}: bad canvas ${JSON.stringify(t.canvas)}`);
    }
  }
}

/** Parse template JSON; throws on invalid JSON or a failed validation. */
export function parseTemplate(json: string): Template {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`template: invalid JSON (${(e as Error).message})`);
  }
  validateTemplate(parsed);
  return parsed;
}

/** Serialise a template to shareable JSON (round-trip stable). */
export function serializeTemplate(t: Template): string {
  return JSON.stringify(t, null, 2);
}

/** Directory holding the built-in template JSON files. */
export function templatesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
}

/** Load one built-in template JSON file by id (e.g. 'talking-clean'). */
export function loadBuiltInTemplate(id: string): Template {
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`template id ${JSON.stringify(id)} is not a safe file name`);
  }
  const path = join(templatesDir(), `${id}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`template ${id}: no built-in template file ${path}`);
  }
  return parseTemplate(raw);
}

/** Ids of the built-in templates shipped with the engine. */
export const BUILTIN_TEMPLATE_IDS = [
  'talking-clean',
  'vlog-film',
  'beat-energetic',
  'interview-duo',
] as const;

/** Load every built-in template (throws if any file is invalid). */
export function loadAllBuiltInTemplates(): Template[] {
  return BUILTIN_TEMPLATE_IDS.map((id) => loadBuiltInTemplate(id));
}

export interface ApplyTemplateOptions {
  /** Subtitles (clip-local output time) for auto-zoom + burn-in. */
  subtitles?: SubtitleItem[];
  /** Beat grid for the template's beat pulse (required when the
   *  template sets beatPulse). */
  beats?: BeatGrid;
}

/**
 * Apply a template to ONE clip. Writes plain values into the clip;
 * after that every item is individually editable. Throws when the
 * template asks for a beat pulse but no BeatGrid was supplied.
 */
export function applyTemplateToClip(
  clip: Clip,
  template: Template,
  opts: ApplyTemplateOptions = {},
): Clip {
  const out: Clip = { ...clip };
  if (template.textStylePreset !== undefined) {
    out.subtitleStyle = { ...TEXT_PRESETS[template.textStylePreset] };
  } else if (template.textStyle !== undefined) {
    out.subtitleStyle = { ...template.textStyle };
  }
  if (template.colorPreset !== undefined) {
    out.color = { ...COLOR_PRESETS[template.colorPreset] };
  } else if (template.color !== undefined) {
    out.color = { ...template.color };
  }
  if (template.mask !== undefined) out.mask = { ...template.mask };
  if (template.audioFadeIn !== undefined) out.audioFadeIn = template.audioFadeIn;
  if (template.audioFadeOut !== undefined) out.audioFadeOut = template.audioFadeOut;
  if (opts.subtitles && opts.subtitles.length > 0) {
    out.subtitles = opts.subtitles;
    if (template.autoZoom !== undefined) {
      out.zoom = generateAutoZoom(opts.subtitles, template.autoZoom);
    }
  }
  if (template.beatPulse !== undefined) {
    if (!opts.beats) {
      throw new Error(
        `template ${template.id}: beatPulse needs a BeatGrid — ` +
          `pass { beats } to applyTemplateToClip, or detect beats first`,
      );
    }
    // Beat pulse replaces the auto-zoom keys when both are set: a
    // clip cannot hold two zoom tracks. The pulse is the template's
    // headline effect, so it wins; the auto-zoom is skipped, not merged.
    const pulsed = applyBeatPulse(out, opts.beats, template.beatPulse);
    out.zoom = pulsed.zoom;
  }
  return out;
}

/**
 * Apply a template to a whole project: every clip gets the clip-level
 * settings, and every transition becomes the template's transition
 * (with its duration) when the template sets one. The project canvas
 * is NOT changed — the template's canvas is a suggestion only.
 */
export function applyTemplateToProject(
  project: Project,
  template: Template,
  opts: ApplyTemplateOptions = {},
): Project {
  const out: Project = {
    ...project,
    clips: project.clips.map((c) => applyTemplateToClip(c, template, opts)),
  };
  if (template.transition !== undefined) {
    out.transitions = project.transitions.map(() => template.transition as TransitionType);
  }
  if (template.transitionDuration !== undefined) {
    out.transitionDuration = template.transitionDuration;
  }
  return out;
}
