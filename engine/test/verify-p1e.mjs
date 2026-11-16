// P1 batch 5 (last) engine verification (M4, 2026-11-17).
// Covers: smart portrait cutout (src/portrait.ts + scripts/portrait_segment.py
// + models/selfie_segmentation_256x256.onnx).
//
// Model selection (measured 2026-11-17 on this VM, Linux CPU, onnxruntime
// 1.32.0; full probe in m2-build-log.md, P1 batch 5 entry):
// - CHOSEN: MediaPipe Selfie Segmentation 256x256 ONNX (PINTO0309 model zoo
//   109_Selfie_Segmentation, model_float32.onnx), 447,658 bytes, md5
//   0244992cbc250eb80b14b070d46b4b7c, Apache 2.0 (commercial use OK, keep
//   attribution). Input [1,256,256,3] RGB [0,1], output [1,256,256,1]
//   foreground probability. Inference median ~3.7 ms/frame (mean ~8 ms incl.
//   warmup), outputs bit-identical across repeated runs.
// - REJECTED: MODNet — weights CC BY-NC-SA 4.0 (NonCommercial, cannot ship
//   in a paid product) + 2.28 GB bundle. RVM — weights GPL-3.0 + 1.08 GB.
//   Rejected on license, not downloaded.
// - Quality on real photos: foreground share 55% (150x150 profile photo)
//   and 67.4% (Obama portrait crop), uncertain band (0.1-0.9) only ~1.25%
//   of pixels (sharp, confident edges). Flat-colour synthetic "fake
//   person" scores ~0 (max prob 0.0026) — the model only fires on real
//   human images.
// - Runtime path: onnxruntime-node 1.22.0 npm install FAILED on this VM
//   (NuGet binary fetch ECONNRESET via proxy); Python onnxruntime 1.32.0
//   (MIT) works, so the engine follows the transcribe.ts precedent:
//   scripts/portrait_segment.py invoked from src/portrait.ts; on Windows
//   the same interface will be served natively by Microsoft.ML.OnnxRuntime
//   (NuGet). Python helper venv is engine/.venv (same venv as P0b's
//   faster-whisper), passed in as PORTRAIT_PYTHON or the default path.
//
// Test asset: test/assets/portrait-obama.jpg (640x360 crop of the Official
// portrait of Barack Obama, CC BY 3.0 via Wikimedia Commons; original
// 803,500 bytes deleted after cropping). Attribution must stay in this
// header. The test video is a slow zoompan over that photo (so the frame
// content changes over time) + 440 Hz sine audio, 4 s, 640x360, 30 fps.
// The "fake person" negative control is flat-colour boxes (no real human),
// and the model is expected NOT to fire on it.
//
// Measurement method (written down so the numbers can be re-derived):
// - Determinism probe was run BEFORE writing assertions (the vidstab
//   lesson: vidstabdetect gave different .trf files on identical input).
//   The helper was run 3x on the same 4 s person video; the mask videos'
//   gray frames at t=2 were compared pixel-for-pixel (corner 0, centre
//   255, identical 3x) and the helper JSON summaries' frames/sampled
//   fields were identical 3x. Timing (medianMs) varies a few ms between
//   runs, so timing is asserted only against a wide bar (< 50 ms), never
//   exact-equal. The test re-runs the helper 3x and asserts the mask
//   frame values are identical, so a future nondeterminism fails loudly.
// - Pixel checks use 16x16 crops averaged to RGB (meanRGB), NOT crop=1:1:
//   crop=1:1 fails on yuv420p in ffmpeg 8.1.2 (odd size rounds to 0).
//   "Corner" is the 16x16 block at (8,8) — top-left background, far from
//   the head. "Centre" is the 16x16 block at (320,180) — on the face.
//   Bars were set FROM the smoke run, not guessed: cutout corner
//   [254,0,0] (red bg), centre [199,150,120] vs control [200,151,119]
//   (~1 LSB apart), control corner [6,5,9] (dark original background).
// - PSNR frame checks use ffmpeg's psnr filter on cropped regions. The
//   centre crop is 64x64 at (288,148): the mask probe shows that block is
//   solidly person (min alpha 255), so PSNR cutout-vs-control must be
//   > 25 (person preserved). A wider 160x120 centre crop was tried first
//   and gave PSNR 20.23 — NOT a cutout failure: the mask probe shows
//   that crop includes background columns (min alpha 0) where the red
//   background legitimately replaces the original. Corner-crop PSNR
//   cutout-vs-control must be < 25 (background really changed).
// - Duration error bar is < 0.3 s per the task (smoke run: 0.00 s).
// - Black-segment check is blackdetect d=0.5 pix_th=0.10, same as P1d.
// - LGPL: portrait.ts is our own code + onnxruntime (MIT) + ffmpeg
//   decode/encode. The new filter-graph filters are alphamerge, format,
//   gblur, fps, overlay, color (all native libavfilter, LGPL part —
//   still to be re-checked on the BtbN LGPL 9.0 build at the M2 gate).
//   All of this was verified on the local GPL 8.1.2 build only.
// Old M1 / P0 / P0b / P1 / P1b / P1c / P1d checks live in their own files
// and must still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  defaultPortraitModelPath,
  defaultPortraitScriptPath,
  exportProject,
  PORTRAIT_SETUP,
  preparePortraitMasks,
  probe,
  PRESETS,
  validatePortraitCutout,
} from '../dist/export.js';
import { buildFilterGraph } from '../dist/filtergraph.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
// Same venv convention as verify-p0b (engine/.venv has onnxruntime 1.32.0).
const PY = process.env.PORTRAIT_PYTHON || `${DIR}../.venv/bin/python`;
const MODEL = `${DIR}../models/selfie_segmentation_256x256.onnx`;
const PHOTO = `${DIR}assets/portrait-obama.jpg`;

const checks = [];
const check = (name, ok, detail = '') =>
  checks.push([`${name}${detail ? ` (${detail})` : ''}`, ok]);

async function run(cmd, args, opts = {}) {
  return exec(cmd, args, { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer', ...opts });
}

function md5(file) {
  return createHash('md5').update(readFileSync(file)).digest('hex');
}

/** One RGB24 frame (optionally cropped) as a Buffer. */
async function rawFrame(file, ss, crop) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', file, '-vf', `crop=${crop}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  return r.stdout;
}

/** One grayscale frame as a Buffer (full frame, W x H). */
async function rawGray(file, ss, w, h) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ]);
  return r.stdout;
}

function meanRGB(buf) {
  let r = 0, g = 0, b = 0;
  const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}

async function psnrCrops(a, b, crop) {
  const r = await run('ffmpeg', [
    '-i', a, '-i', b, '-filter_complex',
    `[0:v]crop=${crop}[a];[1:v]crop=${crop}[b];[a][b]psnr`,
    '-frames:v', '1', '-f', 'null', '-',
  ]).catch((e) => e);
  const m = ((r.stderr ?? '') + (r.stdout ?? '')).match(/average:([0-9.inf]+)/);
  if (!m) return NaN;
  return m[1] === 'inf' ? 999 : Number(m[1]);
}

async function hasBlackSegments(file) {
  const bd = await run('ffmpeg', ['-i', file, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-']).catch((e) => e);
  return /black_start/.test((bd.stderr ?? '') + (bd.stdout ?? ''));
}

const base = { version: 1, width: 640, height: 360, fps: 30, transitions: [], transitionDuration: 0.5 };
const clip = (id, source, extra = {}) => ({ id, source, in: 0, out: 4, speed: 1, volume: 1, ...extra });
const redCutout = (source) => clip('c', source, { portraitCutout: { background: { color: '0xff0000' } } });

// --- 0. model file, paths, graph strings, validation (no encode) ---
check('model file exists', existsSync(MODEL));
check('model size 447658 bytes', existsSync(MODEL) && statSync(MODEL).size === 447658, existsSync(MODEL) ? `${statSync(MODEL).size} bytes` : 'missing');
check('model md5 matches probe', existsSync(MODEL) && md5(MODEL) === '0244992cbc250eb80b14b070d46b4b7c', existsSync(MODEL) ? md5(MODEL) : 'missing');
check('default model path', defaultPortraitModelPath().endsWith('models/selfie_segmentation_256x256.onnx'), defaultPortraitModelPath());
check('default script path', defaultPortraitScriptPath().endsWith('scripts/portrait_segment.py'), defaultPortraitScriptPath());
check('helper python has onnxruntime', await run(PY, ['-c', 'import onnxruntime; print(onnxruntime.__version__)']).then((r) => r.stdout.toString().trim() === '1.32.0', () => false));
{
  const g = buildFilterGraph(
    { ...base, clips: [redCutout(`${DIR}p1e-person.mp4`)] },
    FONT, undefined, undefined, undefined, undefined,
    new Map([[0, `${DIR}p1e-mask.mp4`]]),
  ).filterComplex;
  check('graph: alphamerge + mask fps/gray', g.includes('alphamerge') && g.includes('fps=fps=30,format=gray'), g.slice(0, 120));
  check('graph: solid red background', g.includes('color=c=0xff0000:s=640x360') && g.includes('overlay=0:0'));
  check('graph: portrait mask input counted', buildFilterGraph(
    { ...base, clips: [redCutout(`${DIR}p1e-person.mp4`)] },
    FONT, undefined, undefined, undefined, undefined,
    new Map([[0, `${DIR}p1e-mask.mp4`]]),
  ).extraInputs.length === 1);
}
{
  let threw = false;
  try {
    buildFilterGraph({ ...base, clips: [redCutout(`${DIR}p1e-person.mp4`)] }, FONT);
  } catch (e) { threw = /not prepared/.test(e.message); }
  check('graph: portrait without prepared mask throws', threw);
}
{
  let threw = false;
  try {
    buildFilterGraph(
      { ...base, clips: [clip('c', `${DIR}p1e-person.mp4`, {
        portraitCutout: { background: { color: '0xff0000' } },
        chromaKey: { color: '0x00ff00' },
      })] },
      FONT, undefined, undefined, undefined, undefined,
      new Map([[0, `${DIR}p1e-mask.mp4`]]),
    );
  } catch (e) { threw = /cannot be combined/.test(e.message); }
  check('validate: portrait + chromaKey rejected', threw);
}
{
  const bad = [
    [{ speed: 2 }, /requires speed 1/],
    [{ reverse: true }, /reverse/],
    [{ freezeAt: 1, freezeDuration: 1 }, /freeze/],
    [{ portraitCutout: { edgeFeather: -1 } }, /edgeFeather/],
    [{ portraitCutout: { sampleEvery: 0 } }, /sampleEvery/],
    [{ portraitCutout: { background: { color: 'red', source: 'x.mp4' } } }, /not both/],
  ];
  let allOk = true;
  for (const [extra, re] of bad) {
    try {
      validatePortraitCutout(extra.portraitCutout ?? { background: { color: '0xff0000' } }, { id: 'c', ...extra });
      allOk = false;
    } catch (e) { if (!re.test(e.message)) allOk = false; }
  }
  check('validate: bad portrait configs rejected', allOk);
}

// --- A. test sources ---
await run('ffmpeg', ['-v', 'error', '-loop', '1', '-i', PHOTO,
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-vf', "zoompan=z='min(zoom+0.0006,1.1)':d=120:s=640x360:fps=30",
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  '-t', '4', '-y', `${DIR}p1e-person.mp4`]);
const PERSON = `${DIR}p1e-person.mp4`;
const personProbe = await probe(PERSON);
check('source: person video 4s 640x360 30fps', personProbe.duration === 4 && personProbe.width === 640 && personProbe.fps === 30, JSON.stringify(personProbe));
// Flat-colour "fake person": boxes, no real human — model must NOT fire.
await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x303050:s=640x360:d=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-vf', 'drawbox=x=250:y=40:w=140:h=280:color=0xf0c8a0:t=fill,drawbox=x=270:y=20:w=100:h=100:color=0x8a5a30:t=fill',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  '-t', '4', '-y', `${DIR}p1e-fake.mp4`]);
const FAKE = `${DIR}p1e-fake.mp4`;
await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=640x360:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  '-t', '4', '-y', `${DIR}p1e-bg.mp4`]);
const BGVID = `${DIR}p1e-bg.mp4`;

// --- B. helper determinism probe: 3 runs on the same video ---
// The helper prints its summary JSON to stdout (no summary file); run it
// directly here with the same arguments preparePortraitMasks passes.
async function runHelper(input, maskPath, sampleEvery = 1) {
  const { stdout } = await run(PY, [
    defaultPortraitScriptPath(),
    '--video', input, '--model', MODEL, '--out', maskPath,
    '--fps', '30', '--in', '0', '--dur', '4',
    '--width', '640', '--height', '360',
    '--sample-every', String(sampleEvery),
  ]);
  return JSON.parse(stdout.toString().trim());
}
const summaries = [];
const maskFrames = [];
for (let i = 0; i < 3; i++) {
  const maskPath = `${DIR}p1e-probe-mask.mp4`;
  const sum = await runHelper(PERSON, maskPath);
  summaries.push(sum);
  const gray = await rawGray(maskPath, 2, 640, 360);
  maskFrames.push({
    corner: gray[8 * 640 + 8],
    centre: gray[180 * 640 + 320],
    topCentre: gray[60 * 640 + 320],
    fgShare: (() => { let n = 0; for (const v of gray) if (v > 128) n++; return n / gray.length; })(),
  });
}
const mask0 = maskFrames[0];
check('probe: helper 3x identical mask pixels',
  maskFrames.every((f) => f.corner === mask0.corner && f.centre === mask0.centre && f.topCentre === mask0.topCentre && f.fgShare === mask0.fgShare),
  `corner=${mask0.corner} centre=${mask0.centre} topCentre=${mask0.topCentre} fgShare=${mask0.fgShare.toFixed(3)}`);
check('probe: helper 3x identical frame counts',
  summaries.every((s) => s.frames === summaries[0].frames && s.sampled === summaries[0].sampled),
  `frames=${summaries[0].frames} sampled=${summaries[0].sampled}`);
const medianMs = summaries.map((s) => s.medianMs);
check('probe: inference median < 50 ms/frame', medianMs.every((m) => m < 50), `medianMs x3 = ${medianMs.join('/')}`);
check('probe: sampled == frames at sampleEvery 1', summaries[0].sampled === summaries[0].frames, `sampled=${summaries[0].sampled} frames=${summaries[0].frames}`);

// --- C. independent alpha check on the mask video ---
check('mask: corner alpha ~0 (background)', mask0.corner < 10, `corner=${mask0.corner}`);
check('mask: centre alpha ~255 (person)', mask0.centre > 200, `centre=${mask0.centre}`);
check('mask: top-centre alpha ~255 (head)', mask0.topCentre > 200, `topCentre=${mask0.topCentre}`);
check('mask: fg share plausible 0.3-0.9', mask0.fgShare > 0.3 && mask0.fgShare < 0.9, `fgShare=${mask0.fgShare.toFixed(3)}`);

// --- D. cutout + solid red background export ---
const cut = await exportProject(
  { ...base, clips: [redCutout(PERSON)] },
  `${DIR}p1e-cutout.mp4`, { preset: PRESETS['720p30'], fontfile: FONT, python: PY },
);
check('export: cutout duration err < 0.3s', Math.abs(cut.durationError) < 0.3, `err=${cut.durationError.toFixed(2)}s`);
check('export: cutout has audio', cut.actual.hasAudio);
check('export: cutout no black segment', !(await hasBlackSegments(`${DIR}p1e-cutout.mp4`)));
const cutCorner = meanRGB(await rawFrame(`${DIR}p1e-cutout.mp4`, 2, '16:16:8:8'));
check('export: corner is the new red background',
  cutCorner.r > 240 && cutCorner.g < 20 && cutCorner.b < 20,
  `corner RGB=${Math.round(cutCorner.r)},${Math.round(cutCorner.g)},${Math.round(cutCorner.b)}`);
const ctrl = await exportProject(
  { ...base, clips: [clip('c', PERSON)] },
  `${DIR}p1e-control.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
);
check('export: control duration err < 0.3s', Math.abs(ctrl.durationError) < 0.3, `err=${ctrl.durationError.toFixed(2)}s`);
const ctrlCorner = meanRGB(await rawFrame(`${DIR}p1e-control.mp4`, 2, '16:16:8:8'));
check('control: corner is NOT red (original bg)', ctrlCorner.r < 50, `corner RGB=${Math.round(ctrlCorner.r)},${Math.round(ctrlCorner.g)},${Math.round(ctrlCorner.b)}`);
const centrePsnr = await psnrCrops(`${DIR}p1e-cutout.mp4`, `${DIR}p1e-control.mp4`, '64:64:288:148');
check('export: person centre preserved vs control (PSNR > 25)', centrePsnr > 25, `PSNR=${centrePsnr.toFixed(2)}`);
const cornerPsnr = await psnrCrops(`${DIR}p1e-cutout.mp4`, `${DIR}p1e-control.mp4`, '64:64:8:8');
check('export: corner background really changed (PSNR < 25)', cornerPsnr < 25, `PSNR=${cornerPsnr.toFixed(2)}`);

// --- E. cutout + video background export ---
const cutVid = await exportProject(
  { ...base, clips: [clip('c', PERSON, { portraitCutout: { background: { source: BGVID } } })] },
  `${DIR}p1e-cutout-vid.mp4`, { preset: PRESETS['720p30'], fontfile: FONT, python: PY },
);
check('export: video-bg cutout duration err < 0.3s', Math.abs(cutVid.durationError) < 0.3, `err=${cutVid.durationError.toFixed(2)}s`);
const vidCorner = meanRGB(await rawFrame(`${DIR}p1e-cutout-vid.mp4`, 2, '16:16:8:8'));
const bgCorner = meanRGB(await rawFrame(BGVID, 2, '16:16:8:8'));
const vidDiff = Math.abs(vidCorner.r - bgCorner.r) + Math.abs(vidCorner.g - bgCorner.g) + Math.abs(vidCorner.b - bgCorner.b);
check('export: corner matches video background (mean |diff| < 45)',
  vidDiff < 45,
  `cutout RGB=${Math.round(vidCorner.r)},${Math.round(vidCorner.g)},${Math.round(vidCorner.b)} vs bg RGB=${Math.round(bgCorner.r)},${Math.round(bgCorner.g)},${Math.round(bgCorner.b)}`);

// --- F. sampled frames (sampleEvery=5) + feather ---
const sampled = await exportProject(
  { ...base, clips: [clip('c', PERSON, { portraitCutout: { background: { color: '0xff0000' }, sampleEvery: 5 } })] },
  `${DIR}p1e-sampled.mp4`, { preset: PRESETS['720p30'], fontfile: FONT, python: PY },
);
check('export: sampleEvery=5 duration err < 0.3s', Math.abs(sampled.durationError) < 0.3, `err=${sampled.durationError.toFixed(2)}s`);
const sampledCorner = meanRGB(await rawFrame(`${DIR}p1e-sampled.mp4`, 2, '16:16:8:8'));
check('export: sampleEvery=5 corner still red',
  sampledCorner.r > 240 && sampledCorner.g < 20 && sampledCorner.b < 20,
  `corner RGB=${Math.round(sampledCorner.r)},${Math.round(sampledCorner.g)},${Math.round(sampledCorner.b)}`);
const feathered = await exportProject(
  { ...base, clips: [clip('c', PERSON, { portraitCutout: { background: { color: '0xff0000' }, edgeFeather: 4 } })] },
  `${DIR}p1e-feather.mp4`, { preset: PRESETS['720p30'], fontfile: FONT, python: PY },
);
check('export: edgeFeather=4 duration err < 0.3s', Math.abs(feathered.durationError) < 0.3, `err=${feathered.durationError.toFixed(2)}s`);
const featherPsnr = await psnrCrops(`${DIR}p1e-feather.mp4`, `${DIR}p1e-cutout.mp4`, '640:360:0:0');
check('export: feather changes edges but not the picture (PSNR 10-45)', featherPsnr > 10 && featherPsnr < 45, `PSNR=${featherPsnr.toFixed(2)}`);
const featherCorner = meanRGB(await rawFrame(`${DIR}p1e-feather.mp4`, 2, '16:16:8:8'));
check('export: feathered corner still red',
  featherCorner.r > 240 && featherCorner.g < 20 && featherCorner.b < 20,
  `corner RGB=${Math.round(featherCorner.r)},${Math.round(featherCorner.g)},${Math.round(featherCorner.b)}`);

// --- G. negative control: flat-colour fake person must NOT segment ---
const fakeMasks = await preparePortraitMasks(
  { ...base, clips: [redCutout(FAKE)] }, DIR, { python: PY },
);
const fakeGray = await rawGray(fakeMasks.get(0), 2, 640, 360);
let fakeFg = 0;
for (const v of fakeGray) if (v > 128) fakeFg++;
check('negative: fake person fg share < 0.05', fakeFg / fakeGray.length < 0.05, `fgShare=${(fakeFg / fakeGray.length).toFixed(4)}`);

// --- H. bad inputs rejected ---
{
  let threw = false;
  try {
    await preparePortraitMasks(
      { ...base, clips: [redCutout(PERSON)] }, DIR,
      { python: PY, model: `${DIR}no-such-model.onnx` },
    );
  } catch (e) { threw = /model not found/.test(e.message); }
  check('reject: missing model file', threw);
}
{
  let threw = false;
  try {
    await preparePortraitMasks(
      { ...base, clips: [redCutout(PERSON)] }, DIR,
      { python: '/usr/bin/false' },
    );
  } catch (e) { threw = /segmentation failed|not found/.test(e.message); }
  check('reject: helper failure surfaces as error', threw);
}
{
  let threw = false;
  try {
    await exportProject(
      { ...base, clips: [clip('c', PERSON, { portraitCutout: { background: { color: '0xff0000' } }, speed: 2 })] },
      `${DIR}p1e-bad.mp4`, { preset: PRESETS['720p30'], fontfile: FONT, python: PY },
    );
  } catch (e) { threw = /requires speed 1/.test(e.message); }
  check('reject: export with speed != 1 throws', threw);
}

// --- report ---
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exit(1);
