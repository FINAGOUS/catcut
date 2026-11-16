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
