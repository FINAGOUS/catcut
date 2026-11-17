// Advanced colour grading (P2, M4): HSL zone grading, RGB/master curves,
// white balance, and .cube LUT import.
//
// Everything is implemented as a pure-TS 3D LUT builder: the adjustments
// are baked into one .cube file per clip (generated once at export prep,
// next to the output, like the mask PNGs) and applied with FFmpeg's
// lut3d filter. No per-frame geq, no runtime expression tricks — the
// same input always produces the same .cube bytes (deterministic).
//
// Order inside one LUT, per grid node: white-balance gains -> HSL zone
// adjustments -> per-channel curves -> master curve. The clip's P0
// eq/colorbalance stage (brightness/contrast/saturation/temperature)
// still runs first in the filter graph, so old ColorAdjust fields and
// the new advanced fields compose; an imported .cube (lutFile) applies
// after the generated LUT, and the project preset LUT (ExportPreset.lut)
// still applies last.
//
// LGPL: lut3d is a native libavfilter filter (LGPL part) but is only
// verified here on the local GPL 8.1.2 build — re-check on the BtbN
// LGPL 9.0 build at the M2 gate. The LUT math itself is our own code.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from './project.js';

export type HueZoneName =
  | 'red' | 'orange' | 'yellow' | 'green' | 'cyan' | 'blue' | 'magenta';

/** Hue centre in degrees for each zone (HSL hue circle). */
export const HUE_ZONE_CENTER: Record<HueZoneName, number> = {
  red: 0, orange: 30, yellow: 60, green: 120, cyan: 180, blue: 240, magenta: 300,
};

/**
 * One HSL zone adjustment. `saturation` is a multiplier (1 = unchanged,
 * 0 = fully desaturated in that zone); `lightness` is a delta added to
 * L (-1..1). A zone's weight falls off linearly from 1 at its centre to
 * 0 at +/-45 degrees (HSL_ZONE_HALF_WIDTH), so neighbouring zones blend
 * instead of cutting a hard edge. Multiple zones apply in listed order,
 * each weighted by its own falloff.
 */
export const HSL_ZONE_HALF_WIDTH = 45;

export interface HslZoneAdjust {
  hue: HueZoneName;
  /** Saturation multiplier, 0..3 (1 = unchanged). */
  saturation?: number;
  /** Lightness delta, -1..1 (0 = unchanged). */
  lightness?: number;
}

/** One curve control point, input/output both in [0, 1]. */
export interface CurvePoint {
  x: number;
  y: number;
}

/** Per-channel + master curves. `master` applies to every channel after
 *  the per-channel curve (the FCP-style RGB master curve). */
export interface Curves {
  master?: CurvePoint[];
  red?: CurvePoint[];
  green?: CurvePoint[];
  blue?: CurvePoint[];
}

/** White balance: temperature -1 (cool) .. +1 (warm), tint -1 (green) ..
 *  +1 (magenta). Implemented as channel gains in the LUT (see
 *  buildColorLut): temperature moves red/blue in opposite directions,
 *  tint moves green against red+blue. This is separate from the P0
 *  `ColorAdjust.temperature` (colorbalance rs/bs), which still runs first
 *  when both are set. */
export interface WhiteBalance {
  temperature?: number;
  tint?: number;
}

/**
 * One colour-wheel zone (P3, M4 §8.4 — the P2a summary's "色轮三区
 * 未做"). Hue shift in degrees (-180..180) + saturation multiplier
 * (0..3, 1 = unchanged), weighted by the pixel's lightness so the
 * three zones do not bleed into each other (see zoneWeight below).
 * Unlike the HSL zones (which are keyed on HUE), the wheels are
 * keyed on LIGHTNESS — shadows/midtones/highlights — like FCP's
 * colour wheels. Baked into the same 3D LUT as the HSL zones.
 */
export interface ColorWheelZone {
  /** Hue rotation in degrees, -180..180 (0 = unchanged). */
  hueShift?: number;
  /** Saturation multiplier, 0..3 (1 = unchanged). */
  saturation?: number;
}

/** Colour wheels: one zone per tonal range. */
export interface ColorWheels {
  shadows?: ColorWheelZone;
  midtones?: ColorWheelZone;
  highlights?: ColorWheelZone;
}

/**
 * HSL curves (P3, M4 §8.4 — "HSL 曲线（色相-饱和度/色相-亮度）",
 * Resolve-style hue curves; complements the P2a HSL zones, which are
 * stepped per zone instead of continuous). x is hue/360 in [0, 1],
 * y is a saturation multiplier [0, 3] (hueVsSat) or a lightness delta
 * [-1, 1] (hueVsLum). Points must be strictly increasing in x; for
 * wraparound continuity the first point should be x=0 and the last
 * x=1 (applyCurve clamps outside the endpoints).
 */
export interface HslCurves {
  hueVsSat?: CurvePoint[];
  hueVsLum?: CurvePoint[];
}

export interface AdvancedColor {
  whiteBalance?: WhiteBalance;
  hsl?: HslZoneAdjust[];
  curves?: Curves;
  /** Path to an imported .cube file (validated at export prep with
   *  parseCube; bad files throw instead of being silently skipped). */
  lutFile?: string;
  /** Colour wheels (P3): shadows/midtones/highlights hue+saturation. */
  colorWheels?: ColorWheels;
  /** HSL curves (P3): hue-vs-saturation / hue-vs-lightness. */
  hslCurves?: HslCurves;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Shortest angular distance in degrees between two hue angles. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** RGB (0..1) -> HSL (h in degrees 0..360, s/l in 0..1). */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

/** HSL (h in degrees 0..360, s/l in 0..1) -> RGB (0..1). */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

/** Piecewise-linear curve lookup. Outside the first/last control point
 *  the value clamps to that point's y (no extrapolation). */
export function applyCurve(points: CurvePoint[], x: number): number {
  if (points.length === 0) return x;
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (x >= p0.x && x <= p1.x) {
      const t = (x - p0.x) / (p1.x - p0.x);
      return p0.y + t * (p1.y - p0.y);
    }
  }
  return last.y;
}

function validateCurve(points: CurvePoint[], name: string, id: string): void {
  if (points.length < 2) {
    throw new Error(`clip ${id}: advancedColor.curves.${name} needs at least 2 points`);
  }
  let prevX = -Infinity;
  for (const p of points) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || Number.isNaN(p.x) || Number.isNaN(p.y)) {
      throw new Error(`clip ${id}: advancedColor.curves.${name} has a non-numeric point`);
    }
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) {
      throw new Error(`clip ${id}: advancedColor.curves.${name} point (${p.x}, ${p.y}) outside [0, 1]`);
    }
    if (p.x <= prevX) {
      throw new Error(`clip ${id}: advancedColor.curves.${name} x values must be strictly increasing`);
    }
    prevX = p.x;
  }
}

/** Validate an AdvancedColor; throws with a clip id in the message. */
export function validateAdvancedColor(adv: AdvancedColor, id: string): void {
  if (!adv) return;
  const wb = adv.whiteBalance;
  if (wb) {
    for (const k of ['temperature', 'tint'] as const) {
      const v = wb[k];
      if (v !== undefined && (typeof v !== 'number' || Number.isNaN(v) || v < -1 || v > 1)) {
        throw new Error(`clip ${id}: advancedColor.whiteBalance.${k} ${v} outside [-1, 1]`);
      }
    }
  }
  for (const z of adv.hsl ?? []) {
    if (!(z.hue in HUE_ZONE_CENTER)) {
      throw new Error(`clip ${id}: advancedColor.hsl unknown hue zone ${String(z.hue)}`);
    }
    if (z.saturation !== undefined && (typeof z.saturation !== 'number' || Number.isNaN(z.saturation) || z.saturation < 0 || z.saturation > 3)) {
      throw new Error(`clip ${id}: advancedColor.hsl.${z.hue}.saturation ${z.saturation} outside [0, 3]`);
    }
    if (z.lightness !== undefined && (typeof z.lightness !== 'number' || Number.isNaN(z.lightness) || z.lightness < -1 || z.lightness > 1)) {
      throw new Error(`clip ${id}: advancedColor.hsl.${z.hue}.lightness ${z.lightness} outside [-1, 1]`);
    }
  }
  if (adv.curves) {
    for (const k of ['master', 'red', 'green', 'blue'] as const) {
      const pts = adv.curves[k];
      if (pts) validateCurve(pts, k, id);
    }
  }
  if (adv.lutFile !== undefined && (typeof adv.lutFile !== 'string' || !adv.lutFile)) {
    throw new Error(`clip ${id}: advancedColor.lutFile must be a non-empty path`);
  }
  if (adv.colorWheels) {
    for (const k of ['shadows', 'midtones', 'highlights'] as const) {
      const z = adv.colorWheels[k];
      if (!z) continue;
      if (z.hueShift !== undefined && (typeof z.hueShift !== 'number' || Number.isNaN(z.hueShift) || z.hueShift < -180 || z.hueShift > 180)) {
        throw new Error(`clip ${id}: advancedColor.colorWheels.${k}.hueShift ${z.hueShift} outside [-180, 180]`);
      }
      if (z.saturation !== undefined && (typeof z.saturation !== 'number' || Number.isNaN(z.saturation) || z.saturation < 0 || z.saturation > 3)) {
        throw new Error(`clip ${id}: advancedColor.colorWheels.${k}.saturation ${z.saturation} outside [0, 3]`);
      }
    }
  }
  if (adv.hslCurves) {
    if (adv.hslCurves.hueVsSat) validateHueCurve(adv.hslCurves.hueVsSat, 'hueVsSat', 0, 3, id);
    if (adv.hslCurves.hueVsLum) validateHueCurve(adv.hslCurves.hueVsLum, 'hueVsLum', -1, 1, id);
  }
}

/** Validate one hue curve: x is hue/360 in [0, 1], y in [yLo, yHi]. */
function validateHueCurve(points: CurvePoint[], name: string, yLo: number, yHi: number, id: string): void {
  if (points.length < 2) {
    throw new Error(`clip ${id}: advancedColor.hslCurves.${name} needs at least 2 points`);
  }
  let prevX = -Infinity;
  for (const p of points) {
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || Number.isNaN(p.x) || Number.isNaN(p.y)) {
      throw new Error(`clip ${id}: advancedColor.hslCurves.${name} has a non-numeric point`);
    }
    if (p.x < 0 || p.x > 1 || p.y < yLo || p.y > yHi) {
      throw new Error(`clip ${id}: advancedColor.hslCurves.${name} point (${p.x}, ${p.y}) outside x [0, 1] / y [${yLo}, ${yHi}]`);
    }
    if (p.x <= prevX) {
      throw new Error(`clip ${id}: advancedColor.hslCurves.${name} x values must be strictly increasing`);
    }
    prevX = p.x;
  }
}

/**
 * Colour-wheel zone weight from HSL lightness L (0..1). Smoothstep
 * falloffs so the zones blend instead of cutting a hard edge:
 * shadows fade out over L 0.20..0.55, highlights fade in over
 * 0.45..0.80, midtones is the product of the two ramps (peaks at
 * L=0.5). Measured 2026-11-18: at L=0.25 shadows 0.94, midtones
 * 0.07, highlights 0.00; at L=0.50 shadows 0.06, midtones 1.00,
 * highlights 0.06; at L=0.75 shadows 0.00, midtones 0.07,
 * highlights 0.94.
 */
export function colorWheelWeight(zone: 'shadows' | 'midtones' | 'highlights', l: number): number {
  const smooth = (a: number, b: number, x: number): number => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  if (zone === 'shadows') return 1 - smooth(0.2, 0.55, l);
  if (zone === 'highlights') return smooth(0.45, 0.8, l);
  return smooth(0.2, 0.5, l) * (1 - smooth(0.5, 0.8, l));
}

/**
 * Apply the advanced adjustments to one RGB triple (0..1 in, 0..1 out).
 * Pure function of the input — the LUT builder calls it once per node.
 */
export function applyAdvancedColorToRgb(
  adv: AdvancedColor,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  // White balance gains: temperature +1 = red +25% / blue -25%;
  // tint +1 (magenta) = green -15% / red+blue +7.5% each.
  const wb = adv.whiteBalance;
  if (wb) {
    const t = wb.temperature ?? 0;
    const tint = wb.tint ?? 0;
    r = r * (1 + 0.25 * t) * (1 + 0.075 * tint);
    g = g * (1 - 0.15 * tint);
    b = b * (1 - 0.25 * t) * (1 + 0.075 * tint);
  }
  r = clamp01(r);
  g = clamp01(g);
  b = clamp01(b);
  // HSL zones + colour wheels + HSL curves: one HSL pass. Zones are
  // keyed on hue, wheels on lightness, curves on hue (continuous) —
  // all three read the same (h, s, l) and compose in listed order.
  const zones = adv.hsl ?? [];
  const wheels = adv.colorWheels;
  const curves = adv.hslCurves;
  if (zones.length > 0 || wheels || curves) {
    let [h, s, l] = rgbToHsl(r, g, b);
    for (const z of zones) {
      const w = Math.max(0, 1 - hueDistance(h, HUE_ZONE_CENTER[z.hue]) / HSL_ZONE_HALF_WIDTH);
      if (w === 0) continue;
      if (z.saturation !== undefined) s = clamp01(s * (1 + (z.saturation - 1) * w));
      if (z.lightness !== undefined) l = clamp01(l + z.lightness * w);
    }
    if (wheels) {
      for (const k of ['shadows', 'midtones', 'highlights'] as const) {
        const z = wheels[k];
        if (!z) continue;
        const w = colorWheelWeight(k, l);
        if (w === 0) continue;
        if (z.hueShift !== undefined) h = (((h + z.hueShift * w) % 360) + 360) % 360;
        if (z.saturation !== undefined) s = clamp01(s * (1 + (z.saturation - 1) * w));
      }
    }
    if (curves) {
      const hx = h / 360;
      if (curves.hueVsSat) s = clamp01(s * applyCurve(curves.hueVsSat, hx));
      if (curves.hueVsLum) l = clamp01(l + applyCurve(curves.hueVsLum, hx));
    }
    [r, g, b] = hslToRgb(h, s, l);
  }
  // Curves: per-channel first, then master on every channel.
  const c = adv.curves;
  if (c) {
    if (c.red) r = applyCurve(c.red, r);
    if (c.green) g = applyCurve(c.green, g);
    if (c.blue) b = applyCurve(c.blue, b);
    if (c.master) {
      r = applyCurve(c.master, r);
      g = applyCurve(c.master, g);
      b = applyCurve(c.master, b);
    }
  }
  return [clamp01(r), clamp01(g), clamp01(b)];
}

export interface BuiltLut {
  /** LUT_3D_SIZE. */
  size: number;
  /** Flat RGB triples, .cube order: R fastest, then G, then B
   *  (data.length === size^3). */
  data: Float64Array;
}

/**
 * Bake an AdvancedColor into a 3D LUT. `size` 17 (4,913 nodes, default,
 * fast) or 33 (35,937 nodes, finer). Deterministic: same input, same
 * bytes out (no randomness, no time, no float-order dependence — the
 * loop order is fixed).
 */
export function buildColorLut(adv: AdvancedColor, size = 17): BuiltLut {
  if (size < 2 || size > 64 || !Number.isInteger(size)) {
    throw new Error(`buildColorLut: size ${size} outside [2, 64]`);
  }
  const n = size * size * size;
  const data = new Float64Array(n * 3);
  let i = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const [r, g, b] = applyAdvancedColorToRgb(
          adv,
          ri / (size - 1),
          gi / (size - 1),
          bi / (size - 1),
        );
        data[i++] = r;
        data[i++] = g;
        data[i++] = b;
      }
    }
  }
  return { size, data };
}

/** Serialise a built LUT to .cube text (6 decimals, fixed format). */
export function lutToCube(lut: BuiltLut, title = 'CatCut advanced colour'): string {
  const lines: string[] = [
    `TITLE "${title}"`,
    `LUT_3D_SIZE ${lut.size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ];
  for (let i = 0; i < lut.data.length; i += 3) {
    lines.push(
      `${lut.data[i].toFixed(6)} ${lut.data[i + 1].toFixed(6)} ${lut.data[i + 2].toFixed(6)}`,
    );
  }
  return lines.join('\n') + '\n';
}

/** Write a generated LUT to a .cube file; returns the path. */
export function writeColorLutFile(adv: AdvancedColor, outPath: string, size = 17): string {
  writeFileSync(outPath, lutToCube(buildColorLut(adv, size)), 'utf8');
  return outPath;
}

export interface ParsedCube {
  size: number;
  /** Flat RGB triples, same order as buildColorLut output. */
  data: Float64Array;
}

/**
 * Parse a .cube file (3D LUT). Accepts LUT_3D_SIZE 2..64 (17 and 33
 * verified in tests) with the default 0..1 domain. Throws on: missing
 * or out-of-range LUT_3D_SIZE, non-default DOMAIN_MIN/MAX, wrong data
 * count, non-numeric values, values outside [0, 1], or 1D LUTs. A bad
 * file is a hard error, never a silent skip.
 */
export function parseCube(text: string, id = 'cube'): ParsedCube {
  let size: number | undefined;
  const rows: number[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('TITLE')) continue;
    if (line.startsWith('LUT_1D_SIZE')) {
      throw new Error(`${id}: 1D LUTs are not supported (3D only)`);
    }
    const sizeMatch = line.match(/^LUT_3D_SIZE\s+(\d+)$/);
    if (sizeMatch) {
      size = Number(sizeMatch[1]);
      continue;
    }
    const domainMatch = line.match(/^DOMAIN_(MIN|MAX)\s+(.+)$/);
    if (domainMatch) {
      const vals = domainMatch[2].trim().split(/\s+/).map(Number);
      const want = domainMatch[1] === 'MIN' ? [0, 0, 0] : [1, 1, 1];
      if (vals.length !== 3 || vals.some((v, i) => v !== want[i])) {
        throw new Error(`${id}: non-default DOMAIN_${domainMatch[1]} is not supported`);
      }
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length !== 3) {
      throw new Error(`${id}: bad data line "${line}" (expected 3 numbers)`);
    }
    for (const p of parts) {
      const v = Number(p);
      if (!Number.isFinite(v)) {
        throw new Error(`${id}: non-numeric LUT value "${p}"`);
      }
      if (v < 0 || v > 1) {
        throw new Error(`${id}: LUT value ${v} outside [0, 1]`);
      }
      rows.push(v);
    }
  }
  if (size === undefined) throw new Error(`${id}: missing LUT_3D_SIZE`);
  if (!Number.isInteger(size) || size < 2 || size > 64) {
    throw new Error(`${id}: LUT_3D_SIZE ${size} outside [2, 64]`);
  }
  if (rows.length !== size * size * size * 3) {
    throw new Error(
      `${id}: expected ${size * size * size} RGB rows for LUT_3D_SIZE ${size}, got ${rows.length / 3}`,
    );
  }
  return { size, data: Float64Array.from(rows) };
}

/** lut3d filter argument for a .cube path (quotes escaped for the graph). */
export function lut3dFilter(path: string): string {
  return `lut3d='${path.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")}'`;
}

/**
 * Export-prep step for advanced colour (follows the portrait-mask
 * pattern): for every clip with advancedColor, validate it, bake the
 * HSL/curves/white-balance adjustments into a .cube file next to the
 * output (audit trail, like the mask PNGs), and validate an imported
 * .cube with parseCube. Returns clipIdx -> ordered lut3d paths
 * (generated first, imported second). A clip with advancedColor but
 * only an imported .cube gets just that path; a clip with no
 * adjustments at all still gets an empty entry so the graph stage can
 * tell "prepared" from "forgot to prepare".
 */
export function prepareColorLuts(
  project: Project,
  outDir: string,
  size = 17,
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  project.clips.forEach((clip, i) => {
    const adv = clip.advancedColor;
    if (!adv) return;
    validateAdvancedColor(adv, clip.id);
    const paths: string[] = [];
    const needsGenerated =
      adv.whiteBalance !== undefined ||
      (adv.hsl?.length ?? 0) > 0 ||
      adv.curves !== undefined ||
      adv.colorWheels !== undefined ||
      adv.hslCurves !== undefined;
    if (needsGenerated) {
      const p = join(outDir, `color-c${i}.cube`);
      writeColorLutFile(adv, p, size);
      paths.push(p);
    }
    if (adv.lutFile) {
      // Validate the import now — a bad .cube is a hard error at prep
      // time, not a silent skip at encode time.
      parseCube(readFileSync(adv.lutFile, 'utf8'), `clip ${clip.id} lutFile`);
      paths.push(adv.lutFile);
    }
    out.set(i, paths);
  });
  return out;
}
