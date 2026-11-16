// P0 engine verification (M4, 2026-11-17).
// Covers: 8 xfade transitions, speed curve, opacity+rotation keyframes,
// text box/border/shadow, denoise+loudnorm, colour adjust + LUT,
// 9:16 export preset. Old M1 checks live in verify.mjs and must still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { exportProject, probe, PRESETS, TEXT_PRESETS, COLOR_PRESETS } from '../dist/export.js';
import { buildFilterGraph } from '../dist/filtergraph.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const SRC = `${DIR}source.mp4`;
const VSRC = `${DIR}source-9x16.mp4`;
const LUT = `${DIR}lift.cube`;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

const checks = [];
const check = (name, ok, detail = '') =>
  checks.push([`${name}${detail ? ` (${detail})` : ''}`, ok]);

async function yavg(file, ss, crop = '') {
  const vf = crop
    ? `crop=${crop},signalstats,metadata=print:key=lavfi.signalstats.YAVG`
    : 'signalstats,metadata=print:key=lavfi.signalstats.YAVG';
  const r = await exec('ffmpeg', ['-ss', String(ss), '-i', file, '-vf', vf, '-frames:v', '1', '-f', 'null', '-']);
  return Number(((r.stderr ?? '').match(/lavfi\.signalstats\.YAVG=([\d.]+)/) || [])[1]);
}

async function hasBlackSegments(file) {
  const bd = await exec('ffmpeg', ['-i', file, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-']).catch((e) => e);
  return /black_start/.test((bd.stderr ?? '') + (bd.stdout ?? ''));
}

async function loudnessI(file) {
  const r = await exec('ffmpeg', ['-i', file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-']).catch((e) => e);
  const m = ((r.stderr ?? '') + (r.stdout ?? '')).match(/"input_i"\s*:\s*"(-?[\d.]+)"/);
  return m ? Number(m[1]) : NaN;
}

// --- sources ---
await exec('ffmpeg', [
  '-f', 'lavfi', '-i', 'testsrc2=duration=10:size=1280x720:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', SRC,
]);
await exec('ffmpeg', [
  '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=1080x1920:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', VSRC,
]);
// Lift LUT: out = in*0.9 + 0.1 (raises blacks, verifiable via YAVG).
writeFileSync(LUT, `TITLE "P0 lift test"
LUT_3D_SIZE 2
DOMAIN_MIN 0.0 0.0 0.0
DOMAIN_MAX 1.0 1.0 1.0
0.1 0.1 0.1
1.0 0.1 0.1
0.1 1.0 0.1
1.0 1.0 0.1
0.1 0.1 1.0
1.0 0.1 1.0
0.1 1.0 1.0
1.0 1.0 1.0
`);

const base720 = { version: 1, width: 1280, height: 720, fps: 30, transitionDuration: 0.5 };
const clip2 = (id, a, b) => ({ id, source: SRC, in: a, out: b, speed: 1, volume: 1 });

// --- 0. graph-string checks (no encode) ---
const gProj = {
  ...base720,
  clips: [{ ...clip2('c1', 0, 2), opacity: [{ t: 0, value: 1 }], rotation: [{ t: 0, value: 0 }],
    denoise: true, loudnorm: true, text: [{ ...TEXT_PRESETS.lowerThird, text: 'X', start: 0, end: 2, borderw: 3 }] }],
  transitions: [],
};
const g = buildFilterGraph(gProj, FONT, LUT).filterComplex;
check('graph: blend opacity', g.includes('blend=all_expr='));
check('graph: rotate', g.includes('rotate=angle='));
check('graph: afftdn', g.includes('afftdn'));
check('graph: loudnorm single-pass', g.includes('loudnorm=I=-16:TP=-1.5:LRA=11:linear=true'));
check('graph: lut3d', g.includes(`lut3d=${LUT}`));
check('graph: text box+border', g.includes('box=1') && g.includes('boxcolor=black@0.6') && g.includes('borderw=3'));
check('presets: 3 new export presets', !!PRESETS['douyin-9x16'] && !!PRESETS['bilibili-16x9-1080p60'] && !!PRESETS['vertical-720x1280']);
check('presets: 3 text + 2 colour', Object.keys(TEXT_PRESETS).length === 3 && Object.keys(COLOR_PRESETS).length === 2);

// --- A. transitions fade/dissolve/wipeleft/slideleft (5 clips x 2s -> 8.0s) ---
{
  const p = { ...base720, clips: [0, 2, 4, 6, 8].map((a, i) => clip2(`c${i}`, a, a + 2)),
    transitions: ['fade', 'dissolve', 'wipeleft', 'slideleft'] };
  const rep = await exportProject(p, `${DIR}p0-transitions5.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('A transitions x4 duration ~8.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check('A resolution 1280x720', rep.actual.width === 1280 && rep.actual.height === 720);
  check('A has audio', rep.actual.hasAudio);
  check('A no black segments', !(await hasBlackSegments(`${DIR}p0-transitions5.mp4`)));
  const gg = buildFilterGraph(p, FONT).filterComplex;
  check('A graph has dissolve+wipeleft+slideleft', gg.includes('xfade=transition=dissolve')
    && gg.includes('xfade=transition=wipeleft') && gg.includes('xfade=transition=slideleft'));
}

// --- B. transitions fadeblack/fadewhite/wiperight (4 clips x 2s -> 6.5s) ---
{
  const p = { ...base720, clips: [0, 2, 4, 6].map((a, i) => clip2(`c${i}`, a, a + 2)),
    transitions: ['fadeblack', 'fadewhite', 'wiperight'] };
  const rep = await exportProject(p, `${DIR}p0-transitions3.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('B transitions x3 duration ~6.5s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check('B has audio', rep.actual.hasAudio);
  // xfade fadeblack/fadewhite reach the extreme early (~20% into the
  // 0.5s transition, profiled: black YAVG=3.5 at 1.60, white 250.5 at 3.10),
  // not at the midpoint — so sample at offset + 0.2*duration.
  const yBlack = await yavg(`${DIR}p0-transitions3.mp4`, 1.60);
  const yWhite = await yavg(`${DIR}p0-transitions3.mp4`, 3.10);
  check('B fadeblack dips to black', yBlack < 40, `YAVG=${yBlack}`);
  check('B fadewhite peaks to white', yWhite > 180, `YAVG=${yWhite}`);
}

// --- C. speed curve 0.5x -> 2x (src 0-4s -> 4s + 1s = 5.0s) ---
{
  const p = { ...base720, clips: [{ id: 'c', source: SRC, in: 0, out: 4, speed: 1, volume: 1,
    speedCurve: [{ t: 0, speed: 0.5 }, { t: 2, speed: 2 }] }], transitions: [] };
  const rep = await exportProject(p, `${DIR}p0-curve.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('C speed curve duration ~5.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check('C has audio', rep.actual.hasAudio);
  const gg = buildFilterGraph(p, FONT).filterComplex;
  check('C graph splits into 2 constant-speed segments', (gg.match(/atempo=/g) || []).length >= 2);
}

// --- D. opacity + rotation keyframes (4s) vs plain control ---
{
  const ctrl = { ...base720, clips: [clip2('c', 0, 4)], transitions: [] };
  const op = { ...base720,
    clips: [{ ...clip2('c', 0, 4),
      opacity: [{ t: 0, value: 1 }, { t: 2, value: 0.3 }, { t: 4, value: 1 }],
      rotation: [{ t: 0, value: 0 }, { t: 4, value: 12 }] }],
    transitions: [] };
  const rCtrl = await exportProject(ctrl, `${DIR}p0-op-ctrl.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  const rOp = await exportProject(op, `${DIR}p0-op.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('D opacity duration ~4.0s', rOp.durationError < 0.3, `err=${rOp.durationError.toFixed(2)}s`);
  const yCtrl = await yavg(`${DIR}p0-op-ctrl.mp4`, 2.0);
  const yOp = await yavg(`${DIR}p0-op.mp4`, 2.0);
  check('D opacity 0.3 darkens frame', yOp < yCtrl * 0.7, `YAVG op=${yOp} ctrl=${yCtrl}`);
  const cornerCtrl = await yavg(`${DIR}p0-op-ctrl.mp4`, 3.5, '40:40:0:0');
  const cornerOp = await yavg(`${DIR}p0-op.mp4`, 3.5, '40:40:0:0');
  check('D rotation fills corner black', cornerOp < 25 && cornerOp < cornerCtrl * 0.5,
    `corner op=${cornerOp} ctrl=${cornerCtrl}`);
}

// --- E. text lowerThird preset + border + shadow ---
{
  const p = { ...base720,
    clips: [{ ...clip2('c', 0, 3),
      text: [{ ...TEXT_PRESETS.lowerThird, text: 'P0 Test', start: 0, end: 3, borderw: 3, shadowx: 2, shadowy: 2 }] }],
    transitions: [] };
  const rep = await exportProject(p, `${DIR}p0-text.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('E text duration ~3.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  const y = await yavg(`${DIR}p0-text.mp4`, 1.0);
  check('E text frame not black', y > 10, `YAVG=${y}`);
}

// --- F. denoise + loudnorm + audio fades ---
{
  const p = { ...base720,
    clips: [{ ...clip2('c', 0, 4), audioFadeIn: 0.5, audioFadeOut: 0.5, denoise: true, loudnorm: true }],
    transitions: [] };
  const rep = await exportProject(p, `${DIR}p0-audio.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('F audio duration ~4.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check('F has audio', rep.actual.hasAudio);
  const li = await loudnessI(`${DIR}p0-audio.mp4`);
  check('F loudnorm near -16 LUFS', Number.isFinite(li) && li >= -20 && li <= -12, `input_i=${li}`);
}

// --- G. colour adjust + LUT vs control ---
{
  const ctrl = { ...base720, clips: [clip2('c', 0, 4)], transitions: [] };
  await exportProject(ctrl, `${DIR}p0-color-ctrl.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  const col = { ...base720,
    clips: [{ ...clip2('c', 0, 4), color: { brightness: 0.1, contrast: 1.2, saturation: 1.3, temperature: 0.2 } }],
    transitions: [] };
  const rCol = await exportProject(col, `${DIR}p0-color.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('G colour duration ~4.0s', rCol.durationError < 0.3, `err=${rCol.durationError.toFixed(2)}s`);
  const yCtrl = await yavg(`${DIR}p0-color-ctrl.mp4`, 1.0);
  const yCol = await yavg(`${DIR}p0-color.mp4`, 1.0);
  check('G colour brightens frame', yCol > yCtrl, `YAVG col=${yCol} ctrl=${yCtrl}`);
  const rLut = await exportProject(ctrl, `${DIR}p0-lut.mp4`,
    { preset: { ...PRESETS['720p30'], lut: LUT }, fontfile: FONT });
  check('G LUT duration ~4.0s', rLut.durationError < 0.3, `err=${rLut.durationError.toFixed(2)}s`);
  const yLut = await yavg(`${DIR}p0-lut.mp4`, 1.0);
  check('G LUT lifts blacks', yLut > yCtrl, `YAVG lut=${yLut} ctrl=${yCtrl}`);
}

// --- H. douyin 9:16 preset ---
{
  const p = { version: 1, width: 1080, height: 1920, fps: 30, transitionDuration: 0.5,
    clips: [{ id: 'c', source: VSRC, in: 0, out: 4, speed: 1, volume: 1 }], transitions: [] };
  const rep = await exportProject(p, `${DIR}p0-9x16.mp4`, { preset: PRESETS['douyin-9x16'], fontfile: FONT });
  check('H 9:16 duration ~4.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check('H resolution 1080x1920', rep.actual.width === 1080 && rep.actual.height === 1920);
  check('H fps 30', Math.abs(rep.actual.fps - 30) < 0.5, `fps=${rep.actual.fps}`);
  check('H has audio', rep.actual.hasAudio);
}

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? 'ALL P0 CHECKS PASSED' : `${failed} P0 CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
