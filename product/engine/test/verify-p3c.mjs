// P3 batch 3 engine verification (M4 §8.5 + direction doc §七, 2026-11-18).
// Covers: src/deliver.ts — dual subtitles (ASS two styles + two-layer
// drawtext), subtitle sidecars (SRT/VTT/ASS), export preset management
// (validate/serialise/store, 8K preset), HDR<->SDR (hable tonemap,
// pseudo-HDR lift), export-only switches (video/audio/subtitle),
// batch export queue — wired into project.ts (fields), filtergraph.ts
// (HDR filter at the end of the video chain) and export.ts (encoder
// plan, sidecar format, subtitle-only early path).
//
// Measurement method (probe tmp/probe-p3c.mjs v2 ran BEFORE writing
// assertions; numbers below are its measurements, not guesses):
// - zscale constants are smpte2084 / 2020_ncl. Explicit pin/min/tin on
//   the first zscale are REQUIRED (unknown primaries/transfer -> "no
//   path between colorspaces"). HDR sources are built as RAW PQ codes
//   in node and tagged with setparams (libx265 VUI follows FRAME
//   properties; encoder flags alone do not stick).
// - Tonemap curve on constant-nit PQ patches (64x36, gray mean):
//   naive (raw PQ codes as SDR) 10->76, 50->112, 100->129, 200->147;
//   hable 10->10, 50->45, 100->115, 200->200, 500/1000->255. Span:
//   naive 71 (76..147), hable 190 (10..200). Assertions use ranges
//   around these measured values, not the exact numbers.
// - Dual ASS bands (640x360, primary fontsize 28 marginV 20,
//   secondary fontsize 24 marginV 62): primary y310-345 frac 0.0583,
//   secondary y270-300 frac 0.0389, gap y300-310 frac 0, control
//   y100-150 frac 0. The export path uses fontsize = max(24,
//   round(height*0.055)) = 24 at 360p, so the verify bands are
//   primary y300-335, secondary y268-295, gap y296-304.
// - 8K encode timing (probe): 0.5 s testsrc2 7680x4320 libx265
//   veryfast CRF 28 = 34.4 s; solid colour 0.5 s 8K = ~19.9 s. The
//   8K check below uses a 0.5 s solid-colour source for that reason.
// - LGPL: libx265 is GPL (8K preset + SDR->HDR force it); tonemap /
//   zscale / libx264 are native libavfilter / LGPL but still to be
//   re-checked on the BtbN LGPL 9.0 build at the M2 gate. SDR->HDR is
//   PSEUDO-HDR (lifts SDR into a 10-bit PQ container; adds no new
//   highlight information) — never call it true HDR.
// Old M1 / P0 / P0b / P1 / P1b / P1c / P1d / P1e / P2a / P2b / P2c /
// P3a / P3b checks live in their own files and must still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  HDR_BT2020_PQ,
  addCustomPreset,
  createPresetStore,
  formatVttTime,
  getPreset,
  hdrToSdrFilter,
  hdrVideoFilter,
  listPresets,
  parseExportPreset,
  parseVTT,
  queueAdd,
  queueMove,
  queueRemove,
  resolveEncoderArgs,
  resolveExportOnlyMode,
  runExportQueue,
  sdrToHdrFilter,
  serializeExportPreset,
  subtitlesToDualASS,
  toVTT,
  validateExportPreset,
  validateHdrMode,
  validateQueueItem,
  writeDualSubtitleSidecar,
  writeSubtitleSidecar,
} from '../dist/deliver.js';
import { exportProject, PRESETS, probe } from '../dist/export.js';
import { DEFAULT_ASS_STYLE } from '../dist/subtitles.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

const checks = [];
const check = (name, ok, detail = '') =>
  checks.push([`${name}${detail ? ` (${detail})` : ''}`, ok]);
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

async function run(cmd, args, opts = {}) {
  return exec(cmd, args, { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer', ...opts });
}

const base = { version: 1, width: 640, height: 360, fps: 30, transitions: [], transitionDuration: 0.5 };
const clip = (id, source, extra = {}) => ({ id, source, in: 0, out: 2, speed: 1, volume: 1, ...extra });

async function ffprobeJson(file, entries) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'json', file]);
  return JSON.parse(stdout);
}

async function streamTypes(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
  return String(stdout).split('\n').map((s) => s.trim()).filter(Boolean);
}

// --- PQ helpers (copied from tmp/probe-p3c.mjs v2) ---
function pqEotf(c) {
  const m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  const v = Math.max(Math.pow(Math.max(c, 0), 1 / m2) - c1, 0) / (c2 - c3 * Math.pow(Math.max(c, 0), 1 / m2));
  return 10000 * Math.pow(v, 1 / m1);
}
function pqCode(nits) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (pqEotf(mid) < nits) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
function writePqRaw(path, w, h, nits) {
  const y = Buffer.alloc(w * h * 2);
  for (let i = 0; i < w * h; i++) y.writeUInt16LE(64 + Math.round(pqCode(nits) * 876), i * 2);
  const c = Buffer.alloc((w / 2) * (h / 2) * 2);
  for (let i = 0; i < c.length; i += 2) c.writeUInt16LE(512, i);
  writeFileSync(path, Buffer.concat([y, c, c]));
}
async function encodeHdr(raw, w, h, out, dur = 0.5) {
  // Silent audio track: the export graph references [i:a] for every
  // clip, so an audio-less source fails at graph binding (measured).
  await run('ffmpeg', ['-v', 'error', '-stream_loop', '-1', '-t', String(dur),
    '-f', 'rawvideo', '-video_size', `${w}x${h}`, '-pix_fmt', 'yuv420p10le', '-framerate', '30',
    '-i', raw, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv',
    '-c:v', 'libx265', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p10le',
    '-c:a', 'aac', '-shortest', '-y', out]);
}
async function grayMean(file, w = 64, h = 36) {
  // Frame 7 of 15 (0.5 s @ 30 fps): the probe used n=15 on 1 s files;
  // a 0.5 s file has no frame 15, so that select returns nothing (NaN).
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file,
    '-vf', 'select=eq(n\\,7),format=gray', '-frames:v', '1', '-f', 'rawvideo', '-']);
  const px = Buffer.from(stdout).subarray(0, w * h);
  return Math.round(px.reduce((a, b) => a + b, 0) / px.length);
}
/** Fraction of pixels brighter than 60 in a y-band of a gray frame at t=1s. */
async function bandFrac(file, w, h, y0, y1) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file,
    '-vf', 'select=eq(n\\,30),format=gray', '-frames:v', '1', '-f', 'rawvideo', '-']);
  const px = Buffer.from(stdout).subarray(0, w * h);
  let lit = 0, total = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) { total++; if (px[y * w + x] > 60) lit++; }
  return lit / total;
}

// --- 1. WebVTT ---
const VTT_ITEMS = [
  { text: 'Hello', start: 1, end: 3.5 },
  { text: 'World', start: 4, end: 5 },
];
{
  const vtt = toVTT(VTT_ITEMS);
  check('vtt: header WEBVTT', vtt.startsWith('WEBVTT'));
  check('vtt: timecode uses dot not comma', vtt.includes('00:00:01.000 --> 00:00:03.500'));
  check('vtt: second cue timecode', vtt.includes('00:00:04.000 --> 00:00:05.000'));
  check('vtt: text lines present', vtt.includes('Hello') && vtt.includes('World'));
  check('vtt: formatVttTime 3661.234', formatVttTime(3661.234) === '01:01:01.234');
  const back = parseVTT(vtt);
  check('vtt: round-trip 2 cues', back.length === 2);
  check('vtt: round-trip times/text',
    back.length === 2 && back[0].start === 1 && back[0].end === 3.5 && back[0].text === 'Hello'
    && back[1].start === 4 && back[1].end === 5 && back[1].text === 'World');
}

// --- 2. Dual ASS strings ---
const DUAL = {
  primary: [{ text: 'Hello world', start: 0.2, end: 1.8, words: [{ w: 'Hello', start: 0.2, end: 1.0 }, { w: ' world', start: 1.0, end: 1.8 }] }],
  secondary: [{ text: 'Bonjour le monde', start: 0.2, end: 1.8 }],
};
{
  const ass = subtitlesToDualASS(DUAL, DEFAULT_ASS_STYLE, 640, 360);
  check('dual ass: two Style lines', ass.includes('Style: Sub,') && ass.includes('Style: Sub2,'));
  const subDialogues = (ass.match(/,Sub,,/g) ?? []).length;
  const sub2Dialogues = (ass.match(/,Sub2,,/g) ?? []).length;
  check('dual ass: primary dialogue in Sub style', subDialogues === 1, `n=${subDialogues}`);
  check('dual ass: secondary dialogue in Sub2 style', sub2Dialogues === 1, `n=${sub2Dialogues}`);
  check('dual ass: primary text present', ass.includes('Hello world') || ass.includes('Hello'));
  check('dual ass: secondary text present', ass.includes('Bonjour le monde'));
  check('dual ass: primary has karaoke \\k tags', ass.includes('{\\k'));
  const sub2Line = ass.split('\n').find((l) => l.startsWith('Style: Sub2,'));
  const fields = sub2Line.split(',');
  const expectedMarginV = DEFAULT_ASS_STYLE.marginV + DEFAULT_ASS_STYLE.fontsize + 12;
  check('dual ass: Sub2 marginV clears primary line', Number(fields[21]) === expectedMarginV,
    `marginV=${fields[21]} expected=${expectedMarginV}`);
  const oneLine = subtitlesToDualASS({ primary: DUAL.primary, secondary: [] }, DEFAULT_ASS_STYLE, 640, 360);
  check('dual ass: missing secondary -> one line, no error',
    (oneLine.match(/,Sub2,,/g) ?? []).length === 0 && (oneLine.match(/,Sub,,/g) ?? []).length === 1);
  check('dual ass: empty primary throws', throws(() => subtitlesToDualASS({ primary: [], secondary: DUAL.secondary }, DEFAULT_ASS_STYLE, 640, 360)));
}

// --- 3. Sidecar writers ---
{
  const srtFile = `${DIR}p3c-test.srt`;
  writeSubtitleSidecar(VTT_ITEMS, srtFile, 'srt');
  check('sidecar srt: comma timecode', readFileSync(srtFile, 'utf8').includes('00:00:01,000 --> 00:00:03,500'));
  const vttFile = `${DIR}p3c-test.vtt`;
  writeSubtitleSidecar(VTT_ITEMS, vttFile, 'vtt');
  check('sidecar vtt: WEBVTT header', readFileSync(vttFile, 'utf8').startsWith('WEBVTT'));
  const assFile = `${DIR}p3c-test.ass`;
  writeSubtitleSidecar(VTT_ITEMS, assFile, 'ass');
  check('sidecar ass: V4+ styles', readFileSync(assFile, 'utf8').includes('[V4+ Styles]'));
  const dualAssFile = `${DIR}p3c-test-dual.ass`;
  writeDualSubtitleSidecar(DUAL, dualAssFile, 'ass');
  const dualAss = readFileSync(dualAssFile, 'utf8');
  check('sidecar dual ass: both styles + both texts',
    dualAss.includes('Style: Sub2,') && dualAss.includes('Bonjour le monde') && dualAss.includes('Hello'));
  const dualSrtFile = `${DIR}p3c-test-dual.srt`;
  writeDualSubtitleSidecar(DUAL, dualSrtFile, 'srt');
  const dualSrt = readFileSync(dualSrtFile, 'utf8');
  check('sidecar dual srt: merged two-line cue', dualSrt.includes('Hello world\nBonjour le monde'));
  check('sidecar: unknown format throws', throws(() => writeSubtitleSidecar(VTT_ITEMS, `${DIR}p3c-test.xyz`, 'xyz')));
}

// --- 4. Export presets ---
{
  const good = { name: 'test', width: 1920, height: 1080, fps: 30, crf: 20, preset: 'veryfast', audioBitrate: '160k' };
  check('preset: validate good preset', validateExportPreset(good).name === 'test');
  check('preset: parse JSON round-trip', parseExportPreset(JSON.stringify(good)).width === 1920);
  check('preset: serialise round-trip', JSON.parse(serializeExportPreset(good)).name === 'test');
  check('preset: bad JSON rejected', throws(() => parseExportPreset('{nope')));
  check('preset: missing name rejected', throws(() => validateExportPreset({ ...good, name: undefined })));
  check('preset: width 0 rejected', throws(() => validateExportPreset({ ...good, width: 0 })));
  check('preset: width 99999 rejected', throws(() => validateExportPreset({ ...good, width: 99999 })));
  check('preset: height 5000 rejected', throws(() => validateExportPreset({ ...good, height: 5000 })));
  check('preset: fps 0 rejected', throws(() => validateExportPreset({ ...good, fps: 0 })));
  check('preset: crf 60 rejected', throws(() => validateExportPreset({ ...good, crf: 60 })));
  check('preset: bad encoder preset rejected', throws(() => validateExportPreset({ ...good, preset: 'turbo' })));
  check('preset: bad codec rejected', throws(() => validateExportPreset({ ...good, codec: 'libvpx' })));
  check('preset: bad audioBitrate rejected', throws(() => validateExportPreset({ ...good, audioBitrate: '160' })));
  const store = createPresetStore(PRESETS);
  const p8k = getPreset(store, '8k30');
  check('preset: builtin 8k30 is 7680x4320', p8k.width === 7680 && p8k.height === 4320, `${p8k.width}x${p8k.height}`);
  check('preset: 8k30 codec is libx265', p8k.codec === 'libx265');
  const custom = addCustomPreset(store, JSON.stringify({ ...good, name: 'my4k', width: 3840, height: 2160 }));
  check('preset: custom preset added + resolvable', getPreset(store, 'my4k') === custom);
  check('preset: custom name colliding with builtin rejected',
    throws(() => addCustomPreset(store, JSON.stringify({ ...good, name: '720p30' }))));
  check('preset: duplicate custom rejected',
    throws(() => addCustomPreset(store, JSON.stringify({ ...good, name: 'my4k', width: 3840, height: 2160 }))));
  check('preset: unknown name rejected', throws(() => getPreset(store, 'nope')));
  check('preset: listPresets = builtins + 1 custom',
    listPresets(store).length === Object.keys(PRESETS).length + 1, `n=${listPresets(store).length}`);
}

// --- 5. Encoder plan + HDR filters ---
{
  const plan8k = resolveEncoderArgs(PRESETS['8k30'], 'off');
  check('encoder: 8k30/off -> libx265 yuv420p, no tags',
    plan8k.codec === 'libx265' && plan8k.pixFmt === 'yuv420p' && plan8k.extraArgs.length === 0);
  const planPseudo = resolveEncoderArgs(PRESETS['720p30'], 'sdr-to-hdr');
  check('encoder: sdr-to-hdr forces libx265 + 10-bit + PQ tags',
    planPseudo.codec === 'libx265' && planPseudo.pixFmt === 'yuv420p10le'
    && planPseudo.extraArgs.includes('-color_trc') && planPseudo.extraArgs.includes('smpte2084'));
  const planSdr = resolveEncoderArgs(PRESETS['720p30'], 'hdr-to-sdr');
  check('encoder: hdr-to-sdr keeps preset codec at yuv420p',
    planSdr.codec === 'libx264' && planSdr.pixFmt === 'yuv420p');
  const f = hdrToSdrFilter();
  check('hdr filter: hable chain', f.includes('tonemap=hable') && f.includes('t=linear:npl=100') && f.includes('p=bt709'));
  check('hdr filter: mobius operator', hdrToSdrFilter(HDR_BT2020_PQ, 'mobius').includes('tonemap=mobius'));
  const g = sdrToHdrFilter();
  check('hdr filter: sdr->hdr single zscale to PQ',
    g.includes('t=smpte2084') && g.includes('format=yuv420p10le') && g.includes('p=bt2020'));
  check('hdr filter: off -> undefined', hdrVideoFilter('off') === undefined);
  check('hdr filter: hdr-to-sdr -> tonemap', (hdrVideoFilter('hdr-to-sdr') ?? '').includes('tonemap'));
  check('hdr filter: sdr-to-hdr -> PQ', (hdrVideoFilter('sdr-to-hdr') ?? '').includes('smpte2084'));
  check('hdr mode: unknown string rejected', throws(() => validateHdrMode('hdr')));
  check('hdr mode: undefined -> off', validateHdrMode(undefined) === 'off');
}

// --- 6. Export-only resolver ---
{
  check('export-only: none set -> none', resolveExportOnlyMode({}) === 'none');
  check('export-only: videoOnly -> video', resolveExportOnlyMode({ videoOnly: true }) === 'video');
  check('export-only: audioOnly -> audio', resolveExportOnlyMode({ audioOnly: true }) === 'audio');
  check('export-only: subtitleOnly -> subtitle', resolveExportOnlyMode({ subtitleOnly: true }) === 'subtitle');
  check('export-only: two switches rejected',
    throws(() => resolveExportOnlyMode({ videoOnly: true, audioOnly: true })));
  check('export-only: all three rejected',
    throws(() => resolveExportOnlyMode({ videoOnly: true, audioOnly: true, subtitleOnly: true })));
}

// --- sources for export tests ---
// Every clip source needs an audio stream: the graph references [i:a]
// for every clip, so an audio-less source fails at graph binding
// (measured in the first run of this file). Silent anullsrc is enough.
const black = `${DIR}p3c-black.mp4`;
if (!existsSync(black)) {
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=2',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', black]);
}
const tone = `${DIR}p3a-440.mp4`;
const toneProbe = await probe(tone);
check('export setup: tone source has audio', toneProbe.hasAudio === true);
const toneDur = Math.min(2, toneProbe.duration);

// --- 7. Dual subtitle export: both lines on screen, in separate bands ---
{
  const out = `${DIR}p3c-dual-export.mp4`;
  const rep = await exportProject(
    { ...base, clips: [clip('c', black, { out: 2 })], dualSubtitles: DUAL },
    out,
    { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('dual export: duration err <= 0.05s', rep.durationError <= 0.05, `err=${rep.durationError.toFixed(3)}`);
  const assPath = `${out}.ass`;
  check('dual export: .ass audit file exists with both styles',
    existsSync(assPath) && readFileSync(assPath, 'utf8').includes('Style: Sub2,'));
  const pFrac = await bandFrac(out, 640, 360, 300, 335);
  const sFrac = await bandFrac(out, 640, 360, 268, 295);
  const gFrac = await bandFrac(out, 640, 360, 296, 304);
  const cFrac = await bandFrac(out, 640, 360, 100, 150);
  check('dual export: primary band has text', pFrac > 0.01, `frac=${pFrac.toFixed(4)}`);
  check('dual export: secondary band has text', sFrac > 0.005, `frac=${sFrac.toFixed(4)}`);
  check('dual export: gap band is empty', gFrac < 0.005, `frac=${gFrac.toFixed(4)}`);
  check('dual export: control band is empty', cFrac === 0, `frac=${cFrac.toFixed(4)}`);
}

// --- 8. videoOnly / audioOnly / subtitleOnly exports ---
{
  const vOut = `${DIR}p3c-videoonly.mp4`;
  const vRep = await exportProject(
    { ...base, clips: [clip('c', tone, { out: toneDur })] },
    vOut,
    { preset: PRESETS['720p30'], fontfile: FONT, exportOnly: 'video' },
  );
  check('videoOnly: no audio track', vRep.actual.hasAudio === false);
  check('videoOnly: video present', vRep.actual.width === 640 && vRep.actual.height === 360);
  check('videoOnly: duration err <= 0.05s', vRep.durationError <= 0.05, `err=${vRep.durationError.toFixed(3)}`);
  check('videoOnly: report marks mode', vRep.exportOnly === 'video');

  const aOut = `${DIR}p3c-audioonly.mp4`;
  const aRep = await exportProject(
    { ...base, clips: [clip('c', tone, { out: toneDur })] },
    aOut,
    { preset: PRESETS['720p30'], fontfile: FONT, exportOnly: 'audio' },
  );
  check('audioOnly: audio present, codec aac', aRep.actual.hasAudio === true && aRep.actual.codec === 'aac');
  check('audioOnly: no video stream', !(await streamTypes(aOut)).includes('video'));
  check('audioOnly: duration err <= 0.05s', aRep.durationError <= 0.05, `err=${aRep.durationError.toFixed(3)}`);
  check('audioOnly: report marks mode', aRep.exportOnly === 'audio');

  const sOut = `${DIR}p3c-subonly.mp4`;
  const sVtt = `${DIR}p3c-sub-only.vtt`;
  const sRep = await exportProject(
    { ...base, clips: [clip('c', black, { out: 2 })], subtitles: [{ text: 'Only subtitle here', start: 0.2, end: 1.5 }] },
    sOut,
    { preset: PRESETS['720p30'], fontfile: FONT, exportOnly: 'subtitle', srtPath: sVtt, sidecarFormat: 'vtt' },
  );
  const sVttText = existsSync(sVtt) ? readFileSync(sVtt, 'utf8') : '';
  check('subtitleOnly: sidecar written (VTT)', sVttText.startsWith('WEBVTT') && sVttText.includes('Only subtitle here'));
  check('subtitleOnly: no video rendered', !existsSync(sOut));
  check('subtitleOnly: report marks mode + sidecar', sRep.exportOnly === 'subtitle' && (sRep.sidecarFiles ?? []).includes(sVtt));
  check('subtitleOnly: no subtitles -> throws',
    await (async () => {
      try {
        await exportProject(
          { ...base, clips: [clip('c', black, { out: 2 })] },
          `${DIR}p3c-subonly-none.mp4`,
          { preset: PRESETS['720p30'], fontfile: FONT, exportOnly: 'subtitle' },
        );
        return false;
      } catch {
        return true;
      }
    })());

  const dVtt = `${DIR}p3c-sub-only-dual.vtt`;
  await exportProject(
    { ...base, clips: [clip('c', black, { out: 2 })], dualSubtitles: DUAL },
    `${DIR}p3c-subonly-dual.mp4`,
    { preset: PRESETS['720p30'], fontfile: FONT, exportOnly: 'subtitle', srtPath: dVtt, sidecarFormat: 'vtt' },
  );
  const dVttText = existsSync(dVtt) ? readFileSync(dVtt, 'utf8') : '';
  check('subtitleOnly dual: VTT merges both languages',
    dVttText.includes('Hello world') && dVttText.includes('Bonjour le monde'));
}

// --- 9. HDR -> SDR: measured tonemap curve through the export path ---
{
  const hable = {};
  const naive = {};
  for (const n of [10, 100, 200]) {
    const raw = `${DIR}p3c-patch${n}.yuv`;
    const src = `${DIR}p3c-patch${n}.mp4`;
    // Always (re)encode: the probe-era patch files have no audio track.
    writePqRaw(raw, 64, 36, n);
    await encodeHdr(raw, 64, 36, src, 0.5);
    const tiny = { version: 1, width: 64, height: 36, fps: 30, transitions: [], transitionDuration: 0.5 };
    const hOut = `${DIR}p3c-patch${n}-hable-export.mp4`;
    await exportProject(
      { ...tiny, clips: [clip('c', src, { out: 0.5 })], hdrMode: 'hdr-to-sdr' },
      hOut,
      { preset: PRESETS['720p30'], fontfile: FONT },
    );
    hable[n] = await grayMean(hOut);
    const nOut = `${DIR}p3c-patch${n}-naive-export.mp4`;
    await exportProject(
      { ...tiny, clips: [clip('c', src, { out: 0.5 })] },
      nOut,
      { preset: PRESETS['720p30'], fontfile: FONT },
    );
    naive[n] = await grayMean(nOut);
  }
  check('hdr->sdr: 10 nits shadow stays above black', hable[10] >= 5 && hable[10] <= 20, `mean=${hable[10]}`);
  check('hdr->sdr: 100 nits mid-tone', hable[100] >= 100 && hable[100] <= 130, `mean=${hable[100]}`);
  check('hdr->sdr: 200 nits highlight', hable[200] >= 180 && hable[200] <= 220, `mean=${hable[200]}`);
  check('hdr->sdr: naive 100 nits is washed out vs hable', naive[100] >= 120 && naive[100] <= 140, `mean=${naive[100]}`);
  check('hdr->sdr: hable span beats naive span',
    (hable[200] - hable[10]) > 150 && (naive[200] - naive[10]) < 100,
    `hable span=${hable[200] - hable[10]}, naive span=${naive[200] - naive[10]}`);
  const hdrOut = `${DIR}p3c-patch100-hable-export.mp4`;
  const st = await ffprobeJson(hdrOut, 'stream=codec_name,pix_fmt');
  check('hdr->sdr: output is h264 yuv420p (SDR)',
    st.streams[0].codec_name === 'h264' && st.streams[0].pix_fmt === 'yuv420p',
    `${st.streams[0].codec_name}/${st.streams[0].pix_fmt}`);
  check('hdr->sdr: bad hdrMode rejected',
    await (async () => {
      try {
        await exportProject(
          { version: 1, width: 64, height: 36, fps: 30, transitions: [], transitionDuration: 0.5,
            clips: [clip('c', `${DIR}p3c-patch100.mp4`, { out: 0.5 })], hdrMode: 'hdr' },
          `${DIR}p3c-bad-hdr.mp4`,
          { preset: PRESETS['720p30'], fontfile: FONT },
        );
        return false;
      } catch {
        return true;
      }
    })());
}

// --- 10. SDR -> HDR (pseudo-HDR): container tags ---
{
  const sdr = `${DIR}p3c-sdr.mp4`;
  if (!existsSync(sdr)) {
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=0.5',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '0.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sdr]);
  }
  const out = `${DIR}p3c-sdr2hdr-export.mp4`;
  const rep = await exportProject(
    { ...base, clips: [clip('c', sdr, { out: 0.5 })], hdrMode: 'sdr-to-hdr' },
    out,
    { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('sdr->hdr: duration err <= 0.05s', rep.durationError <= 0.05, `err=${rep.durationError.toFixed(3)}`);
  const st = await ffprobeJson(out, 'stream=codec_name,pix_fmt,color_transfer,color_primaries');
  check('sdr->hdr: hevc 10-bit container',
    st.streams[0].codec_name === 'hevc' && st.streams[0].pix_fmt === 'yuv420p10le',
    `${st.streams[0].codec_name}/${st.streams[0].pix_fmt}`);
  check('sdr->hdr: PQ transfer tagged',
    st.streams[0].color_transfer === 'smpte2084', `trc=${st.streams[0].color_transfer}`);
  check('sdr->hdr: BT.2020 primaries tagged',
    st.streams[0].color_primaries === 'bt2020', `prim=${st.streams[0].color_primaries}`);
}

// --- 11. 8K export (slow: ~20 s for 0.5 s solid colour, probe-measured) ---
{
  const out = `${DIR}p3c-8k.mp4`;
  const rep = await exportProject(
    { version: 1, width: 7680, height: 4320, fps: 30, transitions: [], transitionDuration: 0.5,
      clips: [clip('c', black, { out: 0.5 })] },
    out,
    { preset: PRESETS['8k30'], fontfile: FONT },
  );
  check('8k: duration err <= 0.05s', rep.durationError <= 0.05, `err=${rep.durationError.toFixed(3)}`);
  check('8k: output is 7680x4320', rep.actual.width === 7680 && rep.actual.height === 4320,
    `${rep.actual.width}x${rep.actual.height}`);
  check('8k: codec is hevc (libx265)', rep.actual.codec === 'hevc', `codec=${rep.actual.codec}`);
}

// --- 12. Batch export queue ---
{
  const store = createPresetStore(PRESETS);
  const baseOpts = { preset: PRESETS['720p30'], fontfile: FONT };
  const itemA = { id: 'q1', project: { ...base, clips: [clip('a', black, { out: 0.5 })] }, output: `${DIR}p3c-q1.mp4` };
  const itemB = { id: 'q2', project: { ...base, clips: [clip('b', '/nonexistent/p3c-missing.mp4', { out: 0.5 })] }, output: `${DIR}p3c-q2.mp4` };
  const itemC = { id: 'q3', project: { ...base, clips: [clip('c', black, { out: 0.5 })] }, output: `${DIR}p3c-q3.mp4` };
  let queue = [];
  queue = queueAdd(queue, itemA);
  queue = queueAdd(queue, itemB);
  queue = queueAdd(queue, itemC);
  const results = await runExportQueue(queue, exportProject, { store, baseOpts });
  check('queue: 3 results in order', results.map((r) => r.id).join(',') === 'q1,q2,q3');
  check('queue: first item done', results[0].status === 'done' && !!results[0].report);
  check('queue: failing item recorded, not fatal',
    results[1].status === 'failed' && typeof results[1].error === 'string' && results[1].error.length > 0,
    `error=${(results[1].error ?? '').slice(0, 60)}`);
  check('queue: third item still runs after failure', results[2].status === 'done' && !!results[2].report);
  check('queue: duplicate id rejected', throws(() => queueAdd(queue, itemA)));
  check('queue: move out of range rejected', throws(() => queueMove(queue, 'q1', 3)));
  const moved = queueMove(queue, 'q1', 2);
  check('queue: move reorders', moved.map((q) => q.id).join(',') === 'q2,q3,q1');
  check('queue: remove unknown id rejected', throws(() => queueRemove(queue, 'nope')));
  check('queue: project without clips rejected',
    throws(() => validateQueueItem({ id: 'x', project: { ...base, clips: [] }, output: `${DIR}p3c-qx.mp4` })));
  check('queue: unknown preset fails that item only',
    (await runExportQueue(
      [{ id: 'q9', project: { ...base, clips: [clip('a', black, { out: 0.5 })] }, output: `${DIR}p3c-q9.mp4`, presetName: 'nope' }],
      exportProject, { store, baseOpts },
    ))[0].status === 'failed');
}

// --- summary ---
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
if (failed.length > 0) process.exit(1);
