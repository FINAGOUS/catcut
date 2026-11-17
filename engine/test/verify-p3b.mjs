// P3 batch 2 engine verification (M4 §8.7 + direction doc §三, 2026-11-17).
// Covers: src/smartcut.ts — scene detection (select/showinfo), voice/
// music/silence classification (heuristic on measured audio features),
// subject tracking (P1e portrait mask centroid + smoothing), vertical
// reframe (crop following the track), auto-follow zoom (zoom keyframes
// from tracking + voice segments), wired into filtergraph.ts (reframe
// crop on the SOURCE stream, before scale/pad) and export.ts
// (prepareSmartCut: tracking pass + follow-zoom key merge).
//
// Measurement method (written down so the numbers can be re-derived):
// - Determinism probe was run BEFORE writing assertions (tmp/probe-p3b.mjs).
//   Scene cuts on a 6 s red / bright-green / blue hard-cut video return
//   exactly [2.0, 4.0] at thresholds 0.3/0.4/0.5. Named colour "green" is
//   dark green (luma 81 = red's) and is invisible to the detector — the
//   probe and this test use bright green 0x00FF00. Do not "fix" it back.
// - Classification thresholds are the probe measurements on synthetic
//   sources (voice: tone bursts 0.5 s on / 0.25 s off, pitch 440/520/660/480;
//   music: continuous 220+277+330 chord; silence: digital zeros).
//   Spectral features are active-window means (tmp/probe-p3b2.mjs):
//   voice fracActive 0.75 / flat 0.343 / peakFreqStd 76 / uniqPeak 3 /
//   rmsStd 96.36; music fracActive 1.00 / flat 0.109 / peakFreqStd 0 /
//   uniqPeak 1 / rmsStd 0.01; silence fracActive 0.00 / meanRms -240.
// - Sine/wav sources are 16 kHz mono, written by node (same pattern as
//   verify-p3a). "Silence" asserts use volumedetect-style floors, not
//   exact zeros.
// - The reframe / follow-zoom export checks use a synthetic red square
//   moving left->right (known ground-truth path) plus a synthetic
//   subject track built from that same path — no ONNX in the loop.
//   The one ONNX check (prepareSubjectTracks on p1e-person.mp4) only
//   asserts the track exists, is mostly located, and stays in frame.
// - LGPL: select/showinfo, crop, fps, format are native libavfilter
//   filters. Only verified on the local GPL 8.1.2 build; re-check each
//   on the BtbN LGPL 9.0 build at the M2 gate.
// Old M1 / P0 / P0b / P1 / P1b / P1c / P1d / P1e / P2a / P2b / P2c /
// P3a checks live in their own files and must still pass.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import {
  analyzeAudioSegments,
  audioSegmentFeatures,
  classifyFeatures,
  decodeAudioMonoF32,
  detectScenes,
  followZoomKeys,
  hasAudio,
  prepareSmartCut,
  prepareSubjectTracks,
  reframeCropFilter,
  scenesToSegments,
  smoothTrack,
  trackCenterAt,
  trackFromMaskVideo,
  validateSmartCut,
} from '../dist/smartcut.js';
import { buildFilterGraph } from '../dist/filtergraph.js';
import { exportProject, PRESETS } from '../dist/export.js';
import { zoomScaleAt } from '../dist/autozoom.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const PY = process.env.PORTRAIT_PYTHON || `${DIR}../.venv/bin/python`;
const SR = 16000;

const checks = [];
const check = (name, ok, detail = '') =>
  checks.push([`${name}${detail ? ` (${detail})` : ''}`, ok]);

async function run(cmd, args, opts = {}) {
  return exec(cmd, args, { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer', ...opts });
}

function wavS16(path, samples) {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + samples.length * 2, 4);
  data.write('WAVE', 8); data.write('fmt ', 12); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(SR, 24); data.writeUInt32LE(SR * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  }
  writeFileSync(path, data);
}

// Voice-like: tone bursts (0.5 s on, 0.25 s off), pitch varies.
// Seeded noise rides on the bursts only (same as the probe:
// gaps stay digital silence, so fracActive measures the pauses).
function voiceLike(dur = 4) {
  const n = SR * dur, out = new Float32Array(n);
  const freqs = [440, 520, 660, 480];
  let seed = 777;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < n; i++) {
    const t = i / SR, ph = t % 0.75;
    if (ph < 0.5) {
      const f = freqs[Math.floor(t / 0.75) % freqs.length];
      out[i] = 0.2 * Math.sin(2 * Math.PI * f * t) + 0.02 * (rnd() - 0.5);
    }
  }
  return out;
}
// Music-like: continuous 3-note chord, no gaps.
function musicLike(dur = 4) {
  const n = SR * dur, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = 0.12 * Math.sin(2 * Math.PI * 220 * t)
      + 0.10 * Math.sin(2 * Math.PI * 277 * t)
      + 0.08 * Math.sin(2 * Math.PI * 330 * t);
  }
  return out;
}

const base = { version: 1, width: 640, height: 360, fps: 30, transitions: [], transitionDuration: 0.5 };
const clip = (id, source, extra = {}) => ({ id, source, in: 0, out: 4, speed: 1, volume: 1, ...extra });

/** One RGB24 frame as a Buffer. */
async function rawFrame(file, ss) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  return r.stdout;
}

/** Centroid x fraction of red pixels (R>150, G<80, B<80); NaN if none. */
function redCentroidX(buf, w, h) {
  let sx = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      if (buf[o] > 150 && buf[o + 1] < 80 && buf[o + 2] < 80) { sx += x; n++; }
    }
  }
  return n === 0 ? NaN : sx / n / w;
}

/** PSNR between one frame of a and one frame of b (same timestamp). */
async function psnrFrame(a, b, ss) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', a, '-ss', String(ss), '-i', b,
    '-filter_complex', '[0:v][1:v]psnr', '-frames:v', '1', '-f', 'null', '-',
  ]).catch((e) => e);
  const m = ((r.stderr ?? '') + (r.stdout ?? '')).match(/average:([0-9.inf]+)/);
  if (!m) return NaN;
  return m[1] === 'inf' ? 999 : Number(m[1]);
}

/** Red 40x40 square moving left->right on black, 640x360, 30 fps. */
async function makeBallVideo(out, audioArgs) {
  const ff = spawn('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '640x360', '-r', '30', '-i', '-',
    ...audioArgs,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out,
  ]);
  const frames = 120;
  for (let f = 0; f < frames; f++) {
    const t = f / 30;
    const cx = Math.round(80 + 120 * t);
    const buf = Buffer.alloc(640 * 360 * 3, 0);
    for (let y = 150; y < 190; y++) {
      for (let x = cx; x < cx + 40; x++) {
        const o = (y * 640 + x) * 3;
        buf[o] = 255;
      }
    }
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  const code = await once(ff, 'close');
  if (code[0] !== 0) throw new Error(`makeBallVideo failed (code ${code[0]})`);
}

// --- 0. validation (no encode) ---
{
  const bad = (extra, name) => {
    let threw = false;
    try { validateSmartCut(clip('c', 'x.mp4', extra)); } catch { threw = true; }
    check(`validate: ${name} throws`, threw);
  };
  bad({ sceneThreshold: 0 }, 'sceneThreshold 0');
  bad({ sceneThreshold: 1.2 }, 'sceneThreshold 1.2');
  bad({ reframe: { aspect: '4:3' } }, 'reframe aspect 4:3');
  bad({ reframe: { margin: -0.1 } }, 'reframe margin -0.1');
  bad({ reframe: { margin: 0.5 } }, 'reframe margin 0.5');
  bad({ reframe: {}, speed: 2 }, 'reframe + speed 2');
  bad({ reframe: {}, reverse: true }, 'reframe + reverse');
  bad({ reframe: {}, freezeAt: 1 }, 'reframe + freeze');
  bad({ reframe: {}, portraitCutout: {} }, 'reframe + portraitCutout');
  bad({ reframe: {}, multicam: { angles: ['a.mp4', 'b.mp4'] } }, 'reframe + multicam');
  bad({ followZoom: { maxScale: 1.6 } }, 'followZoom maxScale 1.6');
  bad({ followZoom: { maxScale: 0.9 } }, 'followZoom maxScale 0.9');
  bad({ followZoom: { ease: 0.01 } }, 'followZoom ease 0.01');
  bad({ followZoom: { minHold: 0.05 } }, 'followZoom minHold 0.05');
  bad({ followZoom: { maxRate: 0 } }, 'followZoom maxRate 0');
  bad({ followZoom: {}, speed: 2 }, 'followZoom + speed 2');
  bad({ followZoom: {}, zoom: [{ t: 0, cx: 0.5, cy: 0.5, scale: 1 }] }, 'followZoom + manual zoom');
  let ok = true;
  try {
    validateSmartCut(clip('c', 'x.mp4', { sceneThreshold: 0.4 }));
    validateSmartCut(clip('c', 'x.mp4', { reframe: { aspect: '9:16' } }));
    validateSmartCut(clip('c', 'x.mp4', { followZoom: {} }));
    validateSmartCut(clip('c', 'x.mp4', { reframe: { aspect: '1:1', followY: true }, followZoom: { maxScale: 1.2 } }));
  } catch { ok = false; }
  check('validate: legal combos pass', ok);
}

// --- 1. scene detection ---
const sceneMp4 = `${DIR}p3b-scene.mp4`;
if (!existsSync(sceneMp4)) {
  await run('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=2',
    '-f', 'lavfi', '-i', 'color=c=0x00FF00:s=320x180:r=30:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=2',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', sceneMp4]);
}
{
  const cuts = await detectScenes(sceneMp4);
  check('scene: 2 cuts', cuts.length === 2, `got ${cuts.map((c) => c.t).join(',')}`);
  check('scene: cut at 2.00s', cuts.length >= 1 && Math.abs(cuts[0].t - 2.0) <= 0.05, cuts[0] ? `${cuts[0].t}` : 'none');
  check('scene: cut at 4.00s', cuts.length >= 2 && Math.abs(cuts[1].t - 4.0) <= 0.05, cuts[1] ? `${cuts[1].t}` : 'none');
  const cuts05 = await detectScenes(sceneMp4, { threshold: 0.5 });
  check('scene: th=0.5 same cuts', cuts05.length === 2 && Math.abs(cuts05[0].t - 2) <= 0.05 && Math.abs(cuts05[1].t - 4) <= 0.05);
  const segs = scenesToSegments(cuts, 6);
  check('scene: segments [0,2][2,4][4,6]', segs.length === 3 && segs[0].start === 0 && segs[0].end === 2 && segs[1].start === 2 && segs[1].end === 4 && segs[2].start === 4 && segs[2].end === 6, JSON.stringify(segs));
  check('scene: no cuts -> one segment', JSON.stringify(scenesToSegments([], 6)) === JSON.stringify([{ start: 0, end: 6 }]));
  const rel = await detectScenes(sceneMp4, { from: 2, duration: 2.5 });
  check('scene: from=2 rel cut at 2.0', rel.length === 1 && Math.abs(rel[0].t - 2.0) <= 0.05, `got ${rel.map((c) => c.t).join(',')}`);
  let threw = false;
  try { await detectScenes(sceneMp4, { threshold: 0.01 }); } catch { threw = true; }
  check('scene: threshold 0.01 throws', threw);
}

// --- 2. voice / music / silence classification ---
wavS16(`${DIR}p3b-voice.wav`, voiceLike());
wavS16(`${DIR}p3b-music.wav`, musicLike());
wavS16(`${DIR}p3b-sil.wav`, new Float32Array(SR * 4));
{
  const mix = new Float32Array(SR * 2);
  mix.set(musicLike(1), 0);
  wavS16(`${DIR}p3b-mixed.wav`, mix);
}
{
  const [v] = await analyzeAudioSegments(`${DIR}p3b-voice.wav`, [{ start: 0, end: 4 }]);
  check('classify: voice label', v.label === 'voice', `${v.label} conf=${v.confidence.toFixed(2)}`);
  check('classify: voice confidence >= 0.5', v.confidence >= 0.5, `conf=${v.confidence.toFixed(2)}`);
  check('classify: voice fracActive 0.6..0.85', v.fracActive >= 0.6 && v.fracActive <= 0.85, `fracActive=${v.fracActive.toFixed(2)}`);
  check('classify: voice rmsStd >= 5 (bursty)', v.rmsStdDb >= 5, `rmsStd=${v.rmsStdDb.toFixed(1)}`);
  check('classify: voice peakFreqStd >= 30', v.peakFreqStd >= 30, `std=${v.peakFreqStd.toFixed(0)}`);
  const [m] = await analyzeAudioSegments(`${DIR}p3b-music.wav`, [{ start: 0, end: 4 }]);
  check('classify: music label', m.label === 'music', `${m.label} conf=${m.confidence.toFixed(2)}`);
  check('classify: music confidence >= 0.5', m.confidence >= 0.5, `conf=${m.confidence.toFixed(2)}`);
  check('classify: music fracActive 1.00', m.fracActive === 1, `fracActive=${m.fracActive.toFixed(2)}`);
  check('classify: music rmsStd <= 0.1', m.rmsStdDb <= 0.1, `rmsStd=${m.rmsStdDb.toFixed(2)}`);
  check('classify: music flat <= 0.2', m.meanFlat <= 0.2, `flat=${m.meanFlat.toFixed(3)}`);
  const [s] = await analyzeAudioSegments(`${DIR}p3b-sil.wav`, [{ start: 0, end: 4 }]);
  check('classify: silence label', s.label === 'silence', `${s.label} conf=${s.confidence.toFixed(2)}`);
  check('classify: silence meanRms <= -200', s.meanRmsDb <= -200, `meanRms=${s.meanRmsDb.toFixed(1)}`);
  const [x] = await analyzeAudioSegments(`${DIR}p3b-mixed.wav`, [{ start: 0, end: 2 }]);
  check('classify: music+silence mix -> unknown', x.label === 'unknown' && x.confidence === 0, `${x.label} conf=${x.confidence}`);
  const [short] = await analyzeAudioSegments(`${DIR}p3b-voice.wav`, [{ start: 0, end: 0.2 }]);
  check('classify: 0.2s segment -> unknown', short.label === 'unknown', short.label);
  let threw = false;
  try { await analyzeAudioSegments(`${DIR}p3b-voice.wav`, [{ start: 2, end: 1 }]); } catch { threw = true; }
  check('classify: bad segment throws', threw);
  let threw2 = false;
  try { await decodeAudioMonoF32(sceneMp4); } catch { threw2 = true; }
  check('classify: video-only file has no audio to decode', threw2);
  check('classify: hasAudio false on video-only', (await hasAudio(sceneMp4)) === false);
  check('classify: hasAudio true on wav', (await hasAudio(`${DIR}p3b-voice.wav`)) === true);
  // Direct feature check: music chord is steady, voice is bursty.
  const samples = await decodeAudioMonoF32(`${DIR}p3b-music.wav`);
  const f = audioSegmentFeatures(samples, SR, 0, 4);
  check('classify: chord peakFreqStd 0', f.peakFreqStd === 0, `std=${f.peakFreqStd}`);
  check('classify: rule fn agrees on music features', classifyFeatures(f).label === 'music');
}

// --- 3. subject tracking (synthetic mask video) ---
const maskMp4 = `${DIR}p3b-mask.mp4`;
if (!existsSync(maskMp4)) {
  const W = 64, H = 36, FPS = 10, DUR = 4;
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const frames = [];
  for (let f = 0; f < FPS * DUR; f++) {
    const cx = 10 + (54 - 10) * (f / (FPS * DUR - 1)) + (rnd() * 2 - 1) * 3;
    const g = Buffer.alloc(W * H, 0);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if ((x - cx) ** 2 + (y - 18) ** 2 <= 64) g[y * W + x] = 255;
    }
    frames.push(g);
  }
  writeFileSync(`${DIR}p3b-mask.gray`, Buffer.concat(frames));
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray',
    '-s', `${W}x${H}`, '-r', String(FPS), '-i', `${DIR}p3b-mask.gray`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', maskMp4]);
}
{
  const raw = await trackFromMaskVideo(maskMp4, { sampleFps: 10 });
  check('track: 40 points', raw.points.length === 40, `got ${raw.points.length}`);
  check('track: first x < 0.25', raw.points[0].x < 0.25, `x=${raw.points[0].x.toFixed(3)}`);
  check('track: last x > 0.75', raw.points[39].x > 0.75, `x=${raw.points[39].x.toFixed(3)}`);
  check('track: raw first < raw last', raw.points[0].x < raw.points[39].x);
  const sm = smoothTrack(raw, { window: 5, maxSpeed: 0.5 });
  const mono = sm.points.every((p, i) => i === 0 || p.x >= sm.points[i - 1].x - 0.01);
  check('track: smoothed x monotonic (jitter tol 0.01)', mono);
  check('track: none lost', raw.points.every((p) => !p.lost));
  const maxStep = (pts) => Math.max(...pts.slice(1).map((p, i) => Math.abs(p.x - pts[i].x)));
  const rawStep = maxStep(raw.points);
  const smStep = maxStep(sm.points);
  check('track: smoothing cuts max step', smStep < rawStep, `raw=${rawStep.toFixed(3)} smoothed=${smStep.toFixed(3)}`);
  check('track: smoothed still reaches right side', sm.points[39].x > 0.75, `x=${sm.points[39].x.toFixed(3)}`);
  const mid = trackCenterAt(sm, 2.0);
  check('track: centre at t=2 near 0.5', mid !== null && Math.abs(mid.x - 0.5) <= 0.08, mid ? `x=${mid.x.toFixed(3)}` : 'null');
  check('track: centre before start clamps to first', (() => {
    const c = trackCenterAt(sm, -1);
    return c !== null && Math.abs(c.x - sm.points[0].x) < 1e-9;
  })());
  // All-black mask: every frame lost, centre null, reframe refuses.
  const blackMp4 = `${DIR}p3b-black.mp4`;
  if (!existsSync(blackMp4)) {
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:r=10:d=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', blackMp4]);
  }
  const black = await trackFromMaskVideo(blackMp4, { sampleFps: 10 });
  check('track: black mask all lost', black.points.length > 0 && black.points.every((p) => p.lost));
  check('track: all-lost centre is null', trackCenterAt(black, 1.0) === null);
  let threw = false;
  try { reframeCropFilter(black, {}); } catch { threw = true; }
  check('track: reframe on all-lost track throws', threw);
}

// --- 4. reframe filter string ---
{
  const raw = await trackFromMaskVideo(maskMp4, { sampleFps: 10 });
  const sm = smoothTrack(raw);
  const f916 = reframeCropFilter(sm, { aspect: '9:16' });
  check('reframe: 9:16 crop string', f916.startsWith("crop=w='2*floor(min(ih*0.9800*9/16,iw)/2)'"), f916.slice(0, 60));
  check('reframe: x clamped with min/max', f916.includes('min(max(') && f916.includes('iw-ow'));
  check('reframe: default y centred', f916.includes("y='(ih-oh)/2'"), f916.slice(-40));
  const f11 = reframeCropFilter(sm, { aspect: '1:1' });
  check('reframe: 1:1 square window', f11.includes('min(iw,ih)'));
  const fY = reframeCropFilter(sm, { aspect: '9:16', followY: true });
  check('reframe: followY animates y', fY.includes('ih-oh') && !fY.includes("y='(ih-oh)/2'"));
  const fMargin = reframeCropFilter(sm, { aspect: '9:16', margin: 0.1 });
  check('reframe: margin 0.1 shrinks window', fMargin.includes('ih*0.9000'));
}

// --- 5. reframe export (synthetic track from the known ball path) ---
const ballMp4 = `${DIR}p3b-ball.mp4`;
if (!existsSync(ballMp4)) {
  await makeBallVideo(ballMp4, ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']);
}
{
  // Track built from the ball's ground-truth path: centre x = (100+120t)/640.
  const pts = [];
  for (let f = 0; f < 20; f++) {
    const t = f / 5;
    pts.push({ t, x: (100 + 120 * t) / 640, y: 170 / 360, lost: false, mass: 0.1 });
  }
  const track = { points: pts, sampleFps: 5, width: 640, height: 360 };
  const proj = { ...base, width: 360, height: 640, clips: [clip('c', ballMp4, { reframe: { aspect: '9:16' } })] };
  const g = buildFilterGraph(proj, FONT, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, new Map([[0, track]]));
  check('reframe: graph has crop stage', g.filterComplex.includes("crop=w='2*floor(min(ih*0.9800*9/16,iw)/2)'"));
  check('reframe: graph crop before scale', g.filterComplex.indexOf("crop=w='") < g.filterComplex.indexOf('scale=360:640'));
  let threw = false;
  try { buildFilterGraph(proj, FONT); } catch { threw = true; }
  check('reframe: graph without track throws', threw);
  // The end-to-end reframe export (ONNX track + exportProject) is in
  // §8, on the real person video — the ball video has no person, so
  // its ONNX track would be all-lost and reframe would rightly refuse.
}

// --- 6. follow-zoom keys (unit level) ---
{
  const pts = [];
  for (let f = 0; f < 20; f++) {
    const t = f / 5;
    pts.push({ t, x: (100 + 120 * t) / 640, y: 0.5, lost: false, mass: 0.1 });
  }
  const track = { points: pts, sampleFps: 5, width: 640, height: 360 };
  const voice = [{ start: 1, end: 2 }, { start: 2.8, end: 3.6 }];
  const keys = followZoomKeys(track, voice, {}, 4);
  const maxScale = Math.max(...keys.map((k) => k.scale));
  check('followZoom: max scale 1.35', maxScale === 1.35, `max=${maxScale}`);
  check('followZoom: min scale 1.0', Math.min(...keys.map((k) => k.scale)) === 1.0);
  check('followZoom: scale 1.35 mid-voice', Math.abs(zoomScaleAt(keys, 1.5) - 1.35) < 1e-9, `scale(1.5)=${zoomScaleAt(keys, 1.5).toFixed(3)}`);
  check('followZoom: scale 1.0 in silence', Math.abs(zoomScaleAt(keys, 0.5) - 1.0) < 1e-9, `scale(0.5)=${zoomScaleAt(keys, 0.5).toFixed(3)}`);
  check('followZoom: scale 1.0 after voice', Math.abs(zoomScaleAt(keys, 3.95) - 1.0) < 1e-9, `scale(3.95)=${zoomScaleAt(keys, 3.95).toFixed(3)}`);
  const midKey = keys.find((k) => k.t === 1);
  check('followZoom: centre follows track at push', midKey !== undefined && Math.abs(midKey.cx - (100 + 120 * 1.5) / 640) < 0.05, midKey ? `cx=${midKey.cx.toFixed(3)}` : 'no key at t=1');
  const ramp = zoomScaleAt(keys, 1 - 0.35 / 2);
  check('followZoom: ramp is gradual, not a step', ramp > 1.0 && ramp < 1.35, `scale=${ramp.toFixed(3)}`);
  const keys12 = followZoomKeys(track, voice, { maxScale: 1.2 }, 4);
  check('followZoom: maxScale 1.2 respected', Math.max(...keys12.map((k) => k.scale)) === 1.2);
  const staticTrack = { points: pts.map((p) => ({ ...p, x: 0.5 })), sampleFps: 5, width: 640, height: 360 };
  check('followZoom: no voice + no movement -> no keys', followZoomKeys(staticTrack, [], {}, 4).length === 0);
  const moveKeys = followZoomKeys(track, [], {}, 4);
  check('followZoom: no voice + moving subject -> movement keys', moveKeys.length > 0 && Math.max(...moveKeys.map((k) => k.scale)) === 1.35, `${moveKeys.length} keys`);
  const rfKeys = followZoomKeys(track, voice, {}, 4, true);
  check('followZoom: reframed keys stay centred', rfKeys.every((k) => k.cx === 0.5 && k.cy === 0.5));
}

// --- 7. follow-zoom export end to end (ball + voice 0-2s / silence 2-4s) ---
const ballVoiceMp4 = `${DIR}p3b-ballvoice.mp4`;
if (!existsSync(ballVoiceMp4)) {
  const v2 = voiceLike(2);
  const both = new Float32Array(SR * 4);
  both.set(v2, 0);
  wavS16(`${DIR}p3b-voice2s.wav`, both);
  await makeBallVideo(ballVoiceMp4, ['-i', `${DIR}p3b-voice2s.wav`]);
}
{
  const proj = { ...base, clips: [clip('c', ballVoiceMp4, { followZoom: {} })] };
  const prep = await prepareSmartCut(proj, DIR, { python: PY });
  const merged = prep.project.clips[0].zoom ?? [];
  check('followZoom export: prep merged keys', merged.length > 0, `${merged.length} keys`);
  check('followZoom export: merged max scale 1.35', merged.length > 0 && Math.max(...merged.map((k) => k.scale)) === 1.35);
  check('followZoom export: track prepared', prep.tracks.has(0));
  const rep = await exportProject(proj, `${DIR}p3b-follow.mp4`, {
    preset: PRESETS['720p30'], fontfile: FONT, python: PY,
  });
  check('followZoom export: duration err <= 0.1s', rep.durationError <= 0.1, `err=${rep.durationError.toFixed(3)}`);
  const ctrl = await exportProject(
    { ...base, clips: [clip('c', ballVoiceMp4)] },
    `${DIR}p3b-follow-ctrl.mp4`,
    { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('followZoom export: control duration ok', ctrl.durationError <= 0.1);
  const psnrVoice = await psnrFrame(`${DIR}p3b-follow.mp4`, `${DIR}p3b-follow-ctrl.mp4`, 1.0);
  check('followZoom export: voice-time frame differs (zoomed)', psnrVoice < 35, `PSNR=${psnrVoice}`);
  const psnrSil = await psnrFrame(`${DIR}p3b-follow.mp4`, `${DIR}p3b-follow-ctrl.mp4`, 3.0);
  check('followZoom export: silence-time frame ~identical', psnrSil >= 40, `PSNR=${psnrSil}`);
}

// --- 8. ONNX tracking integration (real person video) ---
{
  const person = `${DIR}p1e-person.mp4`;
  const proj = { ...base, clips: [clip('c', person, { reframe: { aspect: '9:16' } })] };
  const tracks = await prepareSubjectTracks(proj, DIR, { python: PY });
  const tr = tracks.get(0);
  check('onnx track: track exists', tr !== undefined);
  if (tr) {
    const lostFrac = tr.points.filter((p) => p.lost).length / tr.points.length;
    check('onnx track: mostly located', lostFrac < 0.5, `lost=${(lostFrac * 100).toFixed(0)}%`);
    check('onnx track: points in frame', tr.points.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1));
    check('onnx track: mask video written', existsSync(`${DIR}smartcut-c0-mask.mp4`));
  }
  // End-to-end reframe export on the real person video (9:16 project).
  const rep = await exportProject(
    { ...base, width: 360, height: 640, clips: [clip('c', person, { reframe: { aspect: '9:16' } })] },
    `${DIR}p3b-reframe.mp4`,
    { preset: PRESETS['720p30'], fontfile: FONT, python: PY },
  );
  check('reframe export: duration err <= 0.1s', rep.durationError <= 0.1, `err=${rep.durationError.toFixed(3)}`);
  check('reframe export: output is 360x640', rep.actual.width === 360 && rep.actual.height === 640, `${rep.actual.width}x${rep.actual.height}`);
}

// --- summary ---
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
if (failed.length > 0) process.exit(1);
