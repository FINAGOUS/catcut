// Multitrack engine verification (true multi-track rewrite).
// Covers: src/multitrack.ts (track model, validation, legacy
// conversion, flattening, mute/solo), the multitrack branch of
// src/filtergraph.ts (per-track concat/xfade assembly, overlay /
// blend compositing, amix audio, cross-track arrivals) and the
// multitrack export path in src/export.ts (flat prep, proxy rule
// unchanged, legacy regression).
//
// Measurement method (probe-mt.mjs + probe-diss.mjs ran BEFORE
// writing assertions — every number below was measured first):
// - Fixtures are solid-colour videos (ffmpeg colour red=(255,0,0),
//   green=(0,128,0), blue=(0,0,255)) with sine audio (440/880/
//   1320 Hz, amp 0.5, mono WAV muxed to AAC).
// - PiP (w=0.5,h=0.5 at 160,90 on 320x180): corners stay red,
//   (200,120) and (300,170) read green (0,127,0).
// - Track opacity 0.5 green-over-red reads (125,61,0) — i.e.
//   (255*0.5, 128*0.5, 0) within YUV rounding.
// - Blend multiply red-over-green reads (0,0,0) (RGB via gbrp;
//   on yuv420p planes the same blend read (0,89,0)).
// - amix normalize=0: two simultaneous tones read +3.02 dB over
//   one tone (-3.03 vs -6.05 with the suite's -ac 1 RMS window;
//   the absolute level carries a +3.02 dB stereo->mono downmix
//   normalisation, so level assertions are RELATIVE).
// - Dissolve 1 s green-over-red: t=0.2 (202,23,0), t=0.9
//   (25,114,0) — the alpha ramp tracks the transition.
// - Legacy regression: legacy 2-clip projects (cut, dissolve,
//   fadeblack) vs normalizeToTracks exports are frame-identical,
//   PSNR average inf on all three (video; the audio walk mirrors
//   the legacy acrossfade/concat walk).
// - Digital silence measures ~-91 dB with volumedetect-style RMS
//   windows, NOT -inf — "muted" asserts use < -60 dB (roles.ts).
// - New filters here (concat/xfade/acrossfade/geq/fade/overlay/
//   blend/colorchannelmixer/apad/amix/pan/volume, anullsrc, color
//   black@0) are native libavfilter — only verified on the local
//   GPL 8.1.2 build; re-check each on the BtbN LGPL 9.0 build at
//   the M2 gate.
// Old M1 / P0 / P0b / P1 / P1b / P1c / P1d / P1e / P2a / P2b / P2c /
// P3a / P3b / P3c / P3d / P3e / P3f / P3g checks live in their own
// files and must still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import {
  exportProject,
  flattenProject,
  flatClips,
  hasTracks,
  normalizeToTracks,
  PRESETS,
  probe,
  projectDuration,
  resolveAudioTrackMute,
  validateMultitrackProject,
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
const throwsAsync = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return re.test(e.message); }
};
const close = (v, target, tol) => v !== null && Math.abs(v - target) <= tol;
async function pxAt(file, ss, x, y) {
  const r = await run('ffmpeg', ['-ss', String(ss), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const o = (y * 320 + x) * 3;
  return [r.stdout[o], r.stdout[o + 1], r.stdout[o + 2]];
}
async function rmsWindow(file, ss, dur) {
  const r = await run('ffmpeg', ['-v', 'error', '-ss', String(ss), '-i', file, '-t', String(dur),
    '-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-']).catch((e) => e);
  const buf = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? '', 'binary');
  const s = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  if (s.length === 0) return -240;
  let e = 0; for (const v of s) e += v * v;
  return 20 * Math.log10(Math.sqrt(e / s.length) + 1e-12);
}
/** Per-channel RMS (stereo decode, no downmix) — pan checks. */
async function rmsStereo(file, ss, dur) {
  const r = await run('ffmpeg', ['-v', 'error', '-ss', String(ss), '-i', file, '-t', String(dur),
    '-map', '0:a:0', '-f', 'f32le', '-ac', '2', '-ar', '48000', '-']).catch((e) => e);
  const buf = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? '', 'binary');
  const s = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  let el = 0, er = 0; const n = Math.floor(s.length / 2);
  for (let i = 0; i < n; i++) { el += s[i * 2] ** 2; er += s[i * 2 + 1] ** 2; }
  if (n === 0) return [-240, -240];
  return [
    20 * Math.log10(Math.sqrt(el / n) + 1e-12),
    20 * Math.log10(Math.sqrt(er / n) + 1e-12),
  ];
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
const mt = (video, audio = []) => mkProject({ tracks: { video, audio } });
const vtrack = (id, clips, extra = {}) => ({ id, clips, ...extra });
const atrack = (id, clips, extra = {}) => ({ id, clips, ...extra });
const tclip = (clip, start, extra = {}) => ({ ...clip, start, ...extra });

async function main() {
  synthWav(`${DIR}mt-440.wav`, 4, 440);
  synthWav(`${DIR}mt-880.wav`, 4, 880);
  synthWav(`${DIR}mt-1320.wav`, 4, 1320);
  await muxVideo('red', `${DIR}mt-440.wav`, 4, `${DIR}mt-red.mp4`);
  await muxVideo('green', `${DIR}mt-880.wav`, 4, `${DIR}mt-green.mp4`);
  await muxVideo('blue', `${DIR}mt-1320.wav`, 4, `${DIR}mt-blue.mp4`);
  const RED = `${DIR}mt-red.mp4`;
  const GREEN = `${DIR}mt-green.mp4`;
  const BLUE = `${DIR}mt-blue.mp4`;

  // ------------------------------------------------------------------
  // Model: legacy conversion + durations
  // ------------------------------------------------------------------
  const legacy2 = mkProject({
    clips: [mkClip('c0', RED, 2), mkClip('c1', GREEN, 2)],
    transitions: ['cut'],
  });
  const norm2 = normalizeToTracks(legacy2);
  check('normalize cut: starts [0,2]', JSON.stringify(norm2.tracks.video[0].clips.map((c) => c.start)) === '[0,2]');
  check('normalize cut: no transitionIn', norm2.tracks.video[0].clips.every((c) => c.transitionIn === undefined));
  check('normalize cut: duration preserved', close(projectDuration(norm2), 4, 0.001));
  check('normalize cut: transitions neutralised', JSON.stringify(norm2.transitions) === '["cut"]');
  check('normalize cut: legacy clips kept', norm2.clips.length === 2);

  const legacyD = mkProject({
    clips: [mkClip('c0', RED, 2), mkClip('c1', GREEN, 2)],
    transitions: ['dissolve'],
  });
  const normD = normalizeToTracks(legacyD);
  check('normalize dissolve: starts [0,1.5]', JSON.stringify(normD.tracks.video[0].clips.map((c) => c.start)) === '[0,1.5]');
  check('normalize dissolve: transitionIn dissolve/0.5',
    normD.tracks.video[0].clips[1].transitionIn?.type === 'dissolve' &&
    normD.tracks.video[0].clips[1].transitionIn?.duration === 0.5);
  check('normalize dissolve: duration 3.5', close(projectDuration(normD), 3.5, 0.001));
  check('normalize: hasTracks true', hasTracks(normD) === true);
  check('normalize: legacy hasTracks false', hasTracks(legacyD) === false);

  const legacy3 = mkProject({
    clips: [mkClip('c0', RED, 2), mkClip('c1', GREEN, 2), mkClip('c2', BLUE, 2)],
    transitions: ['cut', 'dissolve'],
  });
  const norm3 = normalizeToTracks(legacy3);
  check('normalize 3 clips: starts [0,2,3.5]',
    JSON.stringify(norm3.tracks.video[0].clips.map((c) => c.start)) === '[0,2,3.5]');
  check('normalize 3 clips: duration 5.5', close(projectDuration(norm3), 5.5, 0.001));

  check('duration: multitrack = max video end',
    close(projectDuration(mt([
      vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)]),
      vtrack('v1', [tclip(mkClip('c1', GREEN, 3), 1)]),
    ])), 4, 0.001));
  check('duration: audio-only project from audio tracks',
    close(projectDuration(mt([], [
      atrack('a0', [tclip(mkClip('c0', RED, 3), 0.5)]),
    ])), 3.5, 0.001));
  check('duration: legacy overlap formula unchanged',
    close(projectDuration(legacyD), 3.5, 0.001));
  check('duration: empty video track contributes nothing',
    close(projectDuration(mt([
      vtrack('v0', []),
      vtrack('v1', [tclip(mkClip('c1', GREEN, 2), 0)]),
    ])), 2, 0.001));

  // ------------------------------------------------------------------
  // Model: validation (bad tracks / times rejected)
  // ------------------------------------------------------------------
  const bad = (mut) => {
    const p = mt([vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)])]);
    mut(p);
    return p;
  };
  check('validate: negative start rejected',
    throwsSync(() => validateMultitrackProject(bad((p) => { p.tracks.video[0].clips[0].start = -1; })), /start/));
  check('validate: NaN start rejected',
    throwsSync(() => validateMultitrackProject(bad((p) => { p.tracks.video[0].clips[0].start = NaN; })), /start/));
  check('validate: opacity 1.5 rejected',
    throwsSync(() => validateMultitrackProject(bad((p) => { p.tracks.video[0].opacity = 1.5; })), /opacity/));
  check('validate: opacity -0.1 rejected',
    throwsSync(() => validateMultitrackProject(bad((p) => { p.tracks.video[0].opacity = -0.1; })), /opacity/));
  check('validate: unknown blend rejected',
    throwsSync(() => validateMultitrackProject(bad((p) => { p.tracks.video[0].blend = 'xor'; })), /blend mode/));
  check('validate: blend + offset rejected',
    throwsSync(() => validateMultitrackProject(bad((p) => { p.tracks.video[0].blend = 'multiply'; p.tracks.video[0].x = 10; })), /blend mode/));
  check('validate: blend + scale rejected',
    throwsSync(() => validateMultitrackProject(bad((p) => { p.tracks.video[0].blend = 'multiply'; p.tracks.video[0].w = 0.5; })), /blend mode/));
  check('validate: gainDb 13 rejected',
    throwsSync(() => validateMultitrackProject(mt([], [atrack('a0', [tclip(mkClip('c0', RED, 2), 0)], { gainDb: 13 })])), /gainDb/));
  check('validate: pan 1.5 rejected',
    throwsSync(() => validateMultitrackProject(mt([], [atrack('a0', [tclip(mkClip('c0', RED, 2), 0)], { pan: 1.5 })])), /pan/));
  check('validate: wipe over lower tracks rejected',
    throwsSync(() => validateMultitrackProject(mt([
      vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)]),
      vtrack('v1', [tclip(mkClip('c1', GREEN, 2), 0, { transitionIn: { type: 'wipeleft', duration: 0.5 } })]),
    ])), /not supported over lower tracks/));
  check('validate: wipe WITH same-track overlap allowed',
    (() => {
      try {
        validateMultitrackProject(mt([
          vtrack('v0', [
            tclip(mkClip('c0', RED, 2), 0),
            tclip(mkClip('c1', GREEN, 2), 1.5, { transitionIn: { type: 'wipeleft', duration: 0.5 } }),
          ]),
        ]));
        return true;
      } catch { return false; }
    })());
  check('validate: transitionIn duration > clip rejected',
    throwsSync(() => validateMultitrackProject(mt([
      vtrack('v0', [tclip(mkClip('c0', RED, 2), 0, { transitionIn: { type: 'dissolve', duration: 3 } })]),
    ])), /transitionIn duration/));
  check('validate: transitionIn duration 0 rejected',
    throwsSync(() => validateMultitrackProject(mt([
      vtrack('v0', [tclip(mkClip('c0', RED, 2), 0, { transitionIn: { type: 'dissolve', duration: 0 } })]),
    ])), /transitionIn duration/));
  check('validate: transitionIn duration > overlap rejected',
    throwsSync(() => validateMultitrackProject(mt([
      vtrack('v0', [
        tclip(mkClip('c0', RED, 2), 0),
        tclip(mkClip('c1', GREEN, 2), 1.5, { transitionIn: { type: 'dissolve', duration: 1 } }),
      ]),
    ])), /same-track overlap/));
  check('validate: duplicate track id rejected',
    throwsSync(() => validateMultitrackProject(mt([
      vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)]),
      vtrack('v0', [tclip(mkClip('c1', GREEN, 2), 0)]),
    ])), /duplicate track id/));
  check('validate: empty track id rejected',
    throwsSync(() => validateMultitrackProject(mt([vtrack('', [tclip(mkClip('c0', RED, 2), 0)])])), /non-empty string id/));
  check('validate: legacy non-cut transitions + tracks rejected',
    throwsSync(() => validateMultitrackProject(mkProject({
      clips: [mkClip('c0', RED, 2)],
      transitions: ['dissolve'],
      tracks: { video: [vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)])], audio: [] },
    })), /legacy transitions/));
  check('validate: empty track + gap project accepted',
    (() => {
      try {
        validateMultitrackProject(mt([
          vtrack('v0', []),
          vtrack('v1', [tclip(mkClip('c1', GREEN, 2), 1)]),
        ]));
        return true;
      } catch { return false; }
    })());
  check('validate: legacy project always passes',
    (() => {
      try { validateMultitrackProject(legacy2); return true; } catch { return false; }
    })());

  // ------------------------------------------------------------------
  // Model: flattening + mute/solo
  // ------------------------------------------------------------------
  const flatP = mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 2), 0)]),
  ], [
    atrack('a0', [tclip(mkClip('c2', BLUE, 2), 0), tclip(mkClip('c3', RED, 2), 2)]),
  ]);
  const flat = flattenProject(flatP);
  check('flatten: 4 occurrences in video-then-audio order',
    flat.length === 4 &&
    flat.map((f) => `${f.kind}:${f.globalIndex}`).join(',') === 'video:0,video:1,audio:2,audio:3');
  check('flatten: track ids carried',
    flat[2].trackId === 'a0' && flat[3].clipIndex === 1);
  check('flatten: legacy = clip list',
    flattenProject(legacy2).length === 2 &&
    flattenProject(legacy2).every((f) => f.kind === 'video'));
  check('flatClips: same order as flatten',
    flatClips(flatP).map((c) => c.id).join(',') === 'c0,c1,c2,c3');

  const muteP = mt([], [
    atrack('a0', [tclip(mkClip('c0', RED, 2), 0)]),
    atrack('a1', [tclip(mkClip('c1', GREEN, 2), 0)], { solo: true }),
  ]);
  const mutes = resolveAudioTrackMute(muteP);
  check('mute/solo: solo mutes the other track', mutes.get('a0') === true && mutes.get('a1') === false);
  const muteP2 = mt([], [
    atrack('a0', [tclip(mkClip('c0', RED, 2), 0)], { mute: true }),
    atrack('a1', [tclip(mkClip('c1', GREEN, 2), 0)]),
  ]);
  const mutes2 = resolveAudioTrackMute(muteP2);
  check('mute/solo: explicit mute without solo', mutes2.get('a0') === true && mutes2.get('a1') === false);

  // ------------------------------------------------------------------
  // Graph strings (pure buildFilterGraph, no ffmpeg run)
  // ------------------------------------------------------------------
  const gPip = buildFilterGraph(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 4), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 4), 0)], { w: 0.5, h: 0.5, x: 160, y: 90 }),
  ]), FONT);
  check('graph: PiP track scaled + overlaid at x/y',
    gPip.filterComplex.includes('scale=160:90') && gPip.filterComplex.includes('overlay=x=160:y=90'));
  check('graph: transparent gaps via black@0',
    buildFilterGraph(mt([
      vtrack('v0', [tclip(mkClip('c0', RED, 2), 1)]),
    ]), FONT).filterComplex.includes('color=c=black@0'));
  const gMul = buildFilterGraph(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 4), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 4), 0)], { blend: 'multiply' }),
  ]), FONT);
  check('graph: multiply goes through gbrp blend',
    gMul.filterComplex.includes('blend=all_mode=multiply') && gMul.filterComplex.includes('format=gbrp'));
  const gMute = buildFilterGraph(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)]),
  ], [
    atrack('a0', [tclip(mkClip('c1', GREEN, 2), 0)], { mute: true }),
  ]), FONT);
  check('graph: muted audio track gets volume=0', gMute.filterComplex.includes('volume=0'));
  check('graph: audio mix is amix normalize=0',
    gMute.filterComplex.includes('amix=inputs=2:duration=first:normalize=0'));
  const gDiss = buildFilterGraph(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 4), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 4), 0, { transitionIn: { type: 'dissolve', duration: 1 } })]),
  ]), FONT);
  check('graph: cross-track dissolve is a geq alpha ramp',
    gDiss.filterComplex.includes("a='p(X,Y)*min(1,max(0,T/1))'"));
  const gFb = buildFilterGraph(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 4), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 4), 0, { transitionIn: { type: 'fadeblack', duration: 1 } })]),
  ]), FONT);
  check('graph: cross-track fadeblack is an RGB fade from black',
    gFb.filterComplex.includes('fade=t=in:st=0:d=1:color=black'));
  const gXfade = buildFilterGraph(mt([
    vtrack('v0', [
      tclip(mkClip('c0', RED, 2), 0),
      tclip(mkClip('c1', GREEN, 2), 1.5, { transitionIn: { type: 'dissolve', duration: 0.5 } }),
    ]),
  ]), FONT);
  check('graph: same-track overlap uses xfade',
    gXfade.filterComplex.includes('xfade=transition=dissolve:duration=0.5:offset=1.5'));
  const gGain = buildFilterGraph(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)]),
  ], [
    atrack('a0', [tclip(mkClip('c1', GREEN, 2), 0)], { gainDb: -6, pan: -1 }),
  ]), FONT);
  check('graph: track gain -6dB + pan -1',
    gGain.filterComplex.includes('volume=-6dB') && gGain.filterComplex.includes('pan=stereo|c0=1*c0|c1=0*c1'));
  const gOp = buildFilterGraph(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 2, { opacity: [{ t: 0, value: 0 }, { t: 2, value: 1 }] }), 0)]),
  ]), FONT);
  check('graph: multitrack clip opacity is a geq alpha ramp',
    gOp.filterComplex.includes("a='p(X,Y)*("));
  const gOpLegacy = buildFilterGraph(mkProject({
    clips: [mkClip('c0', RED, 2, { opacity: [{ t: 0, value: 0 }, { t: 2, value: 1 }] })],
    transitions: [],
  }), FONT);
  check('graph: legacy clip opacity still fades to black (blend)',
    gOpLegacy.filterComplex.includes("blend=all_expr='A*(") &&
    !gOpLegacy.filterComplex.includes("a='p(X,Y)*("));
  const gEmpty = buildFilterGraph(mt([], [
    atrack('a0', [tclip(mkClip('c0', RED, 2), 0)]),
  ]), FONT);
  check('graph: no video tracks still yields a black canvas',
    gEmpty.filterComplex.includes('color=c=black:s=320x180'));
  check('graph: roleStems + multitrack throws',
    throwsSync(() => buildFilterGraph(mt([
      vtrack('v0', [tclip(mkClip('c0', RED, 2, { role: 'music' }), 0)]),
    ]), FONT, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true),
    /roleStems is not supported on multitrack/));

  // ------------------------------------------------------------------
  // Render: video compositing
  // ------------------------------------------------------------------
  const exp = (p, out) => exportProject(p, `${DIR}${out}`, { fontfile: FONT, preset: PRESETS['720p30'] });

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 4), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 4), 0)], { w: 0.5, h: 0.5, x: 160, y: 90 }),
  ]), 'mt-v-pip.mp4');
  let px = await pxAt(`${DIR}mt-v-pip.mp4`, 1, 10, 10);
  check('render PiP: top-left stays red', px[0] > 200 && px[1] < 50, px.join(','));
  px = await pxAt(`${DIR}mt-v-pip.mp4`, 1, 300, 170);
  check('render PiP: inside box is green', px[1] > 100 && px[0] < 50, px.join(','));
  px = await pxAt(`${DIR}mt-v-pip.mp4`, 1, 10, 170);
  check('render PiP: bottom-left stays red', px[0] > 200 && px[1] < 50, px.join(','));

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 4), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 4), 0)], { opacity: 0.5 }),
  ]), 'mt-v-op.mp4');
  px = await pxAt(`${DIR}mt-v-op.mp4`, 1, 160, 90);
  check('render opacity 0.5: ~(125,61,0)', close(px[0], 125, 10) && close(px[1], 61, 10) && px[2] < 10, px.join(','));

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 4), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 4), 0)], { blend: 'multiply' }),
  ]), 'mt-v-mul.mp4');
  px = await pxAt(`${DIR}mt-v-mul.mp4`, 1, 160, 90);
  check('render multiply: black', px[0] < 8 && px[1] < 8 && px[2] < 8, px.join(','));

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 4), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 4), 0)], { blend: 'screen' }),
  ]), 'mt-v-screen.mp4');
  px = await pxAt(`${DIR}mt-v-screen.mp4`, 1, 160, 90);
  check('render screen: ~(255,128,0)', close(px[0], 255, 10) && close(px[1], 128, 10) && px[2] < 10, px.join(','));

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 2), 2)]),
  ]), 'mt-v-gap.mp4');
  px = await pxAt(`${DIR}mt-v-gap.mp4`, 1, 160, 90);
  check('render gap: t=1 red (lower track)', px[0] > 200 && px[1] < 50, px.join(','));
  px = await pxAt(`${DIR}mt-v-gap.mp4`, 3, 160, 90);
  check('render gap: t=3 green (upper track)', px[1] > 100 && px[0] < 50, px.join(','));

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2), 1)]),
  ]), 'mt-v-headgap.mp4');
  px = await pxAt(`${DIR}mt-v-headgap.mp4`, 0.5, 160, 90);
  check('render head gap: t=0.5 black', px[0] < 8 && px[1] < 8 && px[2] < 8, px.join(','));
  px = await pxAt(`${DIR}mt-v-headgap.mp4`, 2, 160, 90);
  check('render head gap: t=2 red', px[0] > 200, px.join(','));

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 4), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 4), 0, { transitionIn: { type: 'dissolve', duration: 1 } })]),
  ]), 'mt-v-diss.mp4');
  px = await pxAt(`${DIR}mt-v-diss.mp4`, 0.2, 160, 90);
  check('render dissolve: t=0.2 mostly red', px[0] > 150 && px[1] < 60, px.join(','));
  px = await pxAt(`${DIR}mt-v-diss.mp4`, 0.9, 160, 90);
  check('render dissolve: t=0.9 mostly green', px[0] < 60 && px[1] > 90, px.join(','));
  px = await pxAt(`${DIR}mt-v-diss.mp4`, 2, 160, 90);
  check('render dissolve: t=2 green', px[1] > 100 && px[0] < 50, px.join(','));

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 4), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 4), 0, { transitionIn: { type: 'fadeblack', duration: 1 } })]),
  ]), 'mt-v-fb.mp4');
  px = await pxAt(`${DIR}mt-v-fb.mp4`, 0.25, 160, 90);
  check('render fadeblack: t=0.25 dark', px[0] < 80 && px[1] < 80, px.join(','));
  px = await pxAt(`${DIR}mt-v-fb.mp4`, 2, 160, 90);
  check('render fadeblack: t=2 green', px[1] > 100 && px[0] < 50, px.join(','));

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 2, { opacity: [{ t: 0, value: 0 }, { t: 2, value: 1 }] }), 0)]),
  ]), 'mt-v-clipop.mp4');
  px = await pxAt(`${DIR}mt-v-clipop.mp4`, 0.5, 160, 90);
  check('render clip opacity: t=0.5 mostly red', px[0] > 180 && px[1] < 40, px.join(','));
  px = await pxAt(`${DIR}mt-v-clipop.mp4`, 1.5, 160, 90);
  check('render clip opacity: t=1.5 mostly green', px[1] > 90 && px[0] < 80, px.join(','));

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 4), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 4), 0)], { visible: false }),
  ]), 'mt-v-invis.mp4');
  px = await pxAt(`${DIR}mt-v-invis.mp4`, 1, 160, 90);
  check('render invisible track: all red', px[0] > 200 && px[1] < 50, px.join(','));

  await exp(mt([
    vtrack('v0', []),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 2), 0)]),
  ]), 'mt-v-empty.mp4');
  const emptyProbe = await probe(`${DIR}mt-v-empty.mp4`);
  check('render empty video track: export succeeds, duration 2',
    close(emptyProbe.duration, 2, 0.05), emptyProbe.duration.toFixed(3));
  px = await pxAt(`${DIR}mt-v-empty.mp4`, 1, 160, 90);
  check('render empty video track: frame is green (only v1)', px[1] > 100 && px[0] < 50, px.join(','));

  // ------------------------------------------------------------------
  // Render: audio mixing
  // ------------------------------------------------------------------
  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)]),
  ], [
    atrack('a0', [tclip(mkClip('c1', GREEN, 2), 0)]),
  ]), 'mt-a-both.mp4');
  const rmsBoth = await rmsWindow(`${DIR}mt-a-both.mp4`, 0.5, 1);
  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)]),
  ]), 'mt-a-single.mp4');
  const rmsSingle = await rmsWindow(`${DIR}mt-a-single.mp4`, 0.5, 1);
  check('render amix: two tones +3.0dB over one', close(rmsBoth - rmsSingle, 3.0, 0.5), `${rmsBoth.toFixed(2)} vs ${rmsSingle.toFixed(2)}`);

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)]),
  ], [
    atrack('a0', [tclip(mkClip('c1', GREEN, 2), 0)], { mute: true }),
  ]), 'mt-a-muted.mp4');
  const rmsMuted = await rmsWindow(`${DIR}mt-a-muted.mp4`, 0.5, 1);
  check('render mute: muted track adds nothing', close(rmsMuted, rmsSingle, 0.5), `${rmsMuted.toFixed(2)} vs ${rmsSingle.toFixed(2)}`);

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2, { volume: 0 }), 0)]),
  ], [
    atrack('a0', [tclip(mkClip('c1', GREEN, 2), 0)]),
    atrack('a1', [tclip(mkClip('c2', BLUE, 2), 0)], { solo: true }),
  ]), 'mt-a-solo.mp4');
  const rmsSolo = await rmsWindow(`${DIR}mt-a-solo.mp4`, 0.5, 1);
  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2, { volume: 0 }), 0)]),
  ], [
    atrack('a1', [tclip(mkClip('c2', BLUE, 2), 0)]),
  ]), 'mt-a-soloctrl.mp4');
  const rmsSoloCtrl = await rmsWindow(`${DIR}mt-a-soloctrl.mp4`, 0.5, 1);
  check('render solo: only the solo track sounds', close(rmsSolo, rmsSoloCtrl, 0.5), `${rmsSolo.toFixed(2)} vs ${rmsSoloCtrl.toFixed(2)}`);
  check('render solo: solo is quieter than both tracks mixed', rmsSolo < rmsBoth - 2, `${rmsSolo.toFixed(2)} vs ${rmsBoth.toFixed(2)}`);

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2, { volume: 0 }), 0)]),
  ], [
    atrack('a0', [tclip(mkClip('c1', GREEN, 2), 0)], { gainDb: -6 }),
  ]), 'mt-a-gain.mp4');
  const rmsGain = await rmsWindow(`${DIR}mt-a-gain.mp4`, 0.5, 1);
  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2, { volume: 0 }), 0)]),
  ], [
    atrack('a0', [tclip(mkClip('c1', GREEN, 2), 0)]),
  ]), 'mt-a-gainctrl.mp4');
  const rmsGainCtrl = await rmsWindow(`${DIR}mt-a-gainctrl.mp4`, 0.5, 1);
  check('render gain: -6dB track is 6dB quieter', close(rmsGainCtrl - rmsGain, 6.0, 0.7), `${rmsGainCtrl.toFixed(2)} vs ${rmsGain.toFixed(2)}`);

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2, { volume: 0 }), 0)]),
  ], [
    atrack('a0', [tclip(mkClip('c1', GREEN, 2), 0)], { pan: -1 }),
  ]), 'mt-a-pan.mp4');
  const [panL, panR] = await rmsStereo(`${DIR}mt-a-pan.mp4`, 0.5, 1);
  check('render pan -1: right channel silent', panR < -60, `L ${panL.toFixed(1)} R ${panR.toFixed(1)}`);
  // Left channel compared against the CONTROL's left channel (same
  // stereo decode): the -ac 1 mono window adds +3.02 dB of downmix
  // normalisation and is not a valid baseline here.
  const [ctrlL] = await rmsStereo(`${DIR}mt-a-gainctrl.mp4`, 0.5, 1);
  check('render pan -1: left channel keeps level', close(panL, ctrlL, 1.0), `L ${panL.toFixed(1)} vs ${ctrlL.toFixed(1)}`);

  await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2, { volume: 0 }), 0)]),
  ], [
    atrack('a0', [tclip(mkClip('c1', GREEN, 2), 1)]),
  ]), 'mt-a-gap.mp4');
  const rmsGapEarly = await rmsWindow(`${DIR}mt-a-gap.mp4`, 0.2, 0.6);
  const rmsGapLate = await rmsWindow(`${DIR}mt-a-gap.mp4`, 1.5, 1);
  check('render audio gap: silence before the clip', rmsGapEarly < -60, rmsGapEarly.toFixed(1));
  check('render audio gap: tone after the clip starts', close(rmsGapLate, rmsGainCtrl, 1.0), rmsGapLate.toFixed(1));

  // ------------------------------------------------------------------
  // Render: export duration + legacy regression + guards
  // ------------------------------------------------------------------
  const rep3 = await exp(mt([
    vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)]),
    vtrack('v1', [tclip(mkClip('c1', GREEN, 2), 1)]),
  ]), 'mt-e-dur.mp4');
  check('export duration: 3s project within 0.05s',
    close(rep3.actual.duration, 3, 0.05) && close(rep3.durationError, 0, 0.05),
    `actual ${rep3.actual.duration.toFixed(3)} expected ${rep3.expectedDuration.toFixed(3)}`);

  for (const [name, trans] of [['cut', 'cut'], ['dissolve', 'dissolve'], ['fadeblack', 'fadeblack'], ['wipeleft', 'wipeleft']]) {
    const leg = mkProject({
      clips: [mkClip('c0', RED, 2), mkClip('c1', GREEN, 2)],
      transitions: [trans],
    });
    await exp(leg, `mt-e-leg-${name}.mp4`);
    await exp(normalizeToTracks(leg), `mt-e-mt-${name}.mp4`);
    const psnr = await psnrAverage(`${DIR}mt-e-leg-${name}.mp4`, `${DIR}mt-e-mt-${name}.mp4`);
    check(`legacy regression ${name}: PSNR inf (frame-identical)`, psnr === Infinity, `psnr ${psnr}`);
    const lp = await probe(`${DIR}mt-e-leg-${name}.mp4`);
    const mp = await probe(`${DIR}mt-e-mt-${name}.mp4`);
    check(`legacy regression ${name}: durations equal`, close(lp.duration, mp.duration, 0.02), `${lp.duration.toFixed(3)} vs ${mp.duration.toFixed(3)}`);
  }

  // Single-track legacy export still works end to end (no tracks).
  const repLeg = await exp(legacy2, 'mt-e-legacy.mp4');
  check('legacy export still works (no tracks)', close(repLeg.actual.duration, 4, 0.05), repLeg.actual.duration.toFixed(3));

  check('export guard: silenceCut + multitrack throws',
    await (async () => {
      try {
        await exportProject(
          { ...mt([vtrack('v0', [tclip(mkClip('c0', RED, 2), 0)])]), silenceCut: { mode: 'delete' } },
          `${DIR}mt-e-x.mp4`, { fontfile: FONT, preset: PRESETS['720p30'] });
        return false;
      } catch (e) { return /not supported on multitrack/.test(e.message); }
    })());
  check('export guard: roleStems + multitrack throws',
    await (async () => {
      try {
        await exportProject(
          mt([vtrack('v0', [tclip(mkClip('c0', RED, 2, { role: 'music' }), 0)])]),
          `${DIR}mt-e-x2.mp4`, { fontfile: FONT, preset: PRESETS['720p30'], roleStems: true });
        return false;
      } catch (e) { return /roleStems is not supported on multitrack/.test(e.message); }
    })());
}

await main();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} passed`);
for (const [name, ok] of checks) if (!ok) console.log(`FAIL: ${name}`);
if (passed !== checks.length) process.exit(1);
