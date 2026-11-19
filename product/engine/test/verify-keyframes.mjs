// Position keyframes engine verification (W10, engine first).
// Covers: src/keyframes.ts (positionAt / positionExpr /
// positionOverlayExprs / validatePositionKeyframes /
// positionNeedsStage) and the position stage in
// src/filtergraph.ts (clipVideoChains tail: overlay onto a canvas
// after zoom/rotation/colour/opacity/text — opaque black on the
// legacy single track, transparent yuva420p on multitrack), plus the
// Clip.position / positionInterpolation model in src/project.ts.
//
// Measurement method (probe /tmp/kf-probe.mjs ran BEFORE writing
// assertions — every number below was measured first):
// - Fixtures are solid-colour videos (ffmpeg colour red=(255,0,0)
//   with sine audio 440 Hz, amp 0.5, mono WAV muxed to AAC), 320x180,
//   30 fps, 4 s. A rendered red pixel reads (253,0,0) (yuv420p
//   rounding); black reads (0,0,0). Pixel bars are bands, not exact
//   values: red = r>200,g<20,b<20; black = all channels <20.
// - Pixel reads use ffmpeg -ss before -i + rawvideo rgb24, same as
//   verify-multitrack.mjs's pxAt (frame-accurate for these seeks).
// - Position semantics: x/y are the picture CENTRE as fractions of
//   the frame (0.5,0.5 = dead centre). A 320-wide picture at centre
//   cx spans [(cx-0.5)*320, (cx-0.5)*320+320). E.g. linear keys
//   (0,0.25)->(4,0.75): at t=0.1 cx=0.2625, picture spans -76..244,
//   so (100,90) is red and (300,90) is black; at t=2 cx=0.5, full
//   frame red; at t=3.9 cx=0.7375, spans 76..396, so (20,90) is
//   black and (200,90) is red. All three were measured in the probe.
// - New filters here are `color` + `overlay`, both native libavfilter
//   — only verified on the local GPL 8.1.2 build; re-check each on
//   the BtbN LGPL 9.0 build at the M2 gate.
// Old M1 / P0 / P0b / P1 / P1b / P1c / P1d / P1e / P2a / P2b / P2c /
// P3a / P3b checks live in their own files and must still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import {
  exportProject,
  POSITION_MAX,
  POSITION_MIN,
  positionAt,
  positionExpr,
  positionNeedsStage,
  positionOverlayExprs,
  PRESETS,
  probe,
  validatePositionKeyframes,
} from '../dist/export.js';
import { buildFilterGraph } from '../dist/filtergraph.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

const checks = [];
const check = (name, ok, detail = '') =>
  checks.push([`${name}${detail ? ` (${detail})` : ''}`, ok]);

async function run(cmd, args, opts = {}) {
  return exec(cmd, args, { maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer', ...opts });
}
const throwsSync = (fn, re) => {
  try { fn(); return false; } catch (e) { return re.test(e.message); }
};
const close = (v, target, tol) => v !== null && Math.abs(v - target) <= tol;
const isRed = (p) => p[0] > 200 && p[1] < 20 && p[2] < 20;
const isBlack = (p) => p[0] < 20 && p[1] < 20 && p[2] < 20;
async function pxAt(file, ss, x, y) {
  const r = await run('ffmpeg', ['-ss', String(ss), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const o = (y * 320 + x) * 3;
  return [r.stdout[o], r.stdout[o + 1], r.stdout[o + 2]];
}
async function psnrAverage(a, b) {
  const r = await run('ffmpeg', ['-i', a, '-i', b, '-filter_complex', 'psnr', '-f', 'null', '-']).catch((e) => e);
  const m = (r.stderr ?? r.stdout ?? '').toString().match(/average:(\S+)/);
  if (!m) return null;
  return m[1] === 'inf' ? Infinity : Number(m[1]);
}
function synthWav(path, dur, freq, amp = 0.5) {
  const sr = 48000;
  const n = Math.floor(dur * sr);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, Math.sin(2 * Math.PI * freq * (i / sr)) * amp));
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
const mkProject = (extra = {}) => ({
  version: 1, width: 320, height: 180, fps: 30,
  clips: [], transitions: [], transitionDuration: 0.5, ...extra,
});
const exp = (p, out) => exportProject(p, `${DIR}${out}`, { fontfile: FONT, preset: PRESETS['720p30'] });

async function main() {
  synthWav(`${DIR}kf-440.wav`, 4, 440);
  await muxVideo('red', `${DIR}kf-440.wav`, 4, `${DIR}kf-red.mp4`);
  const RED = `${DIR}kf-red.mp4`;

  // ---- pure model: positionAt -------------------------------------------
  const lin2 = [{ t: 0, x: 0.25, y: 0.5 }, { t: 4, x: 0.75, y: 0.5 }];
  const p0 = positionAt(lin2, 0);
  check('positionAt: start exact', close(p0.x, 0.25, 1e-9) && close(p0.y, 0.5, 1e-9), `(${p0.x},${p0.y})`);
  const p4 = positionAt(lin2, 4);
  check('positionAt: end exact', close(p4.x, 0.75, 1e-9) && close(p4.y, 0.5, 1e-9), `(${p4.x},${p4.y})`);
  const p2 = positionAt(lin2, 2);
  check('positionAt: midpoint linear', close(p2.x, 0.5, 1e-9), `x=${p2.x}`);
  const p1 = positionAt(lin2, 1);
  check('positionAt: quarter linear', close(p1.x, 0.375, 1e-9), `x=${p1.x}`);

  const lin3 = [
    { t: 0, x: 0.25, y: 0.5 },
    { t: 2, x: 0.75, y: 0.25 },
    { t: 4, x: 0.25, y: 0.75 },
  ];
  check('positionAt: multi-keyframe segment 1', close(positionAt(lin3, 1).x, 0.5, 1e-9) && close(positionAt(lin3, 1).y, 0.375, 1e-9), JSON.stringify(positionAt(lin3, 1)));
  check('positionAt: multi-keyframe key 2 exact', close(positionAt(lin3, 2).x, 0.75, 1e-9) && close(positionAt(lin3, 2).y, 0.25, 1e-9), JSON.stringify(positionAt(lin3, 2)));
  check('positionAt: multi-keyframe segment 2', close(positionAt(lin3, 3).x, 0.5, 1e-9) && close(positionAt(lin3, 3).y, 0.5, 1e-9), JSON.stringify(positionAt(lin3, 3)));

  // Out-of-range evaluation time clamps to the nearest key (holds).
  check('positionAt: before first key holds first', close(positionAt(lin2, -1).x, 0.25, 1e-9), `x=${positionAt(lin2, -1).x}`);
  check('positionAt: after last key holds last', close(positionAt(lin2, 99).x, 0.75, 1e-9), `x=${positionAt(lin2, 99).x}`);
  const late = [{ t: 1, x: 0.25, y: 0.5 }, { t: 3, x: 0.75, y: 0.5 }];
  check('positionAt: first key late, t=0 holds it', close(positionAt(late, 0).x, 0.25, 1e-9), `x=${positionAt(late, 0).x}`);
  check('positionAt: last key early, t=4 holds it', close(positionAt(late, 4).x, 0.75, 1e-9), `x=${positionAt(late, 4).x}`);
  check('positionAt: single key is a static offset', close(positionAt([{ t: 0, x: 0.75, y: 0.25 }], 2.5).x, 0.75, 1e-9) && close(positionAt([{ t: 0, x: 0.75, y: 0.25 }], 2.5).y, 0.25, 1e-9));
  check('positionAt: empty list is dead centre', close(positionAt([], 1).x, 0.5, 1e-9) && close(positionAt([], 1).y, 0.5, 1e-9));

  // Hold + smooth modes.
  const hold2 = [{ t: 0, x: 0.25, y: 0.5 }, { t: 2, x: 0.75, y: 0.5 }];
  check('positionAt: hold keeps previous value', close(positionAt(hold2, 1.9, 'hold').x, 0.25, 1e-9) && close(positionAt(hold2, 2.0, 'hold').x, 0.75, 1e-9), JSON.stringify(positionAt(hold2, 1.9, 'hold')));
  check('positionAt: hold at key boundary takes the new key', close(positionAt(hold2, 2, 'hold').x, 0.75, 1e-9));
  check('positionAt: hold after last key holds last', close(positionAt(hold2, 3.5, 'hold').x, 0.75, 1e-9));
  const sm = positionAt(lin2, 1, 'smooth');
  check('positionAt: smooth u=0.25 eases below linear', close(sm.x, 0.25 + 0.5 * 0.15625, 1e-9), `x=${sm.x} (linear would be 0.375)`);
  check('positionAt: smooth midpoint equals linear', close(positionAt(lin2, 2, 'smooth').x, 0.5, 1e-9));
  check('positionAt: smooth end exact', close(positionAt(lin2, 4, 'smooth').x, 0.75, 1e-9));

  // ---- validation ---------------------------------------------------------
  check('validate: decreasing t throws', throwsSync(() => validatePositionKeyframes([{ t: 2, x: 0.5, y: 0.5 }, { t: 1, x: 0.5, y: 0.5 }], 'c'), /strictly increasing/));
  check('validate: duplicate t throws', throwsSync(() => validatePositionKeyframes([{ t: 1, x: 0.5, y: 0.5 }, { t: 1, x: 0.6, y: 0.5 }], 'c'), /strictly increasing/));
  check('validate: negative t throws', throwsSync(() => validatePositionKeyframes([{ t: -0.5, x: 0.5, y: 0.5 }], 'c'), /invalid t/));
  check('validate: x out of range throws', throwsSync(() => validatePositionKeyframes([{ t: 0, x: 2.5, y: 0.5 }], 'c'), /outside/));
  check('validate: y out of range throws', throwsSync(() => validatePositionKeyframes([{ t: 0, x: 0.5, y: -1.5 }], 'c'), /outside/));
  check('validate: key past duration throws', throwsSync(() => validatePositionKeyframes([{ t: 0, x: 0.5, y: 0.5 }, { t: 5, x: 0.6, y: 0.5 }], 'c', 4), /outside clip duration/));
  check('validate: off-screen slide-in allowed', (() => { try { validatePositionKeyframes([{ t: 0, x: -1, y: 0.5 }, { t: 4, x: 2, y: 0.5 }], 'c', 4); return true; } catch { return false; } })());
  check('validate: bounds constants', POSITION_MIN === -1 && POSITION_MAX === 2, `${POSITION_MIN}..${POSITION_MAX}`);

  // ---- stage selection ------------------------------------------------------
  check('positionNeedsStage: empty is false', positionNeedsStage([]) === false);
  check('positionNeedsStage: undefined is false', positionNeedsStage(undefined) === false);
  check('positionNeedsStage: all-centre keys are false', positionNeedsStage([{ t: 0, x: 0.5, y: 0.5 }, { t: 4, x: 0.5, y: 0.5 }]) === false);
  check('positionNeedsStage: single off-centre key is true', positionNeedsStage([{ t: 0, x: 0.75, y: 0.5 }]) === true);

  // ---- graph ---------------------------------------------------------------
  const baseProj = mkProject({ clips: [mkClip('c0', RED, 4)] });
  const baseGraph = buildFilterGraph(baseProj, FONT).filterComplex;
  const posProj = mkProject({ clips: [mkClip('c0', RED, 4, { position: lin2 })] });
  const posGraph = buildFilterGraph(posProj, FONT).filterComplex;
  check('graph: position stage adds overlay onto black canvas', /color=c=black:s=320x180:r=30:d=4\[vpb0\];\[vpb0\]\[vpp0\]overlay=x='[^']+':y='[^']+'\[v0\]/.test(posGraph), posGraph.slice(posGraph.indexOf('color=c=black'), posGraph.indexOf('color=c=black') + 160));
  check('graph: overlay x expression carries the lerp', /overlay=x='\(if\(lt\(t,0\),0\.25,if\(gt\(t,4\),0\.75,0\.25\+\(0\.75-0\.25\)\*\(\(t-0\)\/\(4-0\)\)\)\)-0\.5\)\*320'/.test(posGraph));
  check('graph: no-position graph has no overlay stage', !/overlay=/.test(baseGraph));
  const centreProj = mkProject({ clips: [mkClip('c0', RED, 4, { position: [{ t: 0, x: 0.5, y: 0.5 }, { t: 4, x: 0.5, y: 0.5 }] })] });
  check('graph: all-centre keys build a byte-identical graph', buildFilterGraph(centreProj, FONT).filterComplex === baseGraph);
  const holdProj = mkProject({ clips: [mkClip('c0', RED, 4, { position: lin2, positionInterpolation: 'hold' })] });
  check('graph: hold mode emits a step expression', /overlay=x='\(if\(lt\(t,4\),0\.25,0\.75\)-0\.5\)\*320'/.test(buildFilterGraph(holdProj, FONT).filterComplex));
  const smoothExpr = positionExpr(lin2, (k) => k.x, 'smooth');
  check('graph: smooth expression contains smoothstep', smoothExpr.includes('(3-2*'), smoothExpr.slice(0, 120));
  const [ox, oy] = positionOverlayExprs(lin2, 'linear', 320, 180);
  check('graph: overlay exprs map centre to top-left', ox.endsWith(')*320') && oy.endsWith(')*180') && ox.includes('-0.5'), `${ox} / ${oy}`);
  check('graph: key past duration throws at build', throwsSync(() => buildFilterGraph(mkProject({ clips: [mkClip('c0', RED, 4, { position: [{ t: 0, x: 0.5, y: 0.5 }, { t: 5, x: 0.6, y: 0.5 }] })] }), FONT), /outside clip duration/));
  check('graph: x out of range throws at build', throwsSync(() => buildFilterGraph(mkProject({ clips: [mkClip('c0', RED, 4, { position: [{ t: 0, x: 2.5, y: 0.5 }] })] }), FONT), /outside/));

  // ---- render: linear 2-key horizontal move --------------------------------
  const linOut = 'kf-e-linear.mp4';
  const linRep = await exp(posProj, linOut);
  check('render linear: duration 4.00', close(linRep.actual.duration, 4, 0.05), linRep.actual.duration.toFixed(3));
  check('render linear: has audio', linRep.actual.hasAudio === true);
  const f = `${DIR}${linOut}`;
  check('render linear: t=0.1 left red, right black', isRed(await pxAt(f, 0.1, 100, 90)) && isBlack(await pxAt(f, 0.1, 300, 90)), `${await pxAt(f, 0.1, 100, 90)} / ${await pxAt(f, 0.1, 300, 90)}`);
  check('render linear: t=2.0 full frame red', isRed(await pxAt(f, 2, 300, 90)) && isRed(await pxAt(f, 2, 20, 90)));
  check('render linear: t=3.9 left black, right red', isBlack(await pxAt(f, 3.9, 20, 90)) && isRed(await pxAt(f, 3.9, 200, 90)), `${await pxAt(f, 3.9, 20, 90)} / ${await pxAt(f, 3.9, 200, 90)}`);

  // ---- render: multi-keyframe (two segments, returns) ------------------------
  const multiProj = mkProject({ clips: [mkClip('c0', RED, 4, { position: lin3 })] });
  await exp(multiProj, 'kf-e-multi.mp4');
  const mf = `${DIR}kf-e-multi.mp4`;
  check('render multi: t=1 segment 1 centre (full red)', isRed(await pxAt(mf, 1, 300, 90)) && isRed(await pxAt(mf, 1, 20, 90)));
  check('render multi: t=2 key 2 right (left black)', isBlack(await pxAt(mf, 2, 20, 90)) && isRed(await pxAt(mf, 2, 200, 90)));
  check('render multi: t=3 segment 2 centre (full red)', isRed(await pxAt(mf, 3, 300, 90)) && isRed(await pxAt(mf, 3, 20, 90)));

  // ---- render: hold (step at t=2) -------------------------------------------
  const holdOut = 'kf-e-hold.mp4';
  await exp(mkProject({ clips: [mkClip('c0', RED, 4, { position: [{ t: 0, x: 0.25, y: 0.5 }, { t: 2, x: 0.75, y: 0.5 }], positionInterpolation: 'hold' })] }), holdOut);
  const hf = `${DIR}${holdOut}`;
  check('render hold: t=1.9 still at start (right black)', isBlack(await pxAt(hf, 1.9, 300, 90)) && isRed(await pxAt(hf, 1.9, 100, 90)));
  check('render hold: t=2.1 jumped to end (left black)', isBlack(await pxAt(hf, 2.1, 20, 90)) && isRed(await pxAt(hf, 2.1, 200, 90)));

  // ---- render: smooth (eased, lags linear mid-segment) -----------------------
  const smoothOut = 'kf-e-smooth.mp4';
  await exp(mkProject({ clips: [mkClip('c0', RED, 4, { position: lin2, positionInterpolation: 'smooth' })] }), smoothOut);
  const sf = `${DIR}${smoothOut}`;
  // At t=1 smooth cx=0.328, right edge 265: (270,90) black. Linear at the
  // same time would be cx=0.375, right edge 280: (270,90) red. So this
  // pixel separates the two modes.
  check('render smooth: t=1 lags linear (270,90 black)', isBlack(await pxAt(sf, 1, 270, 90)), `${await pxAt(sf, 1, 270, 90)}`);
  check('render smooth: t=2 midpoint full red', isRed(await pxAt(sf, 2, 300, 90)) && isRed(await pxAt(sf, 2, 20, 90)));

  // ---- render: vertical move + out-of-range clamp + static offset ------------
  const vertOut = 'kf-e-vert.mp4';
  await exp(mkProject({ clips: [mkClip('c0', RED, 4, { position: [{ t: 0, x: 0.5, y: 0.25 }, { t: 4, x: 0.5, y: 0.75 }] })] }), vertOut);
  const vf = `${DIR}${vertOut}`;
  check('render vertical: t=0.1 top red, bottom black', isRed(await pxAt(vf, 0.1, 160, 60)) && isBlack(await pxAt(vf, 0.1, 160, 150)));
  check('render vertical: t=3.9 top black, bottom red', isBlack(await pxAt(vf, 3.9, 160, 20)) && isRed(await pxAt(vf, 3.9, 160, 150)));

  const clampOut = 'kf-e-clamp.mp4';
  await exp(mkProject({ clips: [mkClip('c0', RED, 4, { position: late })] }), clampOut);
  const cf = `${DIR}${clampOut}`;
  check('render clamp: t=0.1 holds first key (right black)', isBlack(await pxAt(cf, 0.1, 300, 90)) && isRed(await pxAt(cf, 0.1, 100, 90)));
  check('render clamp: t=3.9 holds last key (left black)', isBlack(await pxAt(cf, 3.9, 20, 90)) && isRed(await pxAt(cf, 3.9, 200, 90)));

  const staticOut = 'kf-e-static.mp4';
  await exp(mkProject({ clips: [mkClip('c0', RED, 4, { position: [{ t: 0, x: 0.75, y: 0.5 }] })] }), staticOut);
  const stf = `${DIR}${staticOut}`;
  check('render static: single key offsets whole clip', isBlack(await pxAt(stf, 2, 20, 90)) && isRed(await pxAt(stf, 2, 200, 90)));

  // ---- regression: no-position export is frame-identical ----------------------
  await exp(baseProj, 'kf-e-nopos.mp4');
  const psnr = await psnrAverage(`${DIR}${linOut}`, `${DIR}kf-e-nopos.mp4`);
  check('regression: position export differs from no-position (not identical)', psnr !== Infinity && psnr !== null && psnr < 40, `psnr ${psnr}`);
  const ctrlOut = 'kf-e-ctrl.mp4';
  await exp(mkProject({ clips: [mkClip('c0', RED, 4, { position: [{ t: 0, x: 0.5, y: 0.5 }] })] }), ctrlOut);
  const psnr2 = await psnrAverage(`${DIR}kf-e-nopos.mp4`, `${DIR}${ctrlOut}`);
  check('regression: all-centre single key is frame-identical to no position', psnr2 === Infinity, `psnr ${psnr2}`);

  // ---- combined with opacity (smoke: no crash, duration right) ----------------
  const comboRep = await exp(mkProject({ clips: [mkClip('c0', RED, 4, { position: lin2, opacity: [{ t: 0, value: 1 }, { t: 4, value: 1 }] })] }), 'kf-e-combo.mp4');
  check('combined position + opacity exports', close(comboRep.actual.duration, 4, 0.05), comboRep.actual.duration.toFixed(3));
}

await main();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} passed`);
for (const [name, ok] of checks) if (!ok) console.log(`FAIL: ${name}`);
if (passed !== checks.length) process.exit(1);
