// Named style presets (P0, M4). Style-only: spread over a TextOverlay and
// fill in text/start/end at use time, e.g.
//   { ...TEXT_PRESETS.lowerThird, text: '你好', start: 0, end: 3 }
import type { ColorAdjust, TextOverlay } from './project.js';

export type TextStylePreset = Omit<TextOverlay, 'text' | 'start' | 'end'>;

export const TEXT_PRESETS: Record<string, TextStylePreset> = {
  /** Large centred title, top of frame, boxed. */
  title: {
    x: 0.5, y: 0.12, fontsize: 72, fontcolor: 'white',
    borderw: 2, box: true, boxcolor: 'black@0.55', boxborderw: 16,
  },
  /** Lower-third caption bar, bottom centre. */
  lowerThird: {
    x: 0.5, y: 0.85, fontsize: 40, fontcolor: 'white',
    box: true, boxcolor: 'black@0.6', boxborderw: 12,
  },
  /** Big emphasis word, centre frame, yellow with shadow. */
  emphasis: {
    x: 0.5, y: 0.5, fontsize: 96, fontcolor: 'yellow',
    borderw: 3, shadowcolor: 'black', shadowx: 3, shadowy: 3,
  },
};

export const COLOR_PRESETS: Record<string, ColorAdjust> = {
  /** Warm, slightly punchy: for talking-head / food. */
  warm: { brightness: 0.02, contrast: 1.08, saturation: 1.15, temperature: 0.12 },
  /** Cool, slightly desaturated: for tech / screen recordings. */
  cool: { brightness: 0.0, contrast: 1.05, saturation: 1.05, temperature: -0.15 },
};

// --- One-click talking-head presets (P1, M4) ------------------------------
// A preset = subtitle style + mask shape + auto-zoom amplitude, three
// parameter groups packed together. Applying a preset writes plain values
// into the clip (mask, zoom keyframes, subtitle style) — after that every
// item is individually editable, the preset itself is not a black box.
// Presets live apart from project files and are plain JSON, so they can
// be exported and shared (template-store groundwork, M5).
import type { Clip, ClipMask } from './project.js';
import type { SubtitleItem } from './subtitles.js';
import { generateAutoZoom, type AutoZoomOptions } from './autozoom.js';

export type SubtitleMode = 'sentence' | 'karaoke';

export interface TalkPreset {
  id: string;
  /** Display name, e.g. '口播·圆框小窗'. */
  label: string;
  description: string;
  /** Sentence burn-in style (clip subtitles) / karaoke base style. */
  subtitleStyle: TextStylePreset;
  /** 'sentence' burns clip-level drawtext; 'karaoke' expects the
   *  subtitles on the PROJECT (ASS word highlight) instead. */
  subtitleMode: SubtitleMode;
  /** PiP mask; absent = full-frame, no picture-in-picture. */
  mask?: ClipMask;
  autoZoom: AutoZoomOptions;
  /** Suggested canvas; the project still governs the real output size. */
  canvas?: { width: number; height: number };
}

export const TALK_PRESETS: Record<string, TalkPreset> = {
  /** Round-corner PiP: person shrinks to a circle at bottom-right,
   *  screen stays big behind. The dynamic talking-head look. */
  'talking-round-pip': {
    id: 'talking-round-pip',
    label: '口播·圆框小窗',
    description: '人物缩成圆框放右下角，背后是大画面；讲到重点自动推近。',
    subtitleStyle: TEXT_PRESETS.lowerThird,
    subtitleMode: 'sentence',
    mask: {
      shape: 'circle', x: 0.78, y: 0.72, w: 0.26, h: 0.26,
      feather: 12, backgroundBlur: 6,
    },
    autoZoom: { baseScale: 1.0, emphasisScale: 1.3, minHold: 0.5, ease: 0.2 },
  },
  /** Big emphasis words, centre frame, no PiP; push-in is stronger. */
  'talking-big-text': {
    id: 'talking-big-text',
    label: '口播·大字强调',
    description: '中央大字强调，无画中画；重点句推近幅度更大。',
    subtitleStyle: TEXT_PRESETS.emphasis,
    subtitleMode: 'sentence',
    autoZoom: { baseScale: 1.0, emphasisScale: 1.4, minHold: 0.5, ease: 0.2 },
  },
  /** Vertical karaoke: 9:16 canvas, word-by-word highlight (project ASS),
   *  gentle push-in. */
  'vertical-karaoke': {
    id: 'vertical-karaoke',
    label: '竖屏·逐词高亮',
    description: '竖屏 9:16，逐词高亮字幕；推近幅度小，稳。',
    subtitleStyle: TEXT_PRESETS.lowerThird,
    subtitleMode: 'karaoke',
    autoZoom: { baseScale: 1.0, emphasisScale: 1.25, minHold: 0.5, ease: 0.2 },
    canvas: { width: 1080, height: 1920 },
  },
};

/**
 * Apply a preset to a clip. Subtitles (clip-local output time) drive the
 * auto-zoom keyframes. In 'sentence' mode the subtitles are also attached
 * to the clip for drawtext burn-in; in 'karaoke' mode they are NOT
 * attached — put them on the project for the ASS karaoke burn instead,
 * otherwise the same words would burn twice.
 */
export function applyTalkPreset(
  clip: Clip,
  preset: TalkPreset,
  subtitles?: SubtitleItem[],
): Clip {
  const out: Clip = {
    ...clip,
    mask: preset.mask ? { ...preset.mask } : undefined,
    subtitleStyle: { ...preset.subtitleStyle },
  };
  if (subtitles && subtitles.length > 0) {
    out.zoom = generateAutoZoom(subtitles, preset.autoZoom);
    if (preset.subtitleMode === 'sentence') out.subtitles = subtitles;
    else out.subtitles = undefined;
  }
  return out;
}

/** Serialise a preset to shareable JSON (project files stay separate). */
export function serializeTalkPreset(preset: TalkPreset): string {
  return JSON.stringify(preset, null, 2);
}

/** Parse shared preset JSON back; throws on a missing/invalid field. */
export function parseTalkPreset(json: string): TalkPreset {
  const p = JSON.parse(json) as TalkPreset;
  if (!p || typeof p.id !== 'string' || !p.id) throw new Error('talk preset: missing id');
  if (!p.label || !p.subtitleStyle || !p.autoZoom) {
    throw new Error(`talk preset ${p.id}: missing label/subtitleStyle/autoZoom`);
  }
  if (p.subtitleMode !== 'sentence' && p.subtitleMode !== 'karaoke') {
    throw new Error(`talk preset ${p.id}: bad subtitleMode ${String(p.subtitleMode)}`);
  }
  if (p.mask && !['circle', 'ellipse', 'rect', 'roundedRect'].includes(p.mask.shape)) {
    throw new Error(`talk preset ${p.id}: bad mask shape ${String(p.mask.shape)}`);
  }
  return p;
}
