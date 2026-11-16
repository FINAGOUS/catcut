// P1 batch 3 engine verification (M4, 2026-11-17).
// Covers: beat detection + automatic beat-cutting (src/beat.ts) and
// audio ducking (src/ducking.ts, sidechaincompress).
// Measurement method (written down so the numbers can be re-derived):
// - Test audio is generated sample-exact in this file (Node WAV writer,
//   16-bit PCM, 44100 Hz): click tracks at 120/90/140 BPM (1000 Hz
//   bursts, 60 ms, -6 dBFS, on the beat, plus a quiet 110 Hz drone at
//   -30 dBFS so the file is never silent between clicks); a voice-like
//   file (440 Hz tone at -6 dBFS during [0.5,2.5] and [4.5,6.5],
//   silence elsewhere); music is a continuous 220 Hz sine at -12 dBFS.
// - Beat alignment: a detected beat counts as aligned if it is within
//   0.05 s of a true beat. One structural miss is expected and is NOT
//   a failure: a click exactly at t=0 is invisible to the onset
//   envelope (the analysis starts with the click already inside the
//   first window, so there is no energy jump to detect) — the grid's
//   phase anchor is the first DETECTED onset, so the 120/90 BPM grids
//   have 15/16 and 11/12 beats. The bar is therefore aligned/detected
//   >= 0.80 AND median error over detected beats <= 0.01 s — the grid
//   is on the beats, with the documented edge case allowed.
// - Beat-detection determinism was probed BEFORE writing assertions
//   (the vidstab lesson: vidstabdetect gave different .trf files on
//   identical input, and a 23-sample jitter metric swung 1.25/6.46/
//   1.28/4.71 on the same output). Here the PCM decode is byte-
//   identical across 3 runs (md5 8340643f… x3) and detectBeats returns
//   byte-identical grids 3x on every tempo — the detection is pure
//   TypeScript on deterministic PCM, so a single run IS a stable
//   result. The test still re-runs the 120 BPM detection 3x and
//   asserts identical output, so a future nondeterminism would fail
//   loudly instead of passing by luck.
// - Two measurement bugs were found and fixed during probing, both
//   recorded here so they are not re-introduced: (a) the coarse onset
//   envelope fires up to one window (64 ms) BEFORE the attack, so
//   unrefined onsets sat 52 ms early and only 3/16 beats aligned;
//   refineOnsets() now finds the first sample crossing 25% of the
//   local peak (probe: maxErr 0.0001 s). (b) The first refinement
//   searched [-80 ms, +40 ms] around the coarse onset and set its
//   threshold from the quiet drone in front of the click, "finding"
//   the drone 131 ms early; the window is now [-10 ms, +80 ms] so the
//   peak is measured over a range that actually contains the attack.
// - Ducking levels come from volumedetect mean_volume on 1 s windows
//   (voice speaking [1.0,2.0] and [5.0,6.0], silent [3.0,4.0]).
//   Probe numbers (raw ffmpeg, threshold -20 dB / ratio 8 / attack
//   20 ms / release 250 ms): control voice-on -15.0 dB, ducked
//   voice-on -26.7 dB (reduction 11.7 dB), voice-off -15.0 dB
//   (recovery 0.0 dB); duckDb=6 gives voice-on -32.6 dB (reduction
//   17.6 dB, i.e. exactly 6 dB more). Bars in the test leave margin
//   under the probed numbers (>= 6 dB reduction, +/- 1 dB recovery,
//   >= 14 dB with duckDb=6).
// - The ducking sidechain is a CONTROL signal only: it is never mixed
//   into the output. It is used from its own t=0, aligned to the
//   clip-local timeline (v1 limitation, documented in ducking.ts).
// Old M1 / P0 / P0b / P1 / P1b checks live in their own files and must
// still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import {
  applyBeatPulse,
  beatPulseKeys,
  detectBeats,
  duckingEffectiveThresholdDb,
  exportProject,
  probe,
  PRESETS,
  splitClipByBeats,
  zoomScaleAt,
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

/** Mean volume (dB) of a 1 s window, via volumedetect. */
async function meanVolume(file, ss, dur = 1) {
  const r = await exec('ffmpeg', ['-v', 'info', '-ss', String(ss), '-t', String(dur), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-']).catch((e) => e);
  const m = ((r.stderr ?? '') + (r.stdout ?? '')).match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : null;
}

/** Extract one frame as PNG. */
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

function clickTrack(bpm, durSec, path) {
  const n = Math.floor(durSec * SR);
  const s = new Float32Array(n);
  const period = 60 / bpm;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    s[i] = 0.0316 * Math.sin(2 * Math.PI * 110 * t);
    if (t % period < 0.06) s[i] += 0.5012 * Math.sin(2 * Math.PI * 1000 * t);
  }
  writeWav(path, s);
  return Array.from({ length: Math.floor(durSec / period) + 1 }, (_, k) => k * period).filter((t) => t < durSec);
}

const TRUE120 = clickTrack(120, 8, `${DIR}p1c-click-120.wav`);
const TRUE90 = clickTrack(90, 8, `${DIR}p1c-click-90.wav`);
const TRUE140 = clickTrack(140, 8, `${DIR}p1c-click-140.wav`);
// Voice-like file: 440 Hz at -6 dBFS during two bursts, silence elsewhere.
{
  const n = Math.floor(8 * SR);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if ((t >= 0.5 && t < 2.5) || (t >= 4.5 && t < 6.5)) s[i] = 0.5012 * Math.sin(2 * Math.PI * 440 * t);
  }
  writeWav(`${DIR}p1c-voice.wav`, s);
}
// Music video source: testsrc2 + continuous 220 Hz sine at -12 dBFS.
{
  const n = Math.floor(8 * SR);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.2512 * Math.sin(2 * Math.PI * 220 * (i / SR));
  writeWav(`${DIR}p1c-music.wav`, s);
}
await run('ffmpeg', ['-f', 'lavfi', '-i', 'testsrc2=duration=8:size=640x360:rate=30',
  '-i', `${DIR}p1c-click-120.wav`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', `${DIR}p1c-click.mp4`]);
await run('ffmpeg', ['-f', 'lavfi', '-i', 'testsrc2=duration=8:size=640x360:rate=30',
  '-i', `${DIR}p1c-music.wav`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', `${DIR}p1c-music.mp4`]);

const base640 = { version: 1, width: 640, height: 360, fps: 30, transitionDuration: 0.5 };
const VOICE = `${DIR}p1c-voice.wav`;

// --- 0. graph-string + validation checks (no encode) ---
{
  const duck = { source: VOICE, thresholdDb: -20, ratio: 8, attackMs: 20, releaseMs: 250 };
  const p = { ...base640, clips: [{ id: 'c', source: `${DIR}p1c-music.mp4`, in: 0, out: 8, speed: 1, volume: 1, ducking: duck }], transitions: [] };
  const g = buildFilterGraph(p, FONT);
  check('graph: sidechaincompress in audio chain', g.filterComplex.includes('sidechaincompress=threshold=0.1:ratio=8:attack=20:release=250'));
  check('graph: ducking source is an extra input', g.extraInputs.length === 1 && g.extraInputs[0] === VOICE);
  const eff = duckingEffectiveThresholdDb({ thresholdDb: -20, ratio: 8, duckDb: 6 });
  check('duckDb=6 lowers effective threshold by ~6.86 dB', Math.abs(eff - (-26.857)) < 0.01, `eff=${eff.toFixed(3)} dB`);
  const bad = (ducking, why) => {
    let threw = false;
    try {
      buildFilterGraph({ ...base640, clips: [{ id: 'c', source: `${DIR}p1c-music.mp4`, in: 0, out: 8, speed: 1, volume: 1, ducking }], transitions: [] }, FONT);
    } catch { threw = true; }
    return threw;
  };
  check('validate: thresholdDb -70 rejected', bad({ source: VOICE, thresholdDb: -70 }));
  check('validate: thresholdDb +5 rejected', bad({ source: VOICE, thresholdDb: 5 }));
  check('validate: ratio 0 rejected', bad({ source: VOICE, ratio: 0 }));
  check('validate: ratio 25 rejected', bad({ source: VOICE, ratio: 25 }));
  check('validate: attackMs 0 rejected', bad({ source: VOICE, attackMs: 0 }));
  check('validate: releaseMs 5 rejected', bad({ source: VOICE, releaseMs: 5 }));
  check('validate: duckDb 31 rejected', bad({ source: VOICE, duckDb: 31 }));
  check('validate: duckDb -1 rejected', bad({ source: VOICE, duckDb: -1 }));
  check('validate: missing source rejected', bad({}));
  check('validate: ratio 1 + duckDb rejected', bad({ source: VOICE, ratio: 1, duckDb: 5 }));
  const badSplit = (clip, why) => {
    let threw = false;
    try {
      splitClipByBeats(clip, { bpm: 120, period: 0.5, beats: [0.5, 1], onsets: [], confidence: 1, duration: 8 });
    } catch { threw = true; }
    return threw;
  };
  const c0 = { id: 'c', source: `${DIR}p1c-click.mp4`, in: 0, out: 8, speed: 1, volume: 1 };
  check('validate: beat-cut rejects speedCurve', badSplit({ ...c0, speedCurve: [{ t: 0, speed: 2 }] }));
  check('validate: beat-cut rejects reverse', badSplit({ ...c0, reverse: true }));
  check('validate: beat-cut rejects offset 0.6', (() => {
    try { splitClipByBeats(c0, { bpm: 120, period: 0.5, beats: [0.5], onsets: [], confidence: 1, duration: 8 }, { offset: 0.6 }); return false; } catch { return true; }
  })());
  check('validate: beat-cut rejects minSegment 0.05', (() => {
    try { splitClipByBeats(c0, { bpm: 120, period: 0.5, beats: [0.5], onsets: [], confidence: 1, duration: 8 }, { minSegment: 0.05 }); return false; } catch { return true; }
  })());
  // Beat-pulse key shape (unit level, no encode).
  const keys = beatPulseKeys([2.0, 2.5, 3.0], { pulseScale: 1.15 });
  check('pulse: scale at a beat is 1.15', Math.abs(zoomScaleAt(keys, 2.0) - 1.15) < 0.01, `scale(2.0)=${zoomScaleAt(keys, 2.0).toFixed(2)}`);
  check('pulse: scale between beats is back to 1.0', Math.abs(zoomScaleAt(keys, 2.25) - 1.0) < 0.01, `scale(2.25)=${zoomScaleAt(keys, 2.25).toFixed(2)}`);
}

// --- A. beat detection: 3 tempos + 3x repeat determinism ---
async function beatCheck(file, trueBpm, trueBeats, label) {
  const g = await detectBeats(`${DIR}${file}`);
  const errs = g.beats.map((b) => Math.min(...trueBeats.map((t) => Math.abs(t - b))));
  const aligned = errs.filter((e) => e <= 0.05).length;
  const sorted = errs.slice().sort((a, b) => a - b);
  const medianErr = sorted[Math.floor(sorted.length / 2)];
  console.log(`${label}: bpm=${g.bpm.toFixed(2)} (true ${trueBpm}) beats=${g.beats.length} aligned=${aligned}/${g.beats.length} medianErr=${medianErr.toFixed(4)}s conf=${g.confidence.toFixed(3)}`);
  check(`${label} BPM error < 2`, Math.abs(g.bpm - trueBpm) < 2, `bpm=${g.bpm.toFixed(2)} true=${trueBpm}`);
  check(`${label} >= 80% of beats aligned within 0.05s`, aligned >= g.beats.length * 0.8, `${aligned}/${g.beats.length}`);
  check(`${label} median beat error <= 0.01s`, medianErr <= 0.01, `median=${medianErr.toFixed(4)}s`);
  check(`${label} confidence >= 0.5`, g.confidence >= 0.5, `conf=${g.confidence.toFixed(3)}`);
  return g;
}
const g120 = await beatCheck('p1c-click-120.wav', 120, TRUE120, 'A 120 BPM');
await beatCheck('p1c-click-90.wav', 90, TRUE90, 'A 90 BPM');
await beatCheck('p1c-click-140.wav', 140, TRUE140, 'A 140 BPM');
{
  // Determinism: 3x detection on the same file must be identical.
  const r1 = await detectBeats(`${DIR}p1c-click-120.wav`);
  const r2 = await detectBeats(`${DIR}p1c-click-120.wav`);
  const r3 = await detectBeats(`${DIR}p1c-click-120.wav`);
  const s = (g) => JSON.stringify([g.bpm, g.beats, g.onsets, g.confidence]);
  check('A detection is deterministic (3x identical)', s(r1) === s(r2) && s(r2) === s(r3));
}

// --- B. beat split: 8 s clip at 120 BPM ---
const clickClip = { id: 'c', source: `${DIR}p1c-click.mp4`, in: 0, out: 8, speed: 1, volume: 1 };
{
  const parts = splitClipByBeats(clickClip, g120);
  check('B split gives 16 clips (15 cuts)', parts.length === 16, `n=${parts.length}`);
  // Beat times are sample-accurate (~0.1 ms), not exact, so boundaries
  // are checked to 1 ms, not 1 us.
  check('B first clip is [0, 0.5)', Math.abs(parts[0].in - 0) < 1e-3 && Math.abs(parts[0].out - 0.5) < 1e-3,
    `[${parts[0].in.toFixed(4)}, ${parts[0].out.toFixed(4)})`);
  check('B last clip is [7.5, 8)', Math.abs(parts[15].in - 7.5) < 1e-3 && Math.abs(parts[15].out - 8) < 1e-3,
    `[${parts[15].in.toFixed(4)}, ${parts[15].out.toFixed(4)})`);
  check('B every segment is 0.5 s', parts.every((c) => Math.abs(c.out - c.in - 0.5) < 1e-3));
  const coarse = splitClipByBeats(clickClip, g120, { minSegment: 1.0 });
  check('B minSegment 1.0 merges to 8 clips', coarse.length === 8, `n=${coarse.length}`);
  // Offset -0.05 with the default minSegment 0.5 would drop the first
  // cut (the [0, 0.45) segment is shorter than minSegment) — that is
  // correct min-segment behaviour, not an offset bug. Test the offset
  // with minSegment 0.4 so the 0.45 s first segment survives.
  const shifted = splitClipByBeats(clickClip, g120, { offset: -0.05, minSegment: 0.4 });
  check('B offset -0.05 shifts the first cut to 0.45', Math.abs(shifted[0].out - 0.45) < 1e-3, `first cut=${shifted[0].out.toFixed(4)}`);
  // Real export of the 16-way split.
  const p = { ...base640, clips: parts, transitions: [] };
  const rep = await exportProject(p, `${DIR}p1c-split.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('B split export duration ~8.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check('B split export has audio', rep.actual.hasAudio);
  check('B split export no black segments', !(await hasBlackSegments(`${DIR}p1c-split.mp4`)));
}

// --- C. beat pulse: zoom keys + frame-level export check ---
{
  const pulsed = applyBeatPulse(clickClip, g120, { pulseScale: 1.15 });
  check('C pulse keys from grid (15 beats -> keys)', (pulsed.zoom ?? []).length > 0, `keys=${(pulsed.zoom ?? []).length}`);
  check('C pulse scale at beat 2.0 is 1.15', Math.abs(zoomScaleAt(pulsed.zoom ?? [], 2.0) - 1.15) < 0.01,
    `scale(2.0)=${zoomScaleAt(pulsed.zoom ?? [], 2.0).toFixed(2)}`);
  check('C pulse scale at gap 2.25 is 1.0', Math.abs(zoomScaleAt(pulsed.zoom ?? [], 2.25) - 1.0) < 0.01,
    `scale(2.25)=${zoomScaleAt(pulsed.zoom ?? [], 2.25).toFixed(2)}`);
  const pPulse = { ...base640, clips: [pulsed], transitions: [] };
  const pCtrl = { ...base640, clips: [clickClip], transitions: [] };
  const repP = await exportProject(pPulse, `${DIR}p1c-pulse.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('C pulse export duration ~8.0s', repP.durationError < 0.3, `err=${repP.durationError.toFixed(2)}s`);
  await exportProject(pCtrl, `${DIR}p1c-pulse-ctrl.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  await framePng(`${DIR}p1c-pulse.mp4`, 2.0, `${DIR}p1c-f-pulse-beat.png`);
  await framePng(`${DIR}p1c-pulse-ctrl.mp4`, 2.0, `${DIR}p1c-f-ctrl-beat.png`);
  await framePng(`${DIR}p1c-pulse.mp4`, 2.25, `${DIR}p1c-f-pulse-gap.png`);
  await framePng(`${DIR}p1c-pulse-ctrl.mp4`, 2.25, `${DIR}p1c-f-ctrl-gap.png`);
  const pBeat = await psnr(`${DIR}p1c-f-pulse-beat.png`, `${DIR}p1c-f-ctrl-beat.png`);
  const pGap = await psnr(`${DIR}p1c-f-pulse-gap.png`, `${DIR}p1c-f-ctrl-gap.png`);
  check('C frame at a beat differs from control (zoomed)', pBeat < 25, `PSNR=${pBeat}`);
  check('C frame between beats matches control', pGap > 35, `PSNR=${pGap}`);
}

// --- D. ducking: voice bursts vs silence, duckDb, loudnorm order ---
const musicClip = (extra = {}) => ({ id: 'c', source: `${DIR}p1c-music.mp4`, in: 0, out: 8, speed: 1, volume: 1, ...extra });
let ctrlOn, ctrlOff;
{
  const pCtrl = { ...base640, clips: [musicClip()], transitions: [] };
  const repC = await exportProject(pCtrl, `${DIR}p1c-duck-ctrl.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('D control duration ~8.0s', repC.durationError < 0.3, `err=${repC.durationError.toFixed(2)}s`);
  check('D control has audio', repC.actual.hasAudio);
  ctrlOn = await meanVolume(`${DIR}p1c-duck-ctrl.mp4`, 1.0);
  ctrlOff = await meanVolume(`${DIR}p1c-duck-ctrl.mp4`, 3.0);
  const ctrlOn2 = await meanVolume(`${DIR}p1c-duck-ctrl.mp4`, 5.0);
  console.log(`D control: voice-on=${ctrlOn} dB voice-off=${ctrlOff} dB voice-on2=${ctrlOn2} dB`);
  check('D control voice-on and voice-off are the same level (no ducking)', Math.abs(ctrlOn - ctrlOff) < 1,
    `on=${ctrlOn} off=${ctrlOff}`);
}
{
  const duck = { source: VOICE, thresholdDb: -20, ratio: 8, attackMs: 20, releaseMs: 250 };
  const p = { ...base640, clips: [musicClip({ ducking: duck })], transitions: [] };
  const rep = await exportProject(p, `${DIR}p1c-duck.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('D ducked duration ~8.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check('D ducked has audio', rep.actual.hasAudio);
  const on = await meanVolume(`${DIR}p1c-duck.mp4`, 1.0);
  const off = await meanVolume(`${DIR}p1c-duck.mp4`, 3.0);
  const on2 = await meanVolume(`${DIR}p1c-duck.mp4`, 5.0);
  console.log(`D ducked: voice-on=${on} dB (reduction ${(ctrlOn - on).toFixed(1)} dB) voice-off=${off} dB voice-on2=${on2} dB`);
  check('D music drops >= 6 dB while voice speaks', ctrlOn - on >= 6, `reduction=${(ctrlOn - on).toFixed(1)} dB`);
  check('D music recovers to +/- 1 dB in silence', Math.abs(off - ctrlOff) <= 1, `off=${off} ctrlOff=${ctrlOff}`);
  check('D second voice burst ducks the same', ctrlOn - on2 >= 6, `reduction2=${(ctrlOn - on2).toFixed(1)} dB`);
}
{
  // duckDb=6 must add ~6 dB more reduction (probe: -32.6 vs -26.7 dB).
  const duck = { source: VOICE, thresholdDb: -20, ratio: 8, attackMs: 20, releaseMs: 250, duckDb: 6 };
  const p = { ...base640, clips: [musicClip({ ducking: duck })], transitions: [] };
  const rep = await exportProject(p, `${DIR}p1c-duck-db6.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('D duckDb=6 duration ~8.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  const on = await meanVolume(`${DIR}p1c-duck-db6.mp4`, 1.0);
  const off = await meanVolume(`${DIR}p1c-duck-db6.mp4`, 3.0);
  console.log(`D duckDb=6: voice-on=${on} dB (reduction ${(ctrlOn - on).toFixed(1)} dB) voice-off=${off} dB`);
  check('D duckDb=6 drops >= 14 dB while voice speaks', ctrlOn - on >= 14, `reduction=${(ctrlOn - on).toFixed(1)} dB`);
  check('D duckDb=6 recovers to +/- 1 dB in silence', Math.abs(off - ctrlOff) <= 1, `off=${off} ctrlOff=${ctrlOff}`);
}
{
  // loudnorm + ducking: ducking sits AFTER loudnorm, so it must still work.
  const pCtrl = { ...base640, clips: [musicClip({ loudnorm: true })], transitions: [] };
  await exportProject(pCtrl, `${DIR}p1c-duck-ln-ctrl.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  const lnOn = await meanVolume(`${DIR}p1c-duck-ln-ctrl.mp4`, 1.0);
  const lnOff = await meanVolume(`${DIR}p1c-duck-ln-ctrl.mp4`, 3.0);
  const duck = { source: VOICE, thresholdDb: -20, ratio: 8, attackMs: 20, releaseMs: 250 };
  const p = { ...base640, clips: [musicClip({ loudnorm: true, ducking: duck })], transitions: [] };
  const rep = await exportProject(p, `${DIR}p1c-duck-ln.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('D loudnorm+ducking duration ~8.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  const on = await meanVolume(`${DIR}p1c-duck-ln.mp4`, 1.0);
  const off = await meanVolume(`${DIR}p1c-duck-ln.mp4`, 3.0);
  console.log(`D loudnorm: ctrl on=${lnOn} off=${lnOff} | ducked on=${on} (reduction ${(lnOn - on).toFixed(1)} dB) off=${off}`);
  check('D loudnorm+ducking still drops >= 6 dB', lnOn - on >= 6, `reduction=${(lnOn - on).toFixed(1)} dB`);
  check('D loudnorm+ducking recovers to +/- 1 dB', Math.abs(off - lnOff) <= 1, `off=${off} lnOff=${lnOff}`);
}

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? 'ALL P1C CHECKS PASSED' : `${failed} P1C CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
