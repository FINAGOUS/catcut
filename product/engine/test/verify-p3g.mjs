// P3 batch 7 engine verification (M4 §8.4 / §8.7, 2026-11-18) — the
// LAST engine batch. Covers: src/p3g.ts — colour management (zscale
// input conversion + S-Log3/sRGB transfer LUTs + output space), colour
// match (histogram-match LUT), node-based grading (DAG bake +
// masked stages), tracked grading windows (moving mask video),
// LUT library + thumbnails, grade compare + reference stills,
// object tracking (colour centroid + NCC template), clone, key
// outline, auto-video (script + images -> film), AI upscaling
// (Real-ESRGAN ONNX; honest fallback when the model is absent).
//
// Measurement method (probe test/tmp/probe-p3g.mjs + probe-p3g2.mjs
// ran BEFORE writing assertions — every number below was measured first):
// - zscale has NO slog3 transfer; a bare zscale pin/min/tin=log100 or
//   hlg fails with "no path between colorspaces". Tagging the input
//   first with setparams makes the same conversion succeed. S-Log3
//   therefore goes through a TS LUT built from Sony's published curve
//   (anchor-checked: 18% grey -> 420/1023, 90% white -> 598/1023).
// - sRGB output tagging works: setparams color_trc=iec61966-2-1 makes
//   ffprobe read color_transfer=iec61966-2-1.
// - Dilation: one pass grows a r=30 disc mask 2809 -> 3049 white px
//   (~+1 px radius); three passes -> 3553 (~+3 px).
// - Colour-centroid tracking on the moving disc: <= ~1% frame error
//   (probe-p3g2: cx = 0.2 + 0.12*t, measured 0.208 at t=0, 0.664 at
//   t=3.8). drawtext x/y expressions re-evaluate per frame
//   (x='20+60*t': text at x~80 at t=1, x~200 at t=3). maskedmerge
//   with a 5 fps moving mask video follows the disc (centre graded,
//   old centre ungraded).
// - Real-ESRGAN: official .pth (67 MB) downloads fine; the pip
//   `realesrgan` package import breaks on this torchvision
//   (functional_tensor removed) and basicsr 1.4.2 imports the same
//   module — the ONNX export bypasses both via a sys.modules shim
//   and builds RRDBNet straight from basicsr (see test/tmp/export-onnx.py).
// - LGPL: zscale/tonemap/lut3d/dilation/maskedmerge are native
//   libavfilter — only verified on the local GPL 8.1.2 build;
//   re-check each on the BtbN LGPL 9.0 build at the M2 gate.
// Old M1 / P0 / P0b / P1 / P1b / P1c / P1d / P1e / P2a / P2b / P2c /
// P3a / P3b / P3c / P3d / P3e / P3f checks live in their own files
// and must still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addLutEntry,
  applyAdvancedColorToRgb,
  bakeGradeNodes,
  buildAutoVideoProject,
  buildColorMatchLut,
  cloneLaneSize,
  defaultUpscaleModelPath,
  outlineDilationFilter,
  parseOutlineColor,
  prepareClone,
  prepareObjectTracks,
  buildTransferLut,
  buildTrackedWindowMaskBuffer,
  exportProject,
  filterLutLibrary,
  generateLutThumbnail,
  histogramMatchMaps,
  channelHistograms,
  listReferenceStills,
  loadReferenceStill,
  lutLibraryCategories,
  PRESETS,
  probe,
  projectDuration,
  renderComparisonFrame,
  renderFrameMaskPng,
  saveReferenceStill,
  slog3Decode,
  slog3Encode,
  srgbOetf,
  srgbOetfInv,
  toggleLutFavorite,
  topoSortGradeNodes,
  trackObjectByColor,
  trackObjectByTemplate,
  upscaleVideo,
  validateAutoVideo,
  validateCloneEffect,
  validateColorMatch,
  validateGradeNodes,
  validateKeyOutline,
  validateObjectTrack,
  validateTrackedWindow,
  validateUpscale,
  writeBuiltLutFile,
} from '../dist/export.js';
import { buildFilterGraph } from '../dist/filtergraph.js';
import { trackFromMaskVideo } from '../dist/smartcut.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const PYTHON = '.venv/bin/python';
const ENGINE = new URL('..', import.meta.url).pathname;

const checks = [];
const check = (name, ok, detail = '') =>
  checks.push([`${name}${detail ? ` (${detail})` : ''}`, ok]);

async function run(cmd, args, opts = {}) {
  return exec(cmd, args, { maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer', ...opts });
}
const throwsSync = (fn, re) => {
  try { fn(); return false; } catch (e) { return re.test(e.message); }
};
const throwsAsync = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return re.test(e.message); }
};
const close = (v, target, tol = 0.5) => v !== null && Math.abs(v - target) <= tol;
async function rgbMean(file, ss) {
  const r = await run('ffmpeg', ['-ss', String(ss), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const b = r.stdout; let R = 0, G = 0, B = 0; const n = b.length / 3;
  for (let i = 0; i < b.length; i += 3) { R += b[i]; G += b[i + 1]; B += b[i + 2]; }
  return [R / n, G / n, B / n];
}
async function pxAt(file, ss, x, y) {
  const r = await run('ffmpeg', ['-ss', String(ss), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const o = (y * 320 + x) * 3;
  return [r.stdout[o], r.stdout[o + 1], r.stdout[o + 2]];
}
async function grayFrame(file, ss) {
  const r = await run('ffmpeg', ['-ss', String(ss), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  return r.stdout;
}
/** Stddev of gray pixels in a ring around (cx,cy) — blur detector. */
function ringStddev(fr, cx, cy, r0, r1) {
  const vals = [];
  for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d >= r0 && d <= r1) vals.push(fr[y * 320 + x]);
  }
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
}
/** Mean abs horizontal neighbour diff — sharpness (HF) metric. */
function hfMean(fr, w, h) {
  let s = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) { s += Math.abs(fr[y * w + x + 1] - fr[y * w + x]); n++; }
  return s / n;
}
async function ffprobeJson(file, args) {
  const r = await run('ffprobe', ['-v', 'error', ...args, '-of', 'json', file]);
  return JSON.parse(r.stdout.toString());
}
async function rmsWindow(file, ss, dur) {
  const r = await run('ffmpeg', ['-v', 'error', '-ss', String(ss), '-i', file, '-t', String(dur),
    '-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-']).catch((e) => e);
  const buf = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? '', 'binary');
  const s = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  if (s.length === 0) return -240;
  let e = 0; for (const v of s) e += v * v;
  return 20 * Math.log10(Math.sqrt(e / s.length) + 1e-12);
}
function synthWav(path, dur, fn) {
  const sr = 48000;
  const n = Math.floor(dur * sr);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, fn(i / sr)));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * 2, 28);
  hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36);
  hdr.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([hdr, data]));
}
async function muxVideo(color, wav, dur, out, extra = []) {
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30:d=${dur}`,
    '-i', wav, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...extra, '-y', out]);
}
const mkClip = (id, source, dur, extra = {}) => ({
  id, source, in: 0, out: dur, speed: 1, volume: 1, ...extra,
});
const mkProject = (clips, extra = {}) => ({
  version: 1, width: 320, height: 180, fps: 30,
  clips, transitions: new Array(Math.max(0, clips.length - 1)).fill('cut'),
  transitionDuration: 0.5, ...extra,
});
const PRESET = { ...PRESETS['720p30'], width: 320, height: 180, fps: 30 };

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
synthWav(`${DIR}p3g-tone.wav`, 4, (t) => 0.15 * Math.sin(2 * Math.PI * 440 * t));
await muxVideo('red', `${DIR}p3g-tone.wav`, 4, `${DIR}p3g-red.mp4`);
await muxVideo('0x646464', `${DIR}p3g-tone.wav`, 4, `${DIR}p3g-grey.mp4`);
await muxVideo('0xc83232', `${DIR}p3g-tone.wav`, 4, `${DIR}p3g-ref.mp4`);
await muxVideo('0x641e1e', `${DIR}p3g-tone.wav`, 4, `${DIR}p3g-tgt.mp4`);
// Moving RED disc on a deterministic high-frequency grey pattern
// (track colour [255,0,0]; disc cx = 0.2 + 0.12*t of frame width).
// NOTE: geq MUST run in rgb24. On yuv420p the cb/cr planes are
// half-resolution, so the disc test in the chroma planes lands at
// (128,180) with 2x radius and the "red" region becomes the
// luma-disc/chroma-disc intersection — probe-p3g3 caught this
// (frame-0 red bbox x 70-187, y 122-179, not the disc at (64,90)).
await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
  `nullsrc=s=320x180:r=30:d=4,format=rgb24,geq=r='if(lt(pow(X-64-38.4*T,2)+pow(Y-90,2),900),255,128+100*sin(X*0.9)*sin(Y*1.3))':g='if(lt(pow(X-64-38.4*T,2)+pow(Y-90,2),900),0,128+100*sin(X*0.9)*sin(Y*1.3))':b='if(lt(pow(X-64-38.4*T,2)+pow(Y-90,2),900),0,128+100*sin(X*0.9)*sin(Y*1.3))'`,
  '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=4',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', `${DIR}p3g-disc.mp4`]);
// Textured moving target for TEMPLATE tracking: black 40x40 square with
// a white X on white, cx = 0.2 + 0.12*t, cy = 0.5. The red disc is a BAD
// template target (uniform interior; the static high-freq background
// dominates the NCC, probe-p3g3: lost 19/20, min NCC 0.046), so the
// template check uses this square (probe-p3g3: maxErr 0.0043, minNCC 0.970).
await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
  `nullsrc=s=320x180:r=30:d=4,format=rgb24,geq=r='if(lt(abs(X-64-38.4*T),20),if(lt(abs(Y-90),20),if(lt(abs(abs(X-64-38.4*T)-abs(Y-90)),2),255,0),255),255)':g='if(lt(abs(X-64-38.4*T),20),if(lt(abs(Y-90),20),if(lt(abs(abs(X-64-38.4*T)-abs(Y-90)),2),255,0),255),255)':b='if(lt(abs(X-64-38.4*T),20),if(lt(abs(Y-90),20),if(lt(abs(abs(X-64-38.4*T)-abs(Y-90)),2),255,0),255),255)'`,
  '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=4',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', `${DIR}p3g-square.mp4`]);
// Person low-res source for the upscale edge test (1 s window of
// p1e-person.mp4, 160x90 @ 10 fps) + the 640x360 ground-truth frame
// at the same instant (absolute t=1.0, middle of the window).
await run('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', `${DIR}p1e-person.mp4`, '-t', '1',
  '-vf', 'fps=fps=10,scale=160:90', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
  '-y', `${DIR}p3g-person-low.mp4`]);
await run('ffmpeg', ['-v', 'error', '-ss', '1', '-i', `${DIR}p1e-person.mp4`,
  '-frames:v', '1', '-y', `${DIR}p3g-person-gt.png`]);
// Time-varying source for clone (testsrc2 has a moving timecode).
await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=8',
  '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=8',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', `${DIR}p3g-src.mp4`]);
// S-Log3-encoded grey: Rec.709 grey -> slog3 LUT -> file.
{
  const lut = buildTransferLut('rec709', 'slog3', 33);
  writeBuiltLutFile(lut, `${DIR}p3g-enc-slog3.cube`, 'CatCut rec709 to slog3 (test encode)');
  await run('ffmpeg', ['-v', 'error', '-i', `${DIR}p3g-grey.mp4`, '-vf', `lut3d='${DIR}p3g-enc-slog3.cube'`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-y', `${DIR}p3g-grey-slog3.mp4`]);
}
// log100-encoded grey (zscale encode, setparams-tagged input).
await run('ffmpeg', ['-v', 'error', '-i', `${DIR}p3g-grey.mp4`,
  '-vf', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709,zscale=t=log100:m=bt709:range=tv,format=yuv420p',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-y', `${DIR}p3g-grey-log100.mp4`]);
// HLG-encoded grey.
await run('ffmpeg', ['-v', 'error', '-i', `${DIR}p3g-grey.mp4`,
  '-vf', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709,zscale=p=bt2020:t=arib-std-b67:m=bt2020nc:range=tv,format=yuv420p',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-y', `${DIR}p3g-grey-hlg.mp4`]);
// Still images for auto-video (solid colours).
for (const [name, color] of [['a', '0x204060'], ['b', '0x604020'], ['c', '0x206040']]) {
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30:d=1`,
    '-frames:v', '1', '-y', `${DIR}p3g-img-${name}.png`]);
}
// Low-res source for upscaling (testsrc2, 160x90, 1s @ 10fps).
await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=1',
  '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=1',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', `${DIR}p3g-low.mp4`]);
// All-black video (object-track lost test).
await muxVideo('black', `${DIR}p3g-tone.wav`, 4, `${DIR}p3g-black.mp4`);

const greyOrig = await rgbMean(`${DIR}p3g-grey.mp4`, 1);
console.log(`[p3g] grey original mean: ${greyOrig.map((v) => v.toFixed(1))}`);

// ---------------------------------------------------------------------------
// 1. Colour management
// ---------------------------------------------------------------------------
{
  check('cm: slog3Decode 18% grey anchor (420/1023 -> 0.18 +-0.002)',
    close(slog3Decode(420 / 1023), 0.18, 0.002), `${slog3Decode(420 / 1023).toFixed(4)}`);
  check('cm: slog3Decode 90% white anchor (598/1023 -> 0.90 +-0.01)',
    close(slog3Decode(598 / 1023), 0.90, 0.01), `${slog3Decode(598 / 1023).toFixed(4)}`);
  check('cm: slog3Decode black (95/1023 -> 0)',
    close(slog3Decode(95 / 1023), 0, 0.001), `${slog3Decode(95 / 1023).toFixed(4)}`);
  check('cm: slog3 round-trip encode->decode identity (+-0.001)',
    [0.05, 0.18, 0.5, 0.9].every((l) => close(slog3Decode(slog3Encode(l)), l, 0.001)));
  check('cm: srgb oetf/inverse round-trip (+-0.001)',
    [0.05, 0.18, 0.5, 0.9].every((l) => close(srgbOetfInv(srgbOetf(l)), l, 0.001)));
  check('cm: bad inputSpace throws', throwsSync(() =>
    buildFilterGraph(mkProject([mkClip('c', `${DIR}p3g-grey.mp4`, 4, { colorManagement: { inputSpace: 'vlog' } })]), FONT),
  /unknown input color space/));
  check('cm: workingSpace on a clip throws', throwsSync(() =>
    buildFilterGraph(mkProject([mkClip('c', `${DIR}p3g-grey.mp4`, 4, { colorManagement: { workingSpace: 'srgb' } })]), FONT),
  /belong on the project/));
  check('cm: inputSpace on the project throws', throwsSync(() =>
    buildFilterGraph(mkProject([mkClip('c', `${DIR}p3g-grey.mp4`, 4)], { colorManagement: { inputSpace: 'slog3' } }), FONT),
  /belongs on clips/));
  check('cm: bad outputSpace throws at export',
    await throwsAsync(() => exportProject(
      mkProject([mkClip('c', `${DIR}p3g-grey.mp4`, 4)], { colorManagement: { outputSpace: 'xyz' } }),
      `${DIR}p3g-cm-bad.mp4`, { fontfile: FONT, preset: PRESET }), /must be 'rec709' or 'srgb'/));
  // Graph strings: slog3 clip gets a LUT (no zscale), log100 gets zscale.
  const gSlog = buildFilterGraph(
    mkProject([mkClip('c', `${DIR}p3g-grey-slog3.mp4`, 4, { colorManagement: { inputSpace: 'slog3' } })]),
    FONT, ...Array(15).fill(undefined),
    { colorMgmtLuts: new Map([[0, [`${DIR}p3g-enc-slog3.cube`]]]) },
  );
  check('cm: graph applies the input LUT first (lut3d present)', gSlog.filterComplex.includes('lut3d='));
  const gLog = buildFilterGraph(
    mkProject([mkClip('c', `${DIR}p3g-grey-log100.mp4`, 4, { colorManagement: { inputSpace: 'log100' } })]),
    FONT);
  check('cm: log100 graph contains setparams+zscale', gLog.filterComplex.includes('color_trc=log100') && gLog.filterComplex.includes('zscale='));

  // Live round-trips: log-encoded grey -> Rec.709 working space.
  const repSlog = await exportProject(
    mkProject([mkClip('c', `${DIR}p3g-grey-slog3.mp4`, 4, { colorManagement: { inputSpace: 'slog3' } })]),
    `${DIR}p3g-cm-slog3.mp4`, { fontfile: FONT, preset: PRESET });
  const slogMean = await rgbMean(`${DIR}p3g-cm-slog3.mp4`, 1);
  check('cm: slog3 round-trip restores grey (+-6 per channel)',
    greyOrig.every((v, i) => Math.abs(v - slogMean[i]) <= 6),
    `orig ${greyOrig.map((v) => v.toFixed(0))} got ${slogMean.map((v) => v.toFixed(0))}`);
  check('cm: slog3 export keeps duration', repSlog.durationError <= 0.05, `err ${repSlog.durationError}`);
  check('cm: colormgmt LUT written next to output', existsSync(join(DIR, 'colormgmt-c0.cube')));
  const repLog = await exportProject(
    mkProject([mkClip('c', `${DIR}p3g-grey-log100.mp4`, 4, { colorManagement: { inputSpace: 'log100' } })]),
    `${DIR}p3g-cm-log100.mp4`, { fontfile: FONT, preset: PRESET });
  const logMean = await rgbMean(`${DIR}p3g-cm-log100.mp4`, 1);
  check('cm: log100 round-trip restores grey (+-8 per channel)',
    greyOrig.every((v, i) => Math.abs(v - logMean[i]) <= 8),
    `orig ${greyOrig.map((v) => v.toFixed(0))} got ${logMean.map((v) => v.toFixed(0))}`);
  check('cm: log100 export keeps duration', repLog.durationError <= 0.05, `err ${repLog.durationError}`);
  const repHlg = await exportProject(
    mkProject([mkClip('c', `${DIR}p3g-grey-hlg.mp4`, 4, { colorManagement: { inputSpace: 'hlg' } })]),
    `${DIR}p3g-cm-hlg.mp4`, { fontfile: FONT, preset: PRESET });
  const hlgMean = await rgbMean(`${DIR}p3g-cm-hlg.mp4`, 1);
  check('cm: hlg round-trip restores grey (+-10 per channel)',
    greyOrig.every((v, i) => Math.abs(v - hlgMean[i]) <= 10),
    `orig ${greyOrig.map((v) => v.toFixed(0))} got ${hlgMean.map((v) => v.toFixed(0))}`);
  // Output space switch: sRGB tags the file, Rec.709 tags bt709.
  const repSrgb = await exportProject(
    mkProject([mkClip('c', `${DIR}p3g-grey.mp4`, 4)], { colorManagement: { outputSpace: 'srgb' } }),
    `${DIR}p3g-cm-srgb.mp4`, { fontfile: FONT, preset: PRESET });
  const jSrgb = await ffprobeJson(`${DIR}p3g-cm-srgb.mp4`, ['-select_streams', 'v:0', '-show_entries', 'stream=color_transfer']);
  check('cm: sRGB output ffprobe reads color_transfer iec61966-2-1',
    jSrgb.streams[0].color_transfer === 'iec61966-2-1', JSON.stringify(jSrgb.streams[0]));
  check('cm: sRGB export keeps duration', repSrgb.durationError <= 0.05, `err ${repSrgb.durationError}`);
  const rep709 = await exportProject(
    mkProject([mkClip('c', `${DIR}p3g-grey.mp4`, 4)], { colorManagement: { outputSpace: 'rec709' } }),
    `${DIR}p3g-cm-709.mp4`, { fontfile: FONT, preset: PRESET });
  const j709 = await ffprobeJson(`${DIR}p3g-cm-709.mp4`, ['-select_streams', 'v:0', '-show_entries', 'stream=color_transfer']);
  check('cm: Rec.709 output ffprobe reads color_transfer bt709',
    j709.streams[0].color_transfer === 'bt709', JSON.stringify(j709.streams[0]));
  // Output LUT file: working rec709 -> output srgb bakes a LUT.
  check('cm: output LUT written next to the sRGB export', existsSync(`${DIR}colormgmt-output.cube`));
}

// ---------------------------------------------------------------------------
// 2. Colour match
// ---------------------------------------------------------------------------
{
  const refPx = await (async () => {
    const r = await run('ffmpeg', ['-i', `${DIR}p3g-ref.mp4`, '-vf', 'scale=320:180', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return r.stdout;
  })();
  const tgtPx = await (async () => {
    const r = await run('ffmpeg', ['-i', `${DIR}p3g-tgt.mp4`, '-vf', 'scale=320:180', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return r.stdout;
  })();
  const maps = histogramMatchMaps(channelHistograms(refPx), channelHistograms(tgtPx));
  // Reference is (200,50,50); +-2 allows H.264 solid-colour drift.
  check('match: solid target maps to solid reference (100 -> 200, 30 -> 50)',
    close(maps[0][100], 200, 2) && close(maps[1][30], 50, 2) && close(maps[2][30], 50, 2),
    `R ${maps[0][100]} G ${maps[1][30]} B ${maps[2][30]}`);
  const lut0 = buildColorMatchLut(refPx, tgtPx, 0, 17);
  check('match: strength 0 is the identity LUT',
    close(lut0.data[0], 0, 0.001) && close(lut0.data[lut0.data.length - 3], 1, 0.001));
  check('match: bad reference path throws', throwsSync(() =>
    validateColorMatch({ referenceFrame: `${DIR}p3g-nope.png` }, 'c'), /missing/));
  check('match: strength 2 throws', throwsSync(() =>
    validateColorMatch({ referenceFrame: `${DIR}p3g-ref.mp4`, strength: 2 }, 'c'), /strength/));
  const refMean = await rgbMean(`${DIR}p3g-ref.mp4`, 1);
  const tgtMean = await rgbMean(`${DIR}p3g-tgt.mp4`, 1);
  const repMatch = await exportProject(
    mkProject([mkClip('c', `${DIR}p3g-tgt.mp4`, 4, { colorMatch: { referenceFrame: `${DIR}p3g-ref.mp4` } })]),
    `${DIR}p3g-match.mp4`, { fontfile: FONT, preset: PRESET });
  const matchMean = await rgbMean(`${DIR}p3g-match.mp4`, 1);
  check('match: matched target mean within 8 of the reference per channel',
    refMean.every((v, i) => Math.abs(v - matchMean[i]) <= 8),
    `ref ${refMean.map((v) => v.toFixed(0))} got ${matchMean.map((v) => v.toFixed(0))}`);
  check('match: export keeps duration', repMatch.durationError <= 0.05, `err ${repMatch.durationError}`);
  const repCtrl = await exportProject(
    mkProject([mkClip('c', `${DIR}p3g-tgt.mp4`, 4)]),
    `${DIR}p3g-match-ctrl.mp4`, { fontfile: FONT, preset: PRESET });
  const ctrlMean = await rgbMean(`${DIR}p3g-match-ctrl.mp4`, 1);
  check('match: control (no match) keeps the target mean (+-2)',
    tgtMean.every((v, i) => Math.abs(v - ctrlMean[i]) <= 2),
    `tgt ${tgtMean.map((v) => v.toFixed(0))} ctrl ${ctrlMean.map((v) => v.toFixed(0))}`);
}

// ---------------------------------------------------------------------------
// 3. Node-based grading
// ---------------------------------------------------------------------------
{
  const lift = { curves: { master: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }] } };
  const desatRed = { hsl: [{ hue: 'red', saturation: 0 }] };
  const serial = {
    nodes: [
      { id: 'lift', adjust: lift },
      { id: 'desat', adjust: desatRed, inputs: ['lift'] },
    ],
    output: 'desat',
  };
  const order = topoSortGradeNodes(serial);
  check('nodes: serial topo order is lift -> desat',
    order.map((n) => n.id).join(',') === 'lift,desat', order.map((n) => n.id).join(','));
  const baked = bakeGradeNodes(serial, 17);
  // Hand-computed reference: chained applyAdvancedColorToRgb.
  let maxDiff = 0;
  for (const [r, g, b] of [[1, 0, 0], [0.5, 0, 0], [0, 1, 0], [0.1875, 0.375, 0.625]]) {
    const [r1, g1, b1] = applyAdvancedColorToRgb(lift, r, g, b);
    const [r2, g2, b2] = applyAdvancedColorToRgb(desatRed, r1, g1, b1);
    // Sample the baked LUT at the nearest grid node.
    const ri = Math.round(r * 16), gi = Math.round(g * 16), bi = Math.round(b * 16);
    const o = (bi * 17 * 17 + gi * 17 + ri) * 3;
    maxDiff = Math.max(maxDiff, Math.abs(baked.final.data[o] - r2), Math.abs(baked.final.data[o + 1] - g2), Math.abs(baked.final.data[o + 2] - b2));
  }
  check('nodes: baked serial LUT matches hand-chained math (+-0.02)', maxDiff <= 0.02, `maxDiff ${maxDiff.toFixed(4)}`);
  const parallel = {
    nodes: [
      { id: 'a', adjust: lift },
      { id: 'b', adjust: desatRed },
      { id: 'out', adjust: {}, inputs: ['a', 'b'], blend: 'multiply' },
    ],
    output: 'out',
  };
  const bakedPar = bakeGradeNodes(parallel, 17);
  // Hand-computed: multiply(lift(1,0,0), desat(1,0,0)) = lift gives (1,0.2,0.2)... desat red -> grey (0.5,0.5,0.5)? red (1,0,0) HSL s=1 -> s=0 -> (0.5,0.5,0.5); multiply: (1*0.5, 0.2*0.5, 0.2*0.5) = (0.5, 0.1, 0.1).
  const o = (0 * 17 * 17 + 0 * 17 + 16) * 3;
  check('nodes: parallel multiply bake matches hand math (+-0.02)',
    close(bakedPar.final.data[o], 0.5, 0.02) && close(bakedPar.final.data[o + 1], 0.1, 0.02),
    `got ${bakedPar.final.data[o].toFixed(3)},${bakedPar.final.data[o + 1].toFixed(3)}`);
  check('nodes: cycle throws', throwsSync(() => validateGradeNodes({
    nodes: [
      { id: 'a', adjust: {}, inputs: ['b'] },
      { id: 'b', adjust: {}, inputs: ['a'] },
    ], output: 'a',
  }, 'c'), /cycle/));
  check('nodes: dangling input throws', throwsSync(() => validateGradeNodes({
    nodes: [{ id: 'a', adjust: {}, inputs: ['ghost'] }], output: 'a',
  }, 'c'), /not found/));
  check('nodes: duplicate id throws', throwsSync(() => validateGradeNodes({
    nodes: [{ id: 'a', adjust: {} }, { id: 'a', adjust: {} }], output: 'a',
  }, 'c'), /duplicate/));
  check('nodes: unknown blend throws', throwsSync(() => validateGradeNodes({
    nodes: [{ id: 'a', adjust: {}, blend: 'vivid' }], output: 'a',
  }, 'c'), /blend/));
  check('nodes: empty graph throws', throwsSync(() => validateGradeNodes({ nodes: [], output: 'a' }, 'c'), /non-empty/));
  check('nodes: missing output throws', throwsSync(() => validateGradeNodes({
    nodes: [{ id: 'a', adjust: {} }], output: 'ghost',
  }, 'c'), /not found/));
  // Full-frame node mask: shape only inside its box (rect centred
  // 0.5,0.5 size 0.4x0.4 on 320x180 -> white x 96..224, y 54..126).
  {
    const png = renderFrameMaskPng({ shape: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, 320, 180);
    writeFileSync(`${DIR}p3g-nodemask.png`, png);
    const r = await run('ffmpeg', ['-i', `${DIR}p3g-nodemask.png`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    const a = (x, y) => r.stdout[(y * 320 + x) * 4 + 3];
    check('nodes: frame mask alpha is 255 inside the box, 0 outside',
      a(160, 90) === 255 && a(100, 90) === 255 && a(10, 10) === 0 && a(250, 90) === 0 && a(160, 150) === 0,
      `centre ${a(160, 90)} corner ${a(10, 10)}`);
  }
  check('nodes: masked node not feeding output throws', throwsSync(() => validateGradeNodes({
    nodes: [
      { id: 'a', adjust: lift, mask: { shape: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.4 } },
      { id: 'b', adjust: {}, inputs: ['input'] },
      { id: 'out', adjust: {}, inputs: ['b'] },
    ], output: 'out',
  }, 'c'), /must feed the graph output/));
  check('nodes: masked node reading a masked node throws', throwsSync(() => validateGradeNodes({
    nodes: [
      { id: 'a', adjust: lift, mask: { shape: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.4 } },
      { id: 'b', adjust: {}, inputs: ['a'], mask: { shape: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.4 } },
      { id: 'out', adjust: {}, inputs: ['b'] },
    ], output: 'out',
  }, 'c'), /cannot read another masked node/));
  // Live: serial nodes on red — frame vs hand math.
  const repNodes = await exportProject(
    mkProject([mkClip('c', `${DIR}p3g-red.mp4`, 4, { gradeNodes: serial })]),
    `${DIR}p3g-nodes.mp4`, { fontfile: FONT, preset: PRESET });
  const nodeMean = await rgbMean(`${DIR}p3g-nodes.mp4`, 1);
  const [er, eg, eb] = (() => {
    const [a, b, c] = applyAdvancedColorToRgb(lift, 1, 0, 0);
    return applyAdvancedColorToRgb(desatRed, a, b, c);
  })();
  check('nodes: serial export frame matches hand math (+-5 per channel)',
    Math.abs(nodeMean[0] - er * 255) <= 5 && Math.abs(nodeMean[1] - eg * 255) <= 5 && Math.abs(nodeMean[2] - eb * 255) <= 5,
    `expected ${(er * 255).toFixed(0)},${(eg * 255).toFixed(0)},${(eb * 255).toFixed(0)} got ${nodeMean.map((v) => v.toFixed(0))}`);
  check('nodes: serial export keeps duration', repNodes.durationError <= 0.05, `err ${repNodes.durationError}`);
  // Live: masked node — centre lifts, corner does not.
  const maskedGraph = {
    nodes: [
      { id: 'lift', adjust: lift, mask: { shape: 'rect', x: 0.5, y: 0.5, w: 0.4, h: 0.4 } },
      { id: 'out', adjust: {}, inputs: ['lift'] },
    ],
    output: 'out',
  };
  const repMasked = await exportProject(
    mkProject([mkClip('c', `${DIR}p3g-red.mp4`, 4, { gradeNodes: maskedGraph })]),
    `${DIR}p3g-nodes-masked.mp4`, { fontfile: FONT, preset: PRESET });
  const centrePx = await pxAt(`${DIR}p3g-nodes-masked.mp4`, 1, 160, 90);
  const cornerPx = await pxAt(`${DIR}p3g-nodes-masked.mp4`, 1, 10, 10);
  check('nodes: masked node lifts the centre (G 0 -> ~51 +-12)',
    centrePx[1] > 35 && centrePx[1] < 65, `centre G ${centrePx[1]}`);
  check('nodes: masked node leaves the corner alone (G <= 8)',
    cornerPx[1] <= 8, `corner ${cornerPx.join(',')}`);
  check('nodes: masked export keeps duration', repMasked.durationError <= 0.05, `err ${repMasked.durationError}`);
  // advancedColor + gradeNodes is refused.
  check('nodes: advancedColor + gradeNodes throws at export',
    await throwsAsync(() => exportProject(
      mkProject([mkClip('c', `${DIR}p3g-red.mp4`, 4, {
        advancedColor: { whiteBalance: { temperature: 0.5 } },
        gradeNodes: serial,
      })]),
      `${DIR}p3g-nodes-mix.mp4`, { fontfile: FONT, preset: PRESET }), /mutually exclusive/));
}

// ---------------------------------------------------------------------------
// 4. Tracked grading window
// ---------------------------------------------------------------------------
{
  // Track the red disc with the P3b mask tracker. The mask video is
  // built in JS from the KNOWN disc motion (white disc, r=30, on
  // black) — no geq quoting games — then encoded with ffmpeg rawvideo.
  {
    const W = 320, H = 180, FPS = 5, nF = 20;
    const buf = Buffer.alloc(W * H * nF);
    for (let f = 0; f < nF; f++) {
      const cx = (0.2 + 0.12 * (f / FPS)) * W;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        buf[f * W * H + y * W + x] = (x - cx) ** 2 + (y - 90) ** 2 < 900 ? 255 : 0;
      }
    }
    writeFileSync(`${DIR}p3g-disc-mask.raw`, buf);
    await run('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray',
      '-s', `${W}x${H}`, '-r', String(FPS), '-i', `${DIR}p3g-disc-mask.raw`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', `${DIR}p3g-disc-mask.mp4`]);
  }
  const track = await trackFromMaskVideo(`${DIR}p3g-disc-mask.mp4`, { sampleFps: 5, width: 320, height: 180 });
  const trueCx = (t) => 0.2 + 0.12 * t;
  const errs = track.points.filter((p) => !p.lost).map((p) => Math.abs(p.x - trueCx(p.t)));
  check('trackwin: mask tracker follows the disc (max err <= 0.02)',
    errs.length > 0 && Math.max(...errs) <= 0.02, `max ${(Math.max(...errs)).toFixed(3)} over ${errs.length} pts`);
  const tw = {
    shape: 'rect', w: 0.3, h: 0.5,
    adjust: { curves: { master: [{ x: 0, y: 0.3 }, { x: 1, y: 1 }] } },
    track,
  };
  const buf = buildTrackedWindowMaskBuffer(tw, 320, 180, 4);
  const f1 = buf.subarray(5 * 320 * 180, 6 * 320 * 180); // t=1.0 frame
  const f3 = buf.subarray(15 * 320 * 180, 16 * 320 * 180); // t=3.0 frame
  const centreAt = (fr, cx) => fr[90 * 320 + Math.round(cx * 320)];
  check('trackwin: mask buffer is white at the disc centre (t=1, t=3)',
    centreAt(f1, trueCx(1)) === 255 && centreAt(f3, trueCx(3)) === 255);
  check('trackwin: mask buffer is black at the far corner',
    f1[10 * 320 + 10] === 0 && f3[10 * 320 + 10] === 0);
  check('trackwin: mask centroid moves with the disc (t=1 vs t=3)',
    (() => {
      const centroid = (fr) => {
        let sx = 0, sw = 0;
        for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) { const w = fr[y * 320 + x]; sx += w * x; sw += w; }
        return sw ? sx / sw / 320 : 0;
      };
      return Math.abs(centroid(f3) - centroid(f1) - 0.24) <= 0.03;
    })());
  check('trackwin: bad shape throws', throwsSync(() =>
    validateTrackedWindow({ shape: 'triangle', w: 0.3, h: 0.3, adjust: {}, track }, 'c'), /shape/));
  check('trackwin: empty track throws', throwsSync(() =>
    validateTrackedWindow({ shape: 'rect', w: 0.3, h: 0.3, adjust: {}, track: { points: [], sampleFps: 5, width: 320, height: 180 } }, 'c'), /no points/));
  // Live: window grade lifts the disc (red: G 0 -> ~76), corner stays.
  const repTw = await exportProject(
    mkProject([mkClip('c', `${DIR}p3g-disc.mp4`, 4, { trackedWindow: tw })]),
    `${DIR}p3g-trackwin.mp4`, { fontfile: FONT, preset: PRESET });
  const discPx1 = await pxAt(`${DIR}p3g-trackwin.mp4`, 1, Math.round(trueCx(1) * 320), 90);
  const discPx3 = await pxAt(`${DIR}p3g-trackwin.mp4`, 3, Math.round(trueCx(3) * 320), 90);
  const cornerPx = await pxAt(`${DIR}p3g-trackwin.mp4`, 1, 10, 10);
  const ctrlPx1 = await pxAt(`${DIR}p3g-disc.mp4`, 1, Math.round(trueCx(1) * 320), 90);
  check('trackwin: window lifts the disc at t=1 (G 0 -> 55..95)',
    discPx1[1] > 55 && discPx1[1] < 95, `G ${discPx1[1]} (ctrl ${ctrlPx1[1]})`);
  check('trackwin: window follows to t=3 (G 55..95)',
    discPx3[1] > 55 && discPx3[1] < 95, `G ${discPx3[1]}`);
  check('trackwin: corner outside the window is unchanged (+-10 G)',
    Math.abs(cornerPx[1] - (await pxAt(`${DIR}p3g-disc.mp4`, 1, 10, 10))[1]) <= 10, `corner G ${cornerPx[1]}`);
  check('trackwin: export keeps duration', repTw.durationError <= 0.05, `err ${repTw.durationError}`);
}

// ---------------------------------------------------------------------------
// 5. LUT library
// ---------------------------------------------------------------------------
{
  const lib0 = [];
  const e1 = { id: 'lift', name: 'Lift', category: 'film', file: `${DIR}lift.cube`, favorite: true, tags: ['bright'] };
  const e2 = { id: 'c0', name: 'C0 grade', category: 'film', file: `${DIR}color-c0.cube` };
  const e3 = { id: 'teal', name: 'Teal Orange', category: 'teal-orange', file: `${DIR}lift.cube` };
  let lib = addLutEntry(lib0, e1);
  lib = addLutEntry(lib, e2);
  lib = addLutEntry(lib, e3);
  check('lutlib: 3 entries added', lib.length === 3);
  check('lutlib: duplicate id throws', throwsSync(() => addLutEntry(lib, e1), /duplicate/));
  check('lutlib: bad .cube throws', throwsSync(() => addLutEntry(lib,
    { id: 'bad', name: 'Bad', category: 'film', file: `${DIR}p2a-bad.cube` }), /LUT/));
  check('lutlib: missing file throws', throwsSync(() => addLutEntry(lib,
    { id: 'gone', name: 'Gone', category: 'film', file: `${DIR}p3g-nope.cube` }), /missing/));
  check('lutlib: category filter hits 2', filterLutLibrary(lib, { category: 'film' }).length === 2);
  check('lutlib: favorite filter hits 1', filterLutLibrary(lib, { favorite: true }).length === 1);
  check('lutlib: search "teal" hits 1', filterLutLibrary(lib, { search: 'teal' }).length === 1);
  check('lutlib: search "bright" (tag) hits 1', filterLutLibrary(lib, { search: 'bright' }).length === 1);
  check('lutlib: categories are film + teal-orange',
    JSON.stringify(lutLibraryCategories(lib)) === JSON.stringify(['film', 'teal-orange']));
  const flipped = toggleLutFavorite(lib, 'c0');
  check('lutlib: toggle favorite flips on', flipped.find((e) => e.id === 'c0').favorite === true);
  check('lutlib: toggle again flips off', toggleLutFavorite(flipped, 'c0').find((e) => e.id === 'c0').favorite === false);
  check('lutlib: toggle unknown id throws', throwsSync(() => toggleLutFavorite(lib, 'ghost'), /no entry/));
  // Thumbnail vs direct lut3d render: same frame, same LUT.
  const thumb = await generateLutThumbnail(`${DIR}lift.cube`, `${DIR}p3g-red.mp4`, `${DIR}p3g-thumb.png`, { width: 160, height: 90 });
  check('lutlib: thumbnail is 160x90', thumb.width === 160 && thumb.height === 90 && existsSync(thumb.file));
  await run('ffmpeg', ['-v', 'error', '-i', `${DIR}p3g-red.mp4`, '-vf', `lut3d='${DIR}lift.cube',scale=160:90`, '-frames:v', '1', '-y', `${DIR}p3g-thumb-direct.png`]);
  const tm = await rgbMean(`${DIR}p3g-thumb.png`, 0);
  const dm = await rgbMean(`${DIR}p3g-thumb-direct.png`, 0);
  check('lutlib: thumbnail matches the direct lut3d frame (+-3 per channel)',
    tm.every((v, i) => Math.abs(v - dm[i]) <= 3),
    `thumb ${tm.map((v) => v.toFixed(0))} direct ${dm.map((v) => v.toFixed(0))}`);
  check('lutlib: thumbnail with a bad LUT throws',
    await throwsAsync(() => generateLutThumbnail(`${DIR}p2a-bad.cube`, `${DIR}p3g-red.mp4`, `${DIR}p3g-thumb-bad.png`), /LUT/));
}

// ---------------------------------------------------------------------------
// 6. Grade compare + reference stills
// ---------------------------------------------------------------------------
{
  const comp = await renderComparisonFrame(`${DIR}p3g-red.mp4`, `${DIR}lift.cube`, `${DIR}p3g-comp-split.png`, { mode: 'split', ss: 1 });
  check('compare: split render returns mode/wipe', comp.mode === 'split' && comp.wipe === 0.5);
  const leftMean = await (async () => {
    const r = await run('ffmpeg', ['-i', `${DIR}p3g-comp-split.png`, '-vf', 'crop=160:180:0:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const b = r.stdout; let R = 0, G = 0, B = 0; const n = b.length / 3;
    for (let i = 0; i < b.length; i += 3) { R += b[i]; G += b[i + 1]; B += b[i + 2]; }
    return [R / n, G / n, B / n];
  })();
  const rightMean = await (async () => {
    const r = await run('ffmpeg', ['-i', `${DIR}p3g-comp-split.png`, '-vf', 'crop=160:180:160:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const b = r.stdout; let R = 0, G = 0, B = 0; const n = b.length / 3;
    for (let i = 0; i < b.length; i += 3) { R += b[i]; G += b[i + 1]; B += b[i + 2]; }
    return [R / n, G / n, B / n];
  })();
  const origMean = await rgbMean(`${DIR}p3g-red.mp4`, 1);
  await run('ffmpeg', ['-v', 'error', '-i', `${DIR}p3g-red.mp4`, '-vf', `lut3d='${DIR}lift.cube'`, '-frames:v', '1', '-y', `${DIR}p3g-graded.png`]);
  const gradedMean = await rgbMean(`${DIR}p3g-graded.png`, 0);
  check('compare: split left half is the original (+-3)',
    leftMean.every((v, i) => Math.abs(v - origMean[i]) <= 3),
    `left ${leftMean.map((v) => v.toFixed(0))} orig ${origMean.map((v) => v.toFixed(0))}`);
  check('compare: split right half is the graded frame (+-3)',
    rightMean.every((v, i) => Math.abs(v - gradedMean[i]) <= 3),
    `right ${rightMean.map((v) => v.toFixed(0))} graded ${gradedMean.map((v) => v.toFixed(0))}`);
  const compWipe = await renderComparisonFrame(`${DIR}p3g-red.mp4`, `${DIR}lift.cube`, `${DIR}p3g-comp-wipe.png`, { mode: 'wipe', wipe: 0.25, ss: 1 });
  check('compare: wipe 0.25 recorded', compWipe.wipe === 0.25);
  const wipePxL = await (async () => {
    const r = await run('ffmpeg', ['-i', `${DIR}p3g-comp-wipe.png`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const o = (90 * 320 + 20) * 3;
    return [r.stdout[o], r.stdout[o + 1], r.stdout[o + 2]];
  })();
  const wipePxR = await (async () => {
    const r = await run('ffmpeg', ['-i', `${DIR}p3g-comp-wipe.png`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const o = (90 * 320 + 300) * 3;
    return [r.stdout[o], r.stdout[o + 1], r.stdout[o + 2]];
  })();
  check('compare: wipe left of the boundary is original (G <= 8)',
    wipePxL[1] <= 8, `left G ${wipePxL[1]}`);
  // lift.cube maps 0 -> 0.1, so the graded red is G ~25 (not 51 —
  // 51 belongs to the node-graph lift in §3, a different LUT).
  check('compare: wipe right of the boundary is graded (G ~25 +-12)',
    wipePxR[1] > 13 && wipePxR[1] < 37, `right G ${wipePxR[1]}`);
  check('compare: bad wipe throws',
    await throwsAsync(() => renderComparisonFrame(`${DIR}p3g-red.mp4`, null, `${DIR}p3g-comp-bad.png`, { wipe: 1.5 }), /wipe/));
  check('compare: bad mode throws',
    await throwsAsync(() => renderComparisonFrame(`${DIR}p3g-red.mp4`, null, `${DIR}p3g-comp-bad.png`, { mode: 'circle' }), /unknown mode/));
  check('compare: missing source throws',
    await throwsAsync(() => renderComparisonFrame(`${DIR}p3g-nope.mp4`, null, `${DIR}p3g-comp-bad.png`), /missing/));
  // Reference stills.
  const still = await saveReferenceStill(`${DIR}p3g-red.mp4`, 1, `${DIR}p3g-still.png`, { label: 'red grade ref', note: 'before lift' });
  check('stills: saved still is 320x180', still.width === 320 && still.height === 180 && still.time === 1);
  const loaded = await loadReferenceStill(`${DIR}p3g-still.png`);
  check('stills: load round-trips label + source',
    loaded.label === 'red grade ref' && loaded.source === `${DIR}p3g-red.mp4`);
  check('stills: list finds the still', listReferenceStills(DIR).includes(`${DIR}p3g-still.png`));
  const sidecar = JSON.parse(readFileSync(`${DIR}p3g-still.png.json`, 'utf8'));
  sidecar.width = 999;
  writeFileSync(`${DIR}p3g-still.png.json`, JSON.stringify(sidecar));
  check('stills: tampered sidecar dims throw on load',
    await throwsAsync(() => loadReferenceStill(`${DIR}p3g-still.png`), /does not match|sidecar says/));
  sidecar.width = 320;
  writeFileSync(`${DIR}p3g-still.png.json`, JSON.stringify(sidecar));
  check('stills: missing PNG throws',
    await throwsAsync(() => loadReferenceStill(`${DIR}p3g-still-gone.png`), /missing/));
}

// ---------------------------------------------------------------------------
// §7. Object tracking (M4 line 186)
// ---------------------------------------------------------------------------
{
  // Colour-centroid track of the red disc (probe-p3g2/p3g3: maxErr 0.0085).
  const colTrack = await trackObjectByColor(`${DIR}p3g-disc.mp4`, [255, 0, 0],
    { tolerance: 60, sampleFps: 5, width: 320, height: 180 });
  const trueCx = (t) => 0.2 + 0.12 * t;
  const colErrs = colTrack.points.map((p) => Math.abs(p.x - trueCx(p.t)));
  check('objtrack: colour centroid follows the disc (max err <= 0.02, 0 lost)',
    colTrack.points.length === 20 && colTrack.points.every((p) => !p.lost) && Math.max(...colErrs) <= 0.02,
    `max ${Math.max(...colErrs).toFixed(4)}, lost ${colTrack.points.filter((p) => p.lost).length}`);
  check('objtrack: colour track y stays at the disc height (0.5 +- 0.02)',
    colTrack.points.every((p) => Math.abs(p.y - 0.5) <= 0.02));
  // Template track on the TEXTURED square (probe-p3g3: maxErr 0.0043,
  // min NCC 0.970). Box taken from the measured first-frame position.
  const tplSq = await trackObjectByTemplate(`${DIR}p3g-square.mp4`,
    { x: 0.2 - 0.0625, y: 0.5 - 0.111, w: 0.125, h: 0.222 }, { sampleFps: 5 });
  const tplErrs = tplSq.track.points.map((p) => Math.abs(p.x - trueCx(p.t)));
  check('objtrack: template follows the textured square (max err <= 0.02, min NCC >= 0.8)',
    tplSq.track.points.length === 20 && tplSq.track.points.every((p) => !p.lost)
    && Math.max(...tplErrs) <= 0.02 && Math.min(...tplSq.scores) >= 0.8,
    `max ${Math.max(...tplErrs).toFixed(4)}, minNCC ${Math.min(...tplSq.scores).toFixed(3)}`);
  // The uniform red disc is a bad template target: the tracker must
  // report the loss honestly (lost flags), not follow blindly.
  const tplDisc = await trackObjectByTemplate(`${DIR}p3g-disc.mp4`,
    { x: colTrack.points[0].x - 0.05, y: 0.4, w: 0.1, h: 0.2 }, { sampleFps: 5 });
  const lostDisc = tplDisc.track.points.filter((p) => p.lost).length;
  check('objtrack: template on the uniform disc reports loss instead of faking it (>= 50% lost)',
    lostDisc >= 10 && Math.min(...tplDisc.scores) < 0.5,
    `lost ${lostDisc}/20, minNCC ${Math.min(...tplDisc.scores).toFixed(3)}`);
  // Validation.
  check('objtrack: box out of frame throws', throwsSync(() =>
    validateObjectTrack({ method: 'template', box: { x: 0.9, y: 0, w: 0.2, h: 0.2 }, stickerText: 'X' }, 'c'), /out of frame/));
  check('objtrack: bad method throws', throwsSync(() =>
    validateObjectTrack({ method: 'optical', stickerText: 'X' }, 'c'), /must be 'color' or 'template'/));
  check('objtrack: neither sticker nor mosaic throws', throwsSync(() =>
    validateObjectTrack({ method: 'color', color: [255, 0, 0] }, 'c'), /needs a stickerText or a mosaicSize/));
  check('objtrack: bad colour throws', throwsSync(() =>
    validateObjectTrack({ method: 'color', color: [300, 0, 0], stickerText: 'X' }, 'c'), /must be \[r, g, b\]/));
  // Lost target: all-black video has no red pixels — prepare refuses.
  check('objtrack: all-black target throws (lost, not followed)',
    await throwsAsync(() => prepareObjectTracks(
      mkProject([mkClip('c', `${DIR}p3g-black.mp4`, 4, { objectTrack: { method: 'color', color: [255, 0, 0], stickerText: 'X' } })]),
      DIR), /lost/));
  const blackTrack = await trackObjectByColor(`${DIR}p3g-black.mp4`, [255, 0, 0], { sampleFps: 5, width: 320, height: 180 });
  check('objtrack: absent colour target parks every frame as lost',
    blackTrack.points.length > 0 && blackTrack.points.every((p) => p.lost));
  // Live: mosaic follows the disc (ring stddev collapses, probe-p3g3: 0.087).
  const mosProj = mkProject([mkClip('c', `${DIR}p3g-disc.mp4`, 4, {
    objectTrack: { method: 'color', color: [255, 0, 0], mosaicSize: 0.25 },
  })]);
  const ctlProj = mkProject([mkClip('c', `${DIR}p3g-disc.mp4`, 4)]);
  await exportProject(mosProj, `${DIR}p3g-obj-mos.mp4`, { fontfile: FONT, preset: PRESET });
  await exportProject(ctlProj, `${DIR}p3g-obj-ctl.mp4`, { fontfile: FONT, preset: PRESET });
  for (const t of [1, 3]) {
    const cx = trueCx(t) * 320;
    const m = ringStddev(await grayFrame(`${DIR}p3g-obj-mos.mp4`, t), cx, 90, 32, 38);
    const c = ringStddev(await grayFrame(`${DIR}p3g-obj-ctl.mp4`, t), cx, 90, 32, 38);
    check(`objtrack: mosaic follows the disc at t=${t} (ring stddev ratio < 0.3)`,
      m < c * 0.3, `mosaic ${m.toFixed(1)} vs control ${c.toFixed(1)}`);
  }
  // Live: sticker text follows the disc (white X on a red disc: G>200
  // pixels only exist where the text is; probe-p3g3: 229 at t=1, 218 at t=3).
  const stkProj = mkProject([mkClip('c', `${DIR}p3g-disc.mp4`, 4, {
    objectTrack: { method: 'color', color: [255, 0, 0], stickerText: 'X' },
  })]);
  await exportProject(stkProj, `${DIR}p3g-obj-stk.mp4`, { fontfile: FONT, preset: PRESET });
  for (const t of [1, 3]) {
    const fr = await (async () => {
      const r = await run('ffmpeg', ['-ss', String(t), '-i', `${DIR}p3g-obj-stk.mp4`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      return r.stdout;
    })();
    const cx = Math.round(trueCx(t) * 320);
    let n = 0;
    for (let y = 60; y < 120; y++) for (let x = cx - 30; x < cx + 30; x++) {
      if (fr[(y * 320 + x) * 3 + 1] > 200) n++;
    }
    check(`objtrack: sticker follows the disc at t=${t} (> 50 bright px near centre)`, n > 50, `${n} px`);
  }
  // Graph string: sticker drawtext is wired.
  const gStk = buildFilterGraph(stkProj, FONT, ...Array(15).fill(undefined),
    { objectTracks: new Map([[0, colTrack]]) });
  check('objtrack: graph carries the sticker drawtext', gStk.filterComplex.includes('drawtext='));
  // Speed != 1 + objectTrack refuses at export.
  check('objtrack: speed != 1 throws at export',
    await throwsAsync(() => exportProject(
      mkProject([mkClip('c', `${DIR}p3g-disc.mp4`, 4, { speed: 2, objectTrack: { method: 'color', color: [255, 0, 0], stickerText: 'X' } })]),
      `${DIR}p3g-obj-bad.mp4`, { fontfile: FONT, preset: PRESET }), /speed 1/));
}

// ---------------------------------------------------------------------------
// §8. Clone (M4 line 187)
// ---------------------------------------------------------------------------
{
  const src = `${DIR}p3g-src.mp4`;
  const clip = (extra) => mkClip('c', src, 4, extra);
  check('clone: lanes 3 throws', throwsSync(() =>
    validateCloneEffect({ lanes: 3, offsets: [0, 1, 2] }, clip({})), /must be 2 or 4/));
  check('clone: offsets length mismatch throws', throwsSync(() =>
    validateCloneEffect({ lanes: 2, offsets: [0] }, clip({})), /exactly 2 entries/));
  check('clone: offsets[0] != 0 throws', throwsSync(() =>
    validateCloneEffect({ lanes: 2, offsets: [1, 2] }, clip({})), /offsets\[0\] must be 0/));
  check('clone: non-increasing offsets throw', throwsSync(() =>
    validateCloneEffect({ lanes: 2, offsets: [0, 0] }, clip({})), /strictly increasing/));
  check('clone: clone + reverse throws', throwsSync(() =>
    validateCloneEffect({ lanes: 2, offsets: [0, 2] }, { ...clip({}), reverse: true }), /no reverse/));
  check('clone: 2-lane size is 160x180', (() => {
    const s = cloneLaneSize({ lanes: 2, offsets: [0, 2] }, 320, 180);
    return s.laneW === 160 && s.laneH === 180;
  })());
  check('clone: 4-lane size is 160x90', (() => {
    const s = cloneLaneSize({ lanes: 4, offsets: [0, 1, 2, 3] }, 320, 180);
    return s.laneW === 160 && s.laneH === 90;
  })());
  // Live: left half = source @ t=1, right half = source @ t=3 (probe-p3g3:
  // mean err 0.5 / 0.3; pixel MAD halves 22.5). Compare against the
  // source frames downscaled to the 160-wide lane size.
  const scaledFrame = async (file, ss) => {
    const r = await run('ffmpeg', ['-ss', String(ss), '-i', file, '-vf', 'scale=160:180', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return r.stdout;
  };
  const mad = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  };
  await exportProject(
    mkProject([clip({ clone: { lanes: 2, offsets: [0, 2] } })]),
    `${DIR}p3g-clone.mp4`, { fontfile: FONT, preset: PRESET });
  const out1 = await (async () => {
    const r = await run('ffmpeg', ['-ss', '1', '-i', `${DIR}p3g-clone.mp4`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return r.stdout;
  })();
  const left = Buffer.alloc(160 * 180 * 3);
  const right = Buffer.alloc(160 * 180 * 3);
  for (let y = 0; y < 180; y++) for (let x = 0; x < 160; x++) {
    for (let c = 0; c < 3; c++) {
      left[(y * 160 + x) * 3 + c] = out1[(y * 320 + x) * 3 + c];
      right[(y * 160 + x) * 3 + c] = out1[(y * 320 + x + 160) * 3 + c];
    }
  }
  const s1 = await scaledFrame(src, 1);
  const s3 = await scaledFrame(src, 3);
  check('clone: left half matches source @ t=1 (pixel MAD <= 6)', mad(left, s1) <= 6, `MAD ${mad(left, s1).toFixed(2)}`);
  check('clone: right half matches source @ t=3 (pixel MAD <= 6)', mad(right, s3) <= 6, `MAD ${mad(right, s3).toFixed(2)}`);
  check('clone: halves differ (pixel MAD > 10)', mad(left, right) > 10, `MAD ${mad(left, right).toFixed(2)}`);
  check('clone: offset beyond the source throws',
    await throwsAsync(() => prepareClone(
      mkProject([clip({ clone: { lanes: 2, offsets: [0, 5] } })])), /only 8/));
}

// ---------------------------------------------------------------------------
// §9. Key outline (M4 line 188)
// ---------------------------------------------------------------------------
{
  check('outline: parse #ff0000', JSON.stringify(parseOutlineColor('#ff0000')) === '[255,0,0]');
  check('outline: parse named red', JSON.stringify(parseOutlineColor('red')) === '[255,0,0]');
  check('outline: bad colour throws', throwsSync(() => parseOutlineColor('notacolor'), /unknown outline color/));
  check('outline: width 0 throws', throwsSync(() =>
    validateKeyOutline({ color: 'red', width: 0 }, 'c'), /must be an integer in \[1, 10\]/));
  check('outline: width 11 throws', throwsSync(() =>
    validateKeyOutline({ color: 'red', width: 11 }, 'c'), /must be an integer in \[1, 10\]/));
  check('outline: dilation chain has one pass per px', outlineDilationFilter(3).split('dilation').length - 1 === 3);
  // Live on p1e-person.mp4 (640x360, 4 s). Loose-red counts grow with
  // width (probe-p3g4: w1 8353 / w3 12018 / w5 14547); a 1 px ring
  // does not survive 4:2:0 as strict red (w1 strict 0) but is visible
  // loosely. Portrait needs the venv python (onnxruntime).
  const PY = `${DIR}../.venv/bin/python`;
  const rgbFrameWH = async (file, ss) => {
    const r = await run('ffmpeg', ['-ss', String(ss), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return r.stdout;
  };
  const countRed = (fr, W, H, rMin, gMax) => {
    let n = 0;
    for (let i = 0; i < W * H; i++) {
      if (fr[i * 3] > rMin && fr[i * 3 + 1] < gMax && fr[i * 3 + 2] < gMax) n++;
    }
    return n;
  };
  const outProj = (w) => ({
    version: 1, width: 640, height: 360, fps: 30,
    clips: [{ id: 'c', source: `${DIR}p1e-person.mp4`, in: 0, out: 4, speed: 1, volume: 1,
      portraitCutout: true, ...(w ? { outline: { color: '#ff0000', width: w } } : {}) }],
    transitions: [], transitionDuration: 0.5,
  });
  const counts = {};
  for (const w of [1, 3, 5]) {
    await exportProject(outProj(w), `${DIR}p3g-out-w${w}.mp4`, { fontfile: FONT, preset: { ...PRESETS['720p30'], width: 640, height: 360, fps: 30 }, python: PY });
    const fr = await rgbFrameWH(`${DIR}p3g-out-w${w}.mp4`, 1);
    counts[w] = { loose: countRed(fr, 640, 360, 150, 120), strict: countRed(fr, 640, 360, 200, 80) };
  }
  await exportProject(outProj(0), `${DIR}p3g-out-w0.mp4`, { fontfile: FONT, preset: { ...PRESETS['720p30'], width: 640, height: 360, fps: 30 }, python: PY });
  const f3 = await rgbFrameWH(`${DIR}p3g-out-w3.mp4`, 1);
  const f0 = await rgbFrameWH(`${DIR}p3g-out-w0.mp4`, 1);
  check('outline: red pixels grow with width (w3 > w1 x 1.2, w5 > w3)',
    counts[3].loose > counts[1].loose * 1.2 && counts[5].loose > counts[3].loose,
    `w1 ${counts[1].loose} w3 ${counts[3].loose} w5 ${counts[5].loose}`);
  check('outline: 3 px ring is solid red (strict > 1000, 1 px ring is not)',
    counts[3].strict > 1000 && counts[1].strict < 100,
    `w1 strict ${counts[1].strict} w3 strict ${counts[3].strict}`);
  // Interior unchanged: 40x40 box at the centre of the w3 red bbox.
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
  for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) {
    const o = (y * 640 + x) * 3;
    if (f3[o] > 150 && f3[o + 1] < 120 && f3[o + 2] < 120) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  const cx = Math.round((minX + maxX) / 2);
  const cy = Math.round((minY + maxY) / 2);
  const boxMean = (fr, half) => {
    let R = 0, G = 0, B = 0, n = 0;
    for (let y = cy - half; y < cy + half; y++) for (let x = cx - half; x < cx + half; x++) {
      const o = (y * 640 + x) * 3; R += fr[o]; G += fr[o + 1]; B += fr[o + 2]; n++;
    }
    return [R / n, G / n, B / n];
  };
  const m3 = boxMean(f3, 20);
  const m0 = boxMean(f0, 20);
  check('outline: interior 40x40 mean unchanged vs no-outline (+- 5)',
    m3.every((v, i) => Math.abs(v - m0[i]) <= 5),
    `w3 ${m3.map((v) => v.toFixed(1))} w0 ${m0.map((v) => v.toFixed(1))}`);
  check('outline: without portraitCutout throws at export',
    await throwsAsync(() => exportProject(
      mkProject([mkClip('c', `${DIR}p3g-grey.mp4`, 4, { outline: { color: 'red', width: 3 } })]),
      `${DIR}p3g-out-bad.mp4`, { fontfile: FONT, preset: PRESET }), /needs portraitCutout/));
}

// ---------------------------------------------------------------------------
// §10. Auto-video (M4 line 185)
// ---------------------------------------------------------------------------
{
  check('autovideo: empty lines throw', throwsSync(() =>
    validateAutoVideo({ lines: [] }), /non-empty array/));
  check('autovideo: empty text throws', throwsSync(() =>
    validateAutoVideo({ lines: [{ text: '  ' }] }), /text must be non-empty/));
  check('autovideo: missing image throws', throwsSync(() =>
    validateAutoVideo({ lines: [{ text: 'x', image: `${DIR}p3g-nope.png` }] }), /image missing/));
  check('autovideo: bad template throws', throwsSync(() =>
    validateAutoVideo({ lines: [{ text: 'x' }], templateId: 'nope' }), /unknown template/));
  const t0 = Date.now();
  const { project, segments } = await buildAutoVideoProject(
    {
      lines: [
        { text: '做短视频，第一步不是拍，而是想清楚你要说什么。', image: `${DIR}p3g-img-a.png` },
        { text: '然后把这句话拆成画面，一句配一张图，节奏就稳了。', image: `${DIR}p3g-img-b.png` },
        { text: '最后卡着音乐的节拍剪，成片听起来就像会呼吸一样。', image: `${DIR}p3g-img-c.png` },
      ],
      music: `${DIR}p1c-click-120.wav`,
      templateId: 'talking-clean',
    },
    { width: 320, height: 180, fps: 30 },
    { outDir: `${DIR}p3g-autovideo`, python: PYTHON },
  );
  console.log(`[p3g] auto-video build took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  check('autovideo: 3 segments built', segments.length === 3);
  check('autovideo: each segment holds its narration (tts <= dur <= tts + 0.35)',
    segments.every((s) => s.duration >= s.ttsDuration - 0.01 && s.duration <= s.ttsDuration + 0.35),
    segments.map((s) => `${s.ttsDuration.toFixed(2)}->${s.duration.toFixed(2)}`).join(', '));
  check('autovideo: snapped boundaries sit on a beat (<= 0.05 off) when a beat is recorded',
    segments.every((s) => s.beat === undefined || Math.abs((s.start + s.duration) - s.beat) <= 0.05),
    segments.map((s) => (s.beat === undefined ? '-' : s.beat.toFixed(3))).join(', '));
  check('autovideo: segment starts chain (start = sum of previous durations)',
    segments.every((s, i) => Math.abs(s.start - segments.slice(0, i).reduce((a, o) => a + o.duration, 0)) <= 0.01));
  const total = segments.reduce((a, s) => a + s.duration, 0);
  check('autovideo: at least one boundary snapped to the beat grid',
    segments.some((s) => s.beat !== undefined), `beats: ${segments.map((s) => s.beat ?? '-').join(',')}`);
  const repAv = await exportProject(project, `${DIR}p3g-autovideo.mp4`, { fontfile: FONT, preset: PRESET });
  check('autovideo: export total = sum of segments (err <= 0.1)',
    repAv.durationError <= 0.1, `err ${repAv.durationError.toFixed(3)}, total ${total.toFixed(2)}`);
  const rms0 = await rmsWindow(`${DIR}p3g-autovideo.mp4`, 0.2, 1);
  check('autovideo: narration audible in segment 1 (RMS > -50 dB)', rms0 > -50, `${rms0.toFixed(1)} dB`);
}

// ---------------------------------------------------------------------------
// §11. AI upscaling (M4 line 184)
// ---------------------------------------------------------------------------
{
  check('upscale: unknown model throws', throwsSync(() =>
    validateUpscale({ targetWidth: 640, targetHeight: 360, model: 'nope' }, 160, 90), /unknown model/));
  check('upscale: target <= source throws', throwsSync(() =>
    validateUpscale({ targetWidth: 160, targetHeight: 90 }, 160, 90), /must exceed the source/));
  check('upscale: odd target throws', throwsSync(() =>
    validateUpscale({ targetWidth: 641, targetHeight: 360 }, 160, 90), /positive even integer/));
  // The honest-failure path works even when the model IS present, by
  // pointing at a model path that does not exist.
  check('upscale: missing model throws "model not available" (no fake upscale)',
    await throwsAsync(() => upscaleVideo(`${DIR}p3g-low.mp4`, `${DIR}p3g-up-missing.mp4`,
      { targetWidth: 640, targetHeight: 360, modelPath: `${DIR}p3g-no-model.onnx`, python: PYTHON }), /model not available/));
  check('upscale: export with a missing model throws instead of shipping un-upscaled',
    await throwsAsync(() => exportProject(
      mkProject([mkClip('c', `${DIR}p3g-grey.mp4`, 1)], {
        upscale: { targetWidth: 640, targetHeight: 360, modelPath: `${DIR}p3g-no-model.onnx` },
      }),
      `${DIR}p3g-up-export-missing.mp4`, { fontfile: FONT, preset: PRESET }), /model not available/));
  const modelPath = defaultUpscaleModelPath(ENGINE);
  if (!existsSync(modelPath)) {
    console.log('[p3g] Real-ESRGAN ONNX model absent — live upscale checks skipped (interface verified above).');
    check('upscale: model absent is reported (interface-only mode)', true, 'model not available, interface ready');
  } else {
    // Live: testsrc2 160x90 @ 10 fps -> 640x360.
    const u0 = Date.now();
    const up = await upscaleVideo(`${DIR}p3g-low.mp4`, `${DIR}p3g-up.mp4`,
      { targetWidth: 640, targetHeight: 360, python: PYTHON });
    console.log(`[p3g] upscale 10 frames took ${((Date.now() - u0) / 1000).toFixed(1)}s`);
    check('upscale: live output is 640x360, 10 frames, duration +- 0.05',
      up.width === 640 && up.height === 360 && up.frames === 10 && Math.abs(up.duration - 1) <= 0.05,
      `${up.width}x${up.height} ${up.frames}f ${up.duration.toFixed(2)}s`);
    // Edge sharpness vs the lanczos control, on the person frame:
    // ESRGAN transition width is ~5x tighter than lanczos and close
    // to ground truth (probe-p3g6: ESRGAN 1.40 / lanczos 6.80 / GT 2.00).
    // (Plain HF and PSNR do NOT favour ESRGAN on clean downscales —
    // the model hallucinates plausible detail — so the assertion is
    // edge width, the quantity the task asks for.)
    const uPerson = await upscaleVideo(`${DIR}p3g-person-low.mp4`, `${DIR}p3g-up-person.mp4`,
      { targetWidth: 640, targetHeight: 360, python: PYTHON });
    check('upscale: person output is 640x360', uPerson.width === 640 && uPerson.height === 360);
    await run('ffmpeg', ['-v', 'error', '-i', `${DIR}p3g-person-low.mp4`,
      '-vf', 'scale=640:360:flags=lanczos', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an',
      '-y', `${DIR}p3g-up-person-lanczos.mp4`]);
    const grayPng = async (f) => {
      const r = await run('ffmpeg', ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
      return r.stdout;
    };
    const W = 640, H = 360;
    const gt = await grayPng(`${DIR}p3g-person-gt.png`);
    const es = await grayPng(`${DIR}p3g-up-person.mp4`);
    const lz = await grayPng(`${DIR}p3g-up-person-lanczos.mp4`);
    const edgeWidth = (fr, x, y) => {
      const lo = fr[y * W + x - 15];
      const hi = fr[y * W + x + 15];
      const a = Math.min(lo, hi), b = Math.max(lo, hi);
      if (b - a < 40) return null;
      const t10 = a + 0.1 * (b - a), t90 = a + 0.9 * (b - a);
      let x10 = -1, x90 = -1;
      const rising = hi > lo;
      for (let xx = x - 15; xx <= x + 15; xx++) {
        const v = fr[y * W + xx];
        if (rising) {
          if (x10 < 0 && v >= t10) x10 = xx;
          if (x90 < 0 && v >= t90) x90 = xx;
        } else {
          if (x10 < 0 && v <= t10) x10 = xx;
          if (x90 < 0 && v <= t90) x90 = xx;
        }
      }
      return x10 >= 0 && x90 >= 0 ? Math.abs(x90 - x10) : null;
    };
    const rows = [];
    for (let y = 20; y < H - 20; y++) {
      let bg = 0, bx = 0;
      for (let x = 20; x < W - 21; x++) {
        const g = Math.abs(gt[y * W + x + 1] - gt[y * W + x - 1]);
        if (g > bg) { bg = g; bx = x; }
      }
      if (bg > 60) rows.push({ y, x: bx, g: bg });
    }
    rows.sort((a, b) => b.g - a.g);
    const top = rows.filter((r, i) => rows.findIndex((o) => Math.abs(o.y - r.y) < 5) === i).slice(0, 5);
    const meanWidth = (fr) => {
      const ws = top.map((e) => edgeWidth(fr, e.x, e.y)).filter((v) => v !== null);
      return ws.reduce((a, b) => a + b, 0) / ws.length;
    };
    const wGt = meanWidth(gt);
    const wEs = meanWidth(es);
    const wLz = meanWidth(lz);
    check('upscale: ESRGAN edges much tighter than lanczos (mean width <= 0.5x)',
      wEs <= wLz * 0.5, `ESRGAN ${wEs.toFixed(2)} vs lanczos ${wLz.toFixed(2)} (GT ${wGt.toFixed(2)})`);
    check('upscale: ESRGAN edge width stays near ground truth (+- 1.5 px)',
      Math.abs(wEs - wGt) <= 1.5, `ESRGAN ${wEs.toFixed(2)} vs GT ${wGt.toFixed(2)}`);
  }
}

// ---------------------------------------------------------------------------
// §12. Combined (kitchen sink)
// ---------------------------------------------------------------------------
{
  // slog3 input + serial node graph in one export: the node lift must
  // move the frame mean away from the slog3-only export (§1).
  const liftGraph = {
    nodes: [
      { id: 'lift', adjust: { curves: { master: [{ x: 0, y: 0.2 }, { x: 1, y: 1 }] } } },
      { id: 'out', inputs: ['lift'], adjust: {} },
    ],
    output: 'out',
  };
  const repCombo = await exportProject(
    mkProject([mkClip('c', `${DIR}p3g-grey-slog3.mp4`, 4, {
      colorManagement: { inputSpace: 'slog3' }, gradeNodes: liftGraph,
    })]),
    `${DIR}p3g-combo.mp4`, { fontfile: FONT, preset: PRESET });
  const comboMean = await rgbMean(`${DIR}p3g-combo.mp4`, 1);
  const slogOnlyMean = await rgbMean(`${DIR}p3g-cm-slog3.mp4`, 1);
  check('combo: slog3 + node graph exports and the lift moves the mean (> 5)',
    repCombo.durationError <= 0.05 && comboMean.some((v, i) => Math.abs(v - slogOnlyMean[i]) > 5),
    `slog3-only ${slogOnlyMean.map((v) => v.toFixed(0))} combo ${comboMean.map((v) => v.toFixed(0))}`);
  // Graph-only kitchen sink: log100 input (zscale) + node LUT (lut3d) +
  // tracked window (maskedmerge) on clip 0; clone (hstack) + object
  // mosaic (maskedmerge) + sticker (drawtext) + outline (dilation) on
  // clip 1. Fake file paths are fine — this checks graph wiring only.
  const colTrack0 = await trackObjectByColor(`${DIR}p3g-disc.mp4`, [255, 0, 0],
    { tolerance: 60, sampleFps: 5, width: 320, height: 180 });
  const track0 = await trackFromMaskVideo(`${DIR}p3g-disc-mask.mp4`, { sampleFps: 5, width: 320, height: 180 });
  const tw0 = {
    shape: 'rect', w: 0.3, h: 0.5,
    adjust: { curves: { master: [{ x: 0, y: 0.3 }, { x: 1, y: 1 }] } },
    track: track0,
  };
  const gSink = buildFilterGraph(
    mkProject([
      mkClip('c0', `${DIR}p3g-grey-log100.mp4`, 4, {
        colorManagement: { inputSpace: 'log100' }, gradeNodes: liftGraph, trackedWindow: tw0,
      }),
      mkClip('c1', `${DIR}p3g-disc.mp4`, 4, {
        clone: { lanes: 2, offsets: [0, 2] },
        objectTrack: { method: 'color', color: [255, 0, 0], stickerText: 'X', mosaicSize: 0.25 },
        portraitCutout: true,
        outline: { color: '#ff0000', width: 3 },
      }),
    ]),
    FONT, undefined, undefined, undefined, undefined,
    new Map([[1, `${DIR}p3g-disc-mask.mp4`]]),
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined,
    {
      extraLuts: new Map([[0, [`${DIR}lift.cube`]]]),
      trackedWindows: new Map([[0, { lut: `${DIR}lift.cube`, mask: `${DIR}p3g-disc-mask.mp4` }]]),
      objectTracks: new Map([[1, colTrack0]]),
      objectTrackMasks: new Map([[1, `${DIR}p3g-disc-mask.mp4`]]),
    },
  );
  for (const needle of ['zscale', 'lut3d', 'maskedmerge', 'dilation', 'hstack', 'drawtext']) {
    check(`combo: kitchen-sink graph contains ${needle}`, gSink.filterComplex.includes(needle));
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} passed`);
for (const [name, ok] of checks) if (!ok) console.log(`FAIL: ${name}`);
if (passed !== checks.length) process.exit(1);
