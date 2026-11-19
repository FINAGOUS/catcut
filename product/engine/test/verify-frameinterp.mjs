// W10 whole-film frame-interp switch verification (frameinterp.ts +
// export.ts ExportOptions.frameInterp). The switch is export-level:
// undefined = follow the project, null = force OFF, { targetFps } =
// force ON. Covers:
// - resolver tri-state + validation (fails before any ffmpeg work);
// - presets are untouched by the switch (no frameInterp key, fps kept);
// - ON through a 30 fps preset: the pre-W10 trap — encoder -r used to
//   follow the preset fps and silently drop 24->60 interpolated frames
//   back to 30. Output must read 60 fps / ~120 frames at the same
//   duration, and an interpolated frame must sit BETWEEN its
//   neighbours (PSNR method from verify-p3e: a frame copy would score
//   Infinity against one of them);
// - OFF with a project that sets frameInterp: output stays 24 fps /
//   ~48 frames, and is BYTE-IDENTICAL to a plain export of the same
//   project without frameInterp anywhere (sha256);
// - audio-only export suppresses the switch (no video is rendered,
//   so minterpolate's 3-5x cost must not be paid for sunk frames).
// Source is generated here (testsrc2 24 fps, 2 s) so the script is
// self-contained; outputs are w10fi-*.mp4 next to this file.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  exportProject,
  PRESETS,
  resolveExportFrameInterp,
  validateFrameInterp,
} from '../dist/export.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const SRC = `${DIR}w10fi-24.mp4`;

const checks = [];
const check = (name, ok, detail = '') =>
  checks.push([`${name}${detail ? ` (${detail})` : ''}`, ok]);

async function run(cmd, args, opts = {}) {
  return exec(cmd, args, { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer', ...opts });
}
const throwsSync = (fn, re) => {
  try { fn(); return false; } catch (e) { return re.test(e.message); }
};
const close = (v, target, tol = 0.5) => v !== null && Math.abs(v - target) <= tol;
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function frameBuf(file, ss) {
  const r = await run('ffmpeg', ['-ss', String(ss), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return r.stdout;
}
function psnrBuf(a, b) {
  let se = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
  const mse = se / a.length; return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
}
async function frameCount(file) {
  const r = await run('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file,
  ]);
  return Number(r.stdout.toString().trim());
}

await run('ffmpeg', [
  '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=2',
  '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2', '-shortest',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', SRC,
]);

const base = (frameInterp) => ({
  version: 1, width: 320, height: 180, fps: 24,
  clips: [{ id: 'v', source: SRC, in: 0, out: 2, speed: 1, volume: 1 }],
  transitions: [], transitionDuration: 0.5,
  ...(frameInterp ? { frameInterp } : {}),
});
// The 30 fps preset on purpose: pre-W10, -r followed the preset and
// ate the interpolation. The switch must drive -r from the target.
const preset30 = { ...PRESETS['1080p30'], width: 320, height: 180, fps: 30 };
// OFF/ plain exports use a 24 fps preset on purpose: -r duplicates
// frames to reach the preset rate, so a 60 fps preset would read
// 60 fps / 120 frames even with interpolation OFF. fps 24 pins the
// rate to the project rate, so fps + frame count prove the switch.
const preset24 = { ...PRESETS['1080p30'], width: 320, height: 180, fps: 24 };

// ---------------------------------------------------------------------------
// 1. Resolver: tri-state + validation
// ---------------------------------------------------------------------------
{
  check('resolver: undefined switch follows project',
    JSON.stringify(resolveExportFrameInterp({ targetFps: 60 }, undefined, 24)) === '{"targetFps":60}');
  check('resolver: undefined switch + no project = off',
    resolveExportFrameInterp(undefined, undefined, 24) === undefined);
  check('resolver: null switch forces off despite project',
    resolveExportFrameInterp({ targetFps: 60 }, null, 24) === undefined);
  check('resolver: {48} overrides project {60}',
    resolveExportFrameInterp({ targetFps: 60 }, { targetFps: 48 }, 24)?.targetFps === 48);
  check('resolver: ON target<=fps throws',
    throwsSync(() => resolveExportFrameInterp(undefined, { targetFps: 24 }, 24), /must be greater/));
  check('resolver: ON target>120 throws',
    throwsSync(() => resolveExportFrameInterp(undefined, { targetFps: 240 }, 24), /outside/));
  check('resolver: bad project value still throws when switch untouched',
    throwsSync(() => resolveExportFrameInterp({ targetFps: 24 }, undefined, 24), /must be greater/));
  check('validateFrameInterp still exported unchanged',
    validateFrameInterp({ targetFps: 60 }, 24)?.targetFps === 60);
}

// ---------------------------------------------------------------------------
// 2. Presets untouched by the switch
// ---------------------------------------------------------------------------
{
  check('presets: no preset carries frameInterp',
    Object.values(PRESETS).every((p) => !('frameInterp' in p)));
  check('presets: 1080p30 still fps 30 / 1080p60 still fps 60',
    PRESETS['1080p30'].fps === 30 && PRESETS['1080p60'].fps === 60);
  check('presets: 1080p30 literal unchanged',
    JSON.stringify(PRESETS['1080p30']) === JSON.stringify(
      { name: '1080p30', width: 1920, height: 1080, fps: 30, crf: 20, preset: 'veryfast', audioBitrate: '160k' }));
}

// ---------------------------------------------------------------------------
// 3. Switch ON via export options, 30 fps preset (the -r trap case)
// ---------------------------------------------------------------------------
{
  const r = await exportProject(base(), `${DIR}w10fi-on.mp4`,
    { fontfile: FONT, preset: preset30, frameInterp: { targetFps: 60 } });
  check('switch ON: duration unchanged ~2.0s', close(r.actual.duration, 2, 0.05), `got ${r.actual.duration}`);
  check('switch ON: output fps 60 despite 30 fps preset', close(r.actual.fps, 60, 0.5), `got ${r.actual.fps}`);
  const nOn = await frameCount(`${DIR}w10fi-on.mp4`);
  // 48 source frames -> 47 gaps x 2.5 = ~116-118 emitted (the last
  // frame has no successor to interpolate towards); the pin is fps
  // 60 above, this one proves the frames are really there — more
  // than double the 48 source frames, not a 60 fps relabel.
  check('switch ON: ~116 frames (more than 2x the 48 source frames)', nOn > 96 && nOn <= 120, `got ${nOn}`);
  check('switch ON: report names the applied target', r.frameInterp?.targetFps === 60);
  const f60 = await frameBuf(`${DIR}w10fi-on.mp4`, 0.52);
  const f24a = await frameBuf(SRC, 0.5);
  const f24b = await frameBuf(SRC, 0.5416667);
  const pAB = psnrBuf(f24a, f24b);
  const pIA = psnrBuf(f60, f24a);
  const pIB = psnrBuf(f60, f24b);
  check('switch ON: interp frame is between neighbours (not a copy)', pIA < 45 && pIB < 45 && pIA > 10 && pIB > 10, `vsA ${pIA.toFixed(1)} vsB ${pIB.toFixed(1)} A-vs-B ${pAB.toFixed(1)}`);
  check('switch ON: interp closer to both neighbours than they are to each other', pIB > pAB, `interp-vs-B ${pIB.toFixed(1)} > A-vs-B ${pAB.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// 4. Switch OFF forces a project that sets frameInterp back to plain
// ---------------------------------------------------------------------------
{
  const r = await exportProject(base({ targetFps: 60 }), `${DIR}w10fi-off.mp4`,
    { fontfile: FONT, preset: preset24, frameInterp: null });
  check('switch OFF: duration unchanged ~2.0s', close(r.actual.duration, 2, 0.05), `got ${r.actual.duration}`);
  check('switch OFF: output fps 24 (project fps, not 60)', close(r.actual.fps, 24, 0.5), `got ${r.actual.fps}`);
  const nOff = await frameCount(`${DIR}w10fi-off.mp4`);
  check('switch OFF: ~48 frames', close(nOff, 48, 2), `got ${nOff}`);
  check('switch OFF: report carries no frameInterp', r.frameInterp === undefined);
  const plain = await exportProject(base(), `${DIR}w10fi-plain.mp4`,
    { fontfile: FONT, preset: preset24 });
  check('switch OFF: report has no frameInterp either (plain)', plain.frameInterp === undefined);
  check('switch OFF: byte-identical to plain export (sha256)',
    sha256(`${DIR}w10fi-off.mp4`) === sha256(`${DIR}w10fi-plain.mp4`));
  check('switch OFF: byte-identical to plain export (size)',
    readFileSync(`${DIR}w10fi-off.mp4`).length === readFileSync(`${DIR}w10fi-plain.mp4`).length);
  check('switch ON output differs from OFF output',
    sha256(`${DIR}w10fi-on.mp4`) !== sha256(`${DIR}w10fi-off.mp4`));
}

// ---------------------------------------------------------------------------
// 5. Audio-only export suppresses the switch (no video rendered)
// ---------------------------------------------------------------------------
{
  const r = await exportProject(base(), `${DIR}w10fi-audio.m4a`,
    { fontfile: FONT, preset: preset30, frameInterp: { targetFps: 60 }, exportOnly: 'audio' });
  check('audio-only + switch ON: succeeds, duration ~2.0s', close(r.actual.duration, 2, 0.05), `got ${r.actual.duration}`);
  check('audio-only + switch ON: report carries no frameInterp', r.frameInterp === undefined);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} passed`);
for (const [name, ok] of checks) if (!ok) console.log(`FAIL: ${name}`);
if (passed !== checks.length) process.exit(1);
