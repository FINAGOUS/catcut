// Shape masks: pre-generated PNG mask + alphamerge (P1, M4).
// The mask PNG is baked ONCE per shape (SDF alpha, feather included) and
// fed to FFmpeg as a still-image input; the export never runs geq
// per-frame (slow at 4K). geq was only used in the 2026-11-16 experiment
// to bake the first prototype PNG; the engine now renders PNGs in pure
// TypeScript (node:zlib + hand-rolled PNG chunks, no dependency).
// LGPL note: alphamerge/alphaextract/overlay are libavfilter filters
// (LGPL part of FFmpeg), but they have only been verified on this
// machine's GPL 8.1.2 build — re-check with `ffmpeg -filters` on the
// BtbN LGPL 9.0 build before shipping (M2 gate).
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clip, ClipMask, MaskShape, Project } from './project.js';
import { clipDuration } from './project.js';

/** One masked time segment: shape applies on [t0, t1). */
export interface MaskSegment {
  t0: number;
  t1: number;
  shape: MaskShape;
  /** Index into the per-clip PNG file list (one PNG per segment). */
  fileIndex: number;
}

export function validateMask(mask: ClipMask): void {
  if (mask.x < 0 || mask.x > 1 || mask.y < 0 || mask.y > 1) {
    throw new Error(`mask centre (${mask.x}, ${mask.y}) outside 0..1`);
  }
  if (mask.w <= 0 || mask.w > 1 || mask.h <= 0 || mask.h > 1) {
    throw new Error(`mask size (${mask.w}, ${mask.h}) outside (0, 1]`);
  }
  if (mask.radius !== undefined && (mask.radius < 0 || mask.radius > 0.5)) {
    throw new Error(`mask radius ${mask.radius} outside 0..0.5`);
  }
  if (mask.feather !== undefined && mask.feather < 0) {
    throw new Error(`mask feather ${mask.feather} must be >= 0`);
  }
  if (mask.backgroundBlur !== undefined && mask.backgroundBlur < 0) {
    throw new Error(`mask backgroundBlur ${mask.backgroundBlur} must be >= 0`);
  }
}

/** Pixel size of the mask box. Circle is pixel-square (diameter = w).
 *  Sizes are rounded to EVEN numbers: yuva420p (4:2:0) forces odd sizes
 *  down (333 -> 332, verified 2026-11-17), which would desync the mask
 *  PNG from the scaled foreground and break alphamerge. */
export function maskPixelSize(
  mask: ClipMask,
  frameW: number,
  frameH: number,
  shape: MaskShape = mask.shape,
): { pxW: number; pxH: number } {
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const pxW = even(mask.w * frameW);
  const pxH = shape === 'circle' ? pxW : even(mask.h * frameH);
  return { pxW, pxH };
}

/** Overlay position (top-left) of the mask box, clamped inside the frame. */
export function maskOverlayPos(
  mask: ClipMask,
  frameW: number,
  frameH: number,
  shape: MaskShape = mask.shape,
): { x: number; y: number; pxW: number; pxH: number } {
  const { pxW, pxH } = maskPixelSize(mask, frameW, frameH, shape);
  const x = Math.max(0, Math.min(frameW - pxW, Math.round(mask.x * frameW - pxW / 2)));
  const y = Math.max(0, Math.min(frameH - pxH, Math.round(mask.y * frameH - pxH / 2)));
  return { x, y, pxW, pxH };
}

/** Split a mask's keyframes into time segments over [0, duration). */
export function maskSegments(mask: ClipMask, duration: number): MaskSegment[] {
  validateMask(mask);
  const keys = (mask.keyframes ?? []).slice().sort((a, b) => a.t - b.t);
  const bounds: { t: number; shape: MaskShape }[] = [{ t: 0, shape: mask.shape }];
  for (const k of keys) {
    const t = Math.min(Math.max(k.t, 0), duration);
    if (t > bounds[bounds.length - 1].t) bounds.push({ t, shape: k.shape });
    else if (t === bounds[bounds.length - 1].t) bounds[bounds.length - 1].shape = k.shape;
  }
  const segments: MaskSegment[] = [];
  for (let i = 0; i < bounds.length; i++) {
    const t0 = bounds[i].t;
    const t1 = i + 1 < bounds.length ? bounds[i + 1].t : duration;
    if (t1 - t0 < 1e-6) continue;
    segments.push({ t0, t1, shape: bounds[i].shape, fileIndex: segments.length });
  }
  return segments.length > 0
    ? segments
    : [{ t0: 0, t1: duration, shape: mask.shape, fileIndex: 0 }];
}

// --- Signed-distance alpha -------------------------------------------------

/** Signed distance (px) from (px, py) to the shape edge; <= 0 is inside. */
function shapeSdf(shape: MaskShape, px: number, py: number, w: number, h: number, radius: number): number {
  const cx = w / 2;
  const cy = h / 2;
  if (shape === 'circle') {
    return Math.hypot(px - cx, py - cy) - w / 2;
  }
  if (shape === 'ellipse') {
    const rx = w / 2;
    const ry = h / 2;
    // Normalised radial distance, scaled back to px by the smaller radius.
    return (Math.hypot((px - cx) / rx, (py - cy) / ry) - 1) * Math.min(rx, ry);
  }
  // rect / roundedRect: iq's round-box SDF.
  const r = shape === 'roundedRect' ? Math.min(radius, w / 2, h / 2) : 0;
  const bx = w / 2 - r;
  const by = h / 2 - r;
  const qx = Math.abs(px - cx) - bx;
  const qy = Math.abs(py - cy) - by;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Alpha 0..255 at one pixel. Feather spreads the edge over `feather` px. */
export function maskAlpha(mask: ClipMask, pxW: number, pxH: number, px: number, py: number, shape: MaskShape = mask.shape): number {
  const feather = mask.feather ?? 0;
  const radius = (mask.radius ?? 0.25) * Math.min(pxW, pxH);
  const sd = shapeSdf(shape, px + 0.5, py + 0.5, pxW, pxH, radius);
  if (feather <= 0) return sd <= 0 ? 255 : 0;
  const a = 0.5 - sd / feather;
  return Math.max(0, Math.min(255, Math.round(a * 255)));
}

// --- Minimal PNG writer (RGBA, 8-bit, filter 0) ----------------------------

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crc = crc32(Buffer.concat([Buffer.from(type, 'ascii'), data]));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

/** Encode a raw RGBA scanline buffer (filter-0 rows) as a PNG. */
function pngFromRgba(raw: Buffer, pxW: number, pxH: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(pxW, 0);
  ihdr.writeUInt32BE(pxH, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Render a mask to a PNG buffer (white RGB, shape in the alpha channel).
 *  The shape FILLS the given canvas: P1 renders at the mask-box size
 *  (maskPixelSize) and positions it with overlay. Do NOT call this at
 *  frame size for a full-frame mask — use renderFrameMaskPng. */
export function renderMaskPng(mask: ClipMask, pxW: number, pxH: number, shape: MaskShape = mask.shape): Buffer {
  validateMask(mask);
  const raw = Buffer.alloc(pxH * (1 + pxW * 4));
  for (let y = 0; y < pxH; y++) {
    const row = y * (1 + pxW * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < pxW; x++) {
      const o = row + 1 + x * 4;
      raw[o] = 255;
      raw[o + 1] = 255;
      raw[o + 2] = 255;
      raw[o + 3] = maskAlpha(mask, pxW, pxH, x, y, shape);
    }
  }
  return pngFromRgba(raw, pxW, pxH);
}

/**
 * Render a mask to a FULL-FRAME PNG buffer (white RGB, shape in the
 * alpha channel) for maskedmerge-style full-frame application (P3 node
 * grading). The shape occupies only its box — centre (x, y), size
 * (w, h) as frame fractions — on a black (alpha 0) full-frame canvas.
 * Rendering renderMaskPng at frame size instead paints the shape over
 * the whole frame (verify-p3g: node mask alpha 255 everywhere, grade
 * leaked to the corner).
 */
export function renderFrameMaskPng(mask: ClipMask, frameW: number, frameH: number, shape: MaskShape = mask.shape): Buffer {
  validateMask(mask);
  const bw = mask.w * frameW;
  const bh = shape === 'circle' ? bw : mask.h * frameH;
  const cx = mask.x * frameW;
  const cy = mask.y * frameH;
  const feather = mask.feather ?? 0;
  const radius = (mask.radius ?? 0.25) * Math.min(bw, bh);
  const raw = Buffer.alloc(frameH * (1 + frameW * 4));
  for (let y = 0; y < frameH; y++) {
    const row = y * (1 + frameW * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < frameW; x++) {
      const o = row + 1 + x * 4;
      // Translate into the box's local frame (box centred at bw/2, bh/2).
      const sd = shapeSdf(shape, x + 0.5 - cx + bw / 2, y + 0.5 - cy + bh / 2, bw, bh, radius);
      let a: number;
      if (feather <= 0) a = sd <= 0 ? 255 : 0;
      else a = Math.max(0, Math.min(255, Math.round((0.5 - sd / feather) * 255)));
      raw[o] = 255;
      raw[o + 1] = 255;
      raw[o + 2] = 255;
      raw[o + 3] = a;
    }
  }
  return pngFromRgba(raw, frameW, frameH);
}

/**
 * Generate one PNG per mask segment for every masked clip and write them
 * under `dir`. Returns clip index -> PNG paths (segment order). The files
 * are kept next to the export as an audit trail, like the .ass file.
 */
export function prepareClipMaskFiles(project: Project, dir: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  mkdirSync(dir, { recursive: true });
  project.clips.forEach((clip: Clip, i: number) => {
    if (!clip.mask) return;
    const dur = clipDuration(clip);
    const segments = maskSegments(clip.mask, dur);
    const files = segments.map((seg) => {
      const { pxW, pxH } = maskPixelSize(clip.mask as ClipMask, project.width, project.height, seg.shape);
      const file = join(dir, `mask-c${i}-s${seg.fileIndex}.png`);
      writeFileSync(file, renderMaskPng(clip.mask as ClipMask, pxW, pxH, seg.shape));
      return file;
    });
    out.set(i, files);
  });
  return out;
}
