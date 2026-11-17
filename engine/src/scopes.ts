// Scopes (P2, M4): waveform / vectorscope / RGB parade as NUMBERS, not
// just pictures. FFmpeg extracts one frame as raw RGB24; every statistic
// below is pure TypeScript over those pixels, so the numbers are
// reproducible and unit-testable (the FCP "colour inspector" data the
// WPF side will draw).
//
// Definitions (written down so the numbers can be re-derived):
// - Luma is Rec.709: Y = 0.2126R + 0.7152G + 0.0722B.
// - RGB parade: per-channel mean / min / max / peak bin (histogram mode,
//   0..255) / p99 (99th-percentile value).
// - Vectorscope: per-pixel HSV saturation (max-min)/max and hue; the
//   dominant hue is the circular mean over pixels with saturation > 0.05
//   and max channel > 0.05. When the frame is effectively grey
//   (saturationMean < 0.02) the dominant hue is null — grey has no hue.
//   hueHistogram has 12 bins of 30 degrees.
// - Clipping: highlight = fraction of pixels with min(R,G,B) > 250
//   (near-white blowout — all three channels near max); shadow =
//   fraction with max(R,G,B) < 5 (near-black crush). A saturated
//   colour (e.g. pure red 253,0,0) is NOT clipping: only one channel
//   is high, the pixel still carries colour information.
// - renderScopeImage() also produces the picture (FFmpeg waveform /
//   vectorscope filters) for the WPF preview; the numbers above are the
//   source of truth, the picture is only a view.
//
// Determinism note (the vidstab lesson): frame extraction is a plain
// decode of a fixed frame — the probe in verify-p2a runs analyzeFrame
// 3x on the same file and asserts the numbers are exactly equal.
//
// LGPL: waveform / vectorscope are native libavfilter filters (LGPL
// part) but are only verified here on the local GPL 8.1.2 build —
// re-check on the BtbN LGPL 9.0 build at the M2 gate. The statistics
// themselves are our own code.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ChannelStats {
  mean: number;
  min: number;
  max: number;
  /** Histogram mode: the 0..255 bin with the most pixels. */
  peakBin: number;
  /** 99th-percentile channel value (0..255). */
  p99: number;
}

export interface LumaStats {
  mean: number;
  min: number;
  max: number;
  /** 256-bin histogram of rounded luma values. */
  histogram: number[];
}

export interface ScopeResult {
  file: string;
  /** Requested frame time in seconds. */
  time: number;
  width: number;
  height: number;
  luma: LumaStats;
  rgb: { r: ChannelStats; g: ChannelStats; b: ChannelStats };
  vectorscope: {
    /** Mean per-pixel HSV saturation, 0..1. */
    saturationMean: number;
    /** Circular-mean hue in degrees, or null when the frame is grey. */
    dominantHue: number | null;
    /** 12 bins of 30 degrees, counts of pixels with saturation > 0.05. */
    hueHistogram: number[];
  };
  clipping: {
    /** Fraction of pixels with min(R,G,B) > 250 (near-white blowout). */
    highlight: number;
    /** Fraction of pixels with max(R,G,B) < 5 (near-black crush). */
    shadow: number;
  };
}

function channelStats(hist: number[], n: number): ChannelStats {
  let sum = 0;
  let min = 255;
  let max = 0;
  let peakBin = 0;
  let peakCount = -1;
  for (let v = 0; v < 256; v++) {
    const c = hist[v];
    sum += v * c;
    if (c > 0) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (c > peakCount) {
      peakCount = c;
      peakBin = v;
    }
  }
  // p99: smallest value whose cumulative count reaches 99% of pixels.
  let cum = 0;
  let p99 = 255;
  for (let v = 0; v < 256; v++) {
    cum += hist[v];
    if (cum >= 0.99 * n) {
      p99 = v;
      break;
    }
  }
  return { mean: sum / n, min, max, peakBin, p99 };
}

/** Pure-TS statistics over one RGB24 frame buffer (width*height*3 bytes). */
export function analyzeRgbFrame(
  buf: Buffer,
  width: number,
  height: number,
  file: string,
  time: number,
): ScopeResult {
  const n = width * height;
  if (buf.length < n * 3) {
    throw new Error(`analyzeRgbFrame: buffer ${buf.length} bytes too small for ${width}x${height}`);
  }
  const histR = new Array<number>(256).fill(0);
  const histG = new Array<number>(256).fill(0);
  const histB = new Array<number>(256).fill(0);
  const histY = new Array<number>(256).fill(0);
  const hueHist = new Array<number>(12).fill(0);
  let lumaSum = 0;
  let lumaMin = 255;
  let lumaMax = 0;
  let satSum = 0;
  let hx = 0;
  let hy = 0;
  let huePixels = 0;
  let highlight = 0;
  let shadow = 0;
  for (let i = 0; i < n; i++) {
    const r = buf[i * 3];
    const g = buf[i * 3 + 1];
    const b = buf[i * 3 + 2];
    histR[r]++;
    histG[g]++;
    histB[b]++;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const yi = Math.round(y);
    histY[yi]++;
    lumaSum += y;
    if (yi < lumaMin) lumaMin = yi;
    if (yi > lumaMax) lumaMax = yi;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    satSum += sat;
    if (sat > 0.05 && mx > 13) {
      // Hue in degrees (HSV formula, mx in 0..255, d in 0..255).
      const d = mx - mn;
      let h: number;
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
      hx += Math.cos((h * Math.PI) / 180);
      hy += Math.sin((h * Math.PI) / 180);
      huePixels++;
      hueHist[Math.min(11, Math.floor(h / 30))]++;
    }
    if (mn > 250) highlight++;
    if (mx < 5) shadow++;
  }
  const saturationMean = satSum / n;
  let dominantHue: number | null = null;
  if (saturationMean >= 0.02 && huePixels > 0) {
    const hue = (Math.atan2(hy, hx) * 180) / Math.PI;
    dominantHue = hue < 0 ? hue + 360 : hue;
  }
  return {
    file,
    time,
    width,
    height,
    luma: { mean: lumaSum / n, min: lumaMin, max: lumaMax, histogram: histY },
    rgb: {
      r: channelStats(histR, n),
      g: channelStats(histG, n),
      b: channelStats(histB, n),
    },
    vectorscope: { saturationMean, dominantHue, hueHistogram: hueHist },
    clipping: { highlight: highlight / n, shadow: shadow / n },
  };
}

export interface AnalyzeFrameOptions {
  ffmpeg?: string;
  ffprobe?: string;
  /** Frame size; when omitted it is probed with ffprobe. */
  width?: number;
  height?: number;
}

async function probeSize(file: string, ffprobe: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', file,
  ]);
  const data = JSON.parse(stdout) as { streams: { width: number; height: number }[] };
  return { width: data.streams[0].width, height: data.streams[0].height };
}

/** Extract one frame as RGB24 and analyse it. */
export async function analyzeFrame(
  file: string,
  time: number,
  opts: AnalyzeFrameOptions = {},
): Promise<ScopeResult> {
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const ffprobe = opts.ffprobe ?? 'ffprobe';
  const { width, height } =
    opts.width !== undefined && opts.height !== undefined
      ? { width: opts.width, height: opts.height }
      : await probeSize(file, ffprobe);
  const { stdout } = await execFileAsync(
    ffmpeg,
    [
      '-ss', String(time), '-i', file,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ],
    { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' },
  );
  return analyzeRgbFrame(stdout as Buffer, width, height, file, time);
}

export interface ScopeAggregate {
  /** Per-frame results, in the requested order. */
  frames: ScopeResult[];
  /** Mean of the per-frame luma means. */
  lumaMean: number;
  /** Mean of the per-frame saturation means. */
  saturationMean: number;
  /** Mean highlight / shadow clip fractions across the sampled frames. */
  highlightMean: number;
  shadowMean: number;
}

/** Analyse several frames of one file and aggregate the headline numbers. */
export async function analyzeFrames(
  file: string,
  times: number[],
  opts: AnalyzeFrameOptions = {},
): Promise<ScopeAggregate> {
  if (times.length === 0) throw new Error('analyzeFrames: no times given');
  const frames: ScopeResult[] = [];
  for (const t of times) frames.push(await analyzeFrame(file, t, opts));
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    frames,
    lumaMean: mean(frames.map((f) => f.luma.mean)),
    saturationMean: mean(frames.map((f) => f.vectorscope.saturationMean)),
    highlightMean: mean(frames.map((f) => f.clipping.highlight)),
    shadowMean: mean(frames.map((f) => f.clipping.shadow)),
  };
}

export type ScopeImageKind = 'waveform' | 'vectorscope';

/**
 * Render a scope PICTURE (FFmpeg waveform / vectorscope filter) to a PNG
 * for the WPF preview. The numbers from analyzeFrame are the source of
 * truth; this is only the view. Returns the output path.
 */
export async function renderScopeImage(
  file: string,
  time: number,
  kind: ScopeImageKind,
  outPath: string,
  opts: AnalyzeFrameOptions = {},
): Promise<string> {
  const ffmpeg = opts.ffmpeg ?? 'ffmpeg';
  const filter =
    kind === 'waveform'
      ? 'waveform=mode=column:graticule=green:flags=numbers+dots'
      : 'vectorscope=mode=color:graticule=green';
  await execFileAsync(ffmpeg, [
    '-ss', String(time), '-i', file,
    '-vf', filter, '-frames:v', '1', '-y', outPath,
  ]);
  return outPath;
}
