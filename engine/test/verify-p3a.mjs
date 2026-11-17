// P3 batch 1 engine verification (M4 §8.3, 2026-11-17).
// Covers: src/audiofx.ts — built-in EQ (highpass low cut / lowpass
// high cut / anequalizer parametric bands), single-track compressor
// (acompressor), voice effects (pitch via asetrate+atempo, reverb /
// echo via aecho, chorus, tremolo, vibrato), one-key voice beautify
// chain, clip gain trim -30..+30 dB (volume dB) and project master
// gain -30..+30 dB, wired into filtergraph.ts (voice after speed/
// reverse, EQ/compressor before loudnorm, ducking after loudnorm,
// gain after loudnorm/ducking).
//
// Measurement method (written down so the numbers can be re-derived):
// - Determinism probe was run BEFORE writing assertions (the vidstab
//   lesson). tmp/probe-p3a.mjs, run twice: every filter-level number
//   reproduced exactly (sine baselines all -21.07 dB Goertzel RMS).
// - Sine sources are 4 s, 48 kHz mono, amplitude 0.125 (-21.07 dB
//   Goertzel RMS), generated with aevalsrc + sine=...:frequency=...,
//   so every assertion is a measured dB difference, not a guess.
// - level() is a Goertzel single-frequency RMS reader (same code as
//   the probe): it reads one frequency out of a mix, so EQ band and
//   beautify-chain assertions are relative levels, not whole-file
//   means. meanVolume() is volumedetect (no -v error — that flag
//   suppresses the stats entirely, same trap as the p2c tests).
// - "Silence" asserts use < -100 dB for Goertzel (a true digital
//   silence reads -240 dB floor there) and < -60 dB for volumedetect
//   (digital silence measures -91.0 dB).
// - The +30 dB gain assertion uses a QUIET source (-41.07 dB): +30 dB
//   on a -21 dB sine clips (measured mean -0.5 dB), so it cannot be
//   exact on the loud source — the probe proved that, the test uses
//   the quiet one.
// - aecho is a FEED-FORWARD multi-tap delay (one copy per delay, no
//   feedback): a single 250 ms tap puts exactly one echo at +250 ms.
//   The tail window is therefore 2.05-2.30 s after a 2 s tone (measured
//   -32.13 dB vs silence -240); a 2.5-3.5 s window is correctly silent
//   and must NOT be asserted as echo — the first probe got this wrong.
// - deesser's default f=0.5 also cuts 3000 Hz by -3.32 dB relative,
//   which eats the beautify chain's +3 dB presence boost (probe round
//   2: presence relative -1.79 dB with the compressor after the EQ).
//   The chain therefore uses f=0.85 (presence +1.85 dB, sibilance
//   -1.33 dB relative) with the presence EQ LAST (compressor before
//   it). Both numbers are asserted here.
// - Roles are NOT touched: Roles gain stays -60..+12 dB (roles.ts)
//   and clip/project gain is a separate -30..+30 dB range. Two checks
//   below prove the ranges were not merged (role -61/+13 still throw,
//   clip -30/+30 still pass).
// - LGPL: every filter used here (highpass, lowpass, equalizer,
//   acompressor, asetrate, aresample, atempo, aecho, vibrato, chorus,
//   tremolo, deesser, volume, afftdn) is a native libavfilter filter.
//   rubberband is deliberately NOT used (GPL, not in LGPL builds —
//   see audiofx.ts header). Only verified on the local GPL 8.1.2
//   build; re-check each on the BtbN LGPL 9.0 build at the M2 gate.
// Old M1 / P0 / P0b / P1 / P1b / P1c / P1d / P1e / P2a / P2b / P2c
// checks live in their own files and must still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  audioFxFilter,
  compressorFilter,
  enhanceFilter,
  eqFilter,
  exportProject,
  PRESETS,
  probe,
  validateAudioFx,
  validateRoles,
  voiceFilter,
} from '../dist/export.js';
import { buildFilterGraph } from '../dist/filtergraph.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

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

/** Whole-file mean volume in dB (volumedetect; never pass -v error). */
async function meanVolume(file, ss, dur, stream = 0) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', file, '-map', `0:a:${stream}`, '-t', String(dur),
    '-af', 'volumedetect', '-vn', '-f', 'null', '-',
  ]).catch((e) => e);
  const m = ((r.stderr ?? '') + (r.stdout ?? '')).match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : null;
}

/** Goertzel RMS level of one frequency (dBFS) in a window. */
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

/** Apply one audio filter string to a wav source. */
async function af(src, filter, out) {
  await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-af', filter, out]);
}

async function duration(file) {
  // ffprobe format duration (probe() needs a video stream — wavs have none).
  const r = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ]).catch((e) => e);
  return Number(String(r.stdout ?? '').trim());
}

// --- sources ---
// Sines at amplitude 0.125 -> -21.07 dB Goertzel RMS (probe-verified).
const SRC = {};
{
  const sine = async (freq, out, amp = 0.125) => {
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
      '-i', `aevalsrc=${amp}*sin(2*PI*${freq}*t):s=48000:d=4`,
      '-ac', '1', out]);
  };
  await sine(440, `${DIR}p3a-440.wav`);
  await sine(100, `${DIR}p3a-100.wav`);
  await sine(1000, `${DIR}p3a-1000.wav`);
  await sine(10000, `${DIR}p3a-10000.wav`);
  await sine(440, `${DIR}p3a-quiet.wav`, 0.0125); // -41.07 dB
  // Multi-tone: 100 + 440 + 3000 + 6000 Hz, each -21.07 dB.
  await run('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'aevalsrc=0.125*sin(2*PI*100*t):s=48000:d=4',
    '-f', 'lavfi', '-i', 'aevalsrc=0.125*sin(2*PI*440*t):s=48000:d=4',
    '-f', 'lavfi', '-i', 'aevalsrc=0.125*sin(2*PI*3000*t):s=48000:d=4',
    '-f', 'lavfi', '-i', 'aevalsrc=0.125*sin(2*PI*6000*t):s=48000:d=4',
    '-filter_complex', '[0:a][1:a][2:a][3:a]amix=inputs=4:normalize=0',
    '-ac', '1', `${DIR}p3a-multi.wav`]);
  // Two-level dynamics: loud 2 s (-9.03 dB) + quiet 2 s (-29.03 dB).
  await run('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*440*t):s=48000:d=2',
    '-f', 'lavfi', '-i', 'aevalsrc=0.05*sin(2*PI*440*t):s=48000:d=2',
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1',
    '-ac', '1', `${DIR}p3a-dyn.wav`]);
  // Tone 2 s + silence 2 s (echo/reverb tail source).
  await run('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'aevalsrc=0.125*sin(2*PI*440*t):s=48000:d=2',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=2',
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1',
    '-ac', '1', `${DIR}p3a-440sil.wav`]);
  // Video+audio sources for export tests (640x360 testsrc2, 4 s).
  const mkMp4 = async (audio, out) => {
    await run('ffmpeg', ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4',
      '-i', audio, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', out]);
  };
  await mkMp4(`${DIR}p3a-440.wav`, `${DIR}p3a-440.mp4`);
  await mkMp4(`${DIR}p3a-1000.wav`, `${DIR}p3a-1000.mp4`);
  await mkMp4(`${DIR}p3a-multi.wav`, `${DIR}p3a-multi.mp4`);
  await mkMp4(`${DIR}p3a-dyn.wav`, `${DIR}p3a-dyn.mp4`);
  SRC.tone440 = `${DIR}p3a-440.mp4`;
  SRC.tone1000 = `${DIR}p3a-1000.mp4`;
  SRC.multi = `${DIR}p3a-multi.mp4`;
  SRC.dyn = `${DIR}p3a-dyn.mp4`;
}

const base = { version: 1, width: 640, height: 360, fps: 30, transitions: [], transitionDuration: 0.5 };
const clip = (id, source, extra = {}) => ({ id, source, in: 0, out: 4, speed: 1, volume: 1, ...extra });

// --- A. filter-string unit checks ---
{
  check('fx: eq lowCut emits highpass', eqFilter({ lowCutHz: 500 }).includes('highpass=f=500'), eqFilter({ lowCutHz: 500 }));
  check('fx: eq highCut emits lowpass', eqFilter({ highCutHz: 5000 }).includes('lowpass=f=5000'), eqFilter({ highCutHz: 5000 }));
  check('fx: eq band emits equalizer with q width and dB gain',
    eqFilter({ bands: [{ frequency: 1000, gainDb: 6 }] }) === 'equalizer=f=1000:width_type=q:width=1:g=6',
    eqFilter({ bands: [{ frequency: 1000, gainDb: 6 }] }));
  const cf = compressorFilter({ thresholdDb: -20, ratio: 4 });
  check('fx: compressor emits acompressor with ratio 4', cf.includes('acompressor=') && cf.includes('ratio=4'), cf);
  check('fx: compressor threshold -20dB converts to linear 0.1', cf.includes('threshold=0.1'), cf);
  check('fx: pitch +12 emits asetrate 96000 + atempo 0.5',
    voiceFilter({ kind: 'pitch', semitones: 12 }).includes('asetrate=96000') &&
    voiceFilter({ kind: 'pitch', semitones: 12 }).includes('atempo=0.5'),
    voiceFilter({ kind: 'pitch', semitones: 12 }));
  check('fx: pitch -12 emits asetrate 24000 + atempo 2',
    voiceFilter({ kind: 'pitch', semitones: -12 }).includes('asetrate=24000') &&
    voiceFilter({ kind: 'pitch', semitones: -12 }).includes('atempo=2'),
    voiceFilter({ kind: 'pitch', semitones: -12 }));
  check('fx: pitch resamples to 48k first (rate-independent)',
    voiceFilter({ kind: 'pitch', semitones: 12 }).startsWith('aresample=48000'),
    voiceFilter({ kind: 'pitch', semitones: 12 }));
  check('fx: pitch 0 semitones is a no-op', voiceFilter({ kind: 'pitch', semitones: 0 }) === '');
  check('fx: reverb emits 4-tap aecho', voiceFilter({ kind: 'reverb' }) === 'aecho=0.8:0.7:60|90|120|180:0.5|0.4|0.3|0.2', voiceFilter({ kind: 'reverb' }));
  check('fx: echo emits single-tap aecho 250ms', voiceFilter({ kind: 'echo' }) === 'aecho=0.8:0.7:250:0.5', voiceFilter({ kind: 'echo' }));
  check('fx: vibrato emits vibrato f=5 d=0.5', voiceFilter({ kind: 'vibrato' }) === 'vibrato=f=5:d=0.5', voiceFilter({ kind: 'vibrato' }));
  check('fx: tremolo emits tremolo f=5 d=0.5', voiceFilter({ kind: 'tremolo' }) === 'tremolo=f=5:d=0.5', voiceFilter({ kind: 'tremolo' }));
  check('fx: chorus emits chorus with in/out gains 0.5', voiceFilter({ kind: 'chorus' }).startsWith('chorus=0.5:0.5:'), voiceFilter({ kind: 'chorus' }));
  const ef = enhanceFilter();
  check('fx: beautify chain has highpass 80 + deesser + light comp + presence EQ',
    ef.includes('highpass=f=80') && ef.includes('deesser=i=0.5:m=0.5:f=0.85') &&
    ef.includes('acompressor=') && ef.includes('equalizer=f=3000:width_type=q:width=1:g=3'), ef);
  check('fx: beautify presence EQ is LAST (compressor cannot eat the boost)',
    ef.indexOf('equalizer=f=3000') > ef.indexOf('acompressor='), ef);
  check('fx: empty audioFx is a no-op string', audioFxFilter({}) === '');
  check('fx: gainDb is NOT in the pre-loudnorm chain (applied after loudnorm)',
    audioFxFilter({ gainDb: -10 }) === '', audioFxFilter({ gainDb: -10 }));
  const full = audioFxFilter({
    voice: { kind: 'pitch', semitones: 6 }, enhance: true,
    eq: { bands: [{ frequency: 1000, gainDb: 3 }] }, compressor: { ratio: 2 },
  });
  check('fx: full chain order is voice -> beautify -> EQ -> compressor',
    full.indexOf('asetrate') < full.indexOf('deesser') &&
    full.indexOf('deesser') < full.indexOf('equalizer=f=1000') &&
    full.indexOf('equalizer=f=1000') < full.lastIndexOf('acompressor='),
    full);
}

// --- B. filter-level measurements (probe numbers, run twice) ---
{
  const base440 = await level(`${DIR}p3a-440.wav`, 440);
  const base100 = await level(`${DIR}p3a-100.wav`, 100);
  const base1000 = await level(`${DIR}p3a-1000.wav`, 1000);
  const base10000 = await level(`${DIR}p3a-10000.wav`, 10000);
  check('measure: sine baselines are -21.07 dB',
    close(base440, -21.07, 0.1) && close(base100, -21.07, 0.1) &&
    close(base1000, -21.07, 0.1) && close(base10000, -21.07, 0.1),
    `440=${base440.toFixed(2)} 100=${base100.toFixed(2)} 1000=${base1000.toFixed(2)} 10000=${base10000.toFixed(2)}`);

  await af(`${DIR}p3a-100.wav`, eqFilter({ lowCutHz: 500 }), `${DIR}p3a-t-hp.wav`);
  const hp100 = await level(`${DIR}p3a-t-hp.wav`, 100);
  check('measure: highpass 500Hz cuts 100Hz by >= 20 dB', base100 - hp100 >= 20, `${base100.toFixed(2)} -> ${hp100.toFixed(2)}`);

  await af(`${DIR}p3a-10000.wav`, eqFilter({ highCutHz: 5000 }), `${DIR}p3a-t-lp.wav`);
  const lp10k = await level(`${DIR}p3a-t-lp.wav`, 10000);
  check('measure: lowpass 5000Hz cuts 10000Hz by >= 10 dB', base10000 - lp10k >= 10, `${base10000.toFixed(2)} -> ${lp10k.toFixed(2)}`);

  await af(`${DIR}p3a-1000.wav`, eqFilter({ bands: [{ frequency: 1000, gainDb: 6 }] }), `${DIR}p3a-t-eq6.wav`);
  const eq6 = await level(`${DIR}p3a-t-eq6.wav`, 1000);
  check('measure: EQ +6dB @1000Hz reads +6 +-0.5 dB', close(eq6 - base1000, 6), `${(eq6 - base1000).toFixed(2)} dB`);
  await af(`${DIR}p3a-1000.wav`, eqFilter({ bands: [{ frequency: 1000, gainDb: -6 }] }), `${DIR}p3a-t-eqm6.wav`);
  const eqm6 = await level(`${DIR}p3a-t-eqm6.wav`, 1000);
  check('measure: EQ -6dB @1000Hz reads -6 +-0.5 dB', close(eqm6 - base1000, -6), `${(eqm6 - base1000).toFixed(2)} dB`);
  // Two bands on the PURE 1000Hz sine (the multi source has no 1000Hz
  // content — applying the bands to it measures float noise, not EQ).
  await af(`${DIR}p3a-1000.wav`, eqFilter({ bands: [{ frequency: 1000, gainDb: 6 }, { frequency: 100, gainDb: -6 }] }), `${DIR}p3a-t-eq2.wav`);
  const eq2 = await level(`${DIR}p3a-t-eq2.wav`, 1000);
  check('measure: two EQ bands compose (+6 @1000 with -6 @100)', close(eq2 - base1000, 6, 0.75), `${(eq2 - base1000).toFixed(2)} dB`);

  const srcMean = await meanVolume(`${DIR}p3a-440.wav`, 0, 4);
  await af(`${DIR}p3a-440.wav`, 'volume=-30dB', `${DIR}p3a-t-gm30.wav`);
  const gm30 = await meanVolume(`${DIR}p3a-t-gm30.wav`, 0, 4);
  check('measure: volume -30dB is exact (-21.1 -> -51.1)', close(gm30, -51.1), `src=${srcMean} -> ${gm30}`);
  await af(`${DIR}p3a-quiet.wav`, 'volume=+30dB', `${DIR}p3a-t-gp30.wav`);
  const gp30 = await meanVolume(`${DIR}p3a-t-gp30.wav`, 0, 4);
  check('measure: volume +30dB on quiet source is exact (-41.1 -> -11.1)', close(gp30, -11.1), `-> ${gp30}`);

  const loud0 = await level(`${DIR}p3a-dyn.wav`, 440, 0.25, 1.5);
  const quiet0 = await level(`${DIR}p3a-dyn.wav`, 440, 2.25, 1.5);
  await af(`${DIR}p3a-dyn.wav`, compressorFilter({ thresholdDb: -20, ratio: 4 }), `${DIR}p3a-t-comp.wav`);
  const loud1 = await level(`${DIR}p3a-t-comp.wav`, 440, 0.25, 1.5);
  const quiet1 = await level(`${DIR}p3a-t-comp.wav`, 440, 2.25, 1.5);
  check('measure: compressor cuts the loud part by >= 6 dB', loud0 - loud1 >= 6, `${loud0.toFixed(2)} -> ${loud1.toFixed(2)}`);
  check('measure: compressor leaves the quiet part alone (+-0.5 dB)', close(quiet1 - quiet0, 0), `${quiet0.toFixed(2)} -> ${quiet1.toFixed(2)}`);
  check('measure: compressor shrinks dynamic range to <= 14 dB', (loud1 - quiet1) <= 14, `range ${(loud0 - quiet0).toFixed(2)} -> ${(loud1 - quiet1).toFixed(2)}`);

  await af(`${DIR}p3a-440.wav`, voiceFilter({ kind: 'pitch', semitones: 12 }), `${DIR}p3a-t-p12.wav`);
  const p880 = await level(`${DIR}p3a-t-p12.wav`, 880);
  const p440 = await level(`${DIR}p3a-t-p12.wav`, 440);
  const pDur = await duration(`${DIR}p3a-t-p12.wav`);
  check('measure: pitch +12 semitones moves 440Hz to 880Hz (level +-1.5 dB)', close(p880, base440, 1.5), `880=${p880.toFixed(2)} vs src 440=${base440.toFixed(2)}`);
  check('measure: pitch +12 leaves nothing at 440Hz (< -60 dB)', p440 < -60, `440=${p440.toFixed(2)}`);
  check('measure: pitch +12 keeps duration (err < 0.1s)', Math.abs(pDur - 4) < 0.1, `dur=${pDur}`);
  await af(`${DIR}p3a-440.wav`, voiceFilter({ kind: 'pitch', semitones: -12 }), `${DIR}p3a-t-pm12.wav`);
  const pm220 = await level(`${DIR}p3a-t-pm12.wav`, 220);
  const pm440 = await level(`${DIR}p3a-t-pm12.wav`, 440);
  check('measure: pitch -12 semitones moves 440Hz to 220Hz (level +-1.5 dB)', close(pm220, base440, 1.5), `220=${pm220.toFixed(2)}`);
  check('measure: pitch -12 leaves nothing at 440Hz (< -60 dB)', pm440 < -60, `440=${pm440.toFixed(2)}`);

  const tailCtrl = await level(`${DIR}p3a-440sil.wav`, 440, 2.05, 0.25);
  await af(`${DIR}p3a-440sil.wav`, voiceFilter({ kind: 'echo' }), `${DIR}p3a-t-echo.wav`);
  const echoTail = await level(`${DIR}p3a-t-echo.wav`, 440, 2.05, 0.25);
  check('measure: echo 250ms tail is audible (>= -45 dB) after the tone ends', echoTail >= -45, `tail=${echoTail.toFixed(2)}`);
  check('measure: echo control tail is silence (< -100 dB)', tailCtrl < -100, `ctrl=${tailCtrl.toFixed(2)}`);
  await af(`${DIR}p3a-440sil.wav`, voiceFilter({ kind: 'reverb' }), `${DIR}p3a-t-rev.wav`);
  const revTail = await level(`${DIR}p3a-t-rev.wav`, 440, 2.05, 0.25);
  check('measure: reverb multi-tap tail is audible (>= -70 dB)', revTail >= -70, `tail=${revTail.toFixed(2)}`);
  check('measure: reverb control tail is silence (< -100 dB)', tailCtrl < -100, `ctrl=${tailCtrl.toFixed(2)}`);

  await af(`${DIR}p3a-multi.wav`, 'deesser=i=0.5:m=0.5:f=0.5', `${DIR}p3a-t-deess.wav`);
  const d6k = await level(`${DIR}p3a-t-deess.wav`, 6000);
  const d440 = await level(`${DIR}p3a-t-deess.wav`, 440);
  const m6k = await level(`${DIR}p3a-multi.wav`, 6000);
  const m440 = await level(`${DIR}p3a-multi.wav`, 440);
  check('measure: deesser cuts 6000Hz by >= 3 dB', m6k - d6k >= 3, `${m6k.toFixed(2)} -> ${d6k.toFixed(2)}`);
  check('measure: deesser barely touches 440Hz (<= 2 dB)', m440 - d440 <= 2, `${m440.toFixed(2)} -> ${d440.toFixed(2)}`);

  await af(`${DIR}p3a-multi.wav`, enhanceFilter(), `${DIR}p3a-t-beauty.wav`);
  const b100 = await level(`${DIR}p3a-t-beauty.wav`, 100);
  const b440 = await level(`${DIR}p3a-t-beauty.wav`, 440);
  const b3k = await level(`${DIR}p3a-t-beauty.wav`, 3000);
  const b6k = await level(`${DIR}p3a-t-beauty.wav`, 6000);
  const mm100 = await level(`${DIR}p3a-multi.wav`, 100);
  const mm3k = await level(`${DIR}p3a-multi.wav`, 3000);
  const mm6k = await level(`${DIR}p3a-multi.wav`, 6000);
  check('measure: beautify cuts 100Hz rumble by >= 3 dB', mm100 - b100 >= 3, `${mm100.toFixed(2)} -> ${b100.toFixed(2)}`);
  check('measure: beautify lifts presence (3000 vs 440) by >= +1 dB',
    (b3k - b440) - (mm3k - m440) >= 1, `rel ${(b3k - b440).toFixed(2)} vs base ${(mm3k - m440).toFixed(2)}`);
  check('measure: beautify still cuts sibilance (6000 vs 440) by >= 1 dB',
    (mm6k - m440) - (b6k - b440) >= 1, `rel ${(b6k - b440).toFixed(2)} vs base ${(mm6k - m440).toFixed(2)}`);

  await af(`${DIR}p3a-440.wav`, voiceFilter({ kind: 'vibrato' }), `${DIR}p3a-t-vib.wav`);
  const vib440 = await level(`${DIR}p3a-t-vib.wav`, 440);
  const vibMean = await meanVolume(`${DIR}p3a-t-vib.wav`, 0, 4);
  check('measure: vibrato spreads the 440Hz tone by >= 3 dB', base440 - vib440 >= 3, `${base440.toFixed(2)} -> ${vib440.toFixed(2)}`);
  check('measure: vibrato keeps mean volume (+-1 dB)', close(vibMean, srcMean, 1), `mean=${vibMean} src=${srcMean}`);
  await af(`${DIR}p3a-440.wav`, voiceFilter({ kind: 'chorus' }), `${DIR}p3a-t-chorus.wav`);
  const cho440 = await level(`${DIR}p3a-t-chorus.wav`, 440);
  check('measure: chorus moves the 440Hz tone by >= 3 dB', base440 - cho440 >= 3, `${base440.toFixed(2)} -> ${cho440.toFixed(2)}`);
  await af(`${DIR}p3a-440.wav`, voiceFilter({ kind: 'tremolo' }), `${DIR}p3a-t-trem.wav`);
  const tre440 = await level(`${DIR}p3a-t-trem.wav`, 440);
  check('measure: tremolo dips the 440Hz tone by 1..5 dB', base440 - tre440 >= 1 && base440 - tre440 <= 5, `${base440.toFixed(2)} -> ${tre440.toFixed(2)}`);

  await af(`${DIR}p3a-multi.wav`, 'equalizer=f=3000:width_type=q:width=1:g=6,loudnorm=I=-16:TP=-1.5:LRA=11:linear=true', `${DIR}p3a-t-eqln.wav`);
  const ln3k = await level(`${DIR}p3a-t-eqln.wav`, 3000);
  const ln440 = await level(`${DIR}p3a-t-eqln.wav`, 440);
  check('measure: EQ band ratio survives loudnorm (>= 5 dB)', (ln3k - ln440) >= 5, `ratio ${(ln3k - ln440).toFixed(2)} dB`);
}

// --- C. rejects (bad parameters throw, never silently clamp) ---
{
  const bad = (fx) => () => validateAudioFx(fx, 'c1');
  check('reject: EQ band frequency 0 throws', throwsSync(bad({ eq: { bands: [{ frequency: 0, gainDb: 0 }] } }), /outside/));
  check('reject: EQ band frequency 20001 throws', throwsSync(bad({ eq: { bands: [{ frequency: 20001, gainDb: 0 }] } }), /outside/));
  check('reject: EQ band gain +31 throws', throwsSync(bad({ eq: { bands: [{ frequency: 1000, gainDb: 31 }] } }), /outside/));
  check('reject: EQ band gain -31 throws', throwsSync(bad({ eq: { bands: [{ frequency: 1000, gainDb: -31 }] } }), /outside/));
  check('reject: EQ band Q 0 throws', throwsSync(bad({ eq: { bands: [{ frequency: 1000, gainDb: 0, width: 0 }] } }), /outside/));
  check('reject: EQ band Q 11 throws', throwsSync(bad({ eq: { bands: [{ frequency: 1000, gainDb: 0, width: 11 }] } }), /outside/));
  check('reject: lowCut 0 throws', throwsSync(bad({ eq: { lowCutHz: 0 } }), /outside/));
  check('reject: lowCut >= highCut throws', throwsSync(bad({ eq: { lowCutHz: 5000, highCutHz: 1000 } }), /below/));
  check('reject: clip gain -31 throws', throwsSync(bad({ gainDb: -31 }), /outside/));
  check('reject: clip gain +31 throws', throwsSync(bad({ gainDb: 31 }), /outside/));
  check('reject: compressor threshold -61 throws', throwsSync(bad({ compressor: { thresholdDb: -61 } }), /outside/));
  check('reject: compressor ratio 0.5 throws', throwsSync(bad({ compressor: { ratio: 0.5 } }), /outside/));
  check('reject: compressor ratio 21 throws', throwsSync(bad({ compressor: { ratio: 21 } }), /outside/));
  check('reject: compressor attack 0 throws', throwsSync(bad({ compressor: { attackMs: 0 } }), /outside/));
  check('reject: compressor release 10000 throws', throwsSync(bad({ compressor: { releaseMs: 10000 } }), /outside/));
  check('reject: compressor makeup -1 throws', throwsSync(bad({ compressor: { makeupDb: -1 } }), /outside/));
  check('reject: pitch +13 throws', throwsSync(bad({ voice: { kind: 'pitch', semitones: 13 } }), /outside/));
  check('reject: pitch -13 throws', throwsSync(bad({ voice: { kind: 'pitch', semitones: -13 } }), /outside/));
  check('reject: unknown voice kind throws', throwsSync(bad({ voice: { kind: 'robot' } }), /unknown/));
  check('reject: voice depth 1.5 throws', throwsSync(bad({ voice: { kind: 'vibrato', depth: 1.5 } }), /outside/));
  check('reject: voice rateHz 0 throws', throwsSync(bad({ voice: { kind: 'vibrato', rateHz: 0 } }), /outside/));
  check('reject: voice delayMs 0 throws', throwsSync(bad({ voice: { kind: 'echo', delayMs: 0 } }), /outside/));
  check('reject: voice decay 1.5 throws', throwsSync(bad({ voice: { kind: 'echo', decay: 1.5 } }), /outside/));
  check('reject: voice mix 1.5 throws', throwsSync(bad({ voice: { kind: 'chorus', mix: 1.5 } }), /outside/));
  check('accept: clip gain -30 and +30 pass validation',
    validateAudioFx({ gainDb: -30 }, 'c1')?.gainDb === -30 &&
    validateAudioFx({ gainDb: 30 }, 'c1')?.gainDb === 30);
  check('accept: EQ band edges (20Hz / 20000Hz / +-30dB / Q 0.1 / Q 10) pass',
    !!validateAudioFx({ eq: { bands: [{ frequency: 20, gainDb: -30, width: 0.1 }, { frequency: 20000, gainDb: 30, width: 10 }] } }, 'c1'));
  check('reject: master gain -31 throws at graph build',
    throwsSync(() => buildFilterGraph({ ...base, clips: [clip('a', SRC.tone440)], masterGainDb: -31 }, FONT), /outside/));
  check('reject: master gain +31 throws at graph build',
    throwsSync(() => buildFilterGraph({ ...base, clips: [clip('a', SRC.tone440)], masterGainDb: 31 }, FONT), /outside/));
  // Roles range is a DIFFERENT range (-60..+12) and must stay untouched.
  check('roles untouched: role gain -61 still throws', throwsSync(() => validateRoles({ ...base, clips: [], roles: [{ name: 'music', gainDb: -61 }] }), /gainDb -61 outside \[-60, 12\]/));
  check('roles untouched: role gain +13 still throws', throwsSync(() => validateRoles({ ...base, clips: [], roles: [{ name: 'music', gainDb: 13 }] }), /gainDb 13 outside \[-60, 12\]/));
  check('roles untouched: role gain -30 (inside -60..+12) still passes',
    !throwsSync(() => validateRoles({ ...base, clips: [], roles: [{ name: 'music', gainDb: -30 }] }), /./));
}

// --- D. export-level wiring ---
{
  const g = buildFilterGraph({
    ...base,
    clips: [clip('a', SRC.tone1000, {
      audioFx: {
        eq: { bands: [{ frequency: 1000, gainDb: 6 }] },
        compressor: { thresholdDb: -20, ratio: 4 },
        gainDb: -30,
      },
    })],
  }, FONT);
  check('graph: EQ + compressor + gain appear in the filtergraph',
    g.filterComplex.includes('equalizer=f=1000') &&
    g.filterComplex.includes('acompressor=') &&
    g.filterComplex.includes('volume=-30dB'), g.filterComplex.slice(0, 400));
  check('graph: audioFx sits before loudnorm in the chain',
    g.filterComplex.indexOf('equalizer=f=1000') < g.filterComplex.indexOf('loudnorm') ||
    !g.filterComplex.includes('loudnorm'),
    'eq before loudnorm (loudnorm only when clip.loudnorm is set)');
  const gLn = buildFilterGraph({
    ...base,
    clips: [clip('a', SRC.tone1000, { loudnorm: true, audioFx: { eq: { bands: [{ frequency: 1000, gainDb: 6 }] } } })],
  }, FONT);
  check('graph: EQ is before loudnorm when loudnorm is on',
    gLn.filterComplex.indexOf('equalizer=f=1000') < gLn.filterComplex.indexOf('loudnorm'));

  const plain = await exportProject({ ...base, clips: [clip('a', SRC.tone1000)] }, `${DIR}p3a-exp-plain.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: plain 1000Hz export duration err < 0.3s', Math.abs(plain.durationError) < 0.3, `err=${plain.durationError.toFixed(2)}s`);
  const pPlain = await probe(`${DIR}p3a-exp-plain.mp4`);
  check('export: plain export has audio', pPlain.hasAudio);
  const eq = await exportProject({
    ...base,
    clips: [clip('a', SRC.tone1000, { audioFx: { eq: { bands: [{ frequency: 1000, gainDb: 6 }] } } })],
  }, `${DIR}p3a-exp-eq.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: EQ export duration err < 0.3s', Math.abs(eq.durationError) < 0.3, `err=${eq.durationError.toFixed(2)}s`);
  const lPlain = await level(`${DIR}p3a-exp-plain.mp4`, 1000);
  const lEq = await level(`${DIR}p3a-exp-eq.mp4`, 1000);
  check('export: EQ +6dB survives the export (+-1.5 dB vs plain export)', close(lEq - lPlain, 6, 1.5), `eq-plain=${(lEq - lPlain).toFixed(2)} dB`);

  const pitch = await exportProject({
    ...base,
    clips: [clip('a', SRC.tone440, { audioFx: { voice: { kind: 'pitch', semitones: 12 } } })],
  }, `${DIR}p3a-exp-pitch.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: pitch export duration err < 0.3s', Math.abs(pitch.durationError) < 0.3, `err=${pitch.durationError.toFixed(2)}s`);
  const e880 = await level(`${DIR}p3a-exp-pitch.mp4`, 880);
  const e440 = await level(`${DIR}p3a-exp-pitch.mp4`, 440);
  check('export: pitch +12 gives 880Hz in the export (>= -30 dB)', e880 >= -30, `880=${e880.toFixed(2)}`);
  check('export: pitch +12 leaves nothing at 440Hz in the export (< -60 dB)', e440 < -60, `440=${e440.toFixed(2)}`);

  const plainMulti = await exportProject({ ...base, clips: [clip('a', SRC.multi)] }, `${DIR}p3a-exp-multi-plain.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: plain multi export duration err < 0.3s', Math.abs(plainMulti.durationError) < 0.3, `err=${plainMulti.durationError.toFixed(2)}s`);
  const beauty = await exportProject({
    ...base,
    clips: [clip('a', SRC.multi, { audioFx: { enhance: true } })],
  }, `${DIR}p3a-exp-beauty.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: beautify export duration err < 0.3s', Math.abs(beauty.durationError) < 0.3, `err=${beauty.durationError.toFixed(2)}s`);
  const b100e = await level(`${DIR}p3a-exp-beauty.mp4`, 100);
  const p100e = await level(`${DIR}p3a-exp-multi-plain.mp4`, 100);
  check('export: beautify cuts 100Hz in the export by >= 2 dB', p100e - b100e >= 2, `${p100e.toFixed(2)} -> ${b100e.toFixed(2)}`);

  const gain = await exportProject({
    ...base,
    clips: [clip('a', SRC.tone440, { audioFx: { gainDb: -30 } })],
  }, `${DIR}p3a-exp-gain.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: gain -30dB export duration err < 0.3s', Math.abs(gain.durationError) < 0.3, `err=${gain.durationError.toFixed(2)}s`);
  const gMean = await meanVolume(`${DIR}p3a-exp-gain.mp4`, 1, 2);
  check('export: clip gain -30dB reads -51.1 +-1 dB in the export', close(gMean, -51.1, 1), `mean=${gMean}`);

  const master = await exportProject({
    ...base,
    clips: [clip('a', SRC.tone440)],
    masterGainDb: -10,
  }, `${DIR}p3a-exp-master.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: master gain export duration err < 0.3s', Math.abs(master.durationError) < 0.3, `err=${master.durationError.toFixed(2)}s`);
  const mMean = await meanVolume(`${DIR}p3a-exp-master.mp4`, 1, 2);
  check('export: master gain -10dB reads -31.1 +-1 dB in the export', close(mMean, -31.1, 1), `mean=${mMean}`);

  const lnOnly = await exportProject({
    ...base,
    clips: [clip('a', SRC.tone440, { loudnorm: true })],
  }, `${DIR}p3a-exp-ln.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  const lnGain = await exportProject({
    ...base,
    clips: [clip('a', SRC.tone440, { loudnorm: true, audioFx: { gainDb: -10 } })],
  }, `${DIR}p3a-exp-ln-gain.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: loudnorm+gain exports duration err < 0.3s',
    Math.abs(lnOnly.durationError) < 0.3 && Math.abs(lnGain.durationError) < 0.3,
    `err=${lnOnly.durationError.toFixed(2)}/${lnGain.durationError.toFixed(2)}`);
  const lnMean = await meanVolume(`${DIR}p3a-exp-ln.mp4`, 1, 2);
  const lgMean = await meanVolume(`${DIR}p3a-exp-ln-gain.mp4`, 1, 2);
  check('export: gain -10dB after loudnorm is NOT eaten by loudnorm (diff -10 +-1.5 dB)',
    close(lgMean - lnMean, -10, 1.5), `ln=${lnMean} ln+gain=${lgMean}`);

  const duckGain = await exportProject({
    ...base,
    clips: [clip('a', SRC.dyn, {
      audioFx: { gainDb: -10 },
      ducking: { source: `${DIR}p3a-440.wav`, thresholdDb: -20, ratio: 8 },
    })],
  }, `${DIR}p3a-exp-duckgain.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: ducking + clip gain compose (duration err < 0.3s)', Math.abs(duckGain.durationError) < 0.3, `err=${duckGain.durationError.toFixed(2)}s`);
  const dg = buildFilterGraph({
    ...base,
    clips: [clip('a', SRC.dyn, {
      audioFx: { gainDb: -10 },
      ducking: { source: `${DIR}p3a-440.wav`, thresholdDb: -20, ratio: 8 },
    })],
  }, FONT);
  check('graph: ducking + gain graph has sidechaincompress and volume=-10dB',
    dg.filterComplex.includes('sidechaincompress') && dg.filterComplex.includes('volume=-10dB'));

  const rolesFx = await exportProject({
    ...base,
    clips: [clip('a', SRC.tone440, { role: 'music', audioFx: { gainDb: -10 } })],
    roles: [{ name: 'music', gainDb: -6 }],
  }, `${DIR}p3a-exp-rolesfx.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: role gain + clip gain compose (duration err < 0.3s)', Math.abs(rolesFx.durationError) < 0.3, `err=${rolesFx.durationError.toFixed(2)}s`);
  const rMean = await meanVolume(`${DIR}p3a-exp-rolesfx.mp4`, 1, 2);
  check('export: role -6dB + clip -10dB reads -37.1 +-1.5 dB (both apply once)',
    close(rMean, -37.1, 1.5), `mean=${rMean}`);
}

// --- report ---
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exit(1);
