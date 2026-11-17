// P3 batch 4 engine verification (M4, 2026-11-18).
// Covers: src/beauty.ts — face beautify (ONNX mask + hqdn3d +
// slight brightness, single/multi mode, person count, no-face
// error); src/color.ts — colour wheels (shadows/midtones/
// highlights) + HSL curves (hue-vs-sat / hue-vs-lum), baked into
// the same 3D LUT as the P2a grading; video denoise (hqdn3d,
// Clip.videoDenoise — NOT the audio `denoise`/afftdn); beat speed
// + beat flash (src/beat.ts — the P1c row's "卡点变速/闪白未做");
// volume keyframes (src/audiofx.ts — the P0 row's "音量关键帧未做").
//
// Measurement method (written down so the numbers can be re-derived):
// - Determinism probe was run BEFORE writing assertions (the vidstab
//   lesson). tmp/probe-p3d.mjs / probe-p3d-2..7, each run twice where
//   it mattered: volume-key windows reproduced within 0.7 dB of the
//   linear-lerp prediction; hqdn3d HF numbers reproduced exactly;
//   flash frames 255.0 in-window / 128.0 out; colour-wheel node
//   values bit-identical across runs.
// - Volume keys: dB keys [-20@0, 0@2, -20@4] interpolated in LINEAR
//   gain (probe A: [0.5,1.0] -28.64, [1.9,2.1] -21.34, [2.9,3.1]
//   -25.99, [3.5,4.0] -33.79 dB — matches the linear-lerp
//   prediction -28.25/-21.4/-26.3/-34.5 within 0.7 dB).
// - hqdn3d mapping (probe B/B2, noisy grey HF 10.56, mean luma
//   125.8): strength 25 -> 10.49, 50 -> 10.37, 75 -> 9.25,
//   100 -> 6.37; mean luma unchanged (125.9) at every strength.
//   Edge: clean width 0 px, noisy width 2 px, denoised width 0 px.
// - Flash: fade=t=in was REJECTED by probe (it whites everything
//   BEFORE the beat — the video "fades in" from white). drawbox
//   with enable=between(t,B,B+frames/fps) is white only inside the
//   window (probe C3, grey 128 source: 255.0 at 2.0/2.033, 128.0 at
//   1.0/2.1/3.5).
// - Colour wheels (probe D): smoothstep weights measured L=0.25
//   0.94/0.07/0.00, L=0.50 0.06/1.00/0.06, L=0.75 0.00/0.07/0.94
//   (shadows/midtones/highlights); dark red + shadows hue+120 ->
//   (0.055,0.500,0.000); bright red untouched (1,0.5,0.5); mid red
//   + midtones hue+120 -> (0,1,0); dark red + shadows sat 0 ->
//   (0.264,0.236,0.236).
// - HSL curves (probe E): hueVsSat desaturating reds turns red
//   into (0.5,0.5,0.5) and leaves green/yellow untouched;
//   hueVsLum +0.2 on dark red (0.5,0,0) gives (0.9,0,0) — lightness
//   in HSL, not a per-channel +0.2 (that would be (0.7,0.2,0.2)).
// - Beauty (probes G/I/6/7): person video personCount 1 (single and
//   multi), fake-person video throws "no face"; mask coverage 66.4%
//   at t=2; in-mask HF 2.60 plain -> 2.25 hqdn3d-only, 2.46 with
//   unsharp 0.3 (it eats the smoothing — so the filter uses 0.1,
//   in-mask 2.33), out-mask HF 1.74-1.76 in all variants.
// - Two real bugs found by the probes and fixed BEFORE this file:
//   (1) beauty_mask.py's encoder had no -r, so ffmpeg guessed 25
//   fps and the mask video came out 4.8 s — the overlay stretched
//   the export to 4.8 s (duration error 0.800 s); (2) beat-speed
//   clips reported durationError 2.500 s because clipDuration used
//   the base speed — speedCurveSegments now derives the beat nodes
//   (beatSpeedNodes in project.ts), so the 6.5 s output reads err
//   0.000 s.
// - Per-person strengths in multi mode are NOT done in v1 (needs
//   cross-frame identity tracking — see beauty.ts header); no face
//   slimming / eye enlargement (needs landmarks, not a body mask).
// - LGPL: hqdn3d, colorbalance-equivalent LUT math (lut3d), drawbox,
//   volume eval=frame, setpts/atempo are native libavfilter filters
//   — only verified on the local GPL 8.1.2 build; re-check each on
//   the BtbN LGPL 9.0 build at the M2 gate.
// Old M1 / P0 / P0b / P1 / P1b / P1c / P1d / P1e / P2a / P2b / P2c /
// P3a / P3b / P3c checks live in their own files and must still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import {
  applyAdvancedColorToRgb,
  beatFlashFilters,
  beatSpeedCurve,
  beautyFilter,
  buildColorLut,
  colorWheelWeight,
  countComponents,
  exportProject,
  hqdn3dFilter,
  prepareBeautyMasks,
  PRESETS,
  probe,
  validateAdvancedColor,
  validateAudioFx,
  validateBeatFlash,
  validateBeatSpeed,
  validateBeauty,
  volumeKeysFilter,
} from '../dist/export.js';
import { buildFilterGraph } from '../dist/filtergraph.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const PY = process.env.PORTRAIT_PYTHON || `${DIR}../.venv/bin/python`;

const checks = [];
const check = (name, ok, detail = '') =>
  checks.push([`${name}${detail ? ` (${detail})` : ''}`, ok]);

async function run(cmd, args, opts = {}) {
  return exec(cmd, args, { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer', ...opts });
}

const throwsSync = (fn, re) => {
  try { fn(); return false; } catch (e) { return re.test(e.message); }
};
const throwsAsync = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return re.test(e.message); }
};
const close = (v, target, tol = 0.5) => v !== null && Math.abs(v - target) <= tol;
const approx3 = (a, b, tol = 0.02) =>
  Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;

/** Goertzel RMS level of one frequency (dBFS) in a window — same as p3a. */
async function level(file, freq, ss = 1, dur = 2) {
  const r = await run('ffmpeg', [
    '-v', 'error', '-ss', String(ss), '-i', file, '-t', String(dur),
    '-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-',
  ]).catch((e) => e);
  const buf = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? '', 'binary');
  const s = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  const N = s.length;
  if (N === 0) return -240;
  const k = Math.round((N * freq) / 48000);
  const w = (2 * Math.PI * k) / N;
  const c = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let n = 0; n < N; n++) { s0 = s[n] + c * s1 - s2; s2 = s1; s1 = s0; }
  const p = s1 * s1 + s2 * s2 - c * s1 * s2;
  const amp = (2 * Math.sqrt(Math.max(0, p))) / N;
  return 20 * Math.log10(amp / Math.SQRT2 + 1e-12);
}

/** One RGB24 frame (optionally cropped) as a Buffer. */
async function rawFrame(file, ss, crop) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', file, '-vf', `crop=${crop}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  return r.stdout;
}

/** One grayscale frame as a Buffer (full frame). */
async function grayFrame(file, ss) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ]);
  return r.stdout;
}

function meanRGB(buf) {
  let r = 0, g = 0, b = 0;
  const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}

function meanLuma(buf) {
  let s = 0;
  const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) s += 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
  return s / n;
}

/** Mean |horizontal neighbour diff| on luma — HF-energy proxy. */
function hfEnergy(buf, w, h) {
  let s = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * 3;
      const l0 = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
      const l1 = 0.2126 * buf[i + 3] + 0.7152 * buf[i + 4] + 0.0722 * buf[i + 5];
      s += Math.abs(l1 - l0);
      n++;
    }
  }
  return s / n;
}

/** Mask-weighted HF: pairs where both pixels are in-mask vs both out. */
function maskedHF(rgb, mask, w, h) {
  let inS = 0, inN = 0, outS = 0, outN = 0;
  const lum = (buf, i) => 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * 3, j = i + 3;
      const d = Math.abs(lum(rgb, j) - lum(rgb, i));
      const mi = mask[y * w + x] > 128, mj = mask[y * w + x + 1] > 128;
      if (mi && mj) { inS += d; inN++; }
      else if (!mi && !mj) { outS += d; outN++; }
    }
  }
  return { inHF: inN ? inS / inN : 0, outHF: outN ? outS / outN : 0 };
}

/** Edge transition width on the middle row (pixels strictly 10%-90%). */
function edgeWidth(buf, w, h) {
  const y = Math.floor(h / 2);
  let cnt = 0;
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const v = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
    if (v > 25.5 && v < 229.5) cnt++;
  }
  return cnt;
}

/** Apply one video filter string to a source file. */
async function vf(src, filter, out) {
  await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', filter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
}

/** Apply one audio filter string to a wav source. */
async function af(src, filter, out) {
  await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-af', filter, out]);
}

// --- sources ---
const SRC = {};
{
  // 440 Hz sine, 4 s, -21.07 dB (same as p3a).
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
    '-i', 'aevalsrc=0.125*sin(2*PI*440*t):s=48000:d=4', '-ac', '1', `${DIR}p3d-440.wav`]);
  const mkMp4 = async (video, audio, out) => {
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', video,
      '-i', audio, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
  };
  await mkMp4('testsrc2=size=640x360:rate=30:duration=4', `${DIR}p3d-440.wav`, `${DIR}p3d-440.mp4`);
  await mkMp4('color=c=0x808080:s=640x360:d=4:r=30', `${DIR}p3d-440.wav`, `${DIR}p3d-grey.mp4`);
  // Noisy grey 320x180, 2 s + silent stereo audio.
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
    '-i', 'color=c=0x808080:s=320x180:d=2:r=30,noise=alls=30:allf=t+u',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    `${DIR}p3d-noisy.mp4`]);
  // Black|white edge + noise, 2 s + silent audio.
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
    '-i', 'color=c=black:s=160x180:d=2:r=30', '-f', 'lavfi',
    '-i', 'color=c=white:s=160x180:d=2:r=30', '-f', 'lavfi',
    '-i', 'anullsrc=r=48000:cl=stereo:d=2',
    '-filter_complex', '[0:v][1:v]hstack,noise=alls=30:allf=t+u[out]',
    '-map', '[out]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    `${DIR}p3d-edge-noisy.mp4`]);
  // 4x 1 s colour segments (red/green/blue/yellow) + silent audio, 4 s.
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:d=1:r=30',
    '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=640x360:d=1:r=30',
    '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=1:r=30',
    '-f', 'lavfi', '-i', 'color=c=yellow:s=640x360:d=1:r=30',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=4',
    '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]',
    '-map', '[v]', '-map', '4:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-shortest', `${DIR}p3d-4color.mp4`]);
  // Solid colours for the wheel/curve exports (dark red L=0.25,
  // bright red L=0.75, green, yellow) + silent audio.
  for (const [name, color] of [
    ['darkred', '0x800000'], ['brightred', '0xff8080'],
    ['green', '0x00ff00'], ['yellow', '0xffff00'],
  ]) {
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', `color=c=${color}:s=640x360:d=2:r=30`,
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2',
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      `${DIR}p3d-${name}.mp4`]);
  }
  SRC.tone440 = `${DIR}p3d-440.mp4`;
  SRC.grey = `${DIR}p3d-grey.mp4`;
  SRC.noisy = `${DIR}p3d-noisy.mp4`;
  SRC.edgeNoisy = `${DIR}p3d-edge-noisy.mp4`;
  SRC.fourColor = `${DIR}p3d-4color.mp4`;
  SRC.darkRed = `${DIR}p3d-darkred.mp4`;
  SRC.brightRed = `${DIR}p3d-brightred.mp4`;
  SRC.green = `${DIR}p3d-green.mp4`;
  SRC.yellow = `${DIR}p3d-yellow.mp4`;
  SRC.person = `${DIR}p1e-person.mp4`;
  SRC.fake = `${DIR}p1e-fake.mp4`;
}

const base = { version: 1, width: 640, height: 360, fps: 30, transitions: [], transitionDuration: 0.5 };
const clip = (id, source, extra = {}) => ({ id, source, in: 0, out: 4, speed: 1, volume: 1, ...extra });
const clip2 = (id, source, extra = {}) => ({ id, source, in: 0, out: 2, speed: 1, volume: 1, ...extra });

// --- A. filter-string unit checks ---
{
  check('beauty: strength 100 emits hqdn3d 8/6/10/8 + brightness 0.03 + unsharp 0.1',
    beautyFilter(100) === 'hqdn3d=8.00:6.00:10.00:8.00,eq=brightness=0.030,unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=0.1',
    beautyFilter(100));
  check('beauty: strength 50 emits hqdn3d 4/3/5/4',
    beautyFilter(50).startsWith('hqdn3d=4.00:3.00:5.00:4.00'), beautyFilter(50));
  check('beauty: hqdn3dFilter mapping is shared with video denoise',
    hqdn3dFilter(100) === 'hqdn3d=8.00:6.00:10.00:8.00' && hqdn3dFilter(0) === 'hqdn3d=0.00:0.00:0.00:0.00',
    hqdn3dFilter(100));
  check('wheels: weights L=0.25 are 0.94/0.07/0.00',
    close(colorWheelWeight('shadows', 0.25), 0.94, 0.02) &&
    close(colorWheelWeight('midtones', 0.25), 0.07, 0.02) &&
    close(colorWheelWeight('highlights', 0.25), 0, 0.02),
    `s=${colorWheelWeight('shadows', 0.25).toFixed(2)} m=${colorWheelWeight('midtones', 0.25).toFixed(2)} h=${colorWheelWeight('highlights', 0.25).toFixed(2)}`);
  check('wheels: weights L=0.50 are 0.06/1.00/0.06',
    close(colorWheelWeight('shadows', 0.5), 0.06, 0.02) &&
    close(colorWheelWeight('midtones', 0.5), 1, 0.02) &&
    close(colorWheelWeight('highlights', 0.5), 0.06, 0.02),
    `s=${colorWheelWeight('shadows', 0.5).toFixed(2)} m=${colorWheelWeight('midtones', 0.5).toFixed(2)} h=${colorWheelWeight('highlights', 0.5).toFixed(2)}`);
  check('wheels: weights L=0.75 are 0.00/0.07/0.94',
    close(colorWheelWeight('shadows', 0.75), 0, 0.02) &&
    close(colorWheelWeight('midtones', 0.75), 0.07, 0.02) &&
    close(colorWheelWeight('highlights', 0.75), 0.94, 0.02),
    `s=${colorWheelWeight('shadows', 0.75).toFixed(2)} m=${colorWheelWeight('midtones', 0.75).toFixed(2)} h=${colorWheelWeight('highlights', 0.75).toFixed(2)}`);
  const dark = applyAdvancedColorToRgb({ colorWheels: { shadows: { hueShift: 120 } } }, 0.5, 0, 0);
  check('wheels: dark red + shadows hue+120 turns green',
    approx3(dark, [0.055, 0.5, 0], 0.02), `(${dark.map((v) => v.toFixed(3)).join(',')})`);
  const bright = applyAdvancedColorToRgb({ colorWheels: { shadows: { hueShift: 120 } } }, 1, 0.5, 0.5);
  check('wheels: bright red untouched by shadows wheel',
    approx3(bright, [1, 0.5, 0.5], 0.01), `(${bright.map((v) => v.toFixed(3)).join(',')})`);
  const mid = applyAdvancedColorToRgb({ colorWheels: { midtones: { hueShift: 120 } } }, 1, 0, 0);
  check('wheels: mid red + midtones hue+120 turns green',
    approx3(mid, [0, 1, 0], 0.02), `(${mid.map((v) => v.toFixed(3)).join(',')})`);
  const desat = applyAdvancedColorToRgb({ colorWheels: { shadows: { saturation: 0 } } }, 0.5, 0, 0);
  check('wheels: dark red + shadows sat 0 turns grey',
    approx3(desat, [0.25, 0.25, 0.25], 0.02), `(${desat.map((v) => v.toFixed(3)).join(',')})`);
  const red = applyAdvancedColorToRgb({ hslCurves: { hueVsSat: [{ x: 0, y: 0 }, { x: 0.08, y: 0 }, { x: 0.15, y: 1 }, { x: 1, y: 1 }] } }, 1, 0, 0);
  check('curves: hueVsSat desaturates red to grey',
    approx3(red, [0.5, 0.5, 0.5], 0.01), `(${red.map((v) => v.toFixed(3)).join(',')})`);
  const green = applyAdvancedColorToRgb({ hslCurves: { hueVsSat: [{ x: 0, y: 0 }, { x: 0.08, y: 0 }, { x: 0.15, y: 1 }, { x: 1, y: 1 }] } }, 0, 1, 0);
  check('curves: hueVsSat leaves green untouched',
    approx3(green, [0, 1, 0], 0.01), `(${green.map((v) => v.toFixed(3)).join(',')})`);
  const redL = applyAdvancedColorToRgb({ hslCurves: { hueVsLum: [{ x: 0, y: 0.2 }, { x: 0.15, y: 0.2 }, { x: 0.3, y: 0 }, { x: 1, y: 0 }] } }, 0.5, 0, 0);
  check('curves: hueVsLum +0.2 lifts dark red lightness to (0.9,0,0)',
    approx3(redL, [0.9, 0, 0], 0.02), `(${redL.map((v) => v.toFixed(3)).join(',')})`);
  const lut = buildColorLut({ colorWheels: { shadows: { hueShift: 120 } } }, 17);
  const node = (l, r, g, b) => { const i = (b * 17 * 17 + g * 17 + r) * 3; return [l.data[i], l.data[i + 1], l.data[i + 2]]; };
  check('lut: wheel bakes into the 3D LUT (dark red node turns green)',
    approx3(node(lut, 8, 0, 0), [0.055, 0.5, 0], 0.03), `node=${node(lut, 8, 0, 0).map((v) => v.toFixed(3)).join(',')}`);
  check('beatspeed: nodes for beats [1,2] default are slow/fast/slow',
    JSON.stringify(beatSpeedCurve([1, 2])) === JSON.stringify([{ t: 0, speed: 0.5 }, { t: 1, speed: 2 }, { t: 2, speed: 0.5 }]),
    JSON.stringify(beatSpeedCurve([1, 2])));
  check('beatspeed: startWith fast flips the alternation',
    JSON.stringify(beatSpeedCurve([1, 2], { startWith: 'fast' })) === JSON.stringify([{ t: 0, speed: 2 }, { t: 1, speed: 0.5 }, { t: 2, speed: 2 }]),
    JSON.stringify(beatSpeedCurve([1, 2], { startWith: 'fast' })));
  check('beatflash: filters are drawbox with between(t,beat,beat+frames/fps)',
    beatFlashFilters([2, 3], 30, 2).length === 2 &&
    beatFlashFilters([2, 3], 30, 2)[0].startsWith("drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='between(t,2,2.0666") &&
    beatFlashFilters([2, 3], 30, 2)[1].includes("between(t,3,3.0666"),
    beatFlashFilters([2, 3], 30, 2)[0]);
  check('volkeys: single key emits a plain volume dB filter',
    volumeKeysFilter([{ t: 0, gainDb: -10 }]) === 'volume=-10dB', volumeKeysFilter([{ t: 0, gainDb: -10 }]));
  check('volkeys: two keys emit a per-frame expression',
    volumeKeysFilter([{ t: 0, gainDb: -20 }, { t: 2, gainDb: 0 }]).includes("volume='if(lt(t,0),0.1") &&
    volumeKeysFilter([{ t: 0, gainDb: -20 }, { t: 2, gainDb: 0 }]).includes(':eval=frame'),
    volumeKeysFilter([{ t: 0, gainDb: -20 }, { t: 2, gainDb: 0 }]));
  check('volkeys: no keys is an empty string', volumeKeysFilter(undefined) === '' && volumeKeysFilter([]) === '');
  const mk = (w, h, blobs) => {
    const g = new Uint8Array(w * h);
    for (const [cx, cy, r] of blobs) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) g[y * w + x] = 255;
      }
    }
    return g;
  };
  check('components: two blobs count 2', countComponents(mk(64, 36, [[12, 12, 6], [48, 24, 6]]), 64, 36).count === 2);
  check('components: one blob counts 1', countComponents(mk(64, 36, [[32, 18, 8]]), 64, 36).count === 1);
  check('components: speckle dots do not count', countComponents(mk(64, 36, [[5, 5, 1], [20, 20, 1], [50, 10, 1]]), 64, 36).count === 0);
  check('components: blob + speckle counts 1', countComponents(mk(64, 36, [[32, 18, 8], [5, 5, 1]]), 64, 36).count === 1);
  check('components: empty mask counts 0', countComponents(new Uint8Array(64 * 36), 64, 36).count === 0);
}

// --- B. filter-level measurements ---
{
  // Volume keys (probe A numbers).
  const keys = [{ t: 0, gainDb: -20 }, { t: 2, gainDb: 0 }, { t: 4, gainDb: -20 }];
  await af(`${DIR}p3d-440.wav`, volumeKeysFilter(keys), `${DIR}p3d-t-keys.wav`);
  const w1 = await level(`${DIR}p3d-t-keys.wav`, 440, 0.5, 0.5);
  const w2 = await level(`${DIR}p3d-t-keys.wav`, 440, 1.9, 0.2);
  const w3 = await level(`${DIR}p3d-t-keys.wav`, 440, 2.9, 0.2);
  const w4 = await level(`${DIR}p3d-t-keys.wav`, 440, 3.5, 0.5);
  check('measure: volkeys window [0.5,1.0] reads -28.6 +-1.5 dB', close(w1, -28.64, 1.5), `w1=${w1.toFixed(2)}`);
  check('measure: volkeys window [1.9,2.1] reads -21.3 +-1.5 dB', close(w2, -21.34, 1.5), `w2=${w2.toFixed(2)}`);
  check('measure: volkeys window [2.9,3.1] reads -26.0 +-1.5 dB', close(w3, -25.99, 1.5), `w3=${w3.toFixed(2)}`);
  check('measure: volkeys window [3.5,4.0] reads -33.8 +-2 dB', close(w4, -33.79, 2), `w4=${w4.toFixed(2)}`);
  const base440 = await level(`${DIR}p3d-440.wav`, 440, 1, 2);
  check('measure: volkeys baseline is -21.07 dB', close(base440, -21.07, 0.1), `base=${base440.toFixed(2)}`);

  // Denoise (probe B/B2 numbers).
  const raw0 = await rawFrame(SRC.noisy, 1, '320:180:0:0');
  const hf0 = hfEnergy(raw0, 320, 180);
  check('measure: noisy grey HF is 10.56 +-0.5', close(hf0, 10.56, 0.5), `hf0=${hf0.toFixed(2)}`);
  await vf(SRC.noisy, hqdn3dFilter(100), `${DIR}p3d-t-den100.mp4`);
  const raw100 = await rawFrame(`${DIR}p3d-t-den100.mp4`, 1, '320:180:0:0');
  const hf100 = hfEnergy(raw100, 320, 180);
  check('measure: denoise 100 cuts HF to <= 7.0', hf100 <= 7.0, `hf100=${hf100.toFixed(2)} (was ${hf0.toFixed(2)})`);
  check('measure: denoise 100 keeps mean luma (+-2)', close(meanLuma(raw100), meanLuma(raw0), 2), `luma ${meanLuma(raw0).toFixed(1)} -> ${meanLuma(raw100).toFixed(1)}`);
  await vf(SRC.noisy, hqdn3dFilter(50), `${DIR}p3d-t-den50.mp4`);
  const raw50 = await rawFrame(`${DIR}p3d-t-den50.mp4`, 1, '320:180:0:0');
  const hf50 = hfEnergy(raw50, 320, 180);
  check('measure: denoise 50 is weaker than 100 but below noisy', hf50 < hf0 && hf50 > hf100, `hf50=${hf50.toFixed(2)}`);
  const e0 = await rawFrame(SRC.edgeNoisy, 1, '320:180:0:0');
  await vf(SRC.edgeNoisy, hqdn3dFilter(100), `${DIR}p3d-t-edge-den.mp4`);
  const e1 = await rawFrame(`${DIR}p3d-t-edge-den.mp4`, 1, '320:180:0:0');
  check('measure: denoised edge stays sharp (width <= 2 px)', edgeWidth(e1, 320, 180) <= 2, `width ${edgeWidth(e0, 320, 180)} -> ${edgeWidth(e1, 320, 180)}`);
}

// --- C. rejects (bad parameters throw, never silently clamp) ---
{
  const c = (id, source, extra = {}) => ({ id, source, in: 0, out: 4, speed: 1, volume: 1, ...extra });
  check('reject: beauty strength -1 throws', throwsSync(() => validateBeauty({ strength: -1 }, c('a', SRC.person)), /outside/));
  check('reject: beauty strength 101 throws', throwsSync(() => validateBeauty({ strength: 101 }, c('a', SRC.person)), /outside/));
  check('reject: beauty mode "all" throws', throwsSync(() => validateBeauty({ mode: 'all' }, c('a', SRC.person)), /must be 'single' or 'multi'/));
  check('reject: beauty edgeFeather -1 throws', throwsSync(() => validateBeauty({ edgeFeather: -1 }, c('a', SRC.person)), /must be >= 0/));
  check('reject: beauty + reverse throws', throwsSync(() => validateBeauty({ strength: 50 }, c('a', SRC.person, { reverse: true })), /reverse/));
  check('reject: beauty + freeze throws', throwsSync(() => validateBeauty({ strength: 50 }, c('a', SRC.person, { freezeAt: 1 })), /freeze/));
  check('reject: beauty + speed 2 throws', throwsSync(() => validateBeauty({ strength: 50 }, c('a', SRC.person, { speed: 2 })), /speed 1/));
  check('reject: beauty + portraitCutout throws', throwsSync(() => validateBeauty({ strength: 50 }, c('a', SRC.person, { portraitCutout: {} })), /cannot be combined/));
  check('reject: beauty + multicam throws', throwsSync(() => validateBeauty({ strength: 50 }, c('a', SRC.person, { multicam: { angles: [SRC.person, SRC.person], cuts: [] } })), /multicam/));
  check('reject: wheels hueShift 181 throws', throwsSync(() => validateAdvancedColor({ colorWheels: { shadows: { hueShift: 181 } } }, 'c1'), /outside/));
  check('reject: wheels saturation 3.1 throws', throwsSync(() => validateAdvancedColor({ colorWheels: { midtones: { saturation: 3.1 } } }, 'c1'), /outside/));
  check('reject: hueVsSat 1 point throws', throwsSync(() => validateAdvancedColor({ hslCurves: { hueVsSat: [{ x: 0, y: 1 }] } }, 'c1'), /at least 2 points/));
  check('reject: hueVsLum y 1.5 throws', throwsSync(() => validateAdvancedColor({ hslCurves: { hueVsLum: [{ x: 0, y: 1.5 }, { x: 1, y: 0 }] } }, 'c1'), /outside/));
  check('reject: hueVsSat x not increasing throws', throwsSync(() => validateAdvancedColor({ hslCurves: { hueVsSat: [{ x: 0.5, y: 1 }, { x: 0.4, y: 1 }] } }, 'c1'), /strictly increasing/));
  check('reject: beatspeed empty beats throws', throwsSync(() => validateBeatSpeed(c('a', SRC.fourColor, { beatSpeed: { beats: [] } })), /non-empty/));
  check('reject: beatspeed beat 0 throws', throwsSync(() => validateBeatSpeed(c('a', SRC.fourColor, { beatSpeed: { beats: [0, 2] } })), /must be > 0/));
  check('reject: beatspeed beat at source end throws', throwsSync(() => validateBeatSpeed(c('a', SRC.fourColor, { beatSpeed: { beats: [4] } })), /outside source range/));
  check('reject: beatspeed non-increasing throws', throwsSync(() => validateBeatSpeed(c('a', SRC.fourColor, { beatSpeed: { beats: [2, 1] } })), /strictly increasing/));
  check('reject: beatspeed slow 0.1 throws', throwsSync(() => validateBeatSpeed(c('a', SRC.fourColor, { beatSpeed: { beats: [1], slowSpeed: 0.1 } })), /outside/));
  check('reject: beatspeed fast 5 throws', throwsSync(() => validateBeatSpeed(c('a', SRC.fourColor, { beatSpeed: { beats: [1], fastSpeed: 5 } })), /outside/));
  check('reject: beatspeed + manual speedCurve throws', throwsSync(() => validateBeatSpeed(c('a', SRC.fourColor, { speedCurve: [{ t: 0, speed: 2 }], beatSpeed: { beats: [1] } })), /cannot combine with a manual speedCurve/));
  check('reject: beatspeed + reverse throws', throwsSync(() => validateBeatSpeed(c('a', SRC.fourColor, { reverse: true, beatSpeed: { beats: [1] } })), /reverse/));
  check('reject: beatspeed + freeze throws', throwsSync(() => validateBeatSpeed(c('a', SRC.fourColor, { freezeAt: 1, beatSpeed: { beats: [1] } })), /freeze/));
  check('reject: beatflash empty beats throws', throwsSync(() => validateBeatFlash(c('a', SRC.grey, { beatFlash: { beats: [] } })), /non-empty/));
  check('reject: beatflash negative beat throws', throwsSync(() => validateBeatFlash(c('a', SRC.grey, { beatFlash: { beats: [-1] } })), /must be >= 0/));
  check('reject: beatflash non-increasing throws', throwsSync(() => validateBeatFlash(c('a', SRC.grey, { beatFlash: { beats: [3, 2] } })), /strictly increasing/));
  check('reject: beatflash frames 0 throws', throwsSync(() => validateBeatFlash(c('a', SRC.grey, { beatFlash: { beats: [1], frames: 0 } })), /integer in \[1, 10\]/));
  check('reject: beatflash frames 11 throws', throwsSync(() => validateBeatFlash(c('a', SRC.grey, { beatFlash: { beats: [1], frames: 11 } })), /integer in \[1, 10\]/));
  check('reject: beatflash beat beyond clip duration throws at graph build',
    throwsSync(() => buildFilterGraph({ ...base, clips: [c('a', SRC.grey, { beatFlash: { beats: [9] } })] }, FONT), /outside clip duration/));
  check('reject: volkeys negative t throws', throwsSync(() => validateAudioFx({ volumeKeys: [{ t: -1, gainDb: 0 }] }, 'c1'), /must be >= 0/));
  check('reject: volkeys non-increasing t throws', throwsSync(() => validateAudioFx({ volumeKeys: [{ t: 2, gainDb: 0 }, { t: 1, gainDb: 0 }] }, 'c1'), /strictly increasing/));
  check('reject: volkeys gainDb +31 throws', throwsSync(() => validateAudioFx({ volumeKeys: [{ t: 0, gainDb: 31 }] }, 'c1'), /outside/));
  check('reject: volkeys gainDb -31 throws', throwsSync(() => validateAudioFx({ volumeKeys: [{ t: 0, gainDb: -31 }] }, 'c1'), /outside/));
  check('reject: volkeys last key beyond clip duration throws at graph build',
    throwsSync(() => buildFilterGraph({ ...base, clips: [c('a', SRC.tone440, { audioFx: { volumeKeys: [{ t: 0, gainDb: 0 }, { t: 5, gainDb: 0 }] } })] }, FONT), /outside clip duration/));
  check('reject: videoDenoise strength 101 throws at graph build',
    throwsSync(() => buildFilterGraph({ ...base, clips: [c('a', SRC.noisy, { videoDenoise: { strength: 101 } })] }, FONT), /outside/));
  check('reject: videoDenoise strength -1 throws at graph build',
    throwsSync(() => buildFilterGraph({ ...base, clips: [c('a', SRC.noisy, { videoDenoise: { strength: -1 } })] }, FONT), /outside/));
  check('accept: videoDenoise strength 0 puts no hqdn3d in the graph',
    !buildFilterGraph({ ...base, clips: [c('a', SRC.noisy, { videoDenoise: { strength: 0 } })] }, FONT).filterComplex.includes('hqdn3d'));
  check('accept: videoDenoise strength 100 puts hqdn3d in the graph',
    buildFilterGraph({ ...base, clips: [c('a', SRC.noisy, { videoDenoise: { strength: 100 } })] }, FONT).filterComplex.includes('hqdn3d=8.00:6.00:10.00:8.00'));
  check('accept: volkeys + gainDb both appear in the graph (compose, not merge)',
    (() => {
      const g = buildFilterGraph({ ...base, clips: [c('a', SRC.tone440, { audioFx: { gainDb: -10, volumeKeys: [{ t: 0, gainDb: -20 }, { t: 2, gainDb: 0 }] } })] }, FONT);
      return g.filterComplex.includes('volume=-10dB') && g.filterComplex.includes(':eval=frame');
    })());
}

// --- D. export-level wiring ---
{
  // Beat speed: 4x 1 s colours, beats at 1.0/2.0 source, slow 0.5 / fast 2.
  // Output timeline: [0,1)@0.5 -> [0,2); [1,2)@2 -> [2,2.5); [2,4)@0.5 -> [2.5,6.5).
  const bs = await exportProject(
    { ...base, clips: [clip('h', SRC.fourColor, { beatSpeed: { beats: [1, 2], slowSpeed: 0.5, fastSpeed: 2 } })] },
    `${DIR}p3d-exp-beatspeed.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: beat-speed duration err < 0.05s (6.5s total)', Math.abs(bs.durationError) < 0.05, `err=${bs.durationError.toFixed(3)}s`);
  const bsProbe = await probe(`${DIR}p3d-exp-beatspeed.mp4`);
  check('export: beat-speed output is 6.50s', close(bsProbe.duration, 6.5, 0.05), `dur=${bsProbe.duration.toFixed(2)}`);
  const f19 = meanRGB(await rawFrame(`${DIR}p3d-exp-beatspeed.mp4`, 1.9, '64:64:288:148'));
  const f21 = meanRGB(await rawFrame(`${DIR}p3d-exp-beatspeed.mp4`, 2.1, '64:64:288:148'));
  const f26 = meanRGB(await rawFrame(`${DIR}p3d-exp-beatspeed.mp4`, 2.6, '64:64:288:148'));
  const f64 = meanRGB(await rawFrame(`${DIR}p3d-exp-beatspeed.mp4`, 6.4, '64:64:288:148'));
  check('export: beat-speed t=1.9 is still red', f19.r > 200 && f19.g < 50 && f19.b < 50, `R=${f19.r.toFixed(0)} G=${f19.g.toFixed(0)} B=${f19.b.toFixed(0)}`);
  check('export: beat-speed t=2.1 is green (fast segment)', f21.g > 200 && f21.r < 50 && f21.b < 50, `R=${f21.r.toFixed(0)} G=${f21.g.toFixed(0)} B=${f21.b.toFixed(0)}`);
  check('export: beat-speed t=2.6 is blue (slow again)', f26.b > 200 && f26.r < 50 && f26.g < 50, `R=${f26.r.toFixed(0)} G=${f26.g.toFixed(0)} B=${f26.b.toFixed(0)}`);
  check('export: beat-speed t=6.4 is yellow', f64.r > 200 && f64.g > 200 && f64.b < 50, `R=${f64.r.toFixed(0)} G=${f64.g.toFixed(0)} B=${f64.b.toFixed(0)}`);

  // Beat flash on grey: white at the beats, normal elsewhere.
  const fl = await exportProject(
    { ...base, clips: [clip('f', SRC.grey, { beatFlash: { beats: [2, 3], frames: 2 } })] },
    `${DIR}p3d-exp-flash.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: flash duration err < 0.3s', Math.abs(fl.durationError) < 0.3, `err=${fl.durationError.toFixed(3)}s`);
  const l10 = meanLuma(await rawFrame(`${DIR}p3d-exp-flash.mp4`, 1.0, '64:64:288:148'));
  const l20 = meanLuma(await rawFrame(`${DIR}p3d-exp-flash.mp4`, 2.0, '64:64:288:148'));
  const l203 = meanLuma(await rawFrame(`${DIR}p3d-exp-flash.mp4`, 2.033, '64:64:288:148'));
  const l21 = meanLuma(await rawFrame(`${DIR}p3d-exp-flash.mp4`, 2.1, '64:64:288:148'));
  const l30 = meanLuma(await rawFrame(`${DIR}p3d-exp-flash.mp4`, 3.0, '64:64:288:148'));
  const l35 = meanLuma(await rawFrame(`${DIR}p3d-exp-flash.mp4`, 3.5, '64:64:288:148'));
  check('export: flash frame at t=2.0 is white (>= 240)', l20 >= 240, `luma=${l20.toFixed(1)}`);
  check('export: flash frame at t=2.033 is white (>= 240)', l203 >= 240, `luma=${l203.toFixed(1)}`);
  check('export: flash frame at t=3.0 is white (>= 240)', l30 >= 240, `luma=${l30.toFixed(1)}`);
  check('export: frame at t=1.0 is normal grey (128 +-5)', close(l10, 128, 5), `luma=${l10.toFixed(1)}`);
  check('export: frame at t=2.1 is back to grey (128 +-5)', close(l21, 128, 5), `luma=${l21.toFixed(1)}`);
  check('export: frame at t=3.5 is back to grey (128 +-5)', close(l35, 128, 5), `luma=${l35.toFixed(1)}`);

  // Volume keys export + gainDb composition.
  const keys = [{ t: 0, gainDb: -20 }, { t: 2, gainDb: 0 }, { t: 4, gainDb: -20 }];
  const vk = await exportProject(
    { ...base, clips: [clip('v', SRC.tone440, { audioFx: { volumeKeys: keys } })] },
    `${DIR}p3d-exp-volkeys.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: volkeys duration err < 0.3s', Math.abs(vk.durationError) < 0.3, `err=${vk.durationError.toFixed(3)}s`);
  const vk1 = await level(`${DIR}p3d-exp-volkeys.mp4`, 440, 0.5, 0.5);
  const vk2 = await level(`${DIR}p3d-exp-volkeys.mp4`, 440, 1.9, 0.2);
  check('export: volkeys window [0.5,1.0] reads -28.6 +-2 dB', close(vk1, -28.64, 2), `w=${vk1.toFixed(2)}`);
  check('export: volkeys window [1.9,2.1] reads -21.3 +-2 dB', close(vk2, -21.34, 2), `w=${vk2.toFixed(2)}`);
  const vkg = await exportProject(
    { ...base, clips: [clip('v', SRC.tone440, { audioFx: { gainDb: -10, volumeKeys: keys } })] },
    `${DIR}p3d-exp-volkeys-gain.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: volkeys + gainDb duration err < 0.3s', Math.abs(vkg.durationError) < 0.3, `err=${vkg.durationError.toFixed(3)}s`);
  const vkg2 = await level(`${DIR}p3d-exp-volkeys-gain.mp4`, 440, 1.9, 0.2);
  check('export: gainDb -10 composes with volkeys (window reads -31.3 +-2 dB)', close(vkg2, -31.34, 2), `w=${vkg2.toFixed(2)}`);

  // Colour wheels export: dark red turns green, bright red untouched.
  const wDark = await exportProject(
    { ...base, clips: [clip2('w', SRC.darkRed, { advancedColor: { colorWheels: { shadows: { hueShift: 120 } } } })] },
    `${DIR}p3d-exp-wheel-dark.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: wheel dark duration err < 0.3s', Math.abs(wDark.durationError) < 0.3, `err=${wDark.durationError.toFixed(3)}s`);
  const wd = meanRGB(await rawFrame(`${DIR}p3d-exp-wheel-dark.mp4`, 1, '64:64:288:148'));
  check('export: dark red + shadows hue+120 is green-dominant in the export', wd.g > 100 && wd.g > wd.r * 2, `R=${wd.r.toFixed(0)} G=${wd.g.toFixed(0)} B=${wd.b.toFixed(0)}`);
  const wBright = await exportProject(
    { ...base, clips: [clip2('w', SRC.brightRed, { advancedColor: { colorWheels: { shadows: { hueShift: 120 } } } })] },
    `${DIR}p3d-exp-wheel-bright.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: wheel bright duration err < 0.3s', Math.abs(wBright.durationError) < 0.3, `err=${wBright.durationError.toFixed(3)}s`);
  const wb = meanRGB(await rawFrame(`${DIR}p3d-exp-wheel-bright.mp4`, 1, '64:64:288:148'));
  check('export: bright red untouched by shadows wheel (R 255, G/B ~128)', wb.r > 240 && close(wb.g, 128, 10) && close(wb.b, 128, 10), `R=${wb.r.toFixed(0)} G=${wb.g.toFixed(0)} B=${wb.b.toFixed(0)}`);

  // HSL curves export: red desaturates, green untouched.
  const cRed = await exportProject(
    { ...base, clips: [clip2('c', SRC.fourColor, { in: 0, out: 2, advancedColor: { hslCurves: { hueVsSat: [{ x: 0, y: 0 }, { x: 0.08, y: 0 }, { x: 0.15, y: 1 }, { x: 1, y: 1 }] } } })] },
    `${DIR}p3d-exp-curve-red.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: curve red duration err < 0.3s', Math.abs(cRed.durationError) < 0.3, `err=${cRed.durationError.toFixed(3)}s`);
  const cr = meanRGB(await rawFrame(`${DIR}p3d-exp-curve-red.mp4`, 0.5, '64:64:288:148'));
  check('export: red frame desaturated to grey by the curve', close(cr.r, cr.g, 8) && close(cr.g, cr.b, 8) && cr.r > 100 && cr.r < 160, `R=${cr.r.toFixed(0)} G=${cr.g.toFixed(0)} B=${cr.b.toFixed(0)}`);
  const cGreen = await exportProject(
    { ...base, clips: [clip2('c', SRC.green, { advancedColor: { hslCurves: { hueVsSat: [{ x: 0, y: 0 }, { x: 0.08, y: 0 }, { x: 0.15, y: 1 }, { x: 1, y: 1 }] } } })] },
    `${DIR}p3d-exp-curve-green.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: curve green duration err < 0.3s', Math.abs(cGreen.durationError) < 0.3, `err=${cGreen.durationError.toFixed(3)}s`);
  const cg = meanRGB(await rawFrame(`${DIR}p3d-exp-curve-green.mp4`, 1, '64:64:288:148'));
  check('export: green frame untouched by the red curve', cg.g > 200 && cg.r < 50 && cg.b < 50, `R=${cg.r.toFixed(0)} G=${cg.g.toFixed(0)} B=${cg.b.toFixed(0)}`);

  // Denoise export: relative HF drop vs a plain export of the same noisy source.
  const denPlain = await exportProject(
    { ...base, clips: [clip2('d', SRC.noisy)] },
    `${DIR}p3d-exp-den-plain.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: denoise-plain duration err < 0.3s', Math.abs(denPlain.durationError) < 0.3, `err=${denPlain.durationError.toFixed(3)}s`);
  const denOn = await exportProject(
    { ...base, clips: [clip2('d', SRC.noisy, { videoDenoise: { strength: 100 } })] },
    `${DIR}p3d-exp-den-on.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: denoise-on duration err < 0.3s', Math.abs(denOn.durationError) < 0.3, `err=${denOn.durationError.toFixed(3)}s`);
  const hfPlain = hfEnergy(await rawFrame(`${DIR}p3d-exp-den-plain.mp4`, 1, '320:180:0:0'), 320, 180);
  const hfDen = hfEnergy(await rawFrame(`${DIR}p3d-exp-den-on.mp4`, 1, '320:180:0:0'), 320, 180);
  check('export: denoise 100 cuts export HF by >= 30% vs plain export', hfDen <= 0.7 * hfPlain, `plain=${hfPlain.toFixed(2)} den=${hfDen.toFixed(2)}`);

  // Beauty: prep reports 1 person (single + multi), no-face throws.
  const masksSingle = await prepareBeautyMasks(
    { ...base, clips: [clip('p', SRC.person, { beauty: { strength: 80, mode: 'single' } })] },
    DIR, { python: PY });
  const infoS = masksSingle.get(0);
  check('beauty: single mode reports personCount 1', infoS?.personCount === 1, `personCount=${infoS?.personCount}`);
  check('beauty: single mode mask video exists', !!infoS && existsSync(infoS.mask), infoS?.mask ?? '');
  const masksMulti = await prepareBeautyMasks(
    { ...base, clips: [clip('p', SRC.person, { beauty: { strength: 80, mode: 'multi' } })] },
    DIR, { python: PY });
  check('beauty: multi mode reports personCount 1 on a one-person clip', masksMulti.get(0)?.personCount === 1, `personCount=${masksMulti.get(0)?.personCount}`);
  check('beauty: no-face clip throws at prep',
    await throwsAsync(() => prepareBeautyMasks(
      { ...base, clips: [clip('f', SRC.fake, { beauty: { strength: 80 } })] }, DIR, { python: PY }), /no face/));
  check('beauty: strength-0 clip is skipped by prep (empty map)',
    (await prepareBeautyMasks(
      { ...base, clips: [clip('p', SRC.person, { beauty: { strength: 0 } })] }, DIR, { python: PY })).size === 0);

  // Beauty export: in-mask HF drops, out-mask HF unchanged; strength 0 = plain.
  const plainB = await exportProject({ ...base, clips: [clip('p', SRC.person)] }, `${DIR}p3d-exp-beauty-plain.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: beauty-plain duration err < 0.3s', Math.abs(plainB.durationError) < 0.3, `err=${plainB.durationError.toFixed(3)}s`);
  const beautB = await exportProject(
    { ...base, clips: [clip('p', SRC.person, { beauty: { strength: 100, mode: 'single' } })] },
    `${DIR}p3d-exp-beauty.mp4`, { preset: PRESETS['720p30'], fontfile: FONT, python: PY });
  check('export: beauty duration err < 0.3s', Math.abs(beautB.durationError) < 0.3, `err=${beautB.durationError.toFixed(3)}s`);
  const maskFrame = await grayFrame(`${DIR}beauty-c0-mask.mp4`, 2);
  const rgbPlain = await rawFrame(`${DIR}p3d-exp-beauty-plain.mp4`, 2, '640:360:0:0');
  const rgbBeaut = await rawFrame(`${DIR}p3d-exp-beauty.mp4`, 2, '640:360:0:0');
  const mPlain = maskedHF(rgbPlain, maskFrame, 640, 360);
  const mBeaut = maskedHF(rgbBeaut, maskFrame, 640, 360);
  check('export: beauty 100 cuts in-mask HF by >= 5%', mBeaut.inHF <= 0.95 * mPlain.inHF, `in ${mPlain.inHF.toFixed(2)} -> ${mBeaut.inHF.toFixed(2)}`);
  check('export: beauty leaves out-mask HF unchanged (+-3%)', Math.abs(mBeaut.outHF - mPlain.outHF) <= 0.03 * mPlain.outHF, `out ${mPlain.outHF.toFixed(2)} -> ${mBeaut.outHF.toFixed(2)}`);
  const zeroB = await exportProject(
    { ...base, clips: [clip('p', SRC.person, { beauty: { strength: 0 } })] },
    `${DIR}p3d-exp-beauty0.mp4`, { preset: PRESETS['720p30'], fontfile: FONT, python: PY });
  check('export: beauty-0 duration err < 0.3s', Math.abs(zeroB.durationError) < 0.3, `err=${zeroB.durationError.toFixed(3)}s`);
  const rgbZero = await rawFrame(`${DIR}p3d-exp-beauty0.mp4`, 2, '640:360:0:0');
  check('export: beauty strength 0 frame is byte-identical to plain', rgbZero.equals(rgbPlain));
  check('export: beauty + portraitCutout throws at graph build',
    throwsSync(() => buildFilterGraph({ ...base, clips: [clip('p', SRC.person, { beauty: { strength: 50 }, portraitCutout: {} })] }, FONT), /cannot be combined/));
  check('export: beauty without prepared mask throws a clear error',
    throwsSync(() => buildFilterGraph({ ...base, clips: [clip('p', SRC.person, { beauty: { strength: 50 } })] }, FONT), /beauty mask video not prepared/));
}

// --- report ---
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exit(1);
