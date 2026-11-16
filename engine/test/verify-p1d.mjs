// P1 batch 4 engine verification (M4, 2026-11-17).
// Covers: audio-visual auto-alignment (src/align.ts) and the local
// template store (src/templates.ts + engine/templates/*.json).
// Measurement method (written down so the numbers can be re-derived):
// - Test audio is generated sample-exact in this file (Node WAV writer,
//   16-bit PCM, 44100 Hz): a base track of 10 IRREGULAR bursts
//   (0.4/1.1/1.9/2.6/3.8/4.3/5.2/6.1/6.9/7.6 s, distinct frequencies
//   300–740 Hz, 80 ms, -6 dBFS) over a quiet 110 Hz drone at -30 dBFS.
//   Irregular timing is deliberate: a periodic click train aliases in
//   cross-correlation (several lags score equally), while irregular
//   bursts give one unique peak. Delayed copies (+0.5 s, -0.3 s) are
//   made by shifting the same samples, so the true offset is known
//   exactly. Noise files are deterministic LCG white noise (different
//   seeds = unrelated content).
// - Offset estimation: normalised cross-correlation of the 10 ms RMS
//   envelopes (±5 s search), refined on raw samples (±30 ms, 1 s
//   window on the strongest envelope peak). Sign: estimateOffset(ref,
//   target) returns d with target(t) ≈ ref(t − d); positive = target
//   lags. To align, shift the target earlier by d (audioOffset = −d).
// - Alignment determinism was probed BEFORE writing assertions (the
//   vidstab lesson: vidstabdetect gave different .trf files on
//   identical input). Here the PCM decode is byte-identical 3x on the
//   same file (md5 85bad07c… x3) and estimateOffset returns byte-
//   identical results 3x on every test file — pure TypeScript on
//   deterministic PCM, so a single run IS a stable result. The test
//   still re-runs the +0.5 s estimation 3x and asserts identical
//   output, so a future nondeterminism would fail loudly.
// - Confidence bars were set FROM the probe, not guessed: matched
//   content conf=1.000, peakRatio 1.38–1.39; unrelated noise conf
//   0.095–0.114, peakRatio 1.01–1.02; silence conf=0. The reliable
//   bars (confidence >= 0.5, peakRatio >= 1.2) sit between matched and
//   unrelated with margin on both sides.
// - Export-shift verification re-measures the residual offset AFTER
//   export (decode the MP4 audio, estimateOffset vs the reference):
//   mic +0.5 s with audioOffset -0.5 leaves residual -0.0015 s
//   (conf 0.908); mic -0.3 s with +0.3 leaves -0.0014 s (conf 0.983);
//   the no-shift control still measures +0.4985 s — the estimator
//   sees the real delay, it does not rubber-stamp the shift.
// - Template frame checks: PSNR of a frame at t=2.0 (subtitles
//   visible 0.5–3.5 s) vs the untemplated control. Probe: talking-clean
//   4.91 (subtitle burn), vlog-film 16.91 (warm colour + title),
//   beat-energetic 5.29 (emphasis + pulse at a beat). Bar is < 25.
// - LGPL: align.ts is our own code + ffmpeg decode; the shift uses
//   adelay/atrim/apad (native libavfilter, LGPL part — still to be
//   re-checked on the BtbN LGPL 9.0 build at the M2 gate). Templates
//   add no new filters. All of this was verified on the local GPL
//   8.1.2 build only.
// Old M1 / P0 / P0b / P1 / P1b / P1c checks live in their own files
// and must still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import {
  applyTemplateToClip,
  applyTemplateToProject,
  audioShiftFilter,
  estimateOffset,
  exportProject,
  loadAllBuiltInTemplates,
  loadBuiltInTemplate,
  parseTemplate,
  probe,
  PRESETS,
  serializeTemplate,
  shiftClipAudioToReference,
  validateAudioOffset,
} from '../dist/export.js';
import { buildFilterGraph } from '../dist/filtergraph.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const SR = 44100;

const checks = [];
const check = (name, ok, detail = '') =>
  checks.push([`${name}${detail ? ` (${detail})` : ''}`, ok]);

async function run(cmd, args, opts = {}) {
  return exec(cmd, args, { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer', ...opts });
}

async function psnr(a, b) {
  const r = await exec('ffmpeg', ['-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-']).catch((e) => e);
  const m = ((r.stderr ?? '') + (r.stdout ?? '')).match(/average:([0-9.inf]+)/);
  if (!m) return NaN;
  return m[1] === 'inf' ? 999 : Number(m[1]);
}

async function hasBlackSegments(file) {
  const bd = await exec('ffmpeg', ['-i', file, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-']).catch((e) => e);
  return /black_start/.test((bd.stderr ?? '') + (bd.stdout ?? ''));
}

async function framePng(file, ss, out) {
  await run('ffmpeg', ['-ss', String(ss), '-i', file, '-frames:v', '1', '-y', out]);
}

// --- sample-exact WAV writer (16-bit PCM, mono) ---
function writeWav(path, samples, sampleRate = SR) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

const BURSTS = [
  [0.4, 300], [1.1, 520], [1.9, 440], [2.6, 660], [3.8, 380],
  [4.3, 740], [5.2, 500], [6.1, 610], [6.9, 350], [7.6, 580],
];
function baseAudio(durSec = 8) {
  const n = Math.floor(durSec * SR);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    s[i] = 0.0316 * Math.sin(2 * Math.PI * 110 * t);
    for (const [bt, f] of BURSTS) {
      if (t >= bt && t < bt + 0.08) s[i] += 0.5012 * Math.sin(2 * Math.PI * f * t);
    }
  }
  return s;
}
function shiftAudio(s, delaySec) {
  const n = s.length;
  const out = new Float32Array(n);
  const shift = Math.round(delaySec * SR);
  for (let i = 0; i < n; i++) {
    const src = i - shift;
    out[i] = src >= 0 && src < n ? s[src] : 0;
  }
  return out;
}
function noiseAudio(seed, durSec = 8) {
  const n = Math.floor(durSec * SR);
  const s = new Float32Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (1103515245 * x + 12345) >>> 0;
    s[i] = ((x / 2147483648) - 1) * 0.3;
  }
  return s;
}

const base = baseAudio();
writeWav(`${DIR}p1d-ref.wav`, base);
writeWav(`${DIR}p1d-mic-plus05.wav`, shiftAudio(base, 0.5));
writeWav(`${DIR}p1d-mic-minus03.wav`, shiftAudio(base, -0.3));
writeWav(`${DIR}p1d-noise1.wav`, noiseAudio(12345));
writeWav(`${DIR}p1d-noise2.wav`, noiseAudio(99999));
writeWav(`${DIR}p1d-silence.wav`, new Float32Array(base.length));

async function mkVideo(audioWav, out) {
  await run('ffmpeg', ['-f', 'lavfi', '-i', 'testsrc2=duration=8:size=640x360:rate=30',
    '-i', audioWav, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', out]);
}
await mkVideo(`${DIR}p1d-ref.wav`, `${DIR}p1d-vid-ref.mp4`);
await mkVideo(`${DIR}p1d-mic-plus05.wav`, `${DIR}p1d-vid-plus05.mp4`);
await mkVideo(`${DIR}p1d-mic-minus03.wav`, `${DIR}p1d-vid-minus03.mp4`);

const base640 = { version: 1, width: 640, height: 360, fps: 30, transitionDuration: 0.5 };
const REF = `${DIR}p1d-ref.wav`;
const SUBS = [
  { start: 0.5, end: 3.5, text: '你好世界', words: [] },
  { start: 4.0, end: 7.5, text: '模板测试', words: [] },
];
const GRID120 = { bpm: 120, period: 0.5, beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5], onsets: [], confidence: 1, duration: 8 };

// --- 0. graph-string + validation checks (no encode) ---
{
  const c0 = { id: 'c', source: `${DIR}p1d-vid-ref.mp4`, in: 0, out: 8, speed: 1, volume: 1 };
  const gPos = buildFilterGraph({ ...base640, clips: [{ ...c0, audioOffset: 0.3 }], transitions: [] }, FONT);
  check('graph: +0.3 shift uses adelay=300', gPos.filterComplex.includes('adelay=300:all=1'));
  const gNeg = buildFilterGraph({ ...base640, clips: [{ ...c0, audioOffset: -0.5 }], transitions: [] }, FONT);
  check('graph: -0.5 shift cuts the head (atrim start=0.5)', gNeg.filterComplex.includes('atrim=start=0.5'));
  check('graph: unshifted clip has no adelay/atrim shift', !buildFilterGraph({ ...base640, clips: [c0], transitions: [] }, FONT).filterComplex.includes('adelay='));
  check('shift filter: +0.3 is adelay+trim', audioShiftFilter(0.3, 8).startsWith('adelay=300:all=1'));
  check('shift filter: -0.5 is atrim+apad', audioShiftFilter(-0.5, 8).startsWith('atrim=start=0.5'));
  check('shift filter: 0 is anull', audioShiftFilter(0, 8) === 'anull');
  const bad = (clip) => {
    let threw = false;
    try { validateAudioOffset(clip); } catch { threw = true; }
    return threw;
  };
  check('validate: audioOffset 11 rejected', bad({ ...c0, audioOffset: 11 }));
  check('validate: audioOffset -11 rejected', bad({ ...c0, audioOffset: -11 }));
  check('validate: audioOffset 8 (= clip length) rejected', bad({ ...c0, audioOffset: 8 }));
  check('validate: audioOffset NaN rejected', bad({ ...c0, audioOffset: NaN }));
  check('validate: audioOffset 0.3 accepted', validateAudioOffset({ ...c0, audioOffset: 0.3 }) === 0.3);
  const shifted = shiftClipAudioToReference(c0, 0.5);
  check('helper: offset +0.5 -> audioOffset -0.5', shifted.audioOffset === -0.5, `audioOffset=${shifted.audioOffset}`);
  const shifted2 = shiftClipAudioToReference(c0, -0.3);
  check('helper: offset -0.3 -> audioOffset +0.3', shifted2.audioOffset === 0.3, `audioOffset=${shifted2.audioOffset}`);
  let threwNaN = false;
  try { shiftClipAudioToReference(c0, NaN); } catch { threwNaN = true; }
  check('helper: NaN offset rejected', threwNaN);
}

// --- A. offset estimation: known delays + determinism + no-peak cases ---
async function offsetCheck(file, truth, label) {
  const r = await estimateOffset(REF, `${DIR}${file}`);
  console.log(`${label}: offset=${r.offsetSec.toFixed(4)} (true ${truth}) conf=${r.confidence.toFixed(3)} ratio=${Number.isFinite(r.peakRatio) ? r.peakRatio.toFixed(2) : 'Inf'} reliable=${r.reliable}`);
  check(`${label} offset error < 0.05s`, Math.abs(r.offsetSec - truth) < 0.05, `offset=${r.offsetSec.toFixed(4)} true=${truth}`);
  check(`${label} confidence >= 0.5`, r.confidence >= 0.5, `conf=${r.confidence.toFixed(3)}`);
  check(`${label} reliable`, r.reliable);
  return r;
}
await offsetCheck('p1d-mic-plus05.wav', 0.5, 'A mic +0.5s');
await offsetCheck('p1d-mic-minus03.wav', -0.3, 'A mic -0.3s');
await offsetCheck('p1d-ref.wav', 0, 'A identical (0s)');
{
  const s = (r) => JSON.stringify([r.offsetSec, r.confidence, r.peakRatio, r.reliable]);
  const r1 = await estimateOffset(REF, `${DIR}p1d-mic-plus05.wav`);
  const r2 = await estimateOffset(REF, `${DIR}p1d-mic-plus05.wav`);
  const r3 = await estimateOffset(REF, `${DIR}p1d-mic-plus05.wav`);
  check('A estimation is deterministic (3x identical)', s(r1) === s(r2) && s(r2) === s(r3));
}
{
  const rN = await estimateOffset(`${DIR}p1d-noise1.wav`, `${DIR}p1d-noise2.wav`);
  console.log(`A noise vs noise: offset=${rN.offsetSec.toFixed(4)} conf=${rN.confidence.toFixed(3)} ratio=${Number.isFinite(rN.peakRatio) ? rN.peakRatio.toFixed(2) : 'Inf'} reliable=${rN.reliable}`);
  check('A unrelated noise: not reliable', !rN.reliable, `conf=${rN.confidence.toFixed(3)}`);
  check('A unrelated noise: confidence < 0.5', rN.confidence < 0.5, `conf=${rN.confidence.toFixed(3)}`);
  const rS = await estimateOffset(`${DIR}p1d-silence.wav`, REF);
  console.log(`A silence vs signal: offset=${rS.offsetSec.toFixed(4)} conf=${rS.confidence.toFixed(3)} reliable=${rS.reliable}`);
  check('A silence vs signal: not reliable', !rS.reliable, `conf=${rS.confidence.toFixed(3)}`);
  check('A silence vs signal: confidence ~0', rS.confidence < 0.1, `conf=${rS.confidence.toFixed(3)}`);
  const rNS = await estimateOffset(`${DIR}p1d-noise1.wav`, REF);
  check('A noise vs signal: not reliable', !rNS.reliable, `conf=${rNS.confidence.toFixed(3)}`);
}

// --- B. export shift: apply the measured offset, re-measure residual ---
async function shiftExport(clip, out, label, expectResidual) {
  const rep = await exportProject({ ...base640, clips: [clip], transitions: [] }, out, { preset: PRESETS['720p30'], fontfile: FONT });
  check(`${label} duration ~8.0s`, rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check(`${label} has audio`, rep.actual.hasAudio);
  const r = await estimateOffset(REF, out);
  console.log(`${label}: residual offset=${r.offsetSec.toFixed(4)}s conf=${r.confidence.toFixed(3)} reliable=${r.reliable}`);
  check(`${label} residual offset < 0.05s`, Math.abs(r.offsetSec - expectResidual) < 0.05, `residual=${r.offsetSec.toFixed(4)}s`);
  check(`${label} residual is reliable`, r.reliable, `conf=${r.confidence.toFixed(3)}`);
  return rep;
}
await shiftExport(
  { id: 'c', source: `${DIR}p1d-vid-plus05.mp4`, in: 0, out: 8, speed: 1, volume: 1, audioOffset: -0.5 },
  `${DIR}p1d-out-a.mp4`, 'B mic+0.5 shift -0.5', 0,
);
await shiftExport(
  { id: 'c', source: `${DIR}p1d-vid-minus03.mp4`, in: 0, out: 8, speed: 1, volume: 1, audioOffset: 0.3 },
  `${DIR}p1d-out-b.mp4`, 'B mic-0.3 shift +0.3', 0,
);
await shiftExport(
  { id: 'c', source: `${DIR}p1d-vid-plus05.mp4`, in: 0, out: 8, speed: 1, volume: 1 },
  `${DIR}p1d-out-c.mp4`, 'B mic+0.5 no shift (control)', 0.5,
);
{
  // Full workflow: measure, then apply via the helper, then re-measure.
  const est = await estimateOffset(REF, `${DIR}p1d-mic-plus05.wav`);
  const clip0 = { id: 'c', source: `${DIR}p1d-vid-plus05.mp4`, in: 0, out: 8, speed: 1, volume: 1 };
  const aligned = shiftClipAudioToReference(clip0, est.offsetSec);
  check('B workflow: helper sets audioOffset -0.5 from measured +0.5', Math.abs((aligned.audioOffset ?? 0) + 0.5) < 0.01,
    `audioOffset=${aligned.audioOffset}`);
  await shiftExport(aligned, `${DIR}p1d-out-w.mp4`, 'B workflow measure+shift', 0);
}

// --- C. template store: load, round-trip, apply, reject bad ones ---
const clip0 = { id: 'c', source: `${DIR}p1d-vid-ref.mp4`, in: 0, out: 8, speed: 1, volume: 1 };
{
  const all = loadAllBuiltInTemplates();
  check('C 4 built-in templates load', all.length === 4, `n=${all.length}`);
  check('C built-in ids are the 4 expected', ['talking-clean', 'vlog-film', 'beat-energetic', 'interview-duo'].every((id) => all.some((t) => t.id === id)));
  for (const t of all) {
    const rt = parseTemplate(serializeTemplate(t));
    check(`C ${t.id} JSON round-trip identical`, JSON.stringify(rt) === JSON.stringify(t));
  }
  const clean = loadBuiltInTemplate('talking-clean');
  const c1 = applyTemplateToClip(clip0, clean, { subtitles: SUBS });
  check('C talking-clean sets lowerThird style (fontsize 40)', c1.subtitleStyle?.fontsize === 40, `fontsize=${c1.subtitleStyle?.fontsize}`);
  check('C talking-clean attaches subtitles', (c1.subtitles ?? []).length === 2);
  check('C talking-clean adds auto-zoom keys', (c1.zoom ?? []).length > 0, `keys=${(c1.zoom ?? []).length}`);
  check('C talking-clean sets fades 0.3/0.3', c1.audioFadeIn === 0.3 && c1.audioFadeOut === 0.3);
  check('C talking-clean leaves source/in/out untouched', c1.source === clip0.source && c1.in === 0 && c1.out === 8 && c1.speed === 1);
  // Applied values are individually editable afterwards.
  const edited = { ...c1, color: { brightness: 0.1 } };
  check('C applied template values are editable (override colour)', edited.color?.brightness === 0.1 && edited.subtitleStyle?.fontsize === 40);
  const film = loadBuiltInTemplate('vlog-film');
  const c2 = applyTemplateToClip(clip0, film, { subtitles: SUBS });
  check('C vlog-film sets warm colour (brightness 0.02)', c2.color?.brightness === 0.02, `brightness=${c2.color?.brightness}`);
  check('C vlog-film sets title style (fontsize 72)', c2.subtitleStyle?.fontsize === 72, `fontsize=${c2.subtitleStyle?.fontsize}`);
  const duo = loadBuiltInTemplate('interview-duo');
  const p2 = { ...base640, clips: [clip0, clip0], transitions: ['cut'] };
  const pDuo = applyTemplateToProject(p2, duo, { subtitles: SUBS });
  check('C interview-duo sets project transition to fade', pDuo.transitions[0] === 'fade', `transition=${pDuo.transitions[0]}`);
  check('C interview-duo sets transitionDuration 0.6', pDuo.transitionDuration === 0.6, `d=${pDuo.transitionDuration}`);
  check('C template does NOT resize the project (canvas is a suggestion)', pDuo.width === 640 && pDuo.height === 360);
  const beat = loadBuiltInTemplate('beat-energetic');
  let threwNoBeats = false;
  try { applyTemplateToClip(clip0, beat, { subtitles: SUBS }); } catch { threwNoBeats = true; }
  check('C beat-energetic without beats throws (no silent skip)', threwNoBeats);
  const c3 = applyTemplateToClip(clip0, beat, { subtitles: SUBS, beats: GRID120 });
  check('C beat-energetic with beats adds pulse keys', (c3.zoom ?? []).length > 0, `keys=${(c3.zoom ?? []).length}`);
  check('C beat-energetic sets emphasis style (fontsize 96)', c3.subtitleStyle?.fontsize === 96, `fontsize=${c3.subtitleStyle?.fontsize}`);
  // Bad templates are rejected, never silently skipped.
  const bad = (obj, why) => {
    let threw = false;
    try { parseTemplate(JSON.stringify(obj)); } catch { threw = true; }
    return threw;
  };
  const good = { id: 'x', label: 'X', description: 'x', transition: 'cut' };
  check('C reject: unknown transition', bad({ ...good, transition: 'spinzoom' }));
  check('C reject: unknown text style preset', bad({ ...good, textStylePreset: 'neon-glow' }));
  check('C reject: unknown colour preset', bad({ ...good, colorPreset: 'vaporwave' }));
  check('C reject: unknown field', bad({ ...good, secretSauce: true }));
  check('C reject: missing id', bad({ label: 'X', description: 'x' }));
  check('C reject: missing label', bad({ id: 'x', description: 'x' }));
  check('C reject: bad mask shape', bad({ ...good, mask: { shape: 'triangle', x: 0.5, y: 0.5, w: 0.3, h: 0.3 } }));
  check('C reject: preset + inline style both set', bad({ ...good, textStylePreset: 'title', textStyle: { x: 0.5, y: 0.5, fontsize: 40, fontcolor: 'white' } }));
  check('C reject: invalid JSON', (() => { try { parseTemplate('{not json'); return false; } catch { return true; } })());
  check('C reject: unknown built-in id', (() => { try { loadBuiltInTemplate('no-such-template'); return false; } catch { return true; } })());
}

// --- D. template exports: real renders, frame-level visibility ---
{
  const pCtrl = { ...base640, clips: [clip0], transitions: [] };
  await exportProject(pCtrl, `${DIR}p1d-tpl-ctrl.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  await framePng(`${DIR}p1d-tpl-ctrl.mp4`, 2.0, `${DIR}p1d-f-ctrl.png`);
  async function tplExport(id, opts, label) {
    const tpl = loadBuiltInTemplate(id);
    const p = applyTemplateToProject({ ...base640, clips: [clip0], transitions: [] }, tpl, opts);
    const rep = await exportProject(p, `${DIR}p1d-tpl-${id}.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
    check(`${label} duration ~8.0s`, rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
    check(`${label} has audio`, rep.actual.hasAudio);
    check(`${label} no black segments`, !(await hasBlackSegments(`${DIR}p1d-tpl-${id}.mp4`)));
    const pr = await probe(`${DIR}p1d-tpl-${id}.mp4`);
    check(`${label} output is 640x360 (template did not resize)`, pr.width === 640 && pr.height === 360, `${pr.width}x${pr.height}`);
    await framePng(`${DIR}p1d-tpl-${id}.mp4`, 2.0, `${DIR}p1d-f-${id}.png`);
    const ps = await psnr(`${DIR}p1d-f-${id}.png`, `${DIR}p1d-f-ctrl.png`);
    check(`${label} frame at t=2.0 differs from control`, ps < 25, `PSNR=${ps}`);
    return rep;
  }
  await tplExport('talking-clean', { subtitles: SUBS }, 'D talking-clean export');
  await tplExport('vlog-film', { subtitles: SUBS }, 'D vlog-film export');
  await tplExport('beat-energetic', { subtitles: SUBS, beats: GRID120 }, 'D beat-energetic export');
}

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? 'ALL P1D CHECKS PASSED' : `${failed} P1D CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
