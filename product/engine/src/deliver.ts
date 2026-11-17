// Delivery (P3, M4 §8.5 + direction doc §七): dual subtitles, subtitle
// sidecar formats, export preset management, HDR<->SDR, export-only
// switches, batch export queue. Engine layer only — no WPF/UI here.
//
// Licence notes (measured 2026-11-17, probe tmp/probe-p3c.mjs):
// - libx265 is GPL (the 8K preset and SDR->HDR encode with it). The
//   BtbN LGPL 9.0 build has NO libx265 — 8K H.265 and pseudo-HDR export
//   need another encode route before any public LGPL distribution (M2
//   gate). tonemap / zscale / libx264 are native libavfilter / LGPL
//   but still to be re-checked on the BtbN LGPL 9.0 build.
// - SDR->HDR is PSEUDO-HDR: it lifts SDR into a 10-bit PQ container.
//   It adds no new highlight information — never call it true HDR.
// - HDR->SDR uses the FFmpeg-wiki-standard hable chain (zscale to
//   linear, tonemap=hable). Measured curve on constant-nit PQ patches
//   (probe-p3c v2): 10 nits -> 10, 50 -> 45, 100 -> 115, 200 -> 200,
//   500/1000 -> 255. Naive (raw PQ codes as SDR) gives 76/112/129/147/
//   172/191 — a flat, washed-out 76..191 span; hable restores the full
//   10..255 span. Shadows stay above black (10 nits -> 10, not 0);
//   gradation survives up to ~200-400 nits; 500+ nit content saturates
//   to white, which is inherent to SDR (white = 100 nits), not a bug.
// - zscale transfer constants are `smpte2084` / matrix `2020_ncl`
//   (NOT st2084 / bt2020nc — those are rejected). Explicit input specs
//   (pin/min/tin) on the first zscale are REQUIRED: frames whose
//   primaries/transfer are "unknown" make zscale fail with "no path
//   between colorspaces" (measured). libx265 VUI follows FRAME
//   properties, so HDR sources must be tagged with setparams (or an
//   equivalent) — encoder -color_* flags alone do not stick.
// - SDR->HDR is a SINGLE zscale. The two-step form (via gbrpf32le)
//   fails: the second zscale has no path from RGB float to YCbCr.

import { writeFileSync } from 'node:fs';
import {
  DEFAULT_ASS_STYLE,
  formatAssTime,
  subtitlesToASS,
  writeSRT,
  type AssStyle,
  type SubtitleItem,
} from './subtitles.js';
import type { ExportOptions, ExportPreset, ExportReport } from './export.js';
import type { Project } from './project.js';

export type HdrMode = 'off' | 'hdr-to-sdr' | 'sdr-to-hdr';
export type SubtitleSidecarFormat = 'srt' | 'vtt' | 'ass';
export type ExportOnlyMode = 'none' | 'video' | 'audio' | 'subtitle';
export type TonemapOperator = 'hable' | 'mobius' | 'reinhard';

export interface ExportOnlyFlags {
  videoOnly?: boolean;
  audioOnly?: boolean;
  subtitleOnly?: boolean;
}

/** Three export-only switches are mutually exclusive; none set = normal export. */
export function resolveExportOnlyMode(flags: ExportOnlyFlags): ExportOnlyMode {
  const set = [
    flags.videoOnly ? 'video' : undefined,
    flags.audioOnly ? 'audio' : undefined,
    flags.subtitleOnly ? 'subtitle' : undefined,
  ].filter((x): x is ExportOnlyMode => x !== undefined);
  if (set.length > 1) {
    throw new Error(`export-only switches are mutually exclusive; got ${set.join(' + ')}`);
  }
  return set[0] ?? 'none';
}

export function validateHdrMode(mode: unknown): HdrMode {
  if (mode === undefined) return 'off';
  if (mode === 'off' || mode === 'hdr-to-sdr' || mode === 'sdr-to-hdr') return mode;
  throw new Error(`unknown hdrMode: ${String(mode)}`);
}

// --- Dual subtitles -------------------------------------------------------

/** Two subtitle tracks for one timeline: primary (bottom) + second language (above it). */
export interface DualSubtitles {
  primary: SubtitleItem[];
  secondary: SubtitleItem[];
}

/**
 * ASS file with two styles: Sub (primary, bottom) and Sub2 (second
 * language, above the primary). A missing second language is NOT an
 * error — the file just carries one line. A missing primary IS an
 * error: a dual subtitle with no primary is a modelling bug.
 * Secondary style defaults to the primary style with a smaller font,
 * yellow text, and a margin that clears the primary line.
 */
export function subtitlesToDualASS(
  dual: DualSubtitles,
  style: AssStyle,
  playResX: number,
  playResY: number,
  secondaryStyle?: AssStyle,
): string {
  if (!dual.primary || dual.primary.length === 0) {
    throw new Error('dual subtitles: primary track is empty');
  }
  const sub2: AssStyle = secondaryStyle ?? {
    ...style,
    fontsize: Math.max(16, style.fontsize - 4),
    primaryColor: '&H0000FFFF',
    marginV: style.marginV + style.fontsize + 12,
  };
  const escAss = (s: string) => s.replace(/\{/g, '\\{').replace(/\}/g, '\\}');
  const header = [
    '[Script Info]',
    'Title: dual subtitles',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Sub,${style.fontname},${style.fontsize},${style.primaryColor},${style.highlightColor},&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${style.outline},${style.shadow},2,20,20,${style.marginV},1`,
    `Style: Sub2,${sub2.fontname},${sub2.fontsize},${sub2.primaryColor},${sub2.highlightColor},&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${sub2.outline},${sub2.shadow},2,20,20,${sub2.marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const it of dual.primary) {
    let text: string;
    if (it.words && it.words.length > 0) {
      text = it.words
        .map((w) => `{\\k${Math.max(1, Math.round((w.end - w.start) * 100))}}${escAss(w.w)}`)
        .join('');
    } else {
      text = `{\\k${Math.max(1, Math.round((it.end - it.start) * 100))}}${escAss(it.text)}`;
    }
    header.push(
      `Dialogue: 0,${formatAssTime(it.start)},${formatAssTime(it.end)},Sub,,0,0,0,,${text}`,
    );
  }
  for (const it of dual.secondary ?? []) {
    header.push(
      `Dialogue: 0,${formatAssTime(it.start)},${formatAssTime(it.end)},Sub2,,0,0,0,,${escAss(it.text)}`,
    );
  }
  return header.join('\n') + '\n';
}

/**
 * Two-layer drawtext overlays for clip-level dual subtitles: the
 * primary uses the given style, the second language sits one line
 * above it (y - 0.09 of frame height). Same "missing second language
 * is fine, missing primary throws" rule as subtitlesToDualASS.
 */
export function dualSubtitlesToTextOverlays(
  dual: DualSubtitles,
  primaryStyle: Omit<import('./project.js').TextOverlay, 'text' | 'start' | 'end'>,
  secondaryStyle: Omit<import('./project.js').TextOverlay, 'text' | 'start' | 'end'>,
): import('./project.js').TextOverlay[] {
  if (!dual.primary || dual.primary.length === 0) {
    throw new Error('dual subtitles: primary track is empty');
  }
  const out: import('./project.js').TextOverlay[] = dual.primary.map((it) => ({
    ...primaryStyle,
    text: it.text,
    start: it.start,
    end: it.end,
  }));
  for (const it of dual.secondary ?? []) {
    out.push({
      ...secondaryStyle,
      y: primaryStyle.y - 0.09,
      text: it.text,
      start: it.start,
      end: it.end,
    });
  }
  return out;
}

// --- Subtitle sidecars: SRT / VTT / ASS ------------------------------------

/** HH:MM:SS.mmm (WebVTT timecode — dot, not SRT's comma). */
export function formatVttTime(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60000) % 60;
  const h = Math.floor(totalMs / 3600000);
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

export function toVTT(items: SubtitleItem[]): string {
  const blocks = items.map(
    (it, i) =>
      `${i + 1}\n${formatVttTime(it.start)} --> ${formatVttTime(it.end)}\n${it.text}\n`,
  );
  return `WEBVTT\n\n${blocks.join('\n')}`;
}

export function writeVTT(items: SubtitleItem[], file: string): void {
  writeFileSync(file, toVTT(items), 'utf8');
}

function parseSidecarTime(s: string): number {
  const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) throw new Error(`bad sidecar timecode: ${s}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** Parse WebVTT text back into subtitle items (round-trips toVTT). */
export function parseVTT(vtt: string): SubtitleItem[] {
  const blocks = vtt.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  const items: SubtitleItem[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0 || lines[0].trim() === 'WEBVTT') continue;
    const tcIdx = lines.findIndex((l) => l.includes('-->'));
    if (tcIdx < 0) continue;
    const [a, b] = lines[tcIdx].split('-->');
    items.push({
      text: lines.slice(tcIdx + 1).join('\n'),
      start: parseSidecarTime(a),
      end: parseSidecarTime(b),
    });
  }
  items.sort((x, y) => x.start - y.start);
  return items;
}

export interface AssSidecarOptions {
  style?: AssStyle;
  playResX?: number;
  playResY?: number;
}

/** Write one subtitle track as a sidecar file in the requested format. Returns the path written. */
export function writeSubtitleSidecar(
  items: SubtitleItem[],
  file: string,
  format: SubtitleSidecarFormat,
  assOpts?: AssSidecarOptions,
): string {
  if (format === 'srt') {
    writeSRT(items, file);
  } else if (format === 'vtt') {
    writeVTT(items, file);
  } else if (format === 'ass') {
    writeAssSidecar(items, file, assOpts);
  } else {
    throw new Error(`unknown sidecar format: ${String(format)}`);
  }
  return file;
}

/** Write one subtitle track as a burn-ready .ass sidecar. */
export function writeAssSidecar(
  items: SubtitleItem[],
  file: string,
  assOpts?: AssSidecarOptions,
): string {
  writeFileSync(
    file,
    subtitlesToASS(
      items,
      assOpts?.style ?? DEFAULT_ASS_STYLE,
      assOpts?.playResX ?? 1920,
      assOpts?.playResY ?? 1080,
    ),
    'utf8',
  );
  return file;
}

/**
 * Write a dual track as a sidecar. ASS keeps both styles; SRT/VTT merge
 * each cue into two lines (primary, then secondary) — paired by index,
 * extras appended alone. Returns the path written.
 */
export function writeDualSubtitleSidecar(
  dual: DualSubtitles,
  file: string,
  format: SubtitleSidecarFormat,
  assOpts?: AssSidecarOptions,
): string {
  if (format === 'ass') {
    writeFileSync(
      file,
      subtitlesToDualASS(
        dual,
        assOpts?.style ?? DEFAULT_ASS_STYLE,
        assOpts?.playResX ?? 1920,
        assOpts?.playResY ?? 1080,
      ),
      'utf8',
    );
    return file;
  }
  if (format !== 'srt' && format !== 'vtt') {
    throw new Error(`unknown sidecar format: ${String(format)}`);
  }
  const merged: SubtitleItem[] = [];
  const n = Math.max(dual.primary.length, dual.secondary?.length ?? 0);
  for (let i = 0; i < n; i++) {
    const p = dual.primary[i];
    const s = dual.secondary?.[i];
    const base = p ?? s;
    if (!base) continue;
    const lines = [p?.text, s?.text].filter((t): t is string => !!t);
    merged.push({ text: lines.join('\n'), start: base.start, end: base.end });
  }
  if (format === 'srt') writeSRT(merged, file);
  else writeVTT(merged, file);
  return file;
}

// --- Export presets: validate / serialise / store --------------------------

export const X264_PRESET_NAMES = [
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast',
  'medium', 'slow', 'slower', 'veryslow', 'placebo',
];

/** Validate a parsed export preset object; throws on the first problem. Returns it typed. */
export function validateExportPreset(p: unknown): ExportPreset {
  if (!p || typeof p !== 'object') throw new Error('export preset: not an object');
  const q = p as Record<string, unknown>;
  if (typeof q.name !== 'string' || !q.name) throw new Error('export preset: missing name');
  const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
  if (!isInt(q.width) || (q.width as number) < 16 || (q.width as number) > 7680) {
    throw new Error(`export preset ${q.name}: width ${String(q.width)} outside 16..7680`);
  }
  if (!isInt(q.height) || (q.height as number) < 16 || (q.height as number) > 4320) {
    throw new Error(`export preset ${q.name}: height ${String(q.height)} outside 16..4320`);
  }
  if (!isInt(q.fps) || (q.fps as number) < 1 || (q.fps as number) > 120) {
    throw new Error(`export preset ${q.name}: fps ${String(q.fps)} outside 1..120`);
  }
  if (!isInt(q.crf) || (q.crf as number) < 0 || (q.crf as number) > 51) {
    throw new Error(`export preset ${q.name}: crf ${String(q.crf)} outside 0..51`);
  }
  if (typeof q.preset !== 'string' || !X264_PRESET_NAMES.includes(q.preset)) {
    throw new Error(`export preset ${q.name}: bad encoder preset ${String(q.preset)}`);
  }
  if (typeof q.audioBitrate !== 'string' || !/^\d+k$/.test(q.audioBitrate)) {
    throw new Error(`export preset ${q.name}: bad audioBitrate ${String(q.audioBitrate)}`);
  }
  if (q.codec !== undefined && q.codec !== 'libx264' && q.codec !== 'libx265') {
    throw new Error(`export preset ${q.name}: bad codec ${String(q.codec)}`);
  }
  if (q.lut !== undefined && typeof q.lut !== 'string') {
    throw new Error(`export preset ${q.name}: bad lut path`);
  }
  return p as ExportPreset;
}

/** Parse shared preset JSON back; throws on bad JSON or a bad field. */
export function parseExportPreset(json: string): ExportPreset {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new Error('export preset: invalid JSON');
  }
  return validateExportPreset(v);
}

/** Serialise a preset to shareable JSON (validates first). */
export function serializeExportPreset(p: ExportPreset): string {
  validateExportPreset(p);
  return JSON.stringify(p, null, 2);
}

export interface PresetStore {
  builtins: Record<string, ExportPreset>;
  customs: Record<string, ExportPreset>;
}

/** Build a preset store from a built-in table (e.g. PRESETS from export.ts). Validates every entry. */
export function createPresetStore(builtins: Record<string, ExportPreset>): PresetStore {
  for (const [k, v] of Object.entries(builtins)) {
    try {
      validateExportPreset(v);
    } catch (e) {
      throw new Error(`builtin preset ${k}: ${(e as Error).message}`);
    }
  }
  return { builtins: { ...builtins }, customs: {} };
}

/** Resolve a preset by name (customs first, then built-ins); throws on unknown names. */
export function getPreset(store: PresetStore, name: string): ExportPreset {
  const p = store.customs[name] ?? store.builtins[name];
  if (!p) throw new Error(`unknown export preset: ${name}`);
  return p;
}

/** Add a user preset from shared JSON; a name colliding with a built-in (or an existing custom) is refused. */
export function addCustomPreset(store: PresetStore, json: string): ExportPreset {
  const p = parseExportPreset(json);
  if (store.builtins[p.name]) {
    throw new Error(`custom preset name "${p.name}" collides with a built-in preset`);
  }
  if (store.customs[p.name]) {
    throw new Error(`custom preset "${p.name}" already exists`);
  }
  store.customs[p.name] = p;
  return p;
}

export function listPresets(store: PresetStore): ExportPreset[] {
  return [...Object.values(store.builtins), ...Object.values(store.customs)];
}

// --- HDR <-> SDR --------------------------------------------------------------

/** zscale colourspace names for an HDR source (PQ / BT.2020). */
export interface HdrSourceSpace {
  primaries: string;
  matrix: string;
  transfer: string;
}

export const HDR_BT2020_PQ: HdrSourceSpace = {
  primaries: 'bt2020',
  matrix: '2020_ncl',
  transfer: 'smpte2084',
};

/**
 * HDR -> SDR (Rec.709) video filter, appended at the END of the video
 * chain (after subtitles are burned). Explicit input specs (pin/min/
 * tin) are required — see the module header. Operator defaults to
 * hable (FFmpeg-wiki standard); mobius/reinhard keep mid-tones
 * brighter at the cost of a softer highlight rolloff.
 */
export function hdrToSdrFilter(
  src: HdrSourceSpace = HDR_BT2020_PQ,
  operator: TonemapOperator = 'hable',
): string {
  return (
    `zscale=pin=${src.primaries}:min=${src.matrix}:tin=${src.transfer}:rangein=tv:t=linear:npl=100,` +
    `format=gbrpf32le,zscale=p=bt709,tonemap=${operator},format=yuv420p`
  );
}

/**
 * SDR -> HDR (PSEUDO-HDR): lifts SDR into a 10-bit PQ / BT.2020
 * container. Single zscale — the two-step form via gbrpf32le has no
 * path from RGB float to YCbCr in the second zscale (measured).
 * The caller MUST encode with libx265 + yuv420p10le + bt2020 /
 * smpte2084 / bt2020nc tags (see resolveEncoderArgs) or the file is
 * not a valid HDR container.
 */
export function sdrToHdrFilter(): string {
  return (
    'zscale=pin=bt709:min=bt709:tin=bt709:rangein=tv:' +
    'p=bt2020:t=smpte2084:m=2020_ncl:range=tv,format=yuv420p10le'
  );
}

/** Video filter for an HDR mode, or undefined when the mode is 'off'. */
export function hdrVideoFilter(
  mode: HdrMode,
  src?: HdrSourceSpace,
  operator?: TonemapOperator,
): string | undefined {
  if (mode === 'hdr-to-sdr') return hdrToSdrFilter(src, operator);
  if (mode === 'sdr-to-hdr') return sdrToHdrFilter();
  return undefined;
}

// --- Encoder plan -----------------------------------------------------------

export interface EncoderPlan {
  codec: 'libx264' | 'libx265';
  pixFmt: string;
  /** Extra output args (colour tags for pseudo-HDR). */
  extraArgs: string[];
}

/**
 * Resolve the encoder for a preset + HDR mode.
 * - sdr-to-hdr FORCES libx265 + yuv420p10le + BT.2020/PQ tags (a
 *   10-bit PQ container cannot be written with 8-bit libx264).
 * - hdr-to-sdr keeps the preset codec but forces yuv420p (the tonemap
 *   chain ends in yuv420p).
 * - otherwise the preset codec (default libx264) + yuv420p.
 */
export function resolveEncoderArgs(preset: ExportPreset, hdrMode: HdrMode): EncoderPlan {
  if (hdrMode === 'sdr-to-hdr') {
    return {
      codec: 'libx265',
      pixFmt: 'yuv420p10le',
      extraArgs: ['-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc'],
    };
  }
  return { codec: preset.codec ?? 'libx264', pixFmt: 'yuv420p', extraArgs: [] };
}

// --- Batch export queue -----------------------------------------------------

export interface QueueItem {
  id: string;
  project: Project;
  output: string;
  /** Preset name resolved through the store; absent = the queue's base preset. */
  presetName?: string;
  exportOnly?: ExportOnlyMode;
  label?: string;
}

export interface QueueItemResult {
  id: string;
  status: 'done' | 'failed';
  error?: string;
  report?: ExportReport;
}

/** Validate a queue item; throws on the first problem. Returns it typed. */
export function validateQueueItem(item: unknown): QueueItem {
  if (!item || typeof item !== 'object') throw new Error('queue item: not an object');
  const q = item as Record<string, unknown>;
  if (typeof q.id !== 'string' || !q.id) throw new Error('queue item: missing id');
  if (typeof q.output !== 'string' || !q.output) throw new Error(`queue item ${q.id}: missing output`);
  const p = q.project as { clips?: unknown[] } | undefined;
  if (!p || !Array.isArray(p.clips) || p.clips.length === 0) {
    throw new Error(`queue item ${q.id}: project has no clips`);
  }
  if (q.presetName !== undefined && typeof q.presetName !== 'string') {
    throw new Error(`queue item ${q.id}: bad presetName`);
  }
  if (q.exportOnly !== undefined && !['none', 'video', 'audio', 'subtitle'].includes(String(q.exportOnly))) {
    throw new Error(`queue item ${q.id}: bad exportOnly ${String(q.exportOnly)}`);
  }
  return item as QueueItem;
}

export function queueAdd(queue: QueueItem[], item: QueueItem): QueueItem[] {
  const v = validateQueueItem(item);
  if (queue.some((q) => q.id === v.id)) throw new Error(`queue: duplicate id "${v.id}"`);
  return [...queue, v];
}

export function queueRemove(queue: QueueItem[], id: string): QueueItem[] {
  if (!queue.some((q) => q.id === id)) throw new Error(`queue: unknown id "${id}"`);
  return queue.filter((q) => q.id !== id);
}

export function queueMove(queue: QueueItem[], id: string, toIndex: number): QueueItem[] {
  const from = queue.findIndex((q) => q.id === id);
  if (from < 0) throw new Error(`queue: unknown id "${id}"`);
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= queue.length) {
    throw new Error(`queue: move index ${toIndex} outside 0..${queue.length - 1}`);
  }
  const next = [...queue];
  const [it] = next.splice(from, 1);
  next.splice(toIndex, 0, it);
  return next;
}

export interface RunQueueOptions {
  store: PresetStore;
  baseOpts: ExportOptions;
}

/**
 * Run a queue sequentially with the caller's export function (dependency
 * injection: deliver.ts never imports export.ts, so there is no import
 * cycle). A failed item is recorded and the queue CONTINUES with the
 * next item; an unknown preset name fails that item only.
 */
export async function runExportQueue(
  queue: QueueItem[],
  runExport: (project: Project, output: string, opts: ExportOptions) => Promise<ExportReport>,
  opts: RunQueueOptions,
): Promise<QueueItemResult[]> {
  const results: QueueItemResult[] = [];
  for (const item of queue) {
    try {
      const preset = item.presetName ? getPreset(opts.store, item.presetName) : opts.baseOpts.preset;
      const o: ExportOptions = {
        ...opts.baseOpts,
        preset,
        ...(item.exportOnly !== undefined && item.exportOnly !== 'none'
          ? { exportOnly: item.exportOnly }
          : {}),
      };
      const report = await runExport(item.project, item.output, o);
      results.push({ id: item.id, status: 'done', report });
    } catch (e) {
      results.push({ id: item.id, status: 'failed', error: (e as Error).message });
    }
  }
  return results;
}
