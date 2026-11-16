// P0b engine verification (M4, 2026-11-17).
// Covers: auto subtitles (local faster-whisper -> SRT -> burn-in, sentence
// drawtext + ASS karaoke word highlight), reverse, freeze frame.
// Ground truth: test/speech-zh.wav is offline sherpa-onnx VITS speech of
// TRUTH below (see test/tts-zh.py); the Whisper JSONs were produced by
// scripts/transcribe.py (tiny + small; medium if present).
// Old M1 checks live in verify.mjs, P0 in verify-p0.mjs; both must still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { exportProject, probe, PRESETS, parseSRT, toSRT, countBoundaryErrors, validateWordTimes } from '../dist/export.js';
import { buildFilterGraph } from '../dist/filtergraph.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const SRC = `${DIR}source.mp4`;
const SPEECH_WAV = `${DIR}speech-zh.wav`;
const SPEECH_VIDEO = `${DIR}speech-video.mp4`;
const FONT_CJK = '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc';
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const TRUTH = '先说结论，线上生意先选平台再选产品。方向错了，越努力越亏。所以第一步永远是想清楚，你要赚谁的钱。';

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

async function framePng(file, n, out) {
  // Frame-number selection: -ss seeking proved unreliable for frame-exact
  // comparison (rev frame 15 via -ss 0.5 gave PSNR 16.6 vs the same frame
  // via select n=15, which gives 39.4). Always select by frame number.
  await exec('ffmpeg', ['-i', file, '-vf', `select='eq(n\\,${n})'`, '-frames:v', '1', '-y', out]);
}

async function psnr(a, b) {
  const r = await exec('ffmpeg', ['-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-']).catch((e) => e);
  const m = ((r.stderr ?? '') + (r.stdout ?? '')).match(/average:([0-9.inf]+)/);
  if (!m) return NaN;
  return m[1] === 'inf' ? 999 : Number(m[1]);
}

async function meanVolume(file, ss, dur) {
  const r = await exec('ffmpeg', ['-ss', String(ss), '-t', String(dur), '-i', file, '-af', 'volumedetect', '-f', 'null', '-']).catch((e) => e);
  const m = ((r.stderr ?? '') + (r.stdout ?? '')).match(/mean_volume:\s*(-inf|-?[\d.]+)/);
  return m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : NaN;
}

async function hasBlackSegments(file) {
  const bd = await exec('ffmpeg', ['-i', file, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-']).catch((e) => e);
  return /black_start/.test((bd.stderr ?? '') + (bd.stdout ?? ''));
}

async function speechBounds(wav) {
  const r = await exec('ffmpeg', ['-i', wav, '-af', 'silencedetect=noise=-40dB:d=0.3', '-f', 'null', '-']).catch((e) => e);
  const text = (r.stderr ?? '') + (r.stdout ?? '');
  const durM = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const total = durM ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3]) : 0;
  const silences = [...text.matchAll(/silence_start:\s*([\d.]+)[\s\S]*?silence_end:\s*([\d.]+)/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
  const bounds = [];
  let cur = 0;
  for (const [s, e] of silences) {
    if (s > cur) bounds.push({ start: cur, end: s });
    cur = Math.max(cur, e);
  }
  if (cur < total) bounds.push({ start: cur, end: total });
  return bounds;
}

// --- sources ---
await exec('ffmpeg', [
  '-f', 'lavfi', '-i', 'testsrc2=duration=10:size=1280x720:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', SRC,
]);
// Speech video: test pattern video + the real Chinese speech audio.
await exec('ffmpeg', [
  '-f', 'lavfi', '-i', 'testsrc2=duration=13:size=1280x720:rate=30',
  '-i', SPEECH_WAV,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', SPEECH_VIDEO,
]);
const speechProbe = await probe(SPEECH_VIDEO);
const speechDur = speechProbe.duration;

const tinyJson = JSON.parse(readFileSync(`${DIR}speech-zh.json`, 'utf8'));
const tinyItems = tinyJson.segments.map((s) => ({
  text: s.text, start: s.start, end: s.end,
  words: (s.words ?? []).map((w) => ({ w: w.w, start: w.start, end: w.end })),
}));

// --- A. SRT round-trip + word-time validity ---
{
  const srt = toSRT(tinyItems);
  check('A SRT timecode format', /00:00:00,000 --> 00:00:05,160/.test(srt), srt.split('\n')[1]);
  const back = parseSRT(srt);
  const same = back.length === tinyItems.length
    && back.every((b, i) => b.text === tinyItems[i].text
      && Math.abs(b.start - tinyItems[i].start) < 0.001
      && Math.abs(b.end - tinyItems[i].end) < 0.001);
  check('A SRT round-trip identical', same, `${back.length} items`);
  const problems = validateWordTimes(tinyItems);
  check('A word timestamps valid', problems.length === 0, problems.join('; ') || `${tinyItems.reduce((n, it) => n + (it.words?.length ?? 0), 0)} words`);
}

// --- B. Whisper accuracy (measured, not assumed) + timing alignment ---
{
  const cer = async (jsonFile) => {
    const r = await exec(`${DIR}../.venv/bin/python`, [`${DIR}cer.py`, TRUTH, jsonFile]);
    const [pct, frac] = r.stdout.trim().split(' ');
    return { pct: Number(pct), frac };
  };
  const tinyCer = await cer(`${DIR}speech-zh.json`);
  check('B tiny CER measured (<60% sanity gate)', tinyCer.pct < 60, `CER=${tinyCer.pct}% (${tinyCer.frac})`);
  if (existsSync(`${DIR}speech-zh-small.json`)) {
    const smallCer = await cer(`${DIR}speech-zh-small.json`);
    check('B small CER measured (<35%)', smallCer.pct < 35, `CER=${smallCer.pct}% (${smallCer.frac})`);
  }
  const bounds = await speechBounds(SPEECH_WAV);
  const bad = countBoundaryErrors(tinyItems, bounds, 0.2);
  const firstOk = Math.abs(tinyItems[0].start - bounds[0].start) < 0.5;
  const lastOk = Math.abs(tinyItems[tinyItems.length - 1].end - bounds[bounds.length - 1].end) < 0.5;
  check('B subtitle timing covers speech', firstOk && lastOk,
    `speech ${bounds.length} intervals, first start ${bounds[0].start}s, last end ${bounds[bounds.length - 1].end}s; >0.2s-off items: ${bad.length} [${bad.join(',')}]`);
}

// --- C. Clip-level subtitle burn-in (drawtext, CJK font) ---
const base720 = { version: 1, width: 1280, height: 720, fps: 30, transitionDuration: 0.5 };
{
  const ctrl = { ...base720, clips: [{ id: 'c', source: SPEECH_VIDEO, in: 0, out: speechDur, speed: 1, volume: 1 }], transitions: [] };
  await exportProject(ctrl, `${DIR}p0b-sub-ctrl.mp4`, { preset: PRESETS['720p30'], fontfile: FONT_CJK });
  const sub = { ...base720,
    clips: [{ id: 'c', source: SPEECH_VIDEO, in: 0, out: speechDur, speed: 1, volume: 1, subtitles: tinyItems }],
    transitions: [] };
  const rep = await exportProject(sub, `${DIR}p0b-sub.mp4`, { preset: PRESETS['720p30'], fontfile: FONT_CJK });
  check('C clip subtitles duration', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s expected=${rep.expectedDuration.toFixed(2)}s`);
  check('C clip subtitles has audio', rep.actual.hasAudio);
  // Bottom strip (subtitle band): text visible at t=2.0 (inside seg 1),
  // gone at t=12.6 (after last segment ends 12.48).
  const yCtrlOn = await yavg(`${DIR}p0b-sub-ctrl.mp4`, 2.0, '1280:120:0:600');
  const ySubOn = await yavg(`${DIR}p0b-sub.mp4`, 2.0, '1280:120:0:600');
  check('C subtitle visible at t=2.0', Math.abs(ySubOn - yCtrlOn) > 2, `YAVG sub=${ySubOn} ctrl=${yCtrlOn}`);
  const yCtrlOff = await yavg(`${DIR}p0b-sub-ctrl.mp4`, 12.6, '1280:120:0:600');
  const ySubOff = await yavg(`${DIR}p0b-sub.mp4`, 12.6, '1280:120:0:600');
  check('C subtitle gone at t=12.6', Math.abs(ySubOff - yCtrlOff) < 2, `YAVG sub=${ySubOff} ctrl=${yCtrlOff}`);
}

// --- D. Project-level subtitles: SRT sidecar + ASS karaoke burn ---
{
  const srtPath = `${DIR}p0b-project.srt`;
  const p = { ...base720,
    clips: [{ id: 'c', source: SPEECH_VIDEO, in: 0, out: speechDur, speed: 1, volume: 1 }],
    transitions: [], subtitles: tinyItems };
  const rep = await exportProject(p, `${DIR}p0b-ass.mp4`, { preset: PRESETS['720p30'], fontfile: FONT_CJK, srtPath });
  check('D ASS duration', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check('D SRT sidecar written + parses', existsSync(srtPath) && parseSRT(readFileSync(srtPath, 'utf8')).length === tinyItems.length);
  const assText = readFileSync(`${DIR}p0b-ass.mp4.ass`, 'utf8');
  check('D ASS file has karaoke tags', assText.includes('{\\k') && assText.includes('Noto Serif CJK SC'), `${(assText.match(/\\k\d+/g) || []).length} \\k tags`);
  const yCtrlOn = await yavg(`${DIR}p0b-sub-ctrl.mp4`, 2.0, '1280:120:0:600');
  const yAssOn = await yavg(`${DIR}p0b-ass.mp4`, 2.0, '1280:120:0:600');
  check('D ASS subtitle visible at t=2.0', Math.abs(yAssOn - yCtrlOn) > 2, `YAVG ass=${yAssOn} ctrl=${yCtrlOn}`);
  const yAssOff = await yavg(`${DIR}p0b-ass.mp4`, 12.6, '1280:120:0:600');
  check('D ASS subtitle gone at t=12.6', Math.abs(yAssOff - (await yavg(`${DIR}p0b-sub-ctrl.mp4`, 12.6, '1280:120:0:600'))) < 2, `YAVG ass=${yAssOff}`);
}

// --- E. reverse (4s clip) ---
{
  const ctrl = { ...base720, clips: [{ id: 'c', source: SRC, in: 0, out: 4, speed: 1, volume: 1 }], transitions: [] };
  await exportProject(ctrl, `${DIR}p0b-rev-ctrl.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  const rev = { ...base720,
    clips: [{ id: 'c', source: SRC, in: 0, out: 4, speed: 1, volume: 1, reverse: true }],
    transitions: [] };
  const rep = await exportProject(rev, `${DIR}p0b-rev.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('E reverse duration ~4.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check('E reverse has audio', rep.actual.hasAudio);
  // Reversed frame 15 (t=0.5) == source frame 104 (t=3.4667); frame 105
  // (t=3.5) == source frame 14 (t=0.4667). testsrc2 has a frame counter.
  await framePng(`${DIR}p0b-rev.mp4`, 15, `${DIR}f-rev-15.png`);
  await framePng(`${DIR}p0b-rev-ctrl.mp4`, 104, `${DIR}f-ctrl-104.png`);
  const p1 = await psnr(`${DIR}f-rev-15.png`, `${DIR}f-ctrl-104.png`);
  check('E reversed frame matches mirrored source', p1 > 35, `PSNR=${p1}`);
  await framePng(`${DIR}p0b-rev.mp4`, 105, `${DIR}f-rev-105.png`);
  await framePng(`${DIR}p0b-rev-ctrl.mp4`, 14, `${DIR}f-ctrl-14.png`);
  const p2 = await psnr(`${DIR}f-rev-105.png`, `${DIR}f-ctrl-14.png`);
  check('E reversed tail matches mirrored source', p2 > 35, `PSNR=${p2}`);
}

// --- F. freeze frame (4s + 1s freeze = 5.0s, frozen span silent) ---
{
  const frz = { ...base720,
    clips: [{ id: 'c', source: SRC, in: 0, out: 4, speed: 1, volume: 1, freezeAt: 2, freezeDuration: 1 }],
    transitions: [] };
  const rep = await exportProject(frz, `${DIR}p0b-freeze.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('F freeze duration ~5.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s expected=${rep.expectedDuration.toFixed(2)}s`);
  check('F freeze has audio', rep.actual.hasAudio);
  await framePng(`${DIR}p0b-freeze.mp4`, 75, `${DIR}f-frz-25.png`);
  await framePng(`${DIR}p0b-rev-ctrl.mp4`, 60, `${DIR}f-ctrl-60.png`);
  const p1 = await psnr(`${DIR}f-frz-25.png`, `${DIR}f-ctrl-60.png`);
  check('F frozen frame == frame at freezeAt', p1 > 35, `PSNR=${p1}`);
  await framePng(`${DIR}p0b-freeze.mp4`, 135, `${DIR}f-frz-45.png`);
  await framePng(`${DIR}p0b-rev-ctrl.mp4`, 105, `${DIR}f-ctrl-105.png`);
  const p2 = await psnr(`${DIR}f-frz-45.png`, `${DIR}f-ctrl-105.png`);
  check('F post-freeze frame shifted by 1s', p2 > 35, `PSNR=${p2}`);
  const vFreeze = await meanVolume(`${DIR}p0b-freeze.mp4`, 2.2, 0.6);
  const vCtrl = await meanVolume(`${DIR}p0b-rev-ctrl.mp4`, 2.2, 0.6);
  check('F frozen span is silent', vFreeze < -70, `mean_volume freeze=${vFreeze} ctrl=${vCtrl}`);
  check('F no black segments', !(await hasBlackSegments(`${DIR}p0b-freeze.mp4`)));
}

// --- G. reverse + freeze combined ---
{
  const p = { ...base720,
    clips: [{ id: 'c', source: SRC, in: 0, out: 4, speed: 1, volume: 1, reverse: true, freezeAt: 1, freezeDuration: 1 }],
    transitions: [] };
  const rep = await exportProject(p, `${DIR}p0b-revfreeze.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('G reverse+freeze duration ~5.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check('G reverse+freeze has audio', rep.actual.hasAudio);
  check('G reverse+freeze no black segments', !(await hasBlackSegments(`${DIR}p0b-revfreeze.mp4`)));
}

// --- H. graph-string checks ---
{
  const gProj = { ...base720,
    clips: [{ id: 'c', source: SRC, in: 0, out: 4, speed: 1, volume: 1, reverse: true, freezeAt: 1, freezeDuration: 1 }],
    transitions: [], subtitles: tinyItems };
  const g = buildFilterGraph(gProj, FONT, undefined, `${DIR}dummy.ass`).filterComplex;
  check('H graph: reverse+areverse', g.includes(',reverse,') && g.includes('areverse'));
  check('H graph: freeze loop+apad', g.includes('loop=loop=29:size=1') && g.includes('apad=whole_dur=1'));
  check('H graph: ass filter', g.includes(`ass='${DIR}dummy.ass'`));
}

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? 'ALL P0b CHECKS PASSED' : `${failed} P0b CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
