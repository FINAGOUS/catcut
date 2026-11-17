// P3 batch 5 engine verification (M4 §8.2 / §8.3 / §8.6 / §8.7,
// 2026-11-18). Covers: src/timeline.ts — three-point insert/
// overwrite, replace footage, J/L audio windows, linked selection
// delete, markers + MP4 chapters, timeline index search, auditions,
// paste attributes, adjustment layers; src/silencecut.ts — one-click
// silence delete/compress; src/textcut.ts — cut by word/sentence,
// speaker annotation (pyannote-audio MIT, runner not connected);
// src/remix.ts — beat-aware music Remix (no atempo, pitch preserved);
// src/frameinterp.ts — minterpolate 24->60 fps.
//
// Measurement method (probe tmp/probe-p3e.mjs ran BEFORE writing
// assertions):
// - Chapters via ffmetadata + -map_metadata/-map_chapters: ffprobe
//   reads back Intro 0-2s / Main 2-4s with titles intact.
// - eq brightness +0.5 with enable=between(t,1,3): grey-128 source
//   reads luma 76 outside the span, 224 inside.
// - minterpolate 24->60 (testsrc2): output 60 fps, same duration;
//   interpolated frame PSNR 20.72 vs earlier source frame, 31.53 vs
//   later one, source frames 19.44 vs each other — the interpolated
//   frame sits between its neighbours (a copy would score Inf).
// - silencedetect on tone-silence-tone: silence [1.999977, 4.000045].
// - Word-level timestamps: P0b's transcriber DOES emit them
//   (transcribe.ts RawSegment.words / subtitles.ts SubtitleWord), so
//   word cuts are word-exact; sentence fallback is used only when
//   items carry no words, and the result reports the precision.
// - Remix never uses atempo (it would shift pitch); splices land on
//   beat boundaries by construction. Pitch check: 220 Hz component
//   present at the same level after remix, 110 Hz absent.
// - LGPL: minterpolate, silencedetect, eq/colorbalance enable,
//   atrim/apad are native libavfilter — only verified on the local
//   GPL 8.1.2 build; re-check each on the BtbN LGPL 9.0 build at the
//   M2 gate. pyannote-audio is MIT; the diarizer runner is not
//   connected in this batch (no model/token on this machine) and
//   throws with setup instructions instead of faking labels.
// Old M1 / P0 / P0b / P1 / P1b / P1c / P1d / P1e / P2a / P2b / P2c /
// P3a / P3b / P3c / P3d checks live in their own files and must
// still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, writeFileSync } from 'node:fs';
import {
  annotateSpeakers,
  buildRemixAudio,
  clipDuration,
  compressSilences,
  cutClipByText,
  cutSilences,
  deleteClip,
  detectSilencesForClip,
  exportProject,
  hasWordTimestamps,
  markersToFfmetadata,
  minterpolateFilter,
  pasteAttributes,
  planRemix,
  PRESETS,
  probe,
  projectDuration,
  PyannoteDiarizer,
  remixAudio,
  replaceClipSource,
  searchTimeline,
  switchAlternate,
  threePointInsert,
  threePointOverwrite,
  validateFrameInterp,
  validateJLClip,
  validateRemix,
  validateSilenceCut,
  validateTimelineProject,
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

/** Goertzel RMS level of one frequency (dBFS) in a window — same as p3a. */
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

/** RMS level (dBFS) of a window — for silence / continuity checks. */
async function rmsWindow(file, ss, dur) {
  const r = await run('ffmpeg', [
    '-v', 'error', '-ss', String(ss), '-i', file, '-t', String(dur),
    '-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-',
  ]).catch((e) => e);
  const buf = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? '', 'binary');
  const s = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  if (s.length === 0) return -240;
  let e = 0; for (const v of s) e += v * v;
  return 20 * Math.log10(Math.sqrt(e / s.length) + 1e-12);
}

async function grayMean(file, ss) {
  const r = await run('ffmpeg', ['-ss', String(ss), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const b = r.stdout; let s = 0; for (const v of b) s += v; return s / b.length;
}
async function rgbMean(file, ss) {
  const r = await run('ffmpeg', ['-ss', String(ss), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const b = r.stdout; let r0 = 0, g = 0, bl = 0; const n = b.length / 3;
  for (let i = 0; i < b.length; i += 3) { r0 += b[i]; g += b[i + 1]; bl += b[i + 2]; }
  return [r0 / n, g / n, bl / n];
}
async function frameBuf(file, ss) {
  const r = await run('ffmpeg', ['-ss', String(ss), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return r.stdout;
}
function psnrBuf(a, b) {
  let se = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
  const mse = se / a.length; return mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
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
// Tone only in [1,3] of 4 s (J/L probe source).
synthWav(`${DIR}p3e-tonewin.wav`, 4, (t) => (t >= 1 && t < 3 ? 0.5 * Math.sin(2 * Math.PI * 440 * t) : 0));
await muxVideo('red', `${DIR}p3e-tonewin.wav`, 4, `${DIR}p3e-jl.mp4`);
// Tone-silence-tone 6 s (silence cut source).
synthWav(`${DIR}p3e-tst.wav`, 6, (t) => ((t < 2 || t >= 4) ? 0.5 * Math.sin(2 * Math.PI * 440 * t) : 0));
await muxVideo('red', `${DIR}p3e-tst.wav`, 6, `${DIR}p3e-tst.mp4`);
// Music: steady 220+277+330 chord + click every 0.5 s (120 BPM), 8 s.
const chord = (t) => 0.22 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277 * t) + Math.sin(2 * Math.PI * 330 * t));
const click = (t) => {
  const ph = t % 0.5;
  return ph < 0.02 ? 0.5 * Math.sin(2 * Math.PI * 2000 * t) * Math.exp(-ph * 200) : 0;
};
synthWav(`${DIR}p3e-music.wav`, 8, (t) => chord(t) + click(t));
await muxVideo('blue', `${DIR}p3e-music.wav`, 8, `${DIR}p3e-music.mp4`);
// Plain colour clips.
await muxVideo('red', `${DIR}p3e-tonewin.wav`, 4, `${DIR}p3e-red.mp4`);
await muxVideo('green', `${DIR}p3e-tonewin.wav`, 2, `${DIR}p3e-green.mp4`);
await muxVideo('blue', `${DIR}p3e-tonewin.wav`, 4, `${DIR}p3e-blue.mp4`);
// 24 fps testsrc2 for frame interpolation.
await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', `${DIR}p3e-24.mp4`]);

// ---------------------------------------------------------------------------
// 1. Three-point edit + replace footage
// ---------------------------------------------------------------------------
{
  const base = mkProject([mkClip('red', `${DIR}p3e-red.mp4`, 4), mkClip('blue', `${DIR}p3e-blue.mp4`, 4)]);
  const green = mkClip('green', `${DIR}p3e-green.mp4`, 2);
  const ins = threePointInsert(base, green, 2);
  check('3pt insert: total 10.0s', close(projectDuration(ins), 10, 0.01), `got ${projectDuration(ins)}`);
  check('3pt insert: 4 clips red-a/green/red-b/blue', ins.clips.map((c) => c.id).join(',') === 'red-a,green,red-b,blue', ins.clips.map((c) => c.id).join(','));
  check('3pt insert: split points 2.0/2.0', close(ins.clips[0].out, 2, 0.01) && close(ins.clips[2].in, 2, 0.01));
  check('3pt insert: transitions stay clips-1', ins.transitions.length === ins.clips.length - 1);
  const rep = await exportProject(ins, `${DIR}p3e-ins.mp4`, { fontfile: FONT, preset: PRESET });
  check('3pt insert: export 10.0s err<=0.05', rep.durationError <= 0.05, `err ${rep.durationError}`);
  const insRgb = await rgbMean(`${DIR}p3e-ins.mp4`, 2.5);
  check('3pt insert: t=2.5 is green (dark 0,128,0)', insRgb[1] > 100 && insRgb[0] < 50 && insRgb[2] < 50, insRgb.map((v) => v.toFixed(0)).join(','));
  const ow = threePointOverwrite(base, green, 1);
  check('3pt overwrite: total stays 8.0s', close(projectDuration(ow), 8, 0.01), `got ${projectDuration(ow)}`);
  check('3pt overwrite: spans red-a[0,1] green[0,2] red-b[3,4] blue[0,4]', ow.clips.map((c) => `${c.id}[${c.in},${c.out}]`).join(' ') === 'red-a[0,1] green[0,2] red-b[3,4] blue[0,4]', ow.clips.map((c) => `${c.id}[${c.in},${c.out}]`).join(' '));
  const owRep = await exportProject(ow, `${DIR}p3e-ow.mp4`, { fontfile: FONT, preset: PRESET });
  check('3pt overwrite: export 8.0s err<=0.05', owRep.durationError <= 0.05, `err ${owRep.durationError}`);
  const owRgb = await rgbMean(`${DIR}p3e-ow.mp4`, 1.5);
  check('3pt overwrite: t=1.5 is green (dark 0,128,0)', owRgb[1] > 100 && owRgb[0] < 50 && owRgb[2] < 50, owRgb.map((v) => v.toFixed(0)).join(','));
  const repl = replaceClipSource(mkClip('c', `${DIR}p3e-red.mp4`, 4, { color: { brightness: 0.3 }, speed: 2 }), `${DIR}p3e-blue.mp4`);
  check('replace: source swapped, in/out+effects kept', repl.source.endsWith('p3e-blue.mp4') && repl.in === 0 && repl.out === 4 && repl.color.brightness === 0.3 && repl.speed === 2);
  check('3pt insert atTime>dur throws', throwsSync(() => threePointInsert(base, green, 99), /outside timeline/));
  check('3pt overwrite overrun throws', throwsSync(() => threePointOverwrite(base, green, 7), /outside timeline/));
  check('replace empty source throws', throwsSync(() => replaceClipSource(mkClip('c', `${DIR}p3e-red.mp4`, 4), ''), /non-empty/));
}

// ---------------------------------------------------------------------------
// 2. J/L edit (audio window independent of video)
// ---------------------------------------------------------------------------
{
  const jl = mkClip('jl', `${DIR}p3e-jl.mp4`, 2, { in: 1, out: 3, audioIn: 0, audioOut: 2 });
  check('J/L validate returns window [0,2]', JSON.stringify(validateJLClip(jl)) === JSON.stringify({ audioIn: 0, audioOut: 2 }));
  const ctl = mkProject([mkClip('c', `${DIR}p3e-jl.mp4`, 2, { in: 1, out: 3 })]);
  const jlp = mkProject([jl]);
  const rc = await exportProject(ctl, `${DIR}p3e-jl-ctl.mp4`, { fontfile: FONT, preset: PRESET });
  const rj = await exportProject(jlp, `${DIR}p3e-jl-out.mp4`, { fontfile: FONT, preset: PRESET });
  check('J/L: both exports 2.0s', rc.durationError <= 0.05 && rj.durationError <= 0.05, `ctl ${rc.durationError} jl ${rj.durationError}`);
  const ctlLate = await level(`${DIR}p3e-jl-ctl.mp4`, 440, 1.2, 0.6);
  const jlEarly = await level(`${DIR}p3e-jl-out.mp4`, 440, 0.2, 0.6);
  const jlLate = await level(`${DIR}p3e-jl-out.mp4`, 440, 1.2, 0.6);
  check('J/L control: tone present late [1.2,1.8]', ctlLate > -30, `${ctlLate.toFixed(1)}dB`);
  check('J/L: tone silent early [0.2,0.8] (onset shifted +1s)', jlEarly < -60, `${jlEarly.toFixed(1)}dB`);
  check('J/L: tone present late [1.2,1.8] (onset at 1.0s, control 0.0s)', jlLate > -30, `${jlLate.toFixed(1)}dB`);
  // L cut: audio window [2,4] -> tone [2,3] lands at output [0,1].
  const lc = mkClip('lc', `${DIR}p3e-jl.mp4`, 2, { in: 1, out: 3, audioIn: 2, audioOut: 4 });
  await exportProject(mkProject([lc]), `${DIR}p3e-jl-l.mp4`, { fontfile: FONT, preset: PRESET });
  const lEarly = await level(`${DIR}p3e-jl-l.mp4`, 440, 0.2, 0.6);
  const lLate = await level(`${DIR}p3e-jl-l.mp4`, 440, 1.2, 0.6);
  check('L cut: tone present early [0.2,0.8]', lEarly > -30, `${lEarly.toFixed(1)}dB`);
  check('L cut: tone gone late [1.2,1.8]', lLate < -60, `${lLate.toFixed(1)}dB`);
  check('J/L audioOut<=audioIn throws', throwsSync(() => validateJLClip(mkClip('x', `${DIR}p3e-jl.mp4`, 2, { audioIn: 2, audioOut: 2 })), /must be > audioIn/));
  check('J/L window not overlapping video throws', throwsSync(() => validateJLClip(mkClip('x', `${DIR}p3e-jl.mp4`, 2, { in: 1, out: 3, audioIn: 3.5, audioOut: 4 })), /does not overlap/));
  check('J/L with speedCurve throws', throwsSync(() => validateJLClip(mkClip('x', `${DIR}p3e-jl.mp4`, 2, { audioIn: 0, audioOut: 2, speedCurve: [{ t: 0, speed: 2 }] })), /speedCurve/));
}

// ---------------------------------------------------------------------------
// 3. Linked selection delete
// ---------------------------------------------------------------------------
{
  const base = mkProject([mkClip('a', `${DIR}p3e-red.mp4`, 4), mkClip('b', `${DIR}p3e-blue.mp4`, 4)]);
  const linked = deleteClip(base, 0, true);
  check('linked delete: clip gone, total 4.0s', linked.clips.length === 1 && close(projectDuration(linked), 4, 0.01));
  check('linked delete: transitions stay clips-1', linked.transitions.length === 0);
  const unlinked = deleteClip(base, 0, false);
  check('unlinked delete: clip stays audio-only', unlinked.clips[0].audioOnly === true && unlinked.clips.length === 2);
  check('unlinked delete: total stays 8.0s', close(projectDuration(unlinked), 8, 0.01));
  const ru = await exportProject(unlinked, `${DIR}p3e-unlink.mp4`, { fontfile: FONT, preset: PRESET });
  check('unlinked delete: export 8.0s', ru.durationError <= 0.05, `err ${ru.durationError}`);
  const blackLuma = await grayMean(`${DIR}p3e-unlink.mp4`, 1);
  check('unlinked delete: video is black where video was removed', blackLuma < 20, `luma ${blackLuma.toFixed(1)}`);
  const keptTone = await level(`${DIR}p3e-unlink.mp4`, 440, 1.2, 0.6);
  check('unlinked delete: audio kept in the removed span', keptTone > -30, `${keptTone.toFixed(1)}dB`);
  check('deleteClip bad index throws', throwsSync(() => deleteClip(base, 5), /outside/));
  check('unlinked delete twice throws', throwsSync(() => deleteClip(unlinked, 0, false), /already audio-only/));
}

// ---------------------------------------------------------------------------
// 4. Markers + MP4 chapters
// ---------------------------------------------------------------------------
{
  const p = mkProject([mkClip('a', `${DIR}p3e-red.mp4`, 4)], {
    markers: [
      { t: 0, label: 'Intro', color: 'red', chapter: true },
      { t: 2, label: 'Main', color: 'blue', chapter: true },
      { t: 3, label: 'note-only', color: 'green' },
    ],
  });
  const meta = markersToFfmetadata(p);
  check('chapters: ffmetadata has 2 CHAPTER blocks', (meta.match(/\[CHAPTER\]/g) || []).length === 2);
  check('chapters: titles in metadata', meta.includes('title=Intro') && meta.includes('title=Main') && !meta.includes('note-only'));
  const r = await exportProject(p, `${DIR}p3e-chap.mp4`, { fontfile: FONT, preset: PRESET });
  check('chapters: export 4.0s', r.durationError <= 0.05, `err ${r.durationError}`);
  const cj = await ffprobeJson(`${DIR}p3e-chap.mp4`, ['-show_chapters']);
  check('chapters: ffprobe reads 2 chapters', cj.chapters?.length === 2, JSON.stringify(cj.chapters?.map((c) => c.tags?.title)));
  check('chapters: Intro 0-2s / Main 2-4s', cj.chapters?.[0]?.tags?.title === 'Intro' && Number(cj.chapters[0].start_time) === 0 && Number(cj.chapters[0].end_time) === 2 && cj.chapters?.[1]?.tags?.title === 'Main' && Number(cj.chapters[1].start_time) === 2 && Number(cj.chapters[1].end_time) === 4);
  check('marker t out of range throws', throwsSync(() => validateTimelineProject(mkProject([mkClip('a', `${DIR}p3e-red.mp4`, 4)], { markers: [{ t: 99, label: 'x' }] })), /outside timeline/));
}

// ---------------------------------------------------------------------------
// 5. Timeline index search
// ---------------------------------------------------------------------------
{
  const p = mkProject(
    [mkClip('intro-shot', `${DIR}p3e-red.mp4`, 4, { role: 'dialogue' }), mkClip('outro', `${DIR}p3e-blue.mp4`, 4)],
    { markers: [{ t: 5, label: 'Intro note', chapter: false }] },
  );
  const byClip = searchTimeline(p, 'intro-shot');
  check('search: clip id hit at t=0', byClip.length === 1 && byClip[0].type === 'clip' && byClip[0].t === 0);
  const byMarker = searchTimeline(p, 'intro note');
  check('search: marker label hit at t=5', byMarker.length === 1 && byMarker[0].type === 'marker' && byMarker[0].t === 5);
  const byRole = searchTimeline(p, 'dialogue');
  check('search: role hit at t=0', byRole.some((h) => h.type === 'role' && h.t === 0));
  check('search: no match is empty', searchTimeline(p, 'zzz-no-such').length === 0);
}

// ---------------------------------------------------------------------------
// 6. Auditions (alternates)
// ---------------------------------------------------------------------------
{
  const clip = mkClip('c', `${DIR}p3e-red.mp4`, 4, { alternates: [{ source: `${DIR}p3e-blue.mp4`, in: 0, out: 4 }] });
  const sw = switchAlternate(clip, 0);
  check('audition: source swapped to blue', sw.source.endsWith('p3e-blue.mp4'));
  check('audition: old source parked in slot 0', sw.alternates[0].source.endsWith('p3e-red.mp4'));
  check('audition: other fields untouched', sw.in === 0 && sw.out === 4 && sw.id === 'c');
  const back = switchAlternate(sw, 0);
  check('audition: switch back restores red', back.source.endsWith('p3e-red.mp4'));
  const r = await exportProject(mkProject([sw]), `${DIR}p3e-aud.mp4`, { fontfile: FONT, preset: PRESET });
  check('audition: export 4.0s', r.durationError <= 0.05);
  const rgb = await rgbMean(`${DIR}p3e-aud.mp4`, 1);
  check('audition: exported frame is blue, rest unchanged', rgb[2] > 200 && rgb[0] < 50, rgb.map((v) => v.toFixed(0)).join(','));
  check('audition: empty list throws', throwsSync(() => switchAlternate(mkClip('c', `${DIR}p3e-red.mp4`, 4), 0), /no alternates/));
  check('audition: bad index throws', throwsSync(() => switchAlternate(clip, 3), /outside/));
}

// ---------------------------------------------------------------------------
// 7. Paste attributes
// ---------------------------------------------------------------------------
{
  const src = mkClip('s', `${DIR}p3e-red.mp4`, 4, { color: { brightness: 0.3 }, speed: 2, volume: 0.5 });
  const tgt = mkClip('t', `${DIR}p3e-blue.mp4`, 4, { color: { brightness: 0 }, speed: 1, volume: 1 });
  const pasted = pasteAttributes(src, tgt);
  check('paste: colour/speed/volume copied', pasted.color.brightness === 0.3 && pasted.speed === 2 && pasted.volume === 0.5);
  check('paste: target source/in/out untouched', pasted.source.endsWith('p3e-blue.mp4') && pasted.in === 0 && pasted.out === 4);
  check('paste: source unchanged', src.color.brightness === 0.3 && src.speed === 2);
  const beatTgt = mkClip('b', `${DIR}p3e-blue.mp4`, 4, { beatSpeed: { beats: [1, 2] } });
  check('paste: speedCurve onto beatSpeed throws', throwsSync(() => pasteAttributes(mkClip('s', `${DIR}p3e-red.mp4`, 4, { speedCurve: [{ t: 0, speed: 2 }] }), beatTgt), /beatSpeed/));
  check('paste: unknown field throws', throwsSync(() => pasteAttributes(src, tgt, ['nope']), /unknown field/));
}

// ---------------------------------------------------------------------------
// 8. Adjustment layer
// ---------------------------------------------------------------------------
{
  const p = mkProject([mkClip('a', `${DIR}p3e-red.mp4`, 4)], {
    adjustmentLayers: [{ start: 1, end: 3, color: { brightness: 0.5 } }],
  });
  const g = buildFilterGraph(p, FONT);
  check('adjust layer: graph has enable=between(t,1,3)', g.filterComplex.includes("enable='between(t,1,3)'"));
  const r = await exportProject(p, `${DIR}p3e-adj.mp4`, { fontfile: FONT, preset: PRESET });
  check('adjust layer: export 4.0s', r.durationError <= 0.05, `err ${r.durationError}`);
  const lOut = await grayMean(`${DIR}p3e-adj.mp4`, 0.5);
  const lIn = await grayMean(`${DIR}p3e-adj.mp4`, 2);
  const lAfter = await grayMean(`${DIR}p3e-adj.mp4`, 3.5);
  check('adjust layer: luma outside span ~76', close(lOut, 76, 5) && close(lAfter, 76, 5), `${lOut.toFixed(0)}/${lAfter.toFixed(0)}`);
  check('adjust layer: luma inside span ~224', close(lIn, 224, 8), `${lIn.toFixed(0)}`);
  check('adjust layer: span end>duration throws', throwsSync(() => validateTimelineProject(mkProject([mkClip('a', `${DIR}p3e-red.mp4`, 4)], { adjustmentLayers: [{ start: 3, end: 99, color: { brightness: 0.5 } }] })), /outside timeline/));
}

// ---------------------------------------------------------------------------
// 9. Silence cut (delete + compress)
// ---------------------------------------------------------------------------
{
  const clip = mkClip('s', `${DIR}p3e-tst.mp4`, 6);
  const sil = await detectSilencesForClip(clip, { thresholdDb: '-40dB', minDuration: 0.3 });
  check('silence detect: one span ~[2.0,4.0]', sil.length === 1 && close(sil[0].start, 2, 0.05) && close(sil[0].end, 4, 0.05), JSON.stringify(sil));
  const kept = cutSilences(clip, sil);
  check('silence delete (model): 2 kept clips [0,2]+[4,6]', kept.length === 2 && close(kept[0].out, 2, 0.01) && close(kept[1].in, 4, 0.01));
  const del = mkProject([clip], { silenceCut: { mode: 'delete' } });
  const rd = await exportProject(del, `${DIR}p3e-sil-del.mp4`, { fontfile: FONT, preset: PRESET });
  check('silence delete (export): 4.0s, err<=0.05', close(rd.actual.duration, 4, 0.05), `got ${rd.actual.duration}`);
  const toneKept = await level(`${DIR}p3e-sil-del.mp4`, 440, 3.2, 0.6);
  check('silence delete: speech intact at t=3.2 (was t=4.x)', toneKept > -30, `${toneKept.toFixed(1)}dB`);
  const comp = compressSilences(clip, sil, 0.3);
  check('silence compress (model): speedCurve 1 -> 3.33 -> 1', JSON.stringify(comp.speedCurve.map((n) => n.speed)) === JSON.stringify([1, 3.3333, 1]) || comp.speedCurve[1].speed > 3.3, JSON.stringify(comp.speedCurve));
  const compDur = clipDuration(comp);
  check('silence compress (model): duration 4.6s', close(compDur, 4.6, 0.01), `got ${compDur}`);
  const compP = mkProject([clip], { silenceCut: { mode: 'compress', compressFactor: 0.3 } });
  const rc = await exportProject(compP, `${DIR}p3e-sil-comp.mp4`, { fontfile: FONT, preset: PRESET });
  check('silence compress (export): 4.6s, err<=0.05', close(rc.actual.duration, 4.6, 0.05), `got ${rc.actual.duration}`);
  check('silenceCut bad threshold throws', throwsSync(() => validateSilenceCut({ thresholdDb: 'loud' }), /must look like/));
  check('silenceCut compressFactor>1 throws', throwsSync(() => validateSilenceCut({ compressFactor: 2 }), /outside/));
}

// ---------------------------------------------------------------------------
// 10. Text cut
// ---------------------------------------------------------------------------
{
  const subs = [
    { text: 'one', start: 0, end: 1, words: [{ w: 'one', start: 0, end: 1 }] },
    { text: 'two', start: 1, end: 2, words: [{ w: 'two', start: 1, end: 2 }] },
    { text: 'three', start: 2, end: 3, words: [{ w: 'three', start: 2, end: 3 }] },
    { text: 'four', start: 3, end: 4, words: [{ w: 'four', start: 3, end: 4 }] },
  ];
  check('textcut: word timestamps present', hasWordTimestamps(subs) === true);
  const clip = mkClip('t', `${DIR}p3e-red.mp4`, 4);
  const res = cutClipByText(clip, subs, ['three']);
  check('textcut word: precision word', res.precision === 'word');
  check('textcut word: kept [0,2]+[3,4] = 3.0s', res.clips.length === 2 && close(res.clips[0].out, 2, 0.01) && close(res.clips[1].in, 3, 0.01));
  check('textcut word: removed span [2,3] three', res.removed.length === 1 && close(res.removed[0].start, 2, 0.01) && res.removed[0].text === 'three');
  const noWords = subs.map(({ text, start, end }) => ({ text, start, end }));
  check('textcut: no word timestamps detected', hasWordTimestamps(noWords) === false);
  const resS = cutClipByText(clip, noWords, ['three']);
  check('textcut sentence fallback: precision sentence, same spans', resS.precision === 'sentence' && resS.clips.length === 2 && close(resS.clips[1].in, 3, 0.01));
  const resU = cutClipByText(clip, subs, ['zzz']);
  check('textcut: unmatched reported, nothing cut', resU.unmatched.join() === 'zzz' && resU.clips.length === 1);
  // Speaker annotation (pure merge — the pyannote runner is not connected).
  const ann = annotateSpeakers(subs, [{ speaker: 'A', start: 0, end: 2 }, { speaker: 'B', start: 2, end: 4 }]);
  check('speakers: items labelled A/A/B/B', ann.map((a) => a.speaker).join('') === 'AABB');
  const resSp = cutClipByText(clip, ann, ['three'], { speaker: 'A' });
  check('speakers: filter A does not cut B line', resSp.clips.length === 1 && resSp.removed.length === 0);
  const resSpB = cutClipByText(clip, ann, ['three'], { speaker: 'B' });
  check('speakers: filter B cuts the line', resSpB.removed.length === 1);
  check('diarizer stub throws with setup', await throwsAsync(() => new PyannoteDiarizer().diarize(), /pyannote-audio/));
  // Export-level text cut via Project.textCut.
  const tp = mkProject([clip], { textCut: { clipId: 't', subtitles: subs, remove: ['three'] } });
  const rt = await exportProject(tp, `${DIR}p3e-text.mp4`, { fontfile: FONT, preset: PRESET });
  check('textcut (export): 3.0s, err<=0.05', close(rt.actual.duration, 3, 0.05), `got ${rt.actual.duration}`);
  check('textcut: speedCurve clip throws', throwsSync(() => cutClipByText(mkClip('x', `${DIR}p3e-red.mp4`, 4, { speedCurve: [{ t: 0, speed: 2 }] }), subs, ['one']), /speedCurve/));
}

// ---------------------------------------------------------------------------
// 11. Music Remix
// ---------------------------------------------------------------------------
{
  const beats = [0.5, 1, 1.5, 2, 2.5, 3, 3.5];
  const plan6 = planRemix(beats, 4, 6, 120);
  check('remix plan lengthen: total 6.0s', close(plan6.totalDuration, 6, 0.001), `got ${plan6.totalDuration}`);
  check('remix plan: every splice on a beat', plan6.segments.every((s) => beats.includes(s.start) || s.start === 0));
  const plan25 = planRemix(beats, 4, 2.5, 120);
  check('remix plan shorten: total 2.5s', close(plan25.totalDuration, 2.5, 0.001), `got ${plan25.totalDuration}`);
  const wav6 = await remixAudio(`${DIR}p3e-music.wav`, { targetDuration: 6, beats }, `${DIR}p3e-remix6.wav`);
  check('remix render: 6.0s wav', close(await audioDuration(`${DIR}p3e-remix6.wav`), 6, 0.05));
  const src220 = await level(`${DIR}p3e-music.wav`, 220, 0.5, 1);
  const mix220 = await level(`${DIR}p3e-remix6.wav`, 220, 0.5, 1);
  check('remix: pitch preserved (220Hz within 3dB)', Math.abs(mix220 - src220) < 3, `src ${src220.toFixed(1)} remix ${mix220.toFixed(1)}`);
  const low110 = await level(`${DIR}p3e-remix6.wav`, 110, 0.5, 1);
  check('remix: no sub-octave 110Hz artefact', low110 < -60, `${low110.toFixed(1)}dB`);
  // Splice continuity: energy just before/after a splice (t=4.0 in the 6s output).
  const before = await rmsWindow(`${DIR}p3e-remix6.wav`, 3.85, 0.1);
  const after = await rmsWindow(`${DIR}p3e-remix6.wav`, 4.05, 0.1);
  check('remix: splice energy continuous (|dB|<6)', Math.abs(before - after) < 6, `${before.toFixed(1)} vs ${after.toFixed(1)}dB`);
  // Export-level remix: 8s music, clip window 6s -> music fitted to 6s.
  const rp = mkProject([mkClip('m', `${DIR}p3e-music.mp4`, 6, { remix: { targetDuration: 6, beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5] } })]);
  const rr = await exportProject(rp, `${DIR}p3e-remix.mp4`, { fontfile: FONT, preset: PRESET });
  check('remix (export): 6.0s, err<=0.05', close(rr.actual.duration, 6, 0.05), `got ${rr.actual.duration}`);
  const exp220 = await level(`${DIR}p3e-remix.mp4`, 220, 0.5, 1);
  check('remix (export): 220Hz present', exp220 > -30, `${exp220.toFixed(1)}dB`);
  check('remix target<=0 throws', throwsSync(() => validateRemix({ targetDuration: 0 }), /must be > 0/));
  check('remix beats<2 throws', throwsSync(() => validateRemix({ targetDuration: 3, beats: [1] }), /at least 2/));
  check('remix plan target<1 bar throws', throwsSync(() => planRemix(beats, 4, 0.2, 120), /shorter than one bar/));
}

// ---------------------------------------------------------------------------
// 12. Smart frame interpolation
// ---------------------------------------------------------------------------
{
  check('minterpolate filter string', minterpolateFilter(60) === 'minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:vsbmc=1');
  check('frameInterp target<=fps throws', throwsSync(() => validateFrameInterp({ targetFps: 24 }, 24), /must be greater/));
  check('frameInterp target>120 throws', throwsSync(() => validateFrameInterp({ targetFps: 240 }, 24), /outside/));
  const p = {
    version: 1, width: 320, height: 180, fps: 24,
    clips: [{ id: 'v', source: `${DIR}p3e-24.mp4`, in: 0, out: 2, speed: 1, volume: 1 }],
    transitions: [], transitionDuration: 0.5, frameInterp: { targetFps: 60 },
  };
  const r = await exportProject(p, `${DIR}p3e-60.mp4`, { fontfile: FONT, preset: { ...PRESETS['1080p60'], width: 320, height: 180, fps: 60 } });
  check('frameInterp (export): duration unchanged ~2.0s', close(r.actual.duration, 2, 0.05), `got ${r.actual.duration}`);
  check('frameInterp (export): output fps 60', close(r.actual.fps, 60, 0.5), `got ${r.actual.fps}`);
  const f60 = await frameBuf(`${DIR}p3e-60.mp4`, 0.52);
  const f24a = await frameBuf(`${DIR}p3e-24.mp4`, 0.5);
  const f24b = await frameBuf(`${DIR}p3e-24.mp4`, 0.5416667);
  const pAB = psnrBuf(f24a, f24b);
  const pIA = psnrBuf(f60, f24a);
  const pIB = psnrBuf(f60, f24b);
  check('frameInterp: interp frame is between neighbours (not a copy)', pIA < 45 && pIB < 45 && pIA > 10 && pIB > 10, `vsA ${pIA.toFixed(1)} vsB ${pIB.toFixed(1)} A-vs-B ${pAB.toFixed(1)}`);
  check('frameInterp: interp closer to both neighbours than they are to each other', pIB > pAB, `interp-vs-B ${pIB.toFixed(1)} > A-vs-B ${pAB.toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} passed`);
for (const [name, ok] of checks) if (!ok) console.log(`FAIL: ${name}`);
if (passed !== checks.length) process.exit(1);
