// W10 transitions verification (M4 §2 转场库, 2026-11-19).
// Runs against the LIVE engine product/engine (not the abandoned
// root engine/ copy). Proves per-junction transitions are REALLY
// RENDERED, not just defined:
//  - mid-transition frames differ from a hard cut in the expected direction
//    (dissolve/fade midpoint is a 50/50 blend; wipe/slide midpoint is a
//    spatial split; fadewhite flashes to white and comes back),
//  - audio acrossfade is measurable per frequency band (both tones present
//    at reduced level mid-transition, full/quiet outside it),
//  - per-junction durations add up in the total duration and in the graph
//    (mixed 1.0 s + 0.5 s junctions -> 4.5 s, exact offsets),
//  - normalizeToTracks carries the per-junction durations into the
//    multitrack transitionIn form with the total duration preserved,
//  - validation rejects what FFmpeg would silently mangle (a transition
//    longer than its clips exported with a 0.50 s duration error and no
//    failure before W10 — probed 2026-11-19).
// All thresholds below come from tmp/probe runs on this machine
// (ffmpeg 8.1.2): dissolve mid (127,126); wipe/slide halves pure;
// fadewhite luma 255 at 20% in, 187 at mid; acrossfade mid bands
// -29.1/-25.3 dB vs full -21.1 dB and leakage floor -43 dB.
// Runs on Linux and on the Windows CI runner (no drawtext/font needed;
// ffmpeg/ffprobe come from PATH; results file via W10_RESULTS_FILE).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exportProject, PRESETS,
  TRANSITION_LIBRARY, TRANSITION_LIBRARY_IDS,
  resolveTransitionDurations, transitionSpecs, validateTransitions,
} from '../dist/export.js';
import { buildFilterGraph } from '../dist/filtergraph.js';
import { projectDuration } from '../dist/project.js';
import { normalizeToTracks } from '../dist/multitrack.js';
import { analyzeFrame, analyzeRgbFrame } from '../dist/scopes.js';

const exec = promisify(execFile);
const DIR = fileURLToPath(new URL('.', import.meta.url));
const FONT = process.platform === 'win32'
  ? 'C:\\Windows\\Fonts\\arial.ttf'
  : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const RESULTS_FILE = process.env.W10_RESULTS_FILE ?? `${DIR}w10transitions-results.txt`;

const checks = [];
const check = (name, ok, detail = '') =>
  checks.push([`${name}${detail ? ` (${detail})` : ''}`, ok]);

async function run(cmd, args, opts = {}) {
  return exec(cmd, args, { maxBuffer: 256 * 1024 * 1024, encoding: 'buffer', ...opts });
}

async function rgbAt(file, t, w = 320, h = 180) {
  const s = await analyzeFrame(file, t, { width: w, height: h });
  return {
    r: Math.round(s.rgb.r.mean),
    g: Math.round(s.rgb.g.mean),
    b: Math.round(s.rgb.b.mean),
    luma: Math.round(s.luma.mean),
  };
}

async function halfRgb(file, t, side) {
  const crop = side === 'left' ? '160:180:0:0' : '160:180:160:0';
  const { stdout } = await run('ffmpeg', [
    '-ss', String(t), '-i', file, '-vf', `crop=${crop}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  const s = analyzeRgbFrame(stdout, 160, 180, file, t);
  return { r: Math.round(s.rgb.r.mean), g: Math.round(s.rgb.g.mean), b: Math.round(s.rgb.b.mean) };
}

/** Loudest per-channel RMS dB of one tone band in a short window. */
async function bandRms(file, ss, dur, freq) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', file, '-t', String(dur),
    '-af', `bandpass=f=${freq}:width_type=h:width=100,astats=metadata=1:reset=1`,
    '-vn', '-f', 'null', '-',
  ]).catch((e) => e);
  const text = String((r.stderr ?? '') + (r.stdout ?? ''));
  const m = [...text.matchAll(/RMS level dB:\s*(-?[\d.]+|-\s*inf)/g)]
    .map((x) => (x[1].includes('inf') ? -Infinity : Number(x[1])));
  return m.length ? Math.max(...m) : null;
}

async function hasBlackSegments(file) {
  const bd = await run('ffmpeg', ['-i', file, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-']).catch((e) => e);
  return /black_start/.test(String((bd.stderr ?? '') + (bd.stdout ?? '')));
}

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

// --- sources: solid red 440 Hz / solid blue 880 Hz / solid lime 660 Hz ---
// (ffmpeg colour "green" is (0,128,0); "lime" is the full (0,255,0).)
for (const [name, color, freq] of [['red', 'red', 440], ['blue', 'blue', 880], ['lime', 'lime', 660]]) {
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=30:d=4`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=4`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', `${DIR}w10-${name}.mp4`]);
}
const clip = (id, src) => ({ id, source: `${DIR}w10-${src}.mp4`, in: 0, out: 2, speed: 1, volume: 1 });
const base = { version: 1, width: 320, height: 180, fps: 30 };

// --- 0. library + per-junction model (pure, no encode) ---
check('library: exactly 5 presets', TRANSITION_LIBRARY.length === 5,
  `got ${TRANSITION_LIBRARY.length}`);
check('library: ids are dissolve/fade/wipeleft/slideleft/fadewhite',
  JSON.stringify(TRANSITION_LIBRARY_IDS) === JSON.stringify(['dissolve', 'fade', 'wipeleft', 'slideleft', 'fadewhite']));
check('library: dissolve is the canonical xfade, all defaults 0.5s',
  TRANSITION_LIBRARY[0].xfade === 'dissolve'
  && TRANSITION_LIBRARY.every((e) => e.defaultDuration === 0.5 && e.label.length > 0 && e.description.length > 0));
{
  const legacy3 = { ...base, transitionDuration: 0.5,
    clips: [clip('a', 'red'), clip('b', 'blue'), clip('c', 'lime')], transitions: ['fade', 'dissolve'] };
  const perJunction = { ...legacy3, transitionDuration: 0.5, transitionDurations: [1.0, 0.5] };
  check('model: legacy resolves to global duration',
    JSON.stringify(resolveTransitionDurations(legacy3)) === JSON.stringify([0.5, 0.5]));
  check('model: per-junction durations resolve as listed',
    JSON.stringify(resolveTransitionDurations(perJunction)) === JSON.stringify([1.0, 0.5]));
  const specs = transitionSpecs(perJunction);
  check('model: specs zip type+duration',
    specs[0].type === 'fade' && specs[0].duration === 1.0 && specs[1].type === 'dissolve' && specs[1].duration === 0.5);
  check('duration math: 3x2s - dissolve 1.0 - wipeleft 0.5 = 4.5s',
    Math.abs(projectDuration({ ...legacy3, transitions: ['dissolve', 'wipeleft'], transitionDurations: [1.0, 0.5] }) - 4.5) < 1e-9);
  check('duration math: cut junction overlaps nothing (3x2s - 1.0 = 5.0s)',
    Math.abs(projectDuration({ ...legacy3, transitions: ['dissolve', 'cut'], transitionDurations: [1.0, 0.5] }) - 5.0) < 1e-9);
  const gLegacy = buildFilterGraph({ ...legacy3, transitions: ['fade', 'dissolve'] }, FONT).filterComplex;
  const gPer = buildFilterGraph({ ...legacy3, transitions: ['fade', 'dissolve'], transitionDurations: [0.5, 0.5] }, FONT).filterComplex;
  check('compat: per-junction form with global durations builds the identical graph', gLegacy === gPer);
}

// --- 0b. normalizeToTracks carries per-junction durations (pure) ---
{
  const legacy = { ...base, transitionDuration: 0.5,
    clips: [clip('a', 'red'), clip('b', 'blue'), clip('c', 'lime')],
    transitions: ['dissolve', 'wipeleft'], transitionDurations: [1.0, 0.5] };
  const norm = normalizeToTracks(legacy);
  const vclips = norm.tracks.video[0].clips;
  check('tracks: normalizeToTracks keeps per-junction starts [0, 1.0, 2.5]',
    vclips[0].start === 0 && vclips[1].start === 1.0 && vclips[2].start === 2.5,
    `starts=${vclips.map((c) => c.start).join(',')}`);
  check('tracks: transitionIn carries per-junction durations [1.0, 0.5], total 4.5s preserved',
    vclips[1].transitionIn?.type === 'dissolve' && vclips[1].transitionIn?.duration === 1.0
    && vclips[2].transitionIn?.type === 'wipeleft' && vclips[2].transitionIn?.duration === 0.5
    && Math.abs(projectDuration(norm) - 4.5) < 1e-9,
    `in=${JSON.stringify(vclips[1].transitionIn)} ${JSON.stringify(vclips[2].transitionIn)} dur=${projectDuration(norm)}`);
}

// --- 1. validation rejects bad transitions (pure, no encode) ---
{
  const two = { ...base, transitionDuration: 0.5, clips: [clip('a', 'red'), clip('b', 'blue')] };
  const three = { ...base, transitionDuration: 0.5,
    clips: [clip('a', 'red'), clip('b', 'blue'), clip('c', 'lime')] };
  check('reject: unknown transition type',
    throws(() => buildFilterGraph({ ...two, transitions: ['spin'] }, FONT)));
  check('reject: transitions length != clips-1',
    throws(() => buildFilterGraph({ ...three, transitions: ['fade'] }, FONT)));
  check('reject: transitionDurations length mismatch',
    throws(() => buildFilterGraph({ ...three, transitions: ['fade', 'dissolve'], transitionDurations: [1.0] }, FONT)));
  check('reject: duration 0 (below 0.1s)',
    throws(() => buildFilterGraph({ ...two, transitions: ['fade'], transitionDurations: [0] }, FONT)));
  check('reject: duration 6 (above 5s)',
    throws(() => buildFilterGraph({ ...two, transitions: ['fade'], transitionDurations: [6] }, FONT)));
  check('reject: duration 2.5s longer than the 2s clips (silent-corruption case)',
    throws(() => buildFilterGraph({ ...two, transitions: ['dissolve'], transitionDurations: [2.5] }, FONT)));
  check('reject: legacy global duration 2.5s longer than the clips',
    throws(() => buildFilterGraph({ ...two, transitionDuration: 2.5, transitions: ['dissolve'] }, FONT)));
  let boundaryOk = true;
  try { buildFilterGraph({ ...two, transitions: ['dissolve'], transitionDurations: [2.0] }, FONT); }
  catch { boundaryOk = false; }
  check('allow: duration exactly equal to the shorter clip (2.0s)', boundaryOk);
  let cutOk = true;
  try { buildFilterGraph({ ...two, transitions: ['cut'], transitionDurations: [99] }, FONT); }
  catch { cutOk = false; }
  check('allow: cut junction ignores its listed duration', cutOk);
  let validOk = true;
  try { validateTransitions({ ...three, transitions: ['fade', 'dissolve'], transitionDurations: [1.0, 0.5] }); }
  catch { validOk = false; }
  check('validateTransitions accepts a good per-junction project', validOk);
}

// --- 2. dissolve renders: red -> blue, 1.0s (window [1.0,2.0], total 3.0s) ---
{
  const p = { ...base, transitionDuration: 1.0, clips: [clip('a', 'red'), clip('b', 'blue')], transitions: ['dissolve'] };
  const rep = await exportProject(p, `${DIR}w10-dissolve.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('dissolve: duration ~3.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check('dissolve: has audio', rep.actual.hasAudio);
  check('dissolve: no black segments', !(await hasBlackSegments(`${DIR}w10-dissolve.mp4`)));
  const pre = await rgbAt(`${DIR}w10-dissolve.mp4`, 0.5);
  check('dissolve: pre-transition frame is pure red', pre.r > 200 && pre.b < 50, `R=${pre.r} B=${pre.b}`);
  const mid = await rgbAt(`${DIR}w10-dissolve.mp4`, 1.5);
  check('dissolve: mid-transition frame is a 50/50 blend, not a hard cut',
    mid.r >= 100 && mid.r <= 160 && mid.b >= 100 && mid.b <= 160, `R=${mid.r} B=${mid.b}`);
  const post = await rgbAt(`${DIR}w10-dissolve.mp4`, 2.5);
  check('dissolve: post-transition frame is pure blue', post.b > 200 && post.r < 50, `R=${post.r} B=${post.b}`);
}

// --- 3. hard-cut control: same sources, no transition ---
{
  const p = { ...base, transitionDuration: 0.5, clips: [clip('a', 'red'), clip('b', 'blue')], transitions: ['cut'] };
  const rep = await exportProject(p, `${DIR}w10-cut.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('cut control: duration ~4.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  const mid = await rgbAt(`${DIR}w10-cut.mp4`, 1.5);
  check('cut control: mid-window frame is still pure red (dissolve mid was purple)',
    mid.r > 200 && mid.b < 50, `R=${mid.r} B=${mid.b}`);
}

// --- 4. audio acrossfade is measurable (dissolve export vs cut control) ---
{
  const pre440 = await bandRms(`${DIR}w10-dissolve.mp4`, 0.4, 0.2, 440);
  const pre880 = await bandRms(`${DIR}w10-dissolve.mp4`, 0.4, 0.2, 880);
  check('audio: pre-transition 440Hz full, 880Hz silent',
    pre440 >= -23 && pre440 <= -19 && pre880 < -33, `440=${pre440} 880=${pre880}`);
  const mid440 = await bandRms(`${DIR}w10-dissolve.mp4`, 1.4, 0.2, 440);
  const mid880 = await bandRms(`${DIR}w10-dissolve.mp4`, 1.4, 0.2, 880);
  check('audio: mid-transition BOTH tones present at reduced level (acrossfade, not cut)',
    mid440 >= -32 && mid440 <= -23 && mid880 >= -32 && mid880 <= -23, `440=${mid440} 880=${mid880}`);
  const post440 = await bandRms(`${DIR}w10-dissolve.mp4`, 2.4, 0.2, 440);
  const post880 = await bandRms(`${DIR}w10-dissolve.mp4`, 2.4, 0.2, 880);
  check('audio: post-transition 880Hz full, 440Hz silent',
    post880 >= -23 && post880 <= -19 && post440 < -33, `440=${post440} 880=${post880}`);
  const ctrl440 = await bandRms(`${DIR}w10-cut.mp4`, 1.4, 0.2, 440);
  const ctrl880 = await bandRms(`${DIR}w10-cut.mp4`, 1.4, 0.2, 880);
  check('audio: cut control mid-window is still 440Hz full / 880Hz silent',
    ctrl440 >= -23 && ctrl440 <= -19 && ctrl880 < -33, `440=${ctrl440} 880=${ctrl880}`);
}

// --- 5. the other four library types each render (red -> blue, 1.0s) ---
{
  const pFade = { ...base, transitionDuration: 1.0, clips: [clip('a', 'red'), clip('b', 'blue')], transitions: ['fade'] };
  const rFade = await exportProject(pFade, `${DIR}w10-fade.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  const midFade = await rgbAt(`${DIR}w10-fade.mp4`, 1.5);
  check('fade: duration ~3.0s and mid frame is a blend',
    rFade.durationError < 0.3 && midFade.r >= 100 && midFade.r <= 160 && midFade.b >= 100 && midFade.b <= 160,
    `err=${rFade.durationError.toFixed(2)}s R=${midFade.r} B=${midFade.b}`);
}
{
  const pWipe = { ...base, transitionDuration: 1.0, clips: [clip('a', 'red'), clip('b', 'blue')], transitions: ['wipeleft'] };
  const rWipe = await exportProject(pWipe, `${DIR}w10-wipe.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  const left = await halfRgb(`${DIR}w10-wipe.mp4`, 1.5, 'left');
  const right = await halfRgb(`${DIR}w10-wipe.mp4`, 1.5, 'right');
  check('wipeleft: duration ~3.0s and mid frame is split old-left / new-right',
    rWipe.durationError < 0.3 && left.r > 200 && left.b < 50 && right.b > 200 && right.r < 50,
    `err=${rWipe.durationError.toFixed(2)}s left R=${left.r} B=${left.b} right R=${right.r} B=${right.b}`);
}
{
  const pSlide = { ...base, transitionDuration: 1.0, clips: [clip('a', 'red'), clip('b', 'blue')], transitions: ['slideleft'] };
  const rSlide = await exportProject(pSlide, `${DIR}w10-slide.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  const left = await halfRgb(`${DIR}w10-slide.mp4`, 1.5, 'left');
  const right = await halfRgb(`${DIR}w10-slide.mp4`, 1.5, 'right');
  check('slideleft: duration ~3.0s and mid frame is split old-left / new-right',
    rSlide.durationError < 0.3 && left.r > 200 && left.b < 50 && right.b > 200 && right.r < 50,
    `err=${rSlide.durationError.toFixed(2)}s left R=${left.r} B=${left.b} right R=${right.r} B=${right.b}`);
  const gWipe = buildFilterGraph(pSlide, FONT).filterComplex;
  check('graph: slideleft and wipeleft emit different xfade names',
    gWipe.includes('xfade=transition=slideleft')
    && buildFilterGraph({ ...base, transitionDuration: 1.0, clips: [clip('a', 'red'), clip('b', 'blue')], transitions: ['wipeleft'] }, FONT).filterComplex.includes('xfade=transition=wipeleft'));
}
{
  const pFw = { ...base, transitionDuration: 1.0, clips: [clip('a', 'red'), clip('b', 'blue')], transitions: ['fadewhite'] };
  const rFw = await exportProject(pFw, `${DIR}w10-fadewhite.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  const early = await rgbAt(`${DIR}w10-fadewhite.mp4`, 1.2);
  const mid = await rgbAt(`${DIR}w10-fadewhite.mp4`, 1.5);
  check('fadewhite: duration ~3.0s, flashes to white early then comes back down',
    rFw.durationError < 0.3 && early.luma > 240 && mid.luma < 220,
    `err=${rFw.durationError.toFixed(2)}s luma@1.2=${early.luma} luma@1.5=${mid.luma}`);
}

// --- 6. mixed per-junction project: red -> blue -> lime,
//     dissolve 1.0s + wipeleft 0.5s (total 6 - 1.5 = 4.5s) ---
{
  const p = { ...base, transitionDuration: 0.5,
    clips: [clip('a', 'red'), clip('b', 'blue'), clip('c', 'lime')],
    transitions: ['dissolve', 'wipeleft'], transitionDurations: [1.0, 0.5] };
  const g = buildFilterGraph(p, FONT).filterComplex;
  check('mixed: graph has dissolve d=1 offset=1 and wipeleft d=0.5 offset=2.5',
    g.includes('xfade=transition=dissolve:duration=1:offset=1')
    && g.includes('xfade=transition=wipeleft:duration=0.5:offset=2.5'));
  check('mixed: graph acrossfades with the same per-junction durations',
    g.includes('acrossfade=d=1') && g.includes('acrossfade=d=0.5'));
  const rep = await exportProject(p, `${DIR}w10-mixed.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('mixed: duration ~4.5s (per-junction math, not 2x global 0.5s)',
    rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s actual=${rep.actual.duration}`);
  const mid0 = await rgbAt(`${DIR}w10-mixed.mp4`, 1.5);
  check('mixed: first junction mid is a red/blue blend',
    mid0.r >= 100 && mid0.r <= 160 && mid0.b >= 100 && mid0.b <= 160, `R=${mid0.r} B=${mid0.b}`);
  const left1 = await halfRgb(`${DIR}w10-mixed.mp4`, 2.75, 'left');
  const right1 = await halfRgb(`${DIR}w10-mixed.mp4`, 2.75, 'right');
  check('mixed: second junction mid is split blue-left / lime-right',
    left1.b > 200 && left1.g < 100 && right1.g > 200 && right1.b < 100,
    `left B=${left1.b} G=${left1.g} right G=${right1.g} B=${right1.b}`);
  const end = await rgbAt(`${DIR}w10-mixed.mp4`, 4.0);
  check('mixed: tail frame is pure lime', end.g > 200 && end.r < 50 && end.b < 50,
    `R=${end.r} G=${end.g} B=${end.b}`);
}

// --- 7. legacy global form still exports identically ---
{
  const p = { ...base, transitionDuration: 0.5, clips: [clip('a', 'red'), clip('b', 'blue')], transitions: ['dissolve'] };
  const rep = await exportProject(p, `${DIR}w10-legacy.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('legacy: global-duration dissolve still exports ~3.5s',
    rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  const mid = await rgbAt(`${DIR}w10-legacy.mp4`, 1.75);
  check('legacy: mid-transition frame is still a blend',
    mid.r >= 100 && mid.r <= 160 && mid.b >= 100 && mid.b <= 160, `R=${mid.r} B=${mid.b}`);
}

// --- 8. cut stays a hard cut inside a mixed project ---
{
  const p = { ...base, transitionDuration: 0.5,
    clips: [clip('a', 'red'), clip('b', 'blue'), clip('c', 'lime')],
    transitions: ['dissolve', 'cut'], transitionDurations: [1.0, 0.5] };
  const g = buildFilterGraph(p, FONT).filterComplex;
  check('mixed-cut: graph xfades junction 0 and concats junction 1',
    g.includes('xfade=transition=dissolve') && g.includes('concat=n=2:v=1:a=0'));
  const rep = await exportProject(p, `${DIR}w10-mixedcut.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('mixed-cut: duration ~5.0s (only the dissolve overlaps)',
    rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s actual=${rep.actual.duration}`);
  const before = await rgbAt(`${DIR}w10-mixedcut.mp4`, 2.9);
  const after = await rgbAt(`${DIR}w10-mixedcut.mp4`, 3.1);
  check('mixed-cut: hard cut at 3.0s (blue before, lime after)',
    before.b > 200 && before.g < 50 && after.g > 200 && after.b < 50,
    `t=2.9 B=${before.b} G=${before.g} t=3.1 G=${after.g} B=${after.b}`);
}

let failed = 0;
const lines = [];
for (const [name, ok] of checks) {
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
const summary = failed === 0
  ? `PASS: all ${checks.length} W10 transition checks passed`
  : `FAIL: ${failed} of ${checks.length} W10 transition checks failed`;
lines.unshift(summary);
console.log(lines.join('\n'));
mkdirSync(dirname(RESULTS_FILE), { recursive: true });
writeFileSync(RESULTS_FILE, `${lines.join('\n')}\n`, 'utf8');
process.exit(failed === 0 ? 0 : 1);
