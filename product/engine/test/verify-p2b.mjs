// P2 batch 2 engine verification (M4, 2026-11-17).
// Covers: compound clips / nested timelines (src/compound.ts — child
// rendered first to an intermediate MP4, parent treats it as an
// ordinary source; max depth 2, child rendered at the parent's
// width/height/fps) + multicam (src/multicam.ts — 2-16 synchronised
// angles, cut between them, audio from one angle only).
//
// Measurement method (written down so the numbers can be re-derived):
// - Determinism probe was run BEFORE writing assertions (the vidstab
//   lesson). tmp/probe-p2b.mjs generated red/blue/green 4 s sources and
//   exported the same multicam project 3x and the same compound project
//   3x: every value was bit-identical across runs (multicam frames
//   t=1.0 253,0,0 / t=1.9 253,0,0 / t=2.0 0,0,254 / t=2.1 0,0,254 /
//   t=3.0 0,0,254, duration err 0.00 s, no black segments, audio mean
//   volume -21.1 dB at t=1 s; compound durations 3.5 s err 0.00 s,
//   centre@3.0 0,0,254, corner@1.0 253,0,0). This test re-exports the
//   multicam project twice and asserts identical durations and frame
//   RGBs, so a future nondeterminism fails loudly.
// - Pixel checks use 16x16 crops averaged to RGB (meanRGB), same as
//   P1b/P2a (crop=1:1 fails on yuv420p). "Corner" is the 16x16 block at
//   (8,8); "centre" is the 64x64 block at (288,148).
// - PSNR frame checks use ffmpeg's psnr filter on cropped regions
//   (psnrCropsAt, same as P1e's psnrCrops but with -ss on both inputs).
//   The compound subtitle check compares the bottom 80 px strip
//   (subtitle lives at y=0.85, fontsize 40, lowerThird preset) between
//   a child WITH a subtitle and the same child WITHOUT one: the strip
//   must differ (PSNR < 30) while the top 80 px strip is bit-identical
//   (PSNR 999) — that pins the difference to the subtitle, not to the
//   render.
// - Duration error bar is < 0.3 s per the task (probe runs: 0.00 s).
// - Black-segment check is blackdetect d=0.5 pix_th=0.10, same as P1d.
// - LGPL: compound and multicam add NO new FFmpeg filters — the child
//   render uses exactly the filters the child's own clips already use,
//   and multicam switching is trim/setpts/concat, the same filters the
//   speed-curve path already uses. Only verified on the local GPL 8.1.2
//   build; trim/setpts/concat are native libavfilter (LGPL part) but
//   re-check on the BtbN LGPL 9.0 build at the M2 gate.
// Old M1 / P0 / P0b / P1 / P1b / P1c / P1d / P1e / P2a checks live in
// their own files and must still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import {
  compoundChildDuration,
  compoundIntermediatePath,
  compoundRenderDir,
  exportProject,
  MAX_COMPOUND_DEPTH,
  multicamSegments,
  probe,
  PRESETS,
  resolveCompoundClips,
  validateCompoundClip,
  validateMulticam,
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

/** One RGB24 frame (optionally cropped) as a Buffer. */
async function rawFrame(file, ss, crop) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', file, '-vf', `crop=${crop}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ]);
  return r.stdout;
}

function meanRGB(buf) {
  let r = 0, g = 0, b = 0;
  const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  return { r: r / n, g: g / n, b: b / n };
}

async function psnrCropsAt(a, b, ss, crop) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', a, '-ss', String(ss), '-i', b, '-filter_complex',
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

async function meanVolume(file, ss, dur) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', file, '-t', String(dur),
    '-af', 'volumedetect', '-vn', '-f', 'null', '-',
  ]).catch((e) => e);
  const m = ((r.stderr ?? '') + (r.stdout ?? '')).match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : null;
}

const base = { version: 1, width: 640, height: 360, fps: 30, transitions: [], transitionDuration: 0.5 };
const clip = (id, source, extra = {}) => ({ id, source, in: 0, out: 4, speed: 1, volume: 1, ...extra });
const isRed = (m) => m.r > 240 && m.g < 15 && m.b < 15;
const isBlue = (m) => m.b > 240 && m.r < 15 && m.g < 15;
const isGreen = (m) => m.g > 240 && m.r < 15 && m.b < 15;

// --- 0. validation + segments + graph strings (no encode) ---
{
  const child = { ...base, clips: [clip('a', '/tmp/x.mp4', { in: 0, out: 2 })] };
  const comp = { id: 'c', source: '', in: 0, out: 3.5, speed: 1, volume: 1, compound: { project: child } };
  check('compound: MAX depth is 2', MAX_COMPOUND_DEPTH === 2);
  check('compound: child duration 2.0s', compoundChildDuration(child) === 2);
  check('compound: intermediate path carries depth+clip', compoundIntermediatePath('/tmp/o', 0, 3) === '/tmp/o/compound-d0-c3/render.mp4', compoundIntermediatePath('/tmp/o', 0, 3));
  check('compound: render dir per depth+clip', compoundRenderDir('/tmp/o', 1, 2) === '/tmp/o/compound-d1-c2');
  let threw = false;
  try { validateCompoundClip(comp, child, 2, 2); } catch (e) { threw = /deeper than 2/.test(e.message); }
  check('compound: depth 2 rejects a further nesting', threw);
  threw = false;
  try { validateCompoundClip({ ...comp, source: '/tmp/y.mp4' }, child, 2, 0); } catch (e) { threw = /ignore source/.test(e.message); }
  check('compound: non-empty source rejected', threw);
  threw = false;
  try { validateCompoundClip({ ...comp, out: 2.5 }, child, 2, 0); } catch (e) { threw = /exceeds child project duration/.test(e.message); }
  check('compound: out beyond child duration rejected', threw);
  threw = false;
  try { validateCompoundClip({ ...comp, in: -0.5 }, child, 2, 0); } catch (e) { threw = />= 0/.test(e.message); }
  check('compound: negative in rejected', threw);
  threw = false;
  try { validateCompoundClip({ ...comp, out: 0 }, child, 2, 0); } catch (e) { threw = /must be > in/.test(e.message); }
  check('compound: out <= in rejected', threw);
  threw = false;
  try { validateCompoundClip(comp, { ...base, clips: [] }, 0, 0); } catch (e) { threw = /no clips/.test(e.message); }
  check('compound: empty child project rejected', threw);
  // depth-3 rejection through the real resolver (parent -> child -> grandchild -> great-grandchild).
  const gg = { ...base, clips: [clip('g', '/tmp/x.mp4', { in: 0, out: 2 })] };
  const gc = { ...base, clips: [{ id: 'gc', source: '', in: 0, out: 2, speed: 1, volume: 1, compound: { project: gg } }] };
  const ch = { ...base, clips: [{ id: 'ch', source: '', in: 0, out: 2, speed: 1, volume: 1, compound: { project: gc } }] };
  const top = { ...base, clips: [{ id: 'top', source: '', in: 0, out: 2, speed: 1, volume: 1, compound: { project: ch } }] };
  threw = false;
  try {
    await resolveCompoundClips(top, DIR, { preset: PRESETS['720p30'], fontfile: FONT }, 'ffmpeg', 0);
  } catch (e) { threw = /deeper than 2/.test(e.message); }
  check('compound: 3-level nesting rejected by resolver', threw);
}
{
  const mcClip = (extra = {}) => clip('m', 'RED', { multicam: { angles: ['RED', 'BLUE'], cuts: [{ t: 2.0, angle: 1 }] }, ...extra });
  const segs = multicamSegments(mcClip());
  check('multicam: cut at 2.0 splits 4s into 2 segments', segs.length === 2 && segs[0].angle === 0 && segs[0].t0 === 0 && segs[0].t1 === 2.0 && segs[1].angle === 1 && segs[1].t1 === 4, JSON.stringify(segs));
  const segs0 = multicamSegments(mcClip({ multicam: { angles: ['RED', 'BLUE'], cuts: [{ t: 0, angle: 1 }] } }));
  check('multicam: cut at t=0 opens on angle 1', segs0.length === 1 && segs0[0].angle === 1 && segs0[0].t0 === 0 && segs0[0].t1 === 4, JSON.stringify(segs0));
  const segsE = multicamSegments(mcClip({ multicam: { angles: ['RED', 'BLUE'], cuts: [] } }));
  check('multicam: no cuts stays on angle 0', segsE.length === 1 && segsE[0].angle === 0, JSON.stringify(segsE));
  const bad = [
    ['1 angle', { multicam: { angles: ['RED'], cuts: [] } }, /2-16 angles/],
    ['17 angles', { multicam: { angles: Array(17).fill('R'), cuts: [] } }, /2-16 angles/],
    ['angles[0] != source', { multicam: { angles: ['BLUE', 'RED'], cuts: [] } }, /angles\[0\] must be the clip source/],
    ['unsorted cuts', { multicam: { angles: ['RED', 'BLUE'], cuts: [{ t: 3, angle: 1 }, { t: 1, angle: 0 }] } }, /strictly increasing/],
    ['duplicate cut t', { multicam: { angles: ['RED', 'BLUE'], cuts: [{ t: 2, angle: 1 }, { t: 2, angle: 0 }] } }, /strictly increasing/],
    ['cut t out of range', { multicam: { angles: ['RED', 'BLUE'], cuts: [{ t: 4, angle: 1 }] } }, /outside \[0, 4\)/],
    ['cut t negative', { multicam: { angles: ['RED', 'BLUE'], cuts: [{ t: -0.5, angle: 1 }] } }, /outside \[0, 4\)/],
    ['cut angle out of range', { multicam: { angles: ['RED', 'BLUE'], cuts: [{ t: 1, angle: 2 }] } }, /outside \[0, 2\)/],
    ['audioAngle out of range', { multicam: { angles: ['RED', 'BLUE'], cuts: [], audioAngle: 2 } }, /audioAngle/],
    ['speed != 1', { speed: 2, multicam: { angles: ['RED', 'BLUE'], cuts: [] } }, /speed 1/],
    ['reverse', { reverse: true, multicam: { angles: ['RED', 'BLUE'], cuts: [] } }, /reverse/],
    ['freeze', { freezeAt: 1, multicam: { angles: ['RED', 'BLUE'], cuts: [] } }, /freeze/],
    ['stabilize', { stabilize: true, multicam: { angles: ['RED', 'BLUE'], cuts: [] } }, /stabilisation/],
    ['portrait', { portraitCutout: {}, multicam: { angles: ['RED', 'BLUE'], cuts: [] } }, /portrait cutout/],
  ];
  let allOk = true;
  for (const [name, extra, re] of bad) {
    try { validateMulticam(mcClip(extra)); allOk = false; console.log(`  (expected throw, got none: ${name})`); }
    catch (e) { if (!re.test(e.message)) { allOk = false; console.log(`  (wrong message for ${name}: ${e.message})`); } }
  }
  check('multicam: 14 bad configs rejected', allOk);
}
{
  // Graph strings: multicam video trims from both inputs, audio from the audio angle.
  const mcProj = { ...base, clips: [clip('m', 'RED', { multicam: { angles: ['RED', 'BLUE'], cuts: [{ t: 2.0, angle: 1 }], audioAngle: 1 } })] };
  const g = buildFilterGraph(mcProj, FONT);
  check('graph: multicam registers angle 1 as extra input', g.extraInputs.length === 1 && g.extraInputs[0] === 'BLUE', JSON.stringify(g.extraInputs));
  check('graph: angle 0 segment trims input 0', g.filterComplex.includes('[0:v]trim=start=0:end=2'), g.filterComplex.slice(0, 120));
  check('graph: angle 1 segment trims input 1', g.filterComplex.includes('[1:v]trim=start=2:end=4'), g.filterComplex.slice(0, 200));
  check('graph: multicam segments concat to [vb0]', g.filterComplex.includes('concat=n=2:v=1:a=0[vb0]'));
  check('graph: audio comes from angle 1', g.filterComplex.includes('[1:a]atrim=start=0:end=4'), g.filterComplex.slice(0, 300));
  const unres = { ...base, clips: [{ id: 'c', source: '', in: 0, out: 2, speed: 1, volume: 1, compound: { project: { ...base, clips: [clip('a', 'RED')] } } }] };
  let threw = false;
  try { buildFilterGraph(unres, FONT); } catch (e) { threw = /not resolved/.test(e.message); }
  check('graph: unresolved compound clip throws', threw);
}

// --- A. test sources: 3 angles 4 s + short angle 3 s + 320x180 red ---
const ANGLES = {};
for (const [name, c, freq] of [['red', '0xff0000', 440], ['blue', '0x0000ff', 550], ['green', '0x00ff00', 660]]) {
  const f = `${DIR}p2b-${name}.mp4`;
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=640x360:d=4:r=30`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=4`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-t', '4', '-y', f]);
  ANGLES[name] = f;
  const p = await probe(f);
  check(`source: ${name} angle 4s 640x360 30fps`, p.duration === 4 && p.width === 640 && p.fps === 30 && p.hasAudio, JSON.stringify(p));
}
await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x0000ff:s=640x360:d=3:r=30',
  '-f', 'lavfi', '-i', 'sine=frequency=550:duration=3',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-t', '3', '-y', `${DIR}p2b-blue-short.mp4`]);
ANGLES.blueShort = `${DIR}p2b-blue-short.mp4`;
await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=320x180:d=2:r=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-t', '2', '-y', `${DIR}p2b-red-small.mp4`]);
ANGLES.redSmall = `${DIR}p2b-red-small.mp4`;

// --- B. multicam exports ---
const mc2 = {
  ...base,
  clips: [clip('mc', ANGLES.red, {
    multicam: { angles: [ANGLES.red, ANGLES.blue], cuts: [{ t: 2.0, angle: 1 }] },
  })],
};
{
  const r = await exportProject(mc2, `${DIR}p2b-mc2.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: mc 2-angle duration err < 0.3s', Math.abs(r.durationError) < 0.3, `err=${r.durationError.toFixed(2)}s`);
  check('export: mc 2-angle has audio', r.actual.hasAudio);
  check('export: mc 2-angle no black segment', !(await hasBlackSegments(`${DIR}p2b-mc2.mp4`)));
  const f10 = meanRGB(await rawFrame(`${DIR}p2b-mc2.mp4`, 1.0, '16:16:312:172'));
  check('export: mc t=1.0 is red', isRed(f10), `RGB=${Math.round(f10.r)},${Math.round(f10.g)},${Math.round(f10.b)}`);
  const f19 = meanRGB(await rawFrame(`${DIR}p2b-mc2.mp4`, 1.9, '16:16:312:172'));
  check('export: mc t=1.9 (just before cut) is red', isRed(f19), `RGB=${Math.round(f19.r)},${Math.round(f19.g)},${Math.round(f19.b)}`);
  const f20 = meanRGB(await rawFrame(`${DIR}p2b-mc2.mp4`, 2.0, '16:16:312:172'));
  check('export: mc t=2.0 (cut frame) is blue', isBlue(f20), `RGB=${Math.round(f20.r)},${Math.round(f20.g)},${Math.round(f20.b)}`);
  const f21 = meanRGB(await rawFrame(`${DIR}p2b-mc2.mp4`, 2.1, '16:16:312:172'));
  check('export: mc t=2.1 (just after cut) is blue', isBlue(f21), `RGB=${Math.round(f21.r)},${Math.round(f21.g)},${Math.round(f21.b)}`);
  const f30 = meanRGB(await rawFrame(`${DIR}p2b-mc2.mp4`, 3.0, '16:16:312:172'));
  check('export: mc t=3.0 is blue', isBlue(f30), `RGB=${Math.round(f30.r)},${Math.round(f30.g)},${Math.round(f30.b)}`);
  const vol = await meanVolume(`${DIR}p2b-mc2.mp4`, 1, 1);
  check('export: mc audio mean volume -21.1 +-3 dB', vol !== null && Math.abs(vol - (-21.1)) < 3, `vol=${vol}`);
  // Determinism: export the same project again, durations + frame RGBs must match.
  const r2 = await exportProject(mc2, `${DIR}p2b-mc2-again.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  const g10 = meanRGB(await rawFrame(`${DIR}p2b-mc2-again.mp4`, 1.0, '16:16:312:172'));
  const g30 = meanRGB(await rawFrame(`${DIR}p2b-mc2-again.mp4`, 3.0, '16:16:312:172'));
  check('probe: mc re-export duration identical', r2.actual.duration === r.actual.duration, `dur=${r2.actual.duration} vs ${r.actual.duration}`);
  check('probe: mc re-export t=1.0 RGB identical', Math.round(g10.r) === Math.round(f10.r) && Math.round(g10.g) === Math.round(f10.g) && Math.round(g10.b) === Math.round(f10.b), `RGB=${Math.round(g10.r)},${Math.round(g10.g)},${Math.round(g10.b)}`);
  check('probe: mc re-export t=3.0 RGB identical', Math.round(g30.r) === Math.round(f30.r) && Math.round(g30.g) === Math.round(f30.g) && Math.round(g30.b) === Math.round(f30.b), `RGB=${Math.round(g30.r)},${Math.round(g30.g)},${Math.round(g30.b)}`);
}
{
  // 3 angles: red -> green at 1.0, -> blue at 2.5.
  const r = await exportProject(
    { ...base, clips: [clip('mc', ANGLES.red, {
      multicam: { angles: [ANGLES.red, ANGLES.green, ANGLES.blue], cuts: [{ t: 1.0, angle: 1 }, { t: 2.5, angle: 2 }] },
    })] },
    `${DIR}p2b-mc3.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: mc 3-angle duration err < 0.3s', Math.abs(r.durationError) < 0.3, `err=${r.durationError.toFixed(2)}s`);
  check('export: mc 3-angle has audio', r.actual.hasAudio);
  check('export: mc 3-angle no black segment', !(await hasBlackSegments(`${DIR}p2b-mc3.mp4`)));
  const f05 = meanRGB(await rawFrame(`${DIR}p2b-mc3.mp4`, 0.5, '16:16:312:172'));
  check('export: mc3 t=0.5 is red', isRed(f05), `RGB=${Math.round(f05.r)},${Math.round(f05.g)},${Math.round(f05.b)}`);
  const f15 = meanRGB(await rawFrame(`${DIR}p2b-mc3.mp4`, 1.5, '16:16:312:172'));
  check('export: mc3 t=1.5 is green', isGreen(f15), `RGB=${Math.round(f15.r)},${Math.round(f15.g)},${Math.round(f15.b)}`);
  const f30 = meanRGB(await rawFrame(`${DIR}p2b-mc3.mp4`, 3.0, '16:16:312:172'));
  check('export: mc3 t=3.0 is blue', isBlue(f30), `RGB=${Math.round(f30.r)},${Math.round(f30.g)},${Math.round(f30.b)}`);
}
{
  // Cut at t=0 opens on angle 1; empty cuts stay on angle 0.
  const r = await exportProject(
    { ...base, clips: [clip('mc', ANGLES.red, {
      multicam: { angles: [ANGLES.red, ANGLES.blue], cuts: [{ t: 0, angle: 1 }] },
    })] },
    `${DIR}p2b-mc0.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: mc cut-at-0 duration err < 0.3s', Math.abs(r.durationError) < 0.3, `err=${r.durationError.toFixed(2)}s`);
  const f05 = meanRGB(await rawFrame(`${DIR}p2b-mc0.mp4`, 0.5, '16:16:312:172'));
  check('export: mc cut-at-0 t=0.5 is blue', isBlue(f05), `RGB=${Math.round(f05.r)},${Math.round(f05.g)},${Math.round(f05.b)}`);
  const r2 = await exportProject(
    { ...base, clips: [clip('mc', ANGLES.red, {
      multicam: { angles: [ANGLES.red, ANGLES.blue], cuts: [] },
    })] },
    `${DIR}p2b-mc-none.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: mc no-cuts duration err < 0.3s', Math.abs(r2.durationError) < 0.3, `err=${r2.durationError.toFixed(2)}s`);
  const f20 = meanRGB(await rawFrame(`${DIR}p2b-mc-none.mp4`, 2.0, '16:16:312:172'));
  check('export: mc no-cuts t=2.0 stays red', isRed(f20), `RGB=${Math.round(f20.r)},${Math.round(f20.g)},${Math.round(f20.b)}`);
}

// --- C. compound exports ---
const childWithSub = {
  ...base,
  clips: [
    { id: 'a', source: ANGLES.red, in: 0, out: 2, speed: 1, volume: 1 },
    { id: 'b', source: ANGLES.blue, in: 0, out: 2, speed: 1, volume: 1,
      subtitles: [{ start: 0, end: 2, text: 'CHILD SUB', words: [] }] },
  ],
  transitions: ['fade'],
  transitionDuration: 0.5,
};
const childNoSub = {
  ...base,
  clips: [
    { id: 'a', source: ANGLES.red, in: 0, out: 2, speed: 1, volume: 1 },
    { id: 'b', source: ANGLES.blue, in: 0, out: 2, speed: 1, volume: 1 },
  ],
  transitions: ['fade'],
  transitionDuration: 0.5,
};
{
  const r = await exportProject(
    { ...base, clips: [{ id: 'comp', source: '', in: 0, out: 3.5, speed: 1, volume: 1, compound: { project: childWithSub } }] },
    `${DIR}p2b-comp.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: compound duration err < 0.3s', Math.abs(r.durationError) < 0.3, `err=${r.durationError.toFixed(2)}s`);
  check('export: compound has audio', r.actual.hasAudio);
  check('export: compound no black segment', !(await hasBlackSegments(`${DIR}p2b-comp.mp4`)));
  check('export: compound intermediate kept next to output', existsSync(`${DIR}compound-d0-c0/render.mp4`));
  const corner = meanRGB(await rawFrame(`${DIR}p2b-comp.mp4`, 1.0, '16:16:8:8'));
  check('export: compound t=1.0 corner is red (child clip a)', isRed(corner), `RGB=${Math.round(corner.r)},${Math.round(corner.g)},${Math.round(corner.b)}`);
  const centre = meanRGB(await rawFrame(`${DIR}p2b-comp.mp4`, 3.0, '64:64:288:148'));
  check('export: compound t=3.0 centre is blue (child clip b)', isBlue(centre), `RGB=${Math.round(centre.r)},${Math.round(centre.g)},${Math.round(centre.b)}`);
  // Subtitle check: same child without the subtitle as control.
  await exportProject(
    { ...base, clips: [{ id: 'comp', source: '', in: 0, out: 3.5, speed: 1, volume: 1, compound: { project: childNoSub } }] },
    `${DIR}p2b-comp-ctrl.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  const subPsnr = await psnrCropsAt(`${DIR}p2b-comp.mp4`, `${DIR}p2b-comp-ctrl.mp4`, 3.0, '640:80:0:280');
  check('export: compound child subtitle visible in bottom strip (PSNR < 30)', Number.isFinite(subPsnr) && subPsnr < 30, `PSNR=${subPsnr}`);
  const topPsnr = await psnrCropsAt(`${DIR}p2b-comp.mp4`, `${DIR}p2b-comp-ctrl.mp4`, 3.0, '640:80:0:0');
  check('export: compound top strip identical to control (PSNR 999)', topPsnr === 999, `PSNR=${topPsnr}`);
}
{
  // Two-level nesting: grandchild (green 2s) -> child (+ red 2s) -> parent.
  const grandchild = { ...base, clips: [clip('g', ANGLES.green, { in: 0, out: 2 })] };
  const child2 = {
    ...base,
    transitions: ['cut'],
    clips: [
      { id: 'gc', source: '', in: 0, out: 2, speed: 1, volume: 1, compound: { project: grandchild } },
      clip('r', ANGLES.red, { in: 0, out: 2 }),
    ],
  };
  const r = await exportProject(
    { ...base, clips: [{ id: 'comp', source: '', in: 0, out: 4, speed: 1, volume: 1, compound: { project: child2 } }] },
    `${DIR}p2b-comp2.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: 2-level compound duration err < 0.3s', Math.abs(r.durationError) < 0.3, `err=${r.durationError.toFixed(2)}s`);
  check('export: 2-level compound has audio', r.actual.hasAudio);
  check('export: 2-level compound no black segment', !(await hasBlackSegments(`${DIR}p2b-comp2.mp4`)));
  const f10 = meanRGB(await rawFrame(`${DIR}p2b-comp2.mp4`, 1.0, '16:16:312:172'));
  check('export: 2-level t=1.0 is green (grandchild)', isGreen(f10), `RGB=${Math.round(f10.r)},${Math.round(f10.g)},${Math.round(f10.b)}`);
  const f30 = meanRGB(await rawFrame(`${DIR}p2b-comp2.mp4`, 3.0, '16:16:312:172'));
  check('export: 2-level t=3.0 is red (child clip)', isRed(f30), `RGB=${Math.round(f30.r)},${Math.round(f30.g)},${Math.round(f30.b)}`);
}
{
  // Resampling: child project is 320x180, parent is 640x360.
  const smallChild = { version: 1, width: 320, height: 180, fps: 30, transitions: [], transitionDuration: 0.5,
    clips: [clip('s', ANGLES.redSmall, { in: 0, out: 2 })] };
  const r = await exportProject(
    { ...base, clips: [{ id: 'comp', source: '', in: 0, out: 2, speed: 1, volume: 1, compound: { project: smallChild } }] },
    `${DIR}p2b-comp-small.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: resampled compound duration err < 0.3s', Math.abs(r.durationError) < 0.3, `err=${r.durationError.toFixed(2)}s`);
  check('export: resampled compound output is parent size 640x360', r.actual.width === 640 && r.actual.height === 360, `${r.actual.width}x${r.actual.height}`);
  const f10 = meanRGB(await rawFrame(`${DIR}p2b-comp-small.mp4`, 1.0, '16:16:312:172'));
  check('export: resampled compound t=1.0 is red', isRed(f10), `RGB=${Math.round(f10.r)},${Math.round(f10.g)},${Math.round(f10.b)}`);
}
{
  // Compound clip + ordinary clip in the same parent timeline; windowed compound (in 1.0 out 3.0).
  const r = await exportProject(
    { ...base, transitions: ['cut'], clips: [
      { id: 'comp', source: '', in: 0, out: 3.5, speed: 1, volume: 1, compound: { project: childWithSub } },
      clip('r', ANGLES.red, { in: 0, out: 2 }),
    ] },
    `${DIR}p2b-comp-mix.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: compound+clip duration 5.5s err < 0.3s', Math.abs(r.durationError) < 0.3 && Math.abs(r.actual.duration - 5.5) < 0.3, `dur=${r.actual.duration} err=${r.durationError.toFixed(2)}`);
  check('export: compound+clip no black segment', !(await hasBlackSegments(`${DIR}p2b-comp-mix.mp4`)));
  const f45 = meanRGB(await rawFrame(`${DIR}p2b-comp-mix.mp4`, 4.5, '16:16:312:172'));
  check('export: compound+clip t=4.5 is red (ordinary clip)', isRed(f45), `RGB=${Math.round(f45.r)},${Math.round(f45.g)},${Math.round(f45.b)}`);
  const r2 = await exportProject(
    { ...base, clips: [{ id: 'comp', source: '', in: 1.0, out: 3.0, speed: 1, volume: 1, compound: { project: childWithSub } }] },
    `${DIR}p2b-comp-win.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: windowed compound duration 2.0s err < 0.3s', Math.abs(r2.durationError) < 0.3 && Math.abs(r2.actual.duration - 2.0) < 0.3, `dur=${r2.actual.duration} err=${r2.durationError.toFixed(2)}`);
  const w02 = meanRGB(await rawFrame(`${DIR}p2b-comp-win.mp4`, 0.2, '16:16:312:172'));
  check('export: windowed compound t=0.2 is red (child time 1.2, before fade)', isRed(w02), `RGB=${Math.round(w02.r)},${Math.round(w02.g)},${Math.round(w02.b)}`);
  const w12 = meanRGB(await rawFrame(`${DIR}p2b-comp-win.mp4`, 1.2, '16:16:312:172'));
  check('export: windowed compound t=1.2 is blue (child time 2.2, after fade)', isBlue(w12), `RGB=${Math.round(w12.r)},${Math.round(w12.g)},${Math.round(w12.b)}`);
}

// --- D. export-time rejections ---
{
  const throwsWith = async (fn, re) => {
    try { await fn(); return false; } catch (e) { return re.test(e.message); }
  };
  // 3-level nesting at export.
  const gg = { ...base, clips: [clip('g', ANGLES.green, { in: 0, out: 2 })] };
  const gc = { ...base, clips: [{ id: 'gc', source: '', in: 0, out: 2, speed: 1, volume: 1, compound: { project: gg } }] };
  const ch = { ...base, clips: [{ id: 'ch', source: '', in: 0, out: 2, speed: 1, volume: 1, compound: { project: gc } }] };
  const top = { ...base, clips: [{ id: 'top', source: '', in: 0, out: 2, speed: 1, volume: 1, compound: { project: ch } }] };
  check('reject: 3-level nesting throws at export',
    await throwsWith(() => exportProject(top, `${DIR}p2b-deep.mp4`, { preset: PRESETS['720p30'], fontfile: FONT }), /deeper than 2/));
  check('reject: compound out beyond child duration throws at export',
    await throwsWith(() => exportProject(
      { ...base, clips: [{ id: 'c', source: '', in: 0, out: 4.0, speed: 1, volume: 1, compound: { project: childWithSub } }] },
      `${DIR}p2b-comp-over.mp4`, { preset: PRESETS['720p30'], fontfile: FONT }), /exceeds child project duration/));
  check('reject: compound with non-empty source throws at export',
    await throwsWith(() => exportProject(
      { ...base, clips: [{ id: 'c', source: ANGLES.red, in: 0, out: 2, speed: 1, volume: 1, compound: { project: childWithSub } }] },
      `${DIR}p2b-comp-src.mp4`, { preset: PRESETS['720p30'], fontfile: FONT }), /ignore source/));
  check('reject: multicam 17 angles throws at export',
    await throwsWith(() => exportProject(
      { ...base, clips: [clip('mc', ANGLES.red, { multicam: { angles: Array(17).fill(ANGLES.red), cuts: [] } })] },
      `${DIR}p2b-mc17.mp4`, { preset: PRESETS['720p30'], fontfile: FONT }), /2-16 angles/));
  check('reject: multicam mismatched durations throws at export',
    await throwsWith(() => exportProject(
      { ...base, clips: [clip('mc', ANGLES.red, { multicam: { angles: [ANGLES.red, ANGLES.blueShort], cuts: [] } })] },
      `${DIR}p2b-mc-mismatch.mp4`, { preset: PRESETS['720p30'], fontfile: FONT }), /different durations/));
  check('reject: multicam window beyond angle duration throws at export',
    await throwsWith(() => exportProject(
      { ...base, clips: [{ id: 'mc', source: ANGLES.red, in: 0, out: 5, speed: 1, volume: 1, multicam: { angles: [ANGLES.red, ANGLES.blue], cuts: [] } }] },
      `${DIR}p2b-mc-long.mp4`, { preset: PRESETS['720p30'], fontfile: FONT }), /exceeds angle duration/));
  check('reject: multicam with speed 2 throws at export',
    await throwsWith(() => exportProject(
      { ...base, clips: [clip('mc', ANGLES.red, { speed: 2, multicam: { angles: [ANGLES.red, ANGLES.blue], cuts: [] } })] },
      `${DIR}p2b-mc-speed.mp4`, { preset: PRESETS['720p30'], fontfile: FONT }), /speed 1/));
}

// --- report ---
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exit(1);
