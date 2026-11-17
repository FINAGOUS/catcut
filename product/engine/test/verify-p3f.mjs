// P3 batch 6 engine verification (M4 §8.1 / §8.3 / §8.5 / §8.6,
// 2026-11-18). Covers: src/audiorepair.ts — de-click (adeclick),
// mains-hum removal (highpass), noise reduction (afftdn nr=25:nf=-30);
// src/vocalsep.ts — Demucs vocal separation (interface + live run
// when torch + weights are present, honest fallback when not);
// src/tts.ts — local sherpa-onnx TTS narration + timeline mix;
// src/surround.ts — 5.1/7.1 upmix + AC-3 export; src/multicam.ts —
// 16 angles (was 2-4); src/rendercache.ts — background render +
// render cache; src/optimized.ts — DNxHR optimized media;
// src/medialib.ts — media library + ALE + subclips + autosave /
// crash recovery + archive / relink + ingest / watch folder.
//
// Measurement method (probe test/tmp/probe-p3f.mjs ran BEFORE writing
// assertions — every number below was measured first):
// - adeclick on 440 Hz + 3 single-sample clicks (peak 1.000):
//   click-window peak 1.000 -> 0.150, 440 Hz -19.49 -> -19.53 dB.
// - highpass f=100 on 440 Hz + 50 Hz hum: 50 Hz -13.47 -> -25.78 dB
//   (12.3 dB down), 440 Hz untouched (-19.50). f=80 only gives
//   -8.8 dB, so the repair default is 100, not 80.
// - afftdn DEFAULT (nr=12, nf=-50) is near-useless on steady hiss:
//   gap noise -35.19 -> -35.47 dB (0.28 dB), white noise -24.73 ->
//   -24.76 dB. The working setting is afftdn=nr=25:nf=-30: gap noise
//   -35.19 -> -60.04 dB (24.9 dB down). nf=-30 is load-bearing;
//   tn=1 defeats it (-35.73 dB). The test asserts the nr=25:nf=-30
//   numbers, and the code never uses default afftdn for repair.
// - DNxHR: 320x180 red -> dnxhr_hq .mov, ffprobe reads codec dnxhd,
//   profile "DNXHR HQ", 320x180, 30 fps, 2.000 s. PSNR vs the x264
//   source reads 24.65 dB — a colour-space artefact (frame means
//   (255,23,0) vs (253,0,0): 422 vs 420 chroma), NOT a quality
//   problem, so the test asserts frame means, not PSNR.
// - 5.1 upmix + AC-3: ffprobe reads ac3, 6 channels, layout
//   "5.1(side)" (FFmpeg 8's name for 5.1 with back channels — the
//   order is still FL FR FC LFE BL BR); FL/FR/FC/BL/BR all -18.88 dB
//   RMS / -19.51 dB @440 Hz, LFE -240 dB (silent by design). pan
//   rejects a bare `c3=0` — the silent LFE must be `c3=0*c0`.
// - TTS (sherpa-onnx 2.0.1, vits-icefall-zh-aishell3): "你好世界，
//   这是一个测试。" (12 chars) -> 2.65 s @ 8000 Hz, RMS -28.72 dB in
//   the probe — but VITS timing is STOCHASTIC: the same text measured
//   2.65/2.84/3.03/3.06/3.23 s across runs, so the test asserts a
//   [2.0, 4.0] s band for 12 chars, never an exact value. ~0.2-0.3
//   s/char; the per-char band (0, 0.6] still holds.
// - Demucs: LIVE on this machine (torch 2.15.0+cu132 installed from
//   PyPI — download.pytorch.org read-times-out, the PyPI CUDA build
//   pulled ~2.5 GB of nvidia deps, one attempt died with /tmp full
//   (512 MB tmpfs) and was retried with TMPDIR on /home; demucs
//   itself needed its runtime deps completed afterwards —
//   `pip install demucs` added sphn/einops/safetensors). htdemucs
//   weights (~400 MB) downloaded once into the torch hub cache.
//   CPU inference is ~26 s for a 4 s clip (weights cached); the
//   first run took 5.6 min including the download.
// - Live probe material matters: PURE SINE TONES are not vocals to
//   Demucs — a 440+660 Hz sine mix separates to a near-silent vocals
//   stem (-55.16 dB @440, -66.35 @660) with both tones kept in the
//   accompaniment (-10.50/-10.49). So the live probe uses REAL
//   SPEECH (sherpa-onnx TTS) + a 660 Hz music tone: vocals stem
//   660 Hz -65.16 dB (51.7 dB below the mix's -13.47), accompaniment
//   660 Hz -10.50 dB (preserved, +2.97 vs the mix), vocals RMS
//   -27.83 dB in the speech window (speech present). The test
//   asserts those bands, not exact values.
// - Model weights licence: re-check before redistributing (see
//   src/vocalsep.ts). The live branch runs only when torch +
//   cached htdemucs weights are present; otherwise it asserts the
//   honest "model not available" failure and never fakes a result.
// - LGPL: adeclick/highpass/afftdn/pan/ac3/dnxhd are native
//   libavfilter / native encoders — only verified on the local GPL
//   8.1.2 build; re-check each on the BtbN LGPL 9.0 build at the M2
//   gate. Demucs is Python + PyTorch (no FFmpeg filter involved);
//   the vocalSep intermediate uses libx264 (GPL), same as the
//   remix/proxy intermediates.
// Old M1 / P0 / P0b / P1 / P1b / P1c / P1d / P1e / P2a / P2b / P2c /
// P3a / P3b / P3c / P3d / P3e checks live in their own files and must
// still pass. NOTE: verify-p2b.mjs was updated in this batch — the
// multicam limit moved 2-4 -> 2-16, so its "5 angles rejects"
// assertions are now "17 angles rejects".
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aleTimecode,
  archiveProject,
  clearRenderCache,
  clearUncleanExit,
  createSubclip,
  DEMUCS_SETUP,
  detectCrashRecovery,
  exportProject,
  filterMediaLibrary,
  generateOptimizedMedia,
  generateProxy,
  ingestMedia,
  latestAutosaveBackup,
  markUncleanExit,
  mediaTypeOf,
  PRESETS,
  probe,
  projectDuration,
  readAutosaveBackup,
  relinkOfflineMedia,
  renderCacheKey,
  renderCacheSegment,
  repairFilter,
  scanWatchFolder,
  separateVocals,
  sliceProjectForCache,
  surroundAudioCodec,
  surroundUpmixFilter,
  synthesizeSpeech,
  toALE,
  useOptimizedMedia,
  validateAudioRepair,
  validateCacheSegment,
  validateMediaItem,
  validateMediaLibrary,
  validateOptimizedMedia,
  validateSurroundLayout,
  validateTtsNarration,
  validateVocalsep,
  writeAutosaveBackup,
} from '../dist/export.js';
import { buildFilterGraph } from '../dist/filtergraph.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const PYTHON = '.venv/bin/python';
const ENGINE = new URL('..', import.meta.url).pathname;

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

/** Goertzel RMS level of one frequency (dBFS) in a window — same as p3a. */
async function level(file, freq, ss = 1, dur = 2, chan = -1) {
  const args = ['-v', 'error'];
  if (ss) args.push('-ss', String(ss));
  args.push('-i', file, '-t', String(dur));
  if (chan >= 0) args.push('-af', `pan=mono|c0=c${chan}`);
  args.push('-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-');
  const r = await run('ffmpeg', args).catch((e) => e);
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
  return 20 * Math.log10((2 * Math.sqrt(Math.max(0, p))) / N / Math.SQRT2 + 1e-12);
}

/** RMS level (dBFS) of a window. */
async function rmsWindow(file, ss, dur, chan = -1) {
  const args = ['-v', 'error'];
  if (ss) args.push('-ss', String(ss));
  args.push('-i', file, '-t', String(dur));
  if (chan >= 0) args.push('-af', `pan=mono|c0=c${chan}`);
  args.push('-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-');
  const r = await run('ffmpeg', args).catch((e) => e);
  const buf = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? '', 'binary');
  const s = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  if (s.length === 0) return -240;
  let e = 0; for (const v of s) e += v * v;
  return 20 * Math.log10(Math.sqrt(e / s.length) + 1e-12);
}

/** Peak abs sample in a window (for click detection). */
async function peakWindow(file, ss, dur) {
  const r = await run('ffmpeg', ['-v', 'error', '-ss', String(ss), '-i', file, '-t', String(dur),
    '-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-']).catch((e) => e);
  const buf = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? '', 'binary');
  const s = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  let m = 0; for (const v of s) m = Math.max(m, Math.abs(v));
  return m;
}
async function rgbMean(file, ss) {
  const r = await run('ffmpeg', ['-ss', String(ss), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const b = r.stdout; let r0 = 0, g = 0, bl = 0; const n = b.length / 3;
  for (let i = 0; i < b.length; i += 3) { r0 += b[i]; g += b[i + 1]; bl += b[i + 2]; }
  return [r0 / n, g / n, bl / n];
}
async function ffprobeJson(file, args) {
  const r = await run('ffprobe', ['-v', 'error', ...args, '-of', 'json', file]);
  return JSON.parse(r.stdout.toString());
}
async function audioDuration(file) {
  const j = await ffprobeJson(file, ['-show_entries', 'format=duration']);
  return Number(j.format.duration);
}

/** Write a 16-bit mono 48 kHz WAV from a sample function. */
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
async function muxVideo(color, wav, dur, out) {
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30:d=${dur}`,
    '-i', wav, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', out]);
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
// Click source: 440 Hz tone + 3 single-sample clicks (amp 1.0).
synthWav(`${DIR}p3f-click.wav`, 4, (t) => {
  let v = 0.15 * Math.sin(2 * Math.PI * 440 * t);
  for (const c of [1.0, 2.0, 3.0]) if (Math.abs(t - c) < 1 / 48000) v = 1.0;
  return v;
});
await muxVideo('red', `${DIR}p3f-click.wav`, 4, `${DIR}p3f-click.mp4`);
// Hum source: 440 Hz tone + 50 Hz hum (amp 0.3).
synthWav(`${DIR}p3f-hum.wav`, 4, (t) => 0.15 * Math.sin(2 * Math.PI * 440 * t) + 0.3 * Math.sin(2 * Math.PI * 50 * t));
await muxVideo('red', `${DIR}p3f-hum.wav`, 4, `${DIR}p3f-hum.mp4`);
// Gap-noise source: tone bursts + noise-only gaps (afftdn target).
let seed = 999;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 1073741824 - 1; };
synthWav(`${DIR}p3f-gapnoise.wav`, 4, (t) => {
  const tone = (t < 1 || (t >= 2 && t < 3)) ? 0.15 * Math.sin(2 * Math.PI * 440 * t) : 0;
  return tone + 0.03 * rnd();
});
await muxVideo('red', `${DIR}p3f-gapnoise.wav`, 4, `${DIR}p3f-gap.mp4`);
// Silence source (narration measurement: narration must be the only sound).
synthWav(`${DIR}p3f-sil.wav`, 4, () => 0);
await muxVideo('red', `${DIR}p3f-sil.wav`, 4, `${DIR}p3f-sil.mp4`);
// Tone source for surround (stereo mix bus input).
synthWav(`${DIR}p3f-tone.wav`, 4, (t) => 0.15 * Math.sin(2 * Math.PI * 440 * t));
await muxVideo('red', `${DIR}p3f-tone.wav`, 4, `${DIR}p3f-tone.mp4`);
// Voice/music mix for Demucs (440 Hz "voice" + 660 Hz "music").
synthWav(`${DIR}p3f-mix.wav`, 4, (t) => 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.3 * Math.sin(2 * Math.PI * 660 * t));
await muxVideo('red', `${DIR}p3f-mix.wav`, 4, `${DIR}p3f-mix.mp4`);
// Stereo source for surround (L = 440 Hz, R = 660 Hz).
{
  const sr = 48000, n = 4 * sr, data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    data.writeInt16LE(Math.round(0.3 * Math.sin(2 * Math.PI * 440 * t) * 32767), i * 4);
    data.writeInt16LE(Math.round(0.3 * Math.sin(2 * Math.PI * 660 * t) * 32767), i * 4 + 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * 4, 28);
  hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36);
  hdr.writeUInt32LE(data.length, 40);
  writeFileSync(`${DIR}p3f-stereo.wav`, Buffer.concat([hdr, data]));
}
await muxVideo('red', `${DIR}p3f-stereo.wav`, 4, `${DIR}p3f-stereo.mp4`);

// ---------------------------------------------------------------------------
// 1. Audio repair (adeclick / hum highpass / afftdn nr=25:nf=-30)
// ---------------------------------------------------------------------------
{
  check('repair: filter string order is adeclick,highpass,afftdn',
    repairFilter({ declick: true, humCutoffHz: 100, denoise: true }) === 'adeclick,highpass=f=100,afftdn=nr=25:nf=-30',
    repairFilter({ declick: true, humCutoffHz: 100, denoise: true }));
  check('repair: empty block is a no-op', repairFilter({}) === '');
  check('repair: humCutoffHz 20 throws', throwsSync(() => validateAudioRepair({ humCutoffHz: 20 }, 'c'), /humCutoffHz/));
  check('repair: humCutoffHz 500 throws', throwsSync(() => validateAudioRepair({ humCutoffHz: 500 }, 'c'), /humCutoffHz/));
  // Graph: repair + plain denoise must not double up afftdn.
  const g = buildFilterGraph(mkProject([mkClip('c', `${DIR}p3f-click.mp4`, 4, { denoise: true, audioRepair: { declick: true, denoise: true } })]), FONT);
  check('repair: graph has exactly one afftdn when repair.denoise + clip.denoise',
    (g.filterComplex.match(/afftdn/g) ?? []).length === 1, g.filterComplex.slice(0, 120));
  check('repair: graph contains adeclick', g.filterComplex.includes('adeclick'));

  const clickBefore = await peakWindow(`${DIR}p3f-click.mp4`, 1.0, 0.01);
  const repClick = await exportProject(
    mkProject([mkClip('c', `${DIR}p3f-click.mp4`, 4, { audioRepair: { declick: true } })]),
    `${DIR}p3f-repair-click.mp4`, { fontfile: FONT, preset: PRESET });
  const clickAfter = await peakWindow(`${DIR}p3f-repair-click.mp4`, 1.0, 0.01);
  const toneAfterClick = await level(`${DIR}p3f-repair-click.mp4`, 440, 0.5, 0.4);
  check('repair: export declick keeps duration', repClick.durationError <= 0.05, `err ${repClick.durationError}`);
  check('repair: adeclick click peak drops by >=50% to <=0.25 (AAC smears the single-sample click to ~0.52 first — probe wav measured 1.000)',
    clickBefore > 0.4 && clickAfter <= 0.25 && clickAfter < clickBefore * 0.5, `before ${clickBefore.toFixed(3)} after ${clickAfter.toFixed(3)}`);
  check('repair: adeclick tone 440Hz preserved (-19.5 +-1)', close(toneAfterClick, -19.5, 1), `${toneAfterClick.toFixed(2)}`);

  const humBefore = await level(`${DIR}p3f-hum.mp4`, 50, 1, 2);
  const repHum = await exportProject(
    mkProject([mkClip('c', `${DIR}p3f-hum.mp4`, 4, { audioRepair: { humCutoffHz: 100 } })]),
    `${DIR}p3f-repair-hum.mp4`, { fontfile: FONT, preset: PRESET });
  const humAfter = await level(`${DIR}p3f-repair-hum.mp4`, 50, 1, 2);
  const toneAfterHum = await level(`${DIR}p3f-repair-hum.mp4`, 440, 1, 2);
  check('repair: export hum keeps duration', repHum.durationError <= 0.05, `err ${repHum.durationError}`);
  check('repair: highpass f=100 drops 50Hz by >=10 dB', humBefore - humAfter >= 10, `${humBefore.toFixed(2)} -> ${humAfter.toFixed(2)}`);
  check('repair: highpass keeps 440Hz (-19.5 +-1)', close(toneAfterHum, -19.5, 1), `${toneAfterHum.toFixed(2)}`);

  const gapBefore = await rmsWindow(`${DIR}p3f-gap.mp4`, 1.2, 0.6);
  const repNoise = await exportProject(
    mkProject([mkClip('c', `${DIR}p3f-gap.mp4`, 4, { audioRepair: { denoise: true } })]),
    `${DIR}p3f-repair-noise.mp4`, { fontfile: FONT, preset: PRESET });
  const gapAfter = await rmsWindow(`${DIR}p3f-repair-noise.mp4`, 1.2, 0.6);
  const toneAfterNoise = await level(`${DIR}p3f-repair-noise.mp4`, 440, 2.2, 0.6);
  check('repair: export denoise keeps duration', repNoise.durationError <= 0.05, `err ${repNoise.durationError}`);
  check('repair: afftdn nr=25:nf=-30 drops gap noise to <=-50 dB', gapAfter <= -50, `${gapBefore.toFixed(2)} -> ${gapAfter.toFixed(2)}`);
  check('repair: afftdn keeps 440Hz tone (-19.5 +-1.5)', close(toneAfterNoise, -19.5, 1.5), `${toneAfterNoise.toFixed(2)}`);
  // Full repair chain at once.
  const repAll = await exportProject(
    mkProject([mkClip('c', `${DIR}p3f-gap.mp4`, 4, { audioRepair: { declick: true, humCutoffHz: 100, denoise: true } })]),
    `${DIR}p3f-repair-all.mp4`, { fontfile: FONT, preset: PRESET });
  check('repair: full chain export duration', repAll.durationError <= 0.05, `err ${repAll.durationError}`);
}

// ---------------------------------------------------------------------------
// 2. Vocal separation (Demucs) — live only when torch + weights exist
// ---------------------------------------------------------------------------
let demucsLive = false;
{
  check('vocalsep: bad mode throws', throwsSync(() => validateVocalsep({ mode: 'both' }, 'c'), /vocals.*accompaniment/));
  check('vocalsep: unknown model throws', throwsSync(() => validateVocalsep({ mode: 'vocals', model: 'bad' }, 'c'), /unknown/));
  check('vocalsep: setup text names the CPU torch install', DEMUCS_SETUP.includes('download.pytorch.org/whl/cpu'));
  let torchPresent = false;
  try {
    await run(`${ENGINE}${PYTHON}`, ['-c', 'import torch, demucs']);
    torchPresent = true;
    const ckpt = await run('bash', ['-c', 'ls ~/.cache/torch/hub/checkpoints/ 2>/dev/null | grep -i htdemucs; ls -d ~/.cache/huggingface/hub/models--adefossez--HTDemucs 2>/dev/null']).catch(() => ({ stdout: '' }));
    demucsLive = String(ckpt.stdout ?? '').trim().length > 0;
  } catch { demucsLive = false; }
  console.log(`[p3f] demucs live: ${demucsLive} (torch present: ${torchPresent})`);
  if (demucsLive) {
    // Live probe material: real speech (TTS) + a 660 Hz music tone.
    // Pure sines are NOT vocals to Demucs (see header) — the sine
    // mix is not used here.
    await synthesizeSpeech('你好世界，这是一个测试。', `${DIR}p3f-tts-live.wav`, { python: `${ENGINE}${PYTHON}` });
    synthWav(`${DIR}p3f-660.wav`, 4, (t) => 0.3 * Math.sin(2 * Math.PI * 660 * t));
    await run('ffmpeg', ['-v', 'error', '-i', `${DIR}p3f-tts-live.wav`, '-i', `${DIR}p3f-660.wav`,
      '-filter_complex', '[0:a]aresample=48000,apad=whole_dur=4[sp];[1:a]atrim=0:4[mu];[sp][mu]amix=inputs=2:duration=first:normalize=0',
      '-t', '4', '-y', `${DIR}p3f-speechmix.wav`]);
    const mix660 = await level(`${DIR}p3f-speechmix.wav`, 660, 1, 2);
    check('vocalsep: speech mix 660Hz reference is -13.5 +-1', close(mix660, -13.5, 1), `${mix660.toFixed(2)}`);
    const res = await separateVocals(`${DIR}p3f-speechmix.wav`, `${DIR}p3f-vocalsep`, { python: `${ENGINE}${PYTHON}` });
    check('vocalsep: stems exist', existsSync(res.vocals) && existsSync(res.accompaniment), `${res.vocals} / ${res.accompaniment}`);
    check('vocalsep: stem duration 4.0s +-0.1', close(res.duration, 4, 0.1), `${res.duration}`);
    check('vocalsep: model is htdemucs', res.model === 'htdemucs');
    const v660 = await level(res.vocals, 660, 1, 2);
    const vRms = await rmsWindow(res.vocals, 1, 2);
    const a660 = await level(res.accompaniment, 660, 1, 2);
    check('vocalsep: vocals stem suppresses the music tone by >=40 dB', mix660 - v660 >= 40, `mix ${mix660.toFixed(2)} vocals ${v660.toFixed(2)}`);
    check('vocalsep: vocals stem still carries speech (RMS > -40 dB)', vRms > -40, `${vRms.toFixed(2)}`);
    check('vocalsep: accompaniment stem preserves the music tone (+-5 dB)', Math.abs(a660 - mix660) <= 5, `mix ${mix660.toFixed(2)} accomp ${a660.toFixed(2)}`);
    await muxVideo('red', `${DIR}p3f-speechmix.wav`, 4, `${DIR}p3f-speechmix.mp4`);
    const repVs = await exportProject(
      mkProject([mkClip('c', `${DIR}p3f-speechmix.mp4`, 4, { vocalSep: { mode: 'vocals' } })]),
      `${DIR}p3f-vocalsep-exp.mp4`, { fontfile: FONT, preset: PRESET, python: `${ENGINE}${PYTHON}` });
    check('vocalsep: clip export with vocals stem keeps duration', repVs.durationError <= 0.05, `err ${repVs.durationError}`);
    const e660 = await level(`${DIR}p3f-vocalsep-exp.mp4`, 660, 1, 2);
    check('vocalsep: clip export audio suppresses the music tone by >=30 dB', mix660 - e660 >= 30, `mix ${mix660.toFixed(2)} export ${e660.toFixed(2)}`);
    const repVs2 = await exportProject(
      mkProject([mkClip('c', `${DIR}p3f-speechmix.mp4`, 4, { vocalSep: { mode: 'accompaniment' } })]),
      `${DIR}p3f-vocalsep-exp2.mp4`, { fontfile: FONT, preset: PRESET, python: `${ENGINE}${PYTHON}` });
    check('vocalsep: clip export with accompaniment stem keeps duration', repVs2.durationError <= 0.05, `err ${repVs2.durationError}`);
    const e660b = await level(`${DIR}p3f-vocalsep-exp2.mp4`, 660, 1, 2);
    check('vocalsep: accompaniment export preserves the music tone (+-5 dB)', Math.abs(e660b - mix660) <= 5, `mix ${mix660.toFixed(2)} export ${e660b.toFixed(2)}`);
  } else if (!torchPresent) {
    // Honest fallback (task spec): interface is ready, the model is
    // not on this machine — assert the failure, do not fake a result.
    const threw = await throwsAsync(() => separateVocals(`${DIR}p3f-mix.wav`, `${DIR}p3f-vocalsep`, { python: `${ENGINE}${PYTHON}` }), /vocal separation failed/);
    check('vocalsep: without torch/model, separateVocals throws with setup (no fake stems)', threw);
    check('vocalsep: clip export without Demucs throws instead of exporting the mix',
      await throwsAsync(() => exportProject(
        mkProject([mkClip('c', `${DIR}p3f-mix.mp4`, 4, { vocalSep: { mode: 'vocals' } })]),
        `${DIR}p3f-vocalsep-nope.mp4`, { fontfile: FONT, preset: PRESET, python: `${ENGINE}${PYTHON}` }), /vocal separation failed/));
  } else {
    // Torch landed mid-run but the weights are not cached: do NOT
    // start a ~400 MB model download inside the test. Assert the
    // CLI itself runs, and record the live run as not attempted.
    const help = await run(`${ENGINE}${PYTHON}`, ['-m', 'demucs', '--help']).catch((e) => e);
    check('vocalsep: torch present, weights not cached — CLI runs, live run skipped (no download in test)',
      String(help.stdout ?? '').includes('usage:') || String(help.stderr ?? '').includes('usage:'),
      'weights not cached; live separation not attempted');
  }
  check('vocalsep: missing source throws', await throwsAsync(() => separateVocals(`${DIR}p3f-nope.wav`, `${DIR}p3f-vocalsep`, { python: `${ENGINE}${PYTHON}` }), /source file missing/));
  check('vocalsep: unknown model throws before running', await throwsAsync(() => separateVocals(`${DIR}p3f-mix.wav`, `${DIR}p3f-vocalsep`, { python: `${ENGINE}${PYTHON}`, model: 'bad' }), /unknown Demucs model/));
}

// ---------------------------------------------------------------------------
// 3. TTS narration (sherpa-onnx, local)
// ---------------------------------------------------------------------------
{
  check('tts: empty text throws', await throwsAsync(() => synthesizeSpeech('', `${DIR}p3f-tts-empty.wav`, { python: `${ENGINE}${PYTHON}` }), /non-empty/));
  check('tts: 2001 chars throws', await throwsAsync(() => synthesizeSpeech('x'.repeat(2001), `${DIR}p3f-tts-long.wav`, { python: `${ENGINE}${PYTHON}` }), /2000-char cap/));
  check('tts: speed 3 throws', await throwsAsync(() => synthesizeSpeech('你好', `${DIR}p3f-tts-sp.wav`, { python: `${ENGINE}${PYTHON}`, speed: 3 }), /speed/));
  check('tts: empty narration text throws', throwsSync(() => validateTtsNarration({ text: '  ' }), /non-empty/));
  check('tts: narration speed 0.1 throws', throwsSync(() => validateTtsNarration({ text: '你好', speed: 0.1 }), /speed/));
  check('tts: narration gainDb 20 throws', throwsSync(() => validateTtsNarration({ text: '你好', gainDb: 20 }), /gainDb/));
  const tts = await synthesizeSpeech('你好世界，这是一个测试。', `${DIR}p3f-tts.wav`, { python: `${ENGINE}${PYTHON}` });
  const ttsDur = await audioDuration(`${DIR}p3f-tts.wav`);
  const ttsRms = await rmsWindow(`${DIR}p3f-tts.wav`, 0.2, 2);
  check('tts: synthesis duration in [2.0, 4.0]s for 12 chars (VITS timing is stochastic: 2.65/2.84/3.03/3.06/3.23s measured across runs — never assert an exact value)',
    tts.duration >= 2.0 && tts.duration <= 4.0 && close(ttsDur, tts.duration, 0.05), `${tts.duration.toFixed(2)}s`);
  check('tts: duration per char in (0, 0.6] s', tts.duration / 12 > 0 && tts.duration / 12 <= 0.6, `${(tts.duration / 12).toFixed(3)} s/char`);
  check('tts: speech is audible (RMS > -60 dB)', ttsRms > -60, `${ttsRms.toFixed(2)}`);
  // Narration mixed over a silent timeline: the narration window must
  // be the only sound; the control (no narration) must be silent.
  const narr = await exportProject(
    mkProject([mkClip('c', `${DIR}p3f-sil.mp4`, 4)], { narration: { text: '你好世界，这是一个测试。', start: 0.5 } }),
    `${DIR}p3f-narr.mp4`, { fontfile: FONT, preset: PRESET, python: `${ENGINE}${PYTHON}` });
  check('tts: narration export keeps duration', narr.durationError <= 0.05, `err ${narr.durationError}`);
  const narrRms = await rmsWindow(`${DIR}p3f-narr.mp4`, 1.0, 1.5);
  const ctrl = await exportProject(
    mkProject([mkClip('c', `${DIR}p3f-sil.mp4`, 4)]),
    `${DIR}p3f-narr-ctrl.mp4`, { fontfile: FONT, preset: PRESET });
  const ctrlRms = await rmsWindow(`${DIR}p3f-narr-ctrl.mp4`, 1.0, 1.5);
  check('tts: narration window is audible (RMS > -50 dB)', narrRms > -50, `${narrRms.toFixed(2)}`);
  check('tts: control window is silent (RMS < -80 dB)', ctrlRms < -80, `${ctrlRms.toFixed(2)}`);
  check('tts: narration before 0.5s is silent', (await rmsWindow(`${DIR}p3f-narr.mp4`, 0.05, 0.3)) < -80);
  check('tts: narration start past duration throws',
    await throwsAsync(() => exportProject(
      mkProject([mkClip('c', `${DIR}p3f-sil.mp4`, 4)], { narration: { text: '你好', start: 99 } }),
      `${DIR}p3f-narr-past.mp4`, { fontfile: FONT, preset: PRESET, python: `${ENGINE}${PYTHON}` }), /past the project duration/));
}

// ---------------------------------------------------------------------------
// 4. Multichannel 5.1 / 7.1
// ---------------------------------------------------------------------------
{
  check('surround: upmix 5.1 filter', surroundUpmixFilter('5.1') === 'pan=5.1|c0=c0|c1=c1|c2=0.5*c0+0.5*c1|c3=0*c0|c4=c0|c5=c1');
  check('surround: upmix 5.1 mono filter derives all channels from c0', surroundUpmixFilter('5.1', 1) === 'pan=5.1|c0=c0|c1=c0|c2=c0|c3=0*c0|c4=c0|c5=c0');
  check('surround: upmix 7.1 mono filter derives all channels from c0', surroundUpmixFilter('7.1', 1) === 'pan=7.1|c0=c0|c1=c0|c2=c0|c3=0*c0|c4=c0|c5=c0|c6=c0|c7=c0');
  check('surround: upmix bad channel count throws', throwsSync(() => surroundUpmixFilter('5.1', 6), /inputChannels/));
  check('surround: upmix stereo is empty', surroundUpmixFilter('stereo') === '');
  check('surround: codec for 5.1 defaults to ac3', surroundAudioCodec('5.1') === 'ac3');
  check('surround: codec for 7.1 defaults to aac (AC-3 tops out at 5.1)', surroundAudioCodec('7.1') === 'aac');
  check('surround: codec for stereo defaults to aac', surroundAudioCodec('stereo') === 'aac');
  check('surround: explicit aac wins over 5.1 default', surroundAudioCodec('5.1', 'aac') === 'aac');
  check('surround: bad layout throws', throwsSync(() => validateSurroundLayout('5.0'), /unknown/));
  const g51 = buildFilterGraph(mkProject([mkClip('c', `${DIR}p3f-tone.mp4`, 4)], { surroundLayout: '5.1' }), FONT);
  check('surround: graph contains pan=5.1', g51.filterComplex.includes('pan=5.1|'));

  const rep51 = await exportProject(
    mkProject([mkClip('c', `${DIR}p3f-tone.mp4`, 4)], { surroundLayout: '5.1' }),
    `${DIR}p3f-sur51.mp4`, { fontfile: FONT, preset: PRESET });
  check('surround: 5.1 export keeps duration', rep51.durationError <= 0.05, `err ${rep51.durationError}`);
  const j51 = await ffprobeJson(`${DIR}p3f-sur51.mp4`, ['-select_streams', 'a:0', '-show_entries', 'stream=codec_name,channels,channel_layout']);
  check('surround: 5.1 export is ac3 / 6ch / layout 5.1*',
    j51.streams[0].codec_name === 'ac3' && j51.streams[0].channels === 6 && String(j51.streams[0].channel_layout).startsWith('5.1'),
    JSON.stringify(j51.streams[0]));
  const fl = await level(`${DIR}p3f-sur51.mp4`, 440, 1, 2, 0);
  const fc = await level(`${DIR}p3f-sur51.mp4`, 440, 1, 2, 2);
  const lfe = await level(`${DIR}p3f-sur51.mp4`, 440, 1, 2, 3);
  const br = await level(`${DIR}p3f-sur51.mp4`, 440, 1, 2, 5);
  check('surround: 5.1 FL carries the tone (-19.5 +-2)', close(fl, -19.5, 2), `${fl.toFixed(2)}`);
  check('surround: 5.1 FC carries the tone (-19.5 +-2)', close(fc, -19.5, 2), `${fc.toFixed(2)}`);
  check('surround: 5.1 BR carries the tone (-19.5 +-2)', close(br, -19.5, 2), `${br.toFixed(2)}`);
  check('surround: 5.1 LFE is silent (< -80 dB)', lfe < -80, `${lfe.toFixed(2)}`);
  // Stereo bus: left/right must stay separate through the upmix.
  const rep51s = await exportProject(
    mkProject([mkClip('c', `${DIR}p3f-stereo.mp4`, 4)], { surroundLayout: '5.1' }),
    `${DIR}p3f-sur51s.mp4`, { fontfile: FONT, preset: PRESET });
  check('surround: stereo 5.1 export keeps duration', rep51s.durationError <= 0.05, `err ${rep51s.durationError}`);
  const sFL440 = await level(`${DIR}p3f-sur51s.mp4`, 440, 1, 2, 0);
  const sFL660 = await level(`${DIR}p3f-sur51s.mp4`, 660, 1, 2, 0);
  const sFR440 = await level(`${DIR}p3f-sur51s.mp4`, 440, 1, 2, 1);
  const sFR660 = await level(`${DIR}p3f-sur51s.mp4`, 660, 1, 2, 1);
  check('surround: stereo FL is left-dominant (440 beats 660 by >=6 dB)', sFL440 - sFL660 >= 6, `440 ${sFL440.toFixed(2)} 660 ${sFL660.toFixed(2)}`);
  check('surround: stereo FR is right-dominant (660 beats 440 by >=6 dB)', sFR660 - sFR440 >= 6, `440 ${sFR440.toFixed(2)} 660 ${sFR660.toFixed(2)}`);
  check('surround: mixed mono+stereo timeline throws instead of dropping a side',
    await throwsAsync(() => exportProject(
      mkProject([mkClip('a', `${DIR}p3f-tone.mp4`, 4), mkClip('b', `${DIR}p3f-stereo.mp4`, 4)], { surroundLayout: '5.1' }),
      `${DIR}p3f-sur-mixed.mp4`, { fontfile: FONT, preset: PRESET }), /same audio channel count/));

  const rep71 = await exportProject(
    mkProject([mkClip('c', `${DIR}p3f-tone.mp4`, 4)], { surroundLayout: '7.1' }),
    `${DIR}p3f-sur71.mp4`, { fontfile: FONT, preset: PRESET });
  check('surround: 7.1 export keeps duration', rep71.durationError <= 0.05, `err ${rep71.durationError}`);
  const j71 = await ffprobeJson(`${DIR}p3f-sur71.mp4`, ['-select_streams', 'a:0', '-show_entries', 'stream=codec_name,channels,channel_layout']);
  check('surround: 7.1 export is aac / 8ch / layout 7.1',
    j71.streams[0].codec_name === 'aac' && j71.streams[0].channels === 8 && String(j71.streams[0].channel_layout).startsWith('7.1'),
    JSON.stringify(j71.streams[0]));
  check('surround: bad layout throws at export',
    await throwsAsync(() => exportProject(
      mkProject([mkClip('c', `${DIR}p3f-tone.mp4`, 4)], { surroundLayout: '5.0' }),
      `${DIR}p3f-sur-bad.mp4`, { fontfile: FONT, preset: PRESET }), /unknown/));
}

// ---------------------------------------------------------------------------
// 5. Multicam to 16 angles
// ---------------------------------------------------------------------------
{
  const angles16 = Array.from({ length: 16 }, (_, i) => `mc${i}`);
  const clip16 = mkClip('m', 'mc0', 4, { multicam: { angles: angles16, cuts: [{ t: 2, angle: 15 }] } });
  check('multicam16: 16 angles build a graph (no throw)', (() => {
    try {
      buildFilterGraph(mkProject([clip16]), FONT);
      return true;
    } catch { return false; }
  })());
  check('multicam16: 17 angles throws', throwsSync(() =>
    buildFilterGraph(mkProject([mkClip('m', 'R', 4, { multicam: { angles: Array(17).fill('R'), cuts: [] } })]), FONT),
  /2-16 angles/));
  // 16 real angle files, distinct colours, cuts to angle 15 at t=2.
  const palette = ['ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff', 'ff8000', '8000ff', '0080ff', '80ff00', 'ff0080', '00ff80', '804000', '408040', '404080', 'c0c0c0'];
  const angleFiles = [];
  for (let i = 0; i < 16; i++) {
    const f = `${DIR}p3f-mc${i}.mp4`;
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${palette[i]}:s=320x180:r=30:d=4`,
      '-i', `${DIR}p3f-tone.wav`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', f]);
    angleFiles.push(f);
  }
  const repMc = await exportProject(
    mkProject([mkClip('m', angleFiles[0], 4, { multicam: { angles: angleFiles, cuts: [{ t: 2.0, angle: 15 }] } })]),
    `${DIR}p3f-mc16.mp4`, { fontfile: FONT, preset: PRESET });
  check('multicam16: 16-angle export keeps duration', repMc.durationError <= 0.05, `err ${repMc.durationError}`);
  const f1 = await rgbMean(`${DIR}p3f-mc16.mp4`, 1.0);
  const f3 = await rgbMean(`${DIR}p3f-mc16.mp4`, 3.0);
  check('multicam16: t=1.0 is angle 0 red', f1[0] > 200 && f1[1] < 60 && f1[2] < 60, f1.map((v) => v.toFixed(0)).join(','));
  check('multicam16: t=3.0 is angle 15 silver (192,192,192)', f3[0] > 170 && f3[1] > 170 && f3[2] > 170, f3.map((v) => v.toFixed(0)).join(','));
  check('multicam16: 17-angle export throws',
    await throwsAsync(() => exportProject(
      mkProject([mkClip('m', angleFiles[0], 4, { multicam: { angles: [...angleFiles, angleFiles[0]], cuts: [] } })]),
      `${DIR}p3f-mc17.mp4`, { fontfile: FONT, preset: PRESET }), /2-16 angles/));
}

// ---------------------------------------------------------------------------
// 6. Render cache (background render + cache hit / clear)
// ---------------------------------------------------------------------------
{
  const cacheDir = `${DIR}p3f-cache`;
  const proj = mkProject([mkClip('r', `${DIR}p3f-tone.mp4`, 4), mkClip('b', `${DIR}p3f-tone.mp4`, 4)]);
  check('cache: span end past duration throws', throwsSync(() => validateCacheSegment(proj, 0, 99), /exceeds project duration/));
  check('cache: empty span throws', throwsSync(() => validateCacheSegment(proj, 2, 2), /empty or negative/));
  check('cache: xfade project throws', throwsSync(() => validateCacheSegment(
    mkProject([mkClip('r', `${DIR}p3f-tone.mp4`, 4), mkClip('b', `${DIR}p3f-tone.mp4`, 4)], { transitions: ['fade'] }), 0, 4), /all-cut/));
  const sliced = sliceProjectForCache(proj, 3, 6);
  check('cache: slice [3,6] keeps 2 clips re-windowed [3,4]/[0,2]',
    sliced.clips.length === 2 && sliced.clips[0].in === 3 && sliced.clips[0].out === 4 && sliced.clips[1].in === 0 && sliced.clips[1].out === 2,
    sliced.clips.map((c) => `[${c.in},${c.out}]`).join(' '));
  check('cache: same span+project gives the same key', renderCacheKey(proj, 3, 6) === renderCacheKey(proj, 3, 6));
  check('cache: edited project gives a different key',
    renderCacheKey(proj, 3, 6) !== renderCacheKey(mkProject([mkClip('r', `${DIR}p3f-tone.mp4`, 4), mkClip('g', `${DIR}p3f-tone.mp4`, 4)]), 3, 6));
  const first = await renderCacheSegment(proj, 3, 6, cacheDir, { fontfile: FONT, preset: PRESET });
  check('cache: first render is a miss', first.hit === false);
  check('cache: first render duration 3.0s +-0.05', close(first.duration, 3, 0.05), `${first.duration}`);
  check('cache: cache file exists', existsSync(first.task.file));
  const mtime1 = statSync(first.task.file).mtimeMs;
  await new Promise((r) => setTimeout(r, 50));
  const second = await renderCacheSegment(proj, 3, 6, cacheDir, { fontfile: FONT, preset: PRESET });
  const mtime2 = statSync(second.task.file).mtimeMs;
  check('cache: second render is a hit', second.hit === true);
  check('cache: hit did not re-render (mtime unchanged)', mtime1 === mtime2, `${mtime1} vs ${mtime2}`);
  check('cache: hit duration still 3.0s', close(second.duration, 3, 0.05), `${second.duration}`);
  const removed = clearRenderCache(cacheDir);
  check('cache: clear removes the cache file', removed >= 1 && !existsSync(first.task.file), `removed ${removed}`);
  check('cache: clear on empty dir removes 0', clearRenderCache(cacheDir) === 0);
}

// ---------------------------------------------------------------------------
// 7. Optimized media (DNxHR)
// ---------------------------------------------------------------------------
{
  const info = await generateOptimizedMedia(`${DIR}p3f-tone.mp4`, `${DIR}p3f-opt.mov`);
  check('optimized: codec is dnxhd', info.width === 320 && info.height === 180, `${info.width}x${info.height}`);
  check('optimized: profile is dnxhr_hq', info.profile === 'dnxhr_hq');
  check('optimized: duration matches source +-0.05', close(info.duration, info.sourceDuration, 0.05), `${info.duration} vs ${info.sourceDuration}`);
  const j = await ffprobeJson(`${DIR}p3f-opt.mov`, ['-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile,width,height']);
  check('optimized: ffprobe reads dnxhd / DNXHR HQ / 320x180',
    j.streams[0].codec_name === 'dnxhd' && j.streams[0].profile === 'DNXHR HQ' && j.streams[0].width === 320 && j.streams[0].height === 180,
    JSON.stringify(j.streams[0]));
  const srcMean = await rgbMean(`${DIR}p3f-tone.mp4`, 1.0);
  const optMean = await rgbMean(`${DIR}p3f-opt.mov`, 1.0);
  check('optimized: frame means match source (R +-3, G +-25 — 422/420 chroma)',
    Math.abs(srcMean[0] - optMean[0]) <= 3 && Math.abs(srcMean[1] - optMean[1]) <= 25,
    `src ${srcMean.map((v) => v.toFixed(0))} opt ${optMean.map((v) => v.toFixed(0))}`);
  check('optimized: bad profile throws', await throwsAsync(() => generateOptimizedMedia(`${DIR}p3f-tone.mp4`, `${DIR}p3f-opt-bad.mov`, { profile: 'dnxhr_xx' }), /unknown DNxHR profile/));
  const sq = await generateOptimizedMedia(`${DIR}p3f-tone.mp4`, `${DIR}p3f-opt-sq.mov`, { profile: 'dnxhr_sq' });
  check('optimized: dnxhr_sq profile works', sq.profile === 'dnxhr_sq');
  // useOptimizedMedia swaps the source; export still renders the original.
  const projOpt = mkProject([mkClip('c', `${DIR}p3f-tone.mp4`, 4, { optimizedMedia: { file: info.file, width: 320, height: 180 } })]);
  const swapped = useOptimizedMedia(projOpt);
  check('optimized: preview swaps source to the .mov', swapped.clips[0].source.endsWith('p3f-opt.mov'));
  const repOpt = await exportProject(projOpt, `${DIR}p3f-opt-exp.mp4`, { fontfile: FONT, preset: PRESET });
  check('optimized: export with optimizedMedia attached keeps duration', repOpt.durationError <= 0.05, `err ${repOpt.durationError}`);
  check('optimized: missing file throws at export',
    await throwsAsync(() => exportProject(
      mkProject([mkClip('c', `${DIR}p3f-tone.mp4`, 4, { optimizedMedia: { file: `${DIR}p3f-opt-gone.mov`, width: 320, height: 180 } })]),
      `${DIR}p3f-opt-missing.mp4`, { fontfile: FONT, preset: PRESET }), /optimized media file missing/));
  check('optimized: size mismatch throws',
    await throwsAsync(() => validateOptimizedMedia(
      mkProject([mkClip('c', `${DIR}p3f-tone.mp4`, 4, { optimizedMedia: { file: info.file, width: 640, height: 360 } })])), /size mismatch/));
  check('optimized: validate passes for a good reference',
    await (async () => { await validateOptimizedMedia(projOpt); return true; })());
}

// ---------------------------------------------------------------------------
// 8. Project management: library / ALE / subclips / autosave / archive /
//    relink / ingest
// ---------------------------------------------------------------------------
{
  // -- media library + smart bins --
  const lib = [
    { id: 'm1', file: '/x/a.mp4', kind: 'media', bin: 'A-cam', keywords: ['interview'], rating: 5, favorite: true, camera: 'XT4', mediaType: 'video', duration: 10 },
    { id: 'm2', file: '/x/b.mp4', kind: 'media', bin: 'A-cam', keywords: ['broll'], rating: 3, camera: 'XT4', mediaType: 'video', duration: 8 },
    { id: 'm3', file: '/x/c.wav', kind: 'media', bin: 'audio', keywords: ['interview'], rating: 4, rejected: true, camera: 'iPhone', mediaType: 'audio', duration: 5 },
    { id: 'm4', file: '/x/d.mp4', kind: 'media', bin: 'B-roll', keywords: ['broll'], rating: 2, camera: 'iPhone', mediaType: 'video', duration: 6 },
  ];
  check('library: validate passes', validateMediaLibrary(lib).length === 4);
  check('library: duplicate id throws', throwsSync(() => validateMediaLibrary([...lib, { id: 'm1', file: '/x/e.mp4', kind: 'media' }]), /duplicate media item id/));
  check('library: rating 6 throws', throwsSync(() => validateMediaItem({ id: 'x', file: '/x/e.mp4', kind: 'media', rating: 6 }), /rating/));
  check('library: bin filter hits 2', filterMediaLibrary(lib, { bin: 'A-cam' }).length === 2);
  check('library: keyword filter hits 2', filterMediaLibrary(lib, { keyword: 'interview' }).length === 2);
  check('library: minRating 4 hits 2', filterMediaLibrary(lib, { minRating: 4 }).length === 2);
  check('library: favorite filter hits 1', filterMediaLibrary(lib, { favorite: true }).length === 1);
  check('library: rejected filter hits 1', filterMediaLibrary(lib, { rejected: true }).length === 1);
  check('library: mediaType audio hits 1', filterMediaLibrary(lib, { mediaType: 'audio' }).length === 1);
  check('library: camera XT4 hits 2', filterMediaLibrary(lib, { camera: 'XT4' }).length === 2);
  check('library: empty rule matches all', filterMediaLibrary(lib, {}).length === 4);
  check('library: mediaTypeOf mp4/wav/png',
    mediaTypeOf('/x/a.mp4') === 'video' && mediaTypeOf('/x/b.wav') === 'audio' && mediaTypeOf('/x/c.png') === 'image' && mediaTypeOf('/x/d.txt') === 'other');
  // -- subclips --
  const sub = createSubclip(lib, 'm1', 's1', 'best take', 2, 5);
  check('subclip: references parent file (no copy)', sub.file === '/x/a.mp4' && sub.kind === 'subclip' && sub.parentId === 'm1');
  check('subclip: in/out + duration stored', sub.in === 2 && sub.out === 5 && sub.duration === 3);
  check('subclip: end past parent duration throws', throwsSync(() => createSubclip(lib, 'm1', 's2', 'x', 2, 99), /exceeds parent duration/));
  check('subclip: duplicate id throws', throwsSync(() => createSubclip(lib, 'm1', 'm2', 'x', 1, 2), /already used/));
  check('subclip: missing parent throws', throwsSync(() => createSubclip(lib, 'nope', 's3', 'x', 1, 2), /not found/));
  check('subclip: subclip-of-subclip throws', throwsSync(() => createSubclip([...lib, sub], 's1', 's4', 'x', 0, 1), /itself a subclip/));
  // -- ALE --
  const ale = toALE([
    { id: 'm1', name: 'interview-a', file: '/x/a.mp4', kind: 'media', camera: 'XT4', mediaType: 'video', duration: 10, keywords: ['interview'], metadata: { scene: '1', take: '2', notes: 'good take' } },
    sub,
  ]);
  check('ALE: header + name + scene + keywords present',
    ale.includes('FIELD_DELIM\tTABS') && ale.includes('interview-a') && ale.includes('\t1\t2\tinterview') && ale.includes('good take'));
  check('ALE: subclip in timecode is 00:00:02:00', ale.includes('00:00:02:00') && ale.includes('00:00:05:00'));
  check('ALE: timecode helper 1.0s = 00:00:01:00', aleTimecode(1.0) === '00:00:01:00');
  check('ALE: item without file throws', throwsSync(() => toALE([{ id: 'x', file: '', kind: 'media' }]), /file is required/));
  // -- autosave + crash recovery --
  const saveDir = `${DIR}p3f-save`;
  const proj = mkProject([mkClip('c', `${DIR}p3f-tone.mp4`, 4)]);
  const backup = writeAutosaveBackup(proj, saveDir);
  check('autosave: backup file exists', existsSync(backup));
  check('autosave: backup parses back to the same project',
    readAutosaveBackup(backup).clips.length === 1 && readAutosaveBackup(backup).clips[0].id === 'c');
  check('autosave: latest backup is the one just written', latestAutosaveBackup(saveDir) === backup);
  check('autosave: no crash without the flag', detectCrashRecovery(saveDir).crashed === false);
  markUncleanExit(saveDir);
  const rec = detectCrashRecovery(saveDir);
  check('autosave: crash detected with backup after unclean flag', rec.crashed === true && rec.backup === backup);
  clearUncleanExit(saveDir);
  check('autosave: flag cleared, no crash reported', detectCrashRecovery(saveDir).crashed === false);
  check('autosave: garbage backup throws', (() => {
    const bad = join(saveDir, 'garbage.json');
    writeFileSync(bad, '{"nope":true}', 'utf8');
    try { readAutosaveBackup(bad); return false; } catch { return true; }
  })());
  // -- archive + relink --
  const archDir = `${DIR}p3f-archive`;
  const proxyInfo = await generateProxy(`${DIR}p3f-tone.mp4`, `${DIR}p3f-tone.proxy.mp4`);
  const projArch = mkProject([mkClip('c', `${DIR}p3f-tone.mp4`, 4, { proxy: { file: proxyInfo.file, width: proxyInfo.width, height: proxyInfo.height } })]);
  const arch = archiveProject(projArch, archDir);
  check('archive: source + proxy copied into media/', arch.copied.length === 2, `copied ${arch.copied.length}`);
  const archProj = JSON.parse(readFileSync(arch.projectFile, 'utf8'));
  check('archive: archived project uses relative paths', String(archProj.clips[0].source).startsWith('media/'));
  check('archive: missing source throws', throwsSync(() => archiveProject(
    mkProject([mkClip('c', `${DIR}p3f-gone.mp4`, 4)]), `${DIR}p3f-archive2`), /source file missing/));
  // Relink: copy the source under a new name into a search folder,
  // point the project at a missing path with the same basename.
  const searchDir = `${DIR}p3f-search`;
  mkdirSync(searchDir, { recursive: true });
  await run('cp', [`${DIR}p3f-tone.mp4`, `${searchDir}/p3f-tone.mp4`]);
  const lost = mkProject([mkClip('c', '/nowhere/p3f-tone.mp4', 4)]);
  const rel = await relinkOfflineMedia(lost, searchDir, { library: [{ id: 'm1', file: '/nowhere/p3f-tone.mp4', kind: 'media', duration: 4 }] });
  check('relink: missing source matched by basename+duration', rel.relinked.length === 1 && rel.project.clips[0].source === `${searchDir}/p3f-tone.mp4`);
  check('relink: nothing left unmatched', rel.unmatched.length === 0);
  const relNone = await relinkOfflineMedia(mkProject([mkClip('c', '/nowhere/other.mp4', 4)]), searchDir);
  check('relink: no match stays unmatched (not guessed)', relNone.unmatched.length === 1 && relNone.project.clips[0].source === '/nowhere/other.mp4');
  check('relink: duration mismatch throws instead of relinking the wrong file',
    await throwsAsync(() => relinkOfflineMedia(
      mkProject([mkClip('c', '/nowhere/p3f-tone.mp4', 4)]), searchDir,
      { library: [{ id: 'm1', file: '/nowhere/p3f-tone.mp4', kind: 'media', duration: 99 }] }), /does not match expected/));
  // -- ingest + watch folder --
  const mediaDir = `${DIR}p3f-media`;
  const ing = await ingestMedia(`${DIR}p3f-tone.mp4`, mediaDir, 'ing1', { copy: true, transcode: 'none' });
  check('ingest: file copied into media dir', existsSync(ing.file) && ing.file.startsWith(mediaDir));
  check('ingest: item fields (name/type/duration)', ing.item.name === 'p3f-tone.mp4' && ing.item.mediaType === 'video' && close(ing.item.duration, 4, 0.05), JSON.stringify(ing.item));
  const ingOpt = await ingestMedia(`${DIR}p3f-tone.mp4`, mediaDir, 'ing2', { copy: true, transcode: 'dnxhr' });
  check('ingest: dnxhr transcode produces a .mov', ingOpt.transcoded?.endsWith('.optimized.mov') && existsSync(ingOpt.transcoded));
  const ingProxy = await ingestMedia(`${DIR}p3f-tone.mp4`, mediaDir, 'ing3', { copy: true, transcode: 'proxy' });
  check('ingest: proxy transcode produces a .proxy.mp4', ingProxy.transcoded?.endsWith('.proxy.mp4') && existsSync(ingProxy.transcoded));
  check('ingest: unknown transcode throws', await throwsAsync(() => ingestMedia(`${DIR}p3f-tone.mp4`, mediaDir, 'ing4', { transcode: 'prores' }), /unknown transcode/));
  check('ingest: missing source throws', await throwsAsync(() => ingestMedia(`${DIR}p3f-gone.mp4`, mediaDir, 'ing5'), /source file missing/));
  const watchDir = `${DIR}p3f-watch`;
  mkdirSync(watchDir, { recursive: true });
  await run('cp', [`${DIR}p3f-tone.mp4`, `${watchDir}/new1.mp4`]);
  await run('cp', [`${DIR}p3f-tone.mp4`, `${watchDir}/new2.mp4`]);
  const known = [{ id: 'k1', file: `${watchDir}/new1.mp4`, kind: 'media' }];
  const fresh = scanWatchFolder(watchDir, known);
  check('watch: scan returns only the unknown file', fresh.length === 1 && fresh[0].endsWith('new2.mp4'), JSON.stringify(fresh));
  check('watch: scan of a missing dir returns []', scanWatchFolder(`${DIR}p3f-watch-gone`, []).length === 0);
}

// ---------------------------------------------------------------------------
// 9. Combined wiring: repair + narration + 5.1 in one export
// ---------------------------------------------------------------------------
{
  const rep = await exportProject(
    mkProject([mkClip('c', `${DIR}p3f-gap.mp4`, 4, { audioRepair: { denoise: true } })],
      { narration: { text: '你好世界。', start: 0.5 }, surroundLayout: '5.1' }),
    `${DIR}p3f-combo.mp4`, { fontfile: FONT, preset: PRESET, python: `${ENGINE}${PYTHON}` });
  check('combo: repair+narration+5.1 export keeps duration', rep.durationError <= 0.05, `err ${rep.durationError}`);
  const j = await ffprobeJson(`${DIR}p3f-combo.mp4`, ['-select_streams', 'a:0', '-show_entries', 'stream=codec_name,channels']);
  check('combo: export is ac3 / 6ch', j.streams[0].codec_name === 'ac3' && j.streams[0].channels === 6, JSON.stringify(j.streams[0]));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} passed`);
for (const [name, ok] of checks) if (!ok) console.log(`FAIL: ${name}`);
if (passed !== checks.length) process.exit(1);
