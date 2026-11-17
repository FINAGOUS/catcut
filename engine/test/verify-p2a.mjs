// P2 batch 1 engine verification (M4, 2026-11-17).
// Covers: advanced colour grading (src/color.ts — HSL zones, RGB/master
// curves, white balance, .cube import, all baked into a generated 3D LUT
// applied with lut3d) + scopes (src/scopes.ts — waveform luma, RGB
// parade, vectorscope saturation/hue, highlight/shadow clipping, all as
// numbers over raw RGB24 frames, plus waveform/vectorscope pictures).
//
// Measurement method (written down so the numbers can be re-derived):
// - Determinism probe was run BEFORE writing assertions (the vidstab
//   lesson). tmp/probe-p2a.mjs generated solid-colour videos and read
//   the same frame 3x: every value was bit-identical across runs
//   (red 253.0,0.0,0.0 luma 53.8 sat 1.000 hue 0.0; green 0.0,254.0,0.0
//   luma 181.7 hue 120.0; blue 0.0,0.0,254.0 luma 18.3 hue 240.0;
//   gray128 exactly 128.0 sat 0.000; white 255.0; black 0.0; yellow
//   253.0,253.0,0.0 luma 234.7 hue 60.0; cyan 0.0,255.0,255.0 luma
//   200.8 hue 180.0). A 2x2x2 lift LUT (black 0 -> 0.2) applied with
//   lut3d turned black into exactly 51,51,51. This test re-runs
//   analyzeFrame 3x and asserts exact equality, so a future
//   nondeterminism fails loudly.
// - Theory values (Rec.709 luma Y = 0.2126R + 0.7152G + 0.0722B):
//   red luma 54.2 (measured 53.8, bar +-3), green 182.4 (measured
//   181.7), blue 18.4 (measured 18.3), gray128 128.0, white 255.0,
//   black 0.0. Channel bars are +-5, saturation +-0.05, hue +-5 deg.
//   Bars are wider than the probe spread (0.0) so they survive a
//   different encoder, but still tight enough to catch a wrong formula.
// - Pixel checks use 64x64 crops averaged to RGB (meanRGB), same as
//   P1e (crop=1:1 fails on yuv420p). "Corner" is the 16x16 block at
//   (8,8); "centre" is the 64x64 block at (288,148).
// - Duration error bar is < 0.3 s per the task (smoke runs: 0.00 s).
// - Black-segment check is blackdetect d=0.5 pix_th=0.10, same as P1d.
// - LUT smoke (node -e, before writing this file): identity LUT exact;
//   red-zone saturation 0 turns the red node into (0.500,0.500,0.500)
//   and leaves green/yellow nodes untouched; white balance +1 turns the
//   grey node (0.5,0.5,0.5) into (0.625,0.500,0.375) and -1 into
//   (0.375,0.500,0.625); master lift (0,0.2)-(1,1) turns black into
//   0.200 and mid-grey into 0.600; test/lift.cube parses to size 2
//   with black node 0.100.
// - LGPL: lut3d, waveform, vectorscope are native libavfilter filters
//   (LGPL part) but are only verified here on the local GPL 8.1.2
//   build — re-check on the BtbN LGPL 9.0 build at the M2 gate. The
//   LUT math and scope statistics are our own code.
// Old M1 / P0 / P0b / P1 / P1b / P1c / P1d / P1e checks live in their
// own files and must still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  analyzeFrame,
  analyzeFrames,
  analyzeRgbFrame,
  applyAdvancedColorToRgb,
  applyCurve,
  buildColorLut,
  exportProject,
  hslToRgb,
  parseCube,
  prepareColorLuts,
  probe,
  PRESETS,
  renderScopeImage,
  rgbToHsl,
  validateAdvancedColor,
} from '../dist/export.js';
import { buildFilterGraph } from '../dist/filtergraph.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const LIFT_CUBE = `${DIR}lift.cube`;

const checks = [];
const check = (name, ok, detail = '') =>
  checks.push([`${name}${detail ? ` (${detail})` : ''}`, ok]);

async function run(cmd, args, opts = {}) {
  return exec(cmd, args, { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer', ...opts });
}

/** One RGB24 frame (optionally cropped) as a Buffer. */
async function rawFrame(file, ss, crop) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', file, '-vf', `crop=${crop}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  return r.stdout;
}

function meanRGB(buf) {
  let r = 0, g = 0, b = 0;
  const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}

async function hasBlackSegments(file) {
  const bd = await run('ffmpeg', ['-i', file, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-']).catch((e) => e);
  return /black_start/.test((bd.stderr ?? '') + (bd.stdout ?? ''));
}

const base = { version: 1, width: 640, height: 360, fps: 30, transitions: [], transitionDuration: 0.5 };
const clip = (id, source, extra = {}) => ({ id, source, in: 0, out: 2, speed: 1, volume: 1, ...extra });
const approx = (a, b, tol) => Math.abs(a - b) <= tol;

// --- 0. LUT math + .cube parsing + validation (no encode) ---
{
  const id = buildColorLut({}, 2);
  check('lut: identity exact', id.data[0] === 0 && id.data[3] === 1 && id.data[4] === 0 && id.data[5] === 0, `node(1,0,0)=${id.data[3]},${id.data[4]},${id.data[5]}`);
  const d = buildColorLut({ hsl: [{ hue: 'red', saturation: 0 }] }, 17);
  const node = (lut, r, g, b) => { const i = (b * 17 * 17 + g * 17 + r) * 3; return [lut.data[i], lut.data[i + 1], lut.data[i + 2]]; };
  const redNode = node(d, 16, 0, 0);
  check('lut: red desat -> grey 0.5', approx(redNode[0], 0.5, 0.01) && approx(redNode[1], 0.5, 0.01) && approx(redNode[2], 0.5, 0.01), `red node=${redNode.map((v) => v.toFixed(3)).join(',')}`);
  const greenNode = node(d, 0, 16, 0);
  check('lut: green node untouched by red zone', greenNode[0] === 0 && greenNode[1] === 1 && greenNode[2] === 0, `green node=${greenNode.join(',')}`);
  const yellowNode = node(d, 16, 16, 0);
  check('lut: yellow node untouched (60 deg > 45 half-width)', yellowNode[0] === 1 && yellowNode[1] === 1 && yellowNode[2] === 0, `yellow node=${yellowNode.join(',')}`);
  const w = buildColorLut({ whiteBalance: { temperature: 1 } }, 17);
  const greyNode = node(w, 8, 8, 8);
  check('lut: WB +1 warms grey (R up, B down)', approx(greyNode[0], 0.625, 0.01) && approx(greyNode[1], 0.5, 0.01) && approx(greyNode[2], 0.375, 0.01), `grey node=${greyNode.map((v) => v.toFixed(3)).join(',')}`);
  const w2 = buildColorLut({ whiteBalance: { temperature: -1 } }, 17);
  const greyNode2 = node(w2, 8, 8, 8);
  check('lut: WB -1 cools grey (R down, B up)', approx(greyNode2[0], 0.375, 0.01) && approx(greyNode2[2], 0.625, 0.01), `grey node=${greyNode2.map((v) => v.toFixed(3)).join(',')}`);
  const c = buildColorLut({ curves: { master: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }] } }, 17);
  const blackNode = node(c, 0, 0, 0);
  const midNode = node(c, 8, 8, 8);
  check('lut: master lift black 0 -> 0.2', approx(blackNode[0], 0.2, 0.01), `black node=${blackNode[0].toFixed(3)}`);
  check('lut: master lift mid 0.5 -> 0.6', approx(midNode[0], 0.6, 0.01), `mid node=${midNode[0].toFixed(3)}`);
  check('curve: applyCurve clamps outside range', applyCurve([{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.9 }], 0) === 0.3 && applyCurve([{ x: 0.2, y: 0.3 }, { x: 0.8, y: 0.9 }], 1) === 0.9);
  check('curve: applyCurve interpolates', approx(applyCurve([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.25), 0.25, 1e-9));
  const [h, s, l] = rgbToHsl(1, 0, 0);
  check('hsl: red converts to h=0 s=1 l=0.5', h === 0 && s === 1 && l === 0.5, `h=${h} s=${s} l=${l}`);
  const [r2, g2, b2] = hslToRgb(120, 1, 0.5);
  check('hsl: h=120 s=1 l=0.5 converts back to green', approx(r2, 0, 1e-9) && approx(g2, 1, 1e-9) && approx(b2, 0, 1e-9));
  const [ar, ag, ab] = applyAdvancedColorToRgb({ whiteBalance: { tint: 1 } }, 0.5, 0.5, 0.5);
  check('wb: tint +1 cuts green, lifts red/blue', ag < 0.5 && ar > 0.5 && ab > 0.5, `rgb=${ar.toFixed(3)},${ag.toFixed(3)},${ab.toFixed(3)}`);
}
{
  const lift = parseCube(readFileSync(LIFT_CUBE, 'utf8'), 'lift');
  check('cube: P0 lift.cube parses (size 2)', lift.size === 2 && approx(lift.data[0], 0.1, 1e-9), `size=${lift.size} black=${lift.data[0]}`);
  const bad = [
    ['missing size', '0.1 0.1 0.1\n'],
    ['1D LUT', 'LUT_1D_SIZE 2\n0.1\n1.0\n'],
    ['wrong row count', 'LUT_3D_SIZE 2\n0.1 0.1 0.1\n'],
    ['NaN value', 'LUT_3D_SIZE 2\n0.1 0.1 NaN\n1.0 0.1 0.1\n0.1 1.0 0.1\n1.0 1.0 0.1\n0.1 0.1 1.0\n1.0 0.1 1.0\n0.1 1.0 1.0\n1.0 1.0 1.0\n'],
    ['value > 1', 'LUT_3D_SIZE 2\n1.2 0.1 0.1\n1.0 0.1 0.1\n0.1 1.0 0.1\n1.0 1.0 0.1\n0.1 0.1 1.0\n1.0 0.1 1.0\n0.1 1.0 1.0\n1.0 1.0 1.0\n'],
    ['non-default domain', 'LUT_3D_SIZE 2\nDOMAIN_MIN 0.1 0.0 0.0\nDOMAIN_MAX 1.0 1.0 1.0\n0.1 0.1 0.1\n1.0 0.1 0.1\n0.1 1.0 0.1\n1.0 1.0 0.1\n0.1 0.1 1.0\n1.0 0.1 1.0\n0.1 1.0 1.0\n1.0 1.0 1.0\n'],
    ['bad data line', 'LUT_3D_SIZE 2\n0.1 0.1\n'],
  ];
  let allOk = true;
  for (const [name, text] of bad) {
    try { parseCube(text, name); allOk = false; } catch { /* expected */ }
  }
  check('cube: 7 bad files rejected', allOk);
  const badAdv = [
    [{ hsl: [{ hue: 'red', saturation: 5 }] }, /saturation/],
    [{ hsl: [{ hue: 'red', lightness: 2 }] }, /lightness/],
    [{ hsl: [{ hue: 'pink', saturation: 1 }] }, /hue zone/],
    [{ whiteBalance: { temperature: 2 } }, /temperature/],
    [{ whiteBalance: { tint: -2 } }, /tint/],
    [{ curves: { master: [{ x: 0, y: 0 }] } }, /at least 2/],
    [{ curves: { red: [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.6 }] } }, /increasing/],
    [{ curves: { green: [{ x: 0, y: 0 }, { x: 1, y: 1.5 }] } }, /outside/],
    [{ lutFile: '' }, /lutFile/],
  ];
  let allAdvOk = true;
  for (const [adv, re] of badAdv) {
    try { validateAdvancedColor(adv, 'c'); allAdvOk = false; } catch (e) { if (!re.test(e.message)) allAdvOk = false; }
  }
  check('validate: 9 bad advancedColor configs rejected', allAdvOk);
}
{
  const advClip = clip('c', `${DIR}p2a-red.mp4`, { advancedColor: { hsl: [{ hue: 'red', saturation: 0 }] } });
  const lutMap = new Map([[0, [`${DIR}color-c0.cube`]]]);
  const g = buildFilterGraph({ ...base, clips: [advClip] }, FONT, undefined, undefined, undefined, undefined, undefined, lutMap).filterComplex;
  check('graph: advancedColor emits lut3d', g.includes(`lut3d='${DIR}color-c0.cube'`), g.slice(0, 100));
  let threw = false;
  try {
    buildFilterGraph({ ...base, clips: [advClip] }, FONT);
  } catch (e) { threw = /not prepared/.test(e.message); }
  check('graph: advancedColor without prepared LUT throws', threw);
  const impClip = clip('c', `${DIR}p2a-red.mp4`, { advancedColor: { lutFile: LIFT_CUBE } });
  const g2 = buildFilterGraph({ ...base, clips: [impClip] }, FONT, undefined, undefined, undefined, undefined, undefined, new Map([[0, [LIFT_CUBE]]])).filterComplex;
  check('graph: imported .cube emits lut3d', g2.includes(`lut3d='${LIFT_CUBE}'`));
}

// --- A. test sources: solid colours, 2 s, 640x360 ---
const COLORS = { red: '0xff0000', green: '0x00ff00', blue: '0x0000ff', gray128: '0x808080', white: '0xffffff', black: '0x000000' };
const SRC = {};
for (const [name, c] of Object.entries(COLORS)) {
  const f = `${DIR}p2a-${name}.mp4`;
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=640x360:d=2:r=30`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-t', '2', '-y', f]);
  SRC[name] = f;
  const p = await probe(f);
  check(`source: ${name} 2s 640x360 30fps`, p.duration === 2 && p.width === 640 && p.fps === 30, JSON.stringify(p));
}
// Half red / half blue split frame (hue histogram check).
await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=640x360:d=2:r=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-vf', 'drawbox=x=320:y=0:w=320:h=360:color=0x0000ff:t=fill',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-t', '2', '-y', `${DIR}p2a-split.mp4`]);
SRC.split = `${DIR}p2a-split.mp4`;

// --- B. scopes determinism probe: analyzeFrame 3x on the same file ---
const probeRuns = [];
for (let i = 0; i < 3; i++) probeRuns.push(await analyzeFrame(SRC.red, 1));
const numKey = (s) => JSON.stringify({
  luma: [s.luma.mean, s.luma.min, s.luma.max, s.luma.histogram],
  r: s.rgb.r, g: s.rgb.g, b: s.rgb.b,
  sat: s.vectorscope.saturationMean, hue: s.vectorscope.dominantHue,
  hueHist: s.vectorscope.hueHistogram,
  clip: s.clipping,
});
check('probe: analyzeFrame 3x exactly identical',
  probeRuns.every((s) => numKey(s) === numKey(probeRuns[0])),
  `lumaMean=${probeRuns[0].luma.mean.toFixed(2)} sat=${probeRuns[0].vectorscope.saturationMean.toFixed(3)}`);

// --- C. scopes vs theory values ---
{
  const red = probeRuns[0];
  check('scopes: red luma 53.8 +-3 (theory 54.2)', approx(red.luma.mean, 53.8, 3), `luma=${red.luma.mean.toFixed(1)}`);
  check('scopes: red R 253 +-5, G/B ~0', approx(red.rgb.r.mean, 253, 5) && red.rgb.g.mean < 3 && red.rgb.b.mean < 3, `RGB=${red.rgb.r.mean.toFixed(1)},${red.rgb.g.mean.toFixed(1)},${red.rgb.b.mean.toFixed(1)}`);
  check('scopes: red saturation 1.0 +-0.05', approx(red.vectorscope.saturationMean, 1.0, 0.05), `sat=${red.vectorscope.saturationMean.toFixed(3)}`);
  check('scopes: red hue 0 +-5 deg', red.vectorscope.dominantHue !== null && approx(red.vectorscope.dominantHue, 0, 5), `hue=${red.vectorscope.dominantHue}`);
  check('scopes: red no clipping', red.clipping.highlight === 0 && red.clipping.shadow === 0);
  const green = await analyzeFrame(SRC.green, 1);
  check('scopes: green luma 181.7 +-3 (theory 182.4)', approx(green.luma.mean, 181.7, 3), `luma=${green.luma.mean.toFixed(1)}`);
  check('scopes: green hue 120 +-5 deg', green.vectorscope.dominantHue !== null && approx(green.vectorscope.dominantHue, 120, 5), `hue=${green.vectorscope.dominantHue}`);
  const blue = await analyzeFrame(SRC.blue, 1);
  check('scopes: blue luma 18.3 +-3 (theory 18.4)', approx(blue.luma.mean, 18.3, 3), `luma=${blue.luma.mean.toFixed(1)}`);
  check('scopes: blue hue 240 +-5 deg', blue.vectorscope.dominantHue !== null && approx(blue.vectorscope.dominantHue, 240, 5), `hue=${blue.vectorscope.dominantHue}`);
  const gray = await analyzeFrame(SRC.gray128, 1);
  check('scopes: gray128 luma 128 +-3', approx(gray.luma.mean, 128, 3), `luma=${gray.luma.mean.toFixed(1)}`);
  check('scopes: gray128 saturation < 0.02', gray.vectorscope.saturationMean < 0.02, `sat=${gray.vectorscope.saturationMean.toFixed(3)}`);
  check('scopes: gray128 dominantHue is null', gray.vectorscope.dominantHue === null);
  const white = await analyzeFrame(SRC.white, 1);
  check('scopes: white luma 255 +-1', approx(white.luma.mean, 255, 1), `luma=${white.luma.mean.toFixed(1)}`);
  check('scopes: white highlight clip == 1.0', white.clipping.highlight === 1, `highlight=${white.clipping.highlight}`);
  check('scopes: white shadow clip == 0', white.clipping.shadow === 0);
  const black = await analyzeFrame(SRC.black, 1);
  check('scopes: black luma 0 +-1', approx(black.luma.mean, 0, 1), `luma=${black.luma.mean.toFixed(1)}`);
  check('scopes: black shadow clip == 1.0', black.clipping.shadow === 1, `shadow=${black.clipping.shadow}`);
  check('scopes: black highlight clip == 0', black.clipping.highlight === 0);
  const split = await analyzeFrame(SRC.split, 1);
  const hueTotal = split.vectorscope.hueHistogram.reduce((a, b) => a + b, 0);
  check('scopes: split frame hue hist red bin ~50%', approx(split.vectorscope.hueHistogram[0] / hueTotal, 0.5, 0.05), `bin0=${(split.vectorscope.hueHistogram[0] / hueTotal).toFixed(2)}`);
  check('scopes: split frame hue hist blue bin ~50%', approx(split.vectorscope.hueHistogram[8] / hueTotal, 0.5, 0.05), `bin8=${(split.vectorscope.hueHistogram[8] / hueTotal).toFixed(2)}`);
  check('scopes: split frame dominant hue ~300 deg (circular mean of 0 and 240)',
    split.vectorscope.dominantHue !== null && approx(split.vectorscope.dominantHue, 300, 10),
    `hue=${split.vectorscope.dominantHue?.toFixed(1)}`);
}

// --- D. advanced colour exports ---
{
  // D1: red-zone desaturation turns red grey.
  const r1 = await exportProject(
    { ...base, clips: [clip('c', SRC.red, { advancedColor: { hsl: [{ hue: 'red', saturation: 0 }] } })] },
    `${DIR}p2a-desat.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: desat duration err < 0.3s', Math.abs(r1.durationError) < 0.3, `err=${r1.durationError.toFixed(2)}s`);
  check('export: desat has audio', r1.actual.hasAudio);
  check('export: desat no black segment', !(await hasBlackSegments(`${DIR}p2a-desat.mp4`)));
  const desat = meanRGB(await rawFrame(`${DIR}p2a-desat.mp4`, 1, '64:64:288:148'));
  check('export: desat red frame is grey (|R-G|,|G-B| < 6)',
    Math.abs(desat.r - desat.g) < 6 && Math.abs(desat.g - desat.b) < 6,
    `RGB=${Math.round(desat.r)},${Math.round(desat.g)},${Math.round(desat.b)}`);
  check('export: desat grey mean 110-145', desat.r > 110 && desat.r < 145, `mean=${desat.r.toFixed(1)}`);
  check('export: generated .cube kept next to output', existsSync(`${DIR}p2a-desat.mp4`) && existsSync(`${DIR}color-c0.cube`));
  // D2: master lift curve on black.
  const r2 = await exportProject(
    { ...base, clips: [clip('c', SRC.black, { advancedColor: { curves: { master: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }] } } })] },
    `${DIR}p2a-lift.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: lift duration err < 0.3s', Math.abs(r2.durationError) < 0.3, `err=${r2.durationError.toFixed(2)}s`);
  const lift = meanRGB(await rawFrame(`${DIR}p2a-lift.mp4`, 1, '64:64:288:148'));
  check('export: lift black -> ~51 (0.2*255)', lift.r > 45 && lift.r < 57, `RGB=${Math.round(lift.r)},${Math.round(lift.g)},${Math.round(lift.b)}`);
  // D3: white balance both directions on grey.
  const r3 = await exportProject(
    { ...base, clips: [clip('c', SRC.gray128, { advancedColor: { whiteBalance: { temperature: 1 } } })] },
    `${DIR}p2a-wb-warm.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: WB warm duration err < 0.3s', Math.abs(r3.durationError) < 0.3, `err=${r3.durationError.toFixed(2)}s`);
  const warm = meanRGB(await rawFrame(`${DIR}p2a-wb-warm.mp4`, 1, '64:64:288:148'));
  check('export: WB warm R-B > 40', warm.r - warm.b > 40, `RGB=${Math.round(warm.r)},${Math.round(warm.g)},${Math.round(warm.b)}`);
  const r3b = await exportProject(
    { ...base, clips: [clip('c', SRC.gray128, { advancedColor: { whiteBalance: { temperature: -1 } } })] },
    `${DIR}p2a-wb-cool.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: WB cool duration err < 0.3s', Math.abs(r3b.durationError) < 0.3, `err=${r3b.durationError.toFixed(2)}s`);
  const cool = meanRGB(await rawFrame(`${DIR}p2a-wb-cool.mp4`, 1, '64:64:288:148'));
  check('export: WB cool B-R > 40', cool.b - cool.r > 40, `RGB=${Math.round(cool.r)},${Math.round(cool.g)},${Math.round(cool.b)}`);
  // D4: imported .cube (P0 lift.cube, black 0 -> 0.1) on black.
  const r4 = await exportProject(
    { ...base, clips: [clip('c', SRC.black, { advancedColor: { lutFile: LIFT_CUBE } })] },
    `${DIR}p2a-cube.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: imported cube duration err < 0.3s', Math.abs(r4.durationError) < 0.3, `err=${r4.durationError.toFixed(2)}s`);
  const cubed = meanRGB(await rawFrame(`${DIR}p2a-cube.mp4`, 1, '64:64:288:148'));
  check('export: imported cube black -> ~26 (0.1*255)', cubed.r > 20 && cubed.r < 31, `RGB=${Math.round(cubed.r)},${Math.round(cubed.g)},${Math.round(cubed.b)}`);
  // D5: old P0 colour + advanced colour compose (brightness first, then desat).
  const r5 = await exportProject(
    { ...base, clips: [clip('c', SRC.red, { color: { brightness: 0.1 }, advancedColor: { hsl: [{ hue: 'red', saturation: 0 }] } })] },
    `${DIR}p2a-compose.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: old+new colour duration err < 0.3s', Math.abs(r5.durationError) < 0.3, `err=${r5.durationError.toFixed(2)}s`);
  const comp = meanRGB(await rawFrame(`${DIR}p2a-compose.mp4`, 1, '64:64:288:148'));
  check('export: composed frame still grey but brighter than desat-only',
    Math.abs(comp.r - comp.g) < 8 && comp.r > desat.r,
    `RGB=${Math.round(comp.r)},${Math.round(comp.g)},${Math.round(comp.b)} vs desat ${desat.r.toFixed(1)}`);
  // D6: project preset LUT + advanced LUT both apply (lift 0.2 then cube 0.1->1.0: 0.28 -> ~71).
  const r6 = await exportProject(
    { ...base, clips: [clip('c', SRC.black, { advancedColor: { curves: { master: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }] } } })] },
    `${DIR}p2a-both-lut.mp4`, { preset: { ...PRESETS['720p30'], lut: LIFT_CUBE }, fontfile: FONT },
  );
  check('export: preset+advanced LUT duration err < 0.3s', Math.abs(r6.durationError) < 0.3, `err=${r6.durationError.toFixed(2)}s`);
  const both = meanRGB(await rawFrame(`${DIR}p2a-both-lut.mp4`, 1, '64:64:288:148'));
  check('export: both LUTs stack (black -> ~71)', both.r > 60 && both.r < 85, `RGB=${Math.round(both.r)},${Math.round(both.g)},${Math.round(both.b)}`);
}

// --- E. scope pictures (WPF preview) ---
{
  const wf = await renderScopeImage(SRC.red, 1, 'waveform', `${DIR}p2a-waveform.png`);
  check('scope image: waveform PNG exists and non-trivial', existsSync(wf) && statSync(wf).size > 1000, `${statSync(wf).size} bytes`);
  const vs = await renderScopeImage(SRC.red, 1, 'vectorscope', `${DIR}p2a-vectorscope.png`);
  check('scope image: vectorscope PNG exists and non-trivial', existsSync(vs) && statSync(vs).size > 1000, `${statSync(vs).size} bytes`);
}

// --- F. multi-frame aggregate ---
{
  const agg = await analyzeFrames(SRC.red, [0.5, 1.0, 1.5]);
  check('aggregate: 3 frames returned', agg.frames.length === 3);
  check('aggregate: luma mean 53.8 +-3', approx(agg.lumaMean, 53.8, 3), `lumaMean=${agg.lumaMean.toFixed(1)}`);
  check('aggregate: saturation mean 1.0 +-0.05', approx(agg.saturationMean, 1.0, 0.05), `sat=${agg.saturationMean.toFixed(3)}`);
  let threw = false;
  try { await analyzeFrames(SRC.red, []); } catch (e) { threw = /no times/.test(e.message); }
  check('aggregate: empty times rejected', threw);
}

// --- G. bad .cube import rejected at export ---
{
  writeFileSync(`${DIR}p2a-bad.cube`, 'LUT_3D_SIZE 2\n0.1 0.1 0.1\n');
  let threw = false;
  try {
    await exportProject(
      { ...base, clips: [clip('c', SRC.black, { advancedColor: { lutFile: `${DIR}p2a-bad.cube` } })] },
      `${DIR}p2a-bad.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
    );
  } catch (e) { threw = /expected .* RGB rows/.test(e.message); }
  check('reject: bad .cube import throws at export', threw);
  let threw2 = false;
  try {
    prepareColorLuts(
      { ...base, clips: [clip('c', SRC.black, { advancedColor: { lutFile: `${DIR}no-such.cube` } })] },
      DIR,
    );
  } catch (e) { threw2 = /ENOENT/.test(e.message); }
  check('reject: missing .cube import throws at prep', threw2);
}

// --- report ---
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exit(1);
