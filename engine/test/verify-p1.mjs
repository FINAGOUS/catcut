// P1 engine verification (M4, 2026-11-17).
// Covers: shape-mask PiP (PNG + alphamerge, 4 shapes + feather + morph),
// auto-zoom by speech rhythm (subtitle timestamps + silence dips),
// one-click talk presets. Old M1/P0/P0b checks must still pass.
// Ground truth: test/speech-zh.json (tiny faster-whisper, 3 segments,
// 12.744 s) + test/speech-zh.wav (offline sherpa-onnx VITS speech).
// Local FFmpeg here is the GPL 8.1.2 build: alphamerge/alphaextract/
// overlay are libavfilter (LGPL) filters, but they are verified HERE
// only — re-check `ffmpeg -filters` on the BtbN LGPL 9.0 build (M2 gate).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  exportProject, probe, PRESETS, TALK_PRESETS, applyTalkPreset,
  serializeTalkPreset, parseTalkPreset,
} from '../dist/export.js';
import { buildFilterGraph } from '../dist/filtergraph.js';
import {
  renderMaskPng, maskPixelSize, maskOverlayPos, maskSegments,
} from '../dist/mask.js';
import {
  generateAutoZoom, generateAutoZoomWithSilences, detectSilences,
  zoomScaleAt, countScalePushes, emphasisPlateaus,
} from '../dist/autozoom.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const SRC = `${DIR}source.mp4`;
const VSRC = `${DIR}source-9x16.mp4`;
const SRC4K = `${DIR}source-4k.mp4`;
const SPEECH_WAV = `${DIR}speech-zh.wav`;
const SPEECH_VIDEO = `${DIR}speech-video.mp4`;
const SILENCE_WAV = `${DIR}silence-1s.wav`;
const LONG_WAV = `${DIR}speech-long.wav`;
const LONG_VIDEO = `${DIR}speech-long-video.mp4`;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const FONT_CJK = '/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc';

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
  await exec('ffmpeg', ['-i', file, '-vf', `select='eq(n\\,${n})'`, '-frames:v', '1', '-y', out]);
}

async function cropPng(file, n, x, y, w, h, out) {
  await exec('ffmpeg', ['-i', file, '-vf', `select='eq(n\\,${n})',crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-y', out]);
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

/** Raw alpha bytes of a PNG (W*H bytes, 0..255) via alphaextract. */
async function alphaBytes(png, w, h) {
  const raw = `${png}.alpha.raw`;
  await exec('ffmpeg', ['-v', 'error', '-i', png, '-vf', 'alphaextract', '-f', 'rawvideo', '-s', `${w}x${h}`, '-y', raw]);
  return readFileSync(raw);
}

const base720 = { version: 1, width: 1280, height: 720, fps: 30, transitionDuration: 0.5 };
const clip2 = (id, a, b, extra = {}) => ({ id, source: SRC, in: a, out: b, speed: 1, volume: 1, ...extra });

const tinyJson = JSON.parse(readFileSync(`${DIR}speech-zh.json`, 'utf8'));
const tinyItems = tinyJson.segments.map((s) => ({
  text: s.text, start: s.start, end: s.end,
  words: (s.words ?? []).map((w) => ({ w: w.w, start: w.start, end: w.end })),
}));

// --- sources ---
await exec('ffmpeg', [
  '-f', 'lavfi', '-i', 'testsrc2=duration=10:size=1280x720:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', SRC,
]);
await exec('ffmpeg', [
  '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=1080x1920:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', VSRC,
]);
await exec('ffmpeg', [
  '-f', 'lavfi', '-i', 'testsrc2=duration=13:size=1280x720:rate=30',
  '-i', SPEECH_WAV,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', SPEECH_VIDEO,
]);

// --- 0. Mask PNG unit checks (no encode) ---
{
  const circle = { shape: 'circle', x: 0.78, y: 0.72, w: 0.26, h: 0.26, feather: 0 };
  const { pxW, pxH } = maskPixelSize(circle, 1280, 720);
  check('0 circle PNG is square + even', pxW === pxH && pxW % 2 === 0, `${pxW}x${pxH}`);
  const png = `${DIR}p1-mask-circle.png`;
  writeFileSync(png, renderMaskPng(circle, pxW, pxH));
  const a = await alphaBytes(png, pxW, pxH);
  const at = (x, y) => a[y * pxW + x];
  check('0 circle centre opaque, corner transparent', at(166, 166) === 255 && at(0, 0) === 0, `centre=${at(166, 166)} corner=${at(0, 0)}`);
  // Symmetry: equal distance from centre horizontally vs vertically.
  check('0 circle is round (h/v symmetry)', at(166 + 150, 166) === at(166, 166 + 150), `h=${at(316, 166)} v=${at(166, 316)}`);
  // Feather: gradient width along the centre row ~ feather px.
  const feathered = { shape: 'circle', x: 0.5, y: 0.5, w: 0.3, h: 0.3, feather: 12 };
  const fw = maskPixelSize(feathered, 1280, 720).pxW;
  const fpng = `${DIR}p1-mask-feather.png`;
  writeFileSync(fpng, renderMaskPng(feathered, fw, fw));
  const fa = await alphaBytes(fpng, fw, fw);
  let grad = 0;
  for (let x = 0; x < fw; x++) {
    const v = fa[Math.floor(fw / 2) * fw + x];
    if (v > 0 && v < 255) grad++;
  }
  check('0 feather gradient ~12px (no hard edge)', grad >= 8 && grad <= 16, `gradient px=${grad}`);
  const ellipse = { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.4, h: 0.25, feather: 0 };
  const e = maskPixelSize(ellipse, 1280, 720);
  check('0 ellipse dims 512x180 even', e.pxW === 512 && e.pxH === 180, `${e.pxW}x${e.pxH}`);
  const rr = { shape: 'roundedRect', x: 0.5, y: 0.5, w: 0.3, h: 0.3, radius: 0.25, feather: 0 };
  const r = maskPixelSize(rr, 1280, 720);
  const rpng = `${DIR}p1-mask-rr.png`;
  writeFileSync(rpng, renderMaskPng(rr, r.pxW, r.pxH));
  const ra = await alphaBytes(rpng, r.pxW, r.pxH);
  check('0 roundedRect corner cut, edge solid', ra[2 * r.pxW + 2] === 0 && ra[2 * r.pxW + Math.floor(r.pxW / 2)] === 255,
    `corner=${ra[2 * r.pxW + 2]} edge=${ra[2 * r.pxW + Math.floor(r.pxW / 2)]}`);
  const segs = maskSegments({ shape: 'rect', x: 0.5, y: 0.5, w: 0.3, h: 0.3, keyframes: [{ t: 2, shape: 'circle' }] }, 4);
  check('0 mask keyframes split 2 segments', segs.length === 2 && segs[0].shape === 'rect' && segs[1].shape === 'circle' && segs[1].t0 === 2,
    JSON.stringify(segs.map((s) => [s.t0, s.t1, s.shape])));
}

// --- A. Four shapes export (4s each, blur 0 for frame checks) ---
const MASK4 = {
  circle: { shape: 'circle', x: 0.78, y: 0.72, w: 0.26, h: 0.26, feather: 12 },
  ellipse: { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.4, h: 0.25, feather: 8 },
  rect: { shape: 'rect', x: 0.3, y: 0.3, w: 0.3, h: 0.3, feather: 0 },
  roundedRect: { shape: 'roundedRect', x: 0.7, y: 0.3, w: 0.3, h: 0.3, radius: 0.25, feather: 6 },
};
const ctrlProj = { ...base720, clips: [clip2('c', 0, 4)], transitions: [] };
await exportProject(ctrlProj, `${DIR}p1-ctrl.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
for (const [shape, mask] of Object.entries(MASK4)) {
  const p = { ...base720, clips: [clip2('c', 0, 4, { mask })], transitions: [] };
  const rep = await exportProject(p, `${DIR}p1-mask-${shape}.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check(`A ${shape} duration ~4.0s`, rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check(`A ${shape} has audio`, rep.actual.hasAudio);
  check(`A ${shape} no black segments`, !(await hasBlackSegments(`${DIR}p1-mask-${shape}.mp4`)));
  // Frame check at t=2.0 (frame 60): a 10x10 probe tight in the box corner
  // shows bg for circle/ellipse/roundedRect (PSNR high vs control), fg
  // for rect (PSNR low); box centre always shows the scaled fg (PSNR low).
  const pos = maskOverlayPos(mask, 1280, 720, shape);
  const cx = pos.x + Math.floor(pos.pxW / 2);
  const cy = pos.y + Math.floor(pos.pxH / 2);
  await cropPng(`${DIR}p1-mask-${shape}.mp4`, 60, pos.x + 2, pos.y + 2, 10, 10, `${DIR}f-${shape}-corner.png`);
  await cropPng(`${DIR}p1-ctrl.mp4`, 60, pos.x + 2, pos.y + 2, 10, 10, `${DIR}f-ctrl-corner-${shape}.png`);
  const pCorner = await psnr(`${DIR}f-${shape}-corner.png`, `${DIR}f-ctrl-corner-${shape}.png`);
  await cropPng(`${DIR}p1-mask-${shape}.mp4`, 60, cx - 80, cy - 80, 160, 160, `${DIR}f-${shape}-centre.png`);
  await cropPng(`${DIR}p1-ctrl.mp4`, 60, cx - 80, cy - 80, 160, 160, `${DIR}f-ctrl-centre-${shape}.png`);
  const pCentre = await psnr(`${DIR}f-${shape}-centre.png`, `${DIR}f-ctrl-centre-${shape}.png`);
  if (shape === 'rect') {
    check(`A rect corner is fg (differs from ctrl)`, pCorner < 25, `PSNR=${pCorner}`);
  } else {
    check(`A ${shape} corner is bg (matches ctrl)`, pCorner > 35, `PSNR=${pCorner}`);
  }
  check(`A ${shape} centre is fg (differs from ctrl)`, pCentre < 30, `PSNR=${pCentre}`);
}
// Background blur: same circle mask with blur 6 — the box corner (bg) must
// differ from the sharp control, i.e. the blur actually ran.
{
  const mask = { ...MASK4.circle, backgroundBlur: 6 };
  const p = { ...base720, clips: [clip2('c', 0, 4, { mask })], transitions: [] };
  const rep = await exportProject(p, `${DIR}p1-mask-blur.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('A blur duration ~4.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  const pos = maskOverlayPos(mask, 1280, 720, 'circle');
  await cropPng(`${DIR}p1-mask-blur.mp4`, 60, pos.x + 2, pos.y + 2, 10, 10, `${DIR}f-blur-corner.png`);
  const pCorner = await psnr(`${DIR}f-blur-corner.png`, `${DIR}f-ctrl-corner-circle.png`);
  check('A backgroundBlur changes the corner', pCorner < 35, `PSNR=${pCorner}`);
}

// --- B. 4K circle mask (正圆 at 4K) ---
{
  await exec('ffmpeg', [
    '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=3840x2160:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', SRC4K,
  ]);
  const mask = { shape: 'circle', x: 0.78, y: 0.72, w: 0.2, h: 0.2, feather: 16 };
  const p = { version: 1, width: 3840, height: 2160, fps: 30, transitionDuration: 0.5,
    clips: [{ id: 'c', source: SRC4K, in: 0, out: 4, speed: 1, volume: 1, mask }], transitions: [] };
  const rep = await exportProject(p, `${DIR}p1-mask-4k.mp4`, { preset: PRESETS['4k30'], fontfile: FONT });
  check('B 4K circle duration ~4.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check('B 4K resolution 3840x2160', rep.actual.width === 3840 && rep.actual.height === 2160);
  const { pxW, pxH } = maskPixelSize(mask, 3840, 2160);
  check('B 4K circle PNG square', pxW === pxH && pxW === 768, `${pxW}x${pxH}`);
  const y = await yavg(`${DIR}p1-mask-4k.mp4`, 2.0);
  check('B 4K frame not black', y > 10, `YAVG=${y}`);
}

// --- C. Shape morph rect -> circle at t=2 ---
{
  const mask = { shape: 'rect', x: 0.78, y: 0.72, w: 0.26, h: 0.26, feather: 0, keyframes: [{ t: 2, shape: 'circle' }] };
  const p = { ...base720, clips: [clip2('c', 0, 4, { mask })], transitions: [] };
  const rep = await exportProject(p, `${DIR}p1-mask-morph.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('C morph duration ~4.0s', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check('C morph has audio', rep.actual.hasAudio);
  const pos = maskOverlayPos(mask, 1280, 720, 'rect');
  await cropPng(`${DIR}p1-mask-morph.mp4`, 30, pos.x + 2, pos.y + 2, 10, 10, `${DIR}f-morph-rect.png`);
  const pRect = await psnr(`${DIR}f-morph-rect.png`, `${DIR}f-ctrl-corner-circle.png`);
  check('C t=1.0 rect corner is fg', pRect < 25, `PSNR=${pRect}`);
  await cropPng(`${DIR}p1-mask-morph.mp4`, 90, pos.x + 2, pos.y + 2, 10, 10, `${DIR}f-morph-circle.png`);
  const pCircle = await psnr(`${DIR}f-morph-circle.png`, `${DIR}f-ctrl-corner-circle.png`);
  check('C t=3.0 circle corner is bg', pCircle > 35, `PSNR=${pCircle}`);
}

// --- D. Auto-zoom unit checks: 4x repeated speech, 1s gaps (54s) ---
const REPEAT = 13.744; // 12.744 speech + 1.0 s gap
const longItems = [];
for (let r = 0; r < 4; r++) {
  for (const it of tinyItems) {
    longItems.push({
      text: it.text, start: it.start + r * REPEAT, end: it.end + r * REPEAT,
      words: (it.words ?? []).map((w) => ({ w: w.w, start: w.start + r * REPEAT, end: w.end + r * REPEAT })),
    });
  }
}
const LONG_DUR = 4 * 12.744 + 3 * 1.0; // 53.976
{
  const keys = generateAutoZoom(longItems, {}, LONG_DUR);
  const mono = keys.every((k, i) => i === 0 || k.t >= keys[i - 1].t);
  check('D keys monotonic, scale in [1, 1.6]', mono && keys.every((k) => k.scale >= 1 && k.scale <= 1.6),
    `${keys.length} keys, max=${Math.max(...keys.map((k) => k.scale))}`);
  const pushes = countScalePushes(keys, 1.35);
  check('D one push per sentence (4 intervals, 12 items)', pushes === 4, `pushes=${pushes}`);
  const plateaus = emphasisPlateaus(keys, 1.35);
  check('D every plateau >= 0.5s', plateaus.length === 4 && plateaus.every((d) => d >= 0.5 - 1e-6),
    plateaus.map((d) => d.toFixed(2)).join(','));
  check('D scale at sentence start is emphasis', Math.abs(zoomScaleAt(keys, 2.0) - 1.35) < 0.01, `scale(2.0)=${zoomScaleAt(keys, 2.0)}`);
  check('D scale in the 1s gap is base', Math.abs(zoomScaleAt(keys, 13.2) - 1.0) < 0.01, `scale(13.2)=${zoomScaleAt(keys, 13.2)}`);
  // Synthetic tone-silence-tone (1s + 1s + 1s): the detector must find the
  // middle silence. The real TTS speech has no >=0.3s pause at -40dB
  // (continuous speech, measured 2026-11-17) — so on speech-zh.wav we
  // only assert the detector runs and stays in range, not that it finds one.
  await exec('ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', '-y', `${DIR}p1-tone1.wav`]);
  await exec('ffmpeg', ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-c:a', 'pcm_s16le', '-y', `${DIR}p1-sil1.wav`]);
  await exec('ffmpeg', ['-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', '-c:a', 'pcm_s16le', '-y', `${DIR}p1-tone2.wav`]);
  await exec('ffmpeg', ['-i', `${DIR}p1-tone1.wav`, '-i', `${DIR}p1-sil1.wav`, '-i', `${DIR}p1-tone2.wav`,
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[aout]', '-map', '[aout]', '-y', `${DIR}p1-tst.wav`]);
  const silSyn = await detectSilences(`${DIR}p1-tst.wav`);
  check('D silencedetect finds a known 1s silence', silSyn.length === 1
    && Math.abs(silSyn[0].start - 1.0) < 0.15 && Math.abs(silSyn[0].end - 2.0) < 0.15,
    JSON.stringify(silSyn));
  const sil = await detectSilences(SPEECH_WAV);
  check('D silencedetect runs on speech, in range', sil.every((s) => s.start >= 0 && s.end <= 12.744),
    `${sil.length} silences found (TTS speech is continuous; 0 is expected)`);
  const keysNoSil = generateAutoZoom(tinyItems, {}, 12.744);
  const keysSil = generateAutoZoomWithSilences(tinyItems, [{ start: 2.0, end: 3.0 }], {}, 12.744);
  check('D silence inside a sentence dips to base', Math.abs(zoomScaleAt(keysSil, 2.5) - 1.0) < 0.01
    && countScalePushes(keysSil, 1.35) === countScalePushes(keysNoSil, 1.35) + 1,
    `scale(2.5)=${zoomScaleAt(keysSil, 2.5)}, pushes ${countScalePushes(keysNoSil, 1.35)}->${countScalePushes(keysSil, 1.35)}`);
}

// --- E. Auto-zoom export (54s): emphasis frame zoomed, gap frame identical ---
{
  await exec('ffmpeg', ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-c:a', 'pcm_s16le', '-y', SILENCE_WAV]);
  const inputs = [];
  const filt = [];
  for (let r = 0; r < 4; r++) {
    inputs.push('-i', SPEECH_WAV);
    if (r < 3) inputs.push('-i', SILENCE_WAV);
  }
  for (let i = 0; i < 7; i++) filt.push(`[${i}:a]aresample=44100[a${i}]`);
  filt.push('[a0][a1][a2][a3][a4][a5][a6]concat=n=7:v=0:a=1[aout]');
  await exec('ffmpeg', [...inputs, '-filter_complex', filt.join(';'), '-map', '[aout]', '-c:a', 'pcm_s16le', '-y', LONG_WAV]);
  await exec('ffmpeg', [
    '-f', 'lavfi', '-i', `testsrc2=duration=${LONG_DUR}:size=1280x720:rate=30`,
    '-i', LONG_WAV,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', LONG_VIDEO,
  ]);
  const keys = generateAutoZoom(longItems, {}, LONG_DUR);
  const ctrl = { ...base720, clips: [{ id: 'c', source: LONG_VIDEO, in: 0, out: LONG_DUR, speed: 1, volume: 1 }], transitions: [] };
  await exportProject(ctrl, `${DIR}p1-zoom-ctrl.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  const zoomed = { ...base720, clips: [{ id: 'c', source: LONG_VIDEO, in: 0, out: LONG_DUR, speed: 1, volume: 1, zoom: keys }], transitions: [] };
  const rep = await exportProject(zoomed, `${DIR}p1-zoom.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('E auto-zoom 54s duration', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s expected=${rep.expectedDuration.toFixed(2)}s`);
  check('E auto-zoom has audio', rep.actual.hasAudio);
  check('E auto-zoom no black segments', !(await hasBlackSegments(`${DIR}p1-zoom.mp4`)));
  await framePng(`${DIR}p1-zoom.mp4`, 60, `${DIR}f-zoom-emph.png`);
  await framePng(`${DIR}p1-zoom-ctrl.mp4`, 60, `${DIR}f-zoom-ctrl-emph.png`);
  const pEmph = await psnr(`${DIR}f-zoom-emph.png`, `${DIR}f-zoom-ctrl-emph.png`);
  check('E emphasis frame is zoomed (differs from ctrl)', pEmph < 30, `PSNR=${pEmph}`);
  await framePng(`${DIR}p1-zoom.mp4`, 396, `${DIR}f-zoom-gap.png`);
  await framePng(`${DIR}p1-zoom-ctrl.mp4`, 396, `${DIR}f-zoom-ctrl-gap.png`);
  const pGap = await psnr(`${DIR}f-zoom-gap.png`, `${DIR}f-zoom-ctrl-gap.png`);
  check('E gap frame is unzoomed (matches ctrl)', pGap > 40, `PSNR=${pGap}`);
}

// --- F. One-click presets ---
{
  const base = { id: 'c', source: SPEECH_VIDEO, in: 0, out: 12.744, speed: 1, volume: 1 };
  const pip = applyTalkPreset(base, TALK_PRESETS['talking-round-pip'], tinyItems);
  check('F round-pip: circle mask + lowerThird + subtitles attached',
    pip.mask?.shape === 'circle' && pip.subtitleStyle?.fontsize === 40 && (pip.subtitles?.length ?? 0) === tinyItems.length,
    `mask=${pip.mask?.shape} zoomKeys=${(pip.zoom ?? []).length}`);
  check('F round-pip: zoom keys from subtitles', (pip.zoom ?? []).length >= 3 && countScalePushes(pip.zoom ?? [], 1.3) >= 1,
    `keys=${(pip.zoom ?? []).length} pushes=${countScalePushes(pip.zoom ?? [], 1.3)}`);
  const big = applyTalkPreset(base, TALK_PRESETS['talking-big-text'], tinyItems);
  check('F big-text: no mask, emphasis style, 1.4 push',
    big.mask === undefined && big.subtitleStyle?.fontsize === 96
    && Math.max(...(big.zoom ?? []).map((k) => k.scale)) === 1.4,
    `mask=${String(big.mask)} maxScale=${Math.max(...(big.zoom ?? []).map((k) => k.scale))}`);
  const kara = applyTalkPreset(base, TALK_PRESETS['vertical-karaoke'], tinyItems);
  check('F karaoke: no clip subtitles (project ASS instead), zoom present',
    kara.subtitles === undefined && (kara.zoom ?? []).length >= 3,
    `clipSubtitles=${String(kara.subtitles)} keys=${(kara.zoom ?? []).length}`);
  const rt = parseTalkPreset(serializeTalkPreset(TALK_PRESETS['talking-round-pip']));
  check('F preset JSON round-trip identical',
    JSON.stringify(rt) === JSON.stringify(TALK_PRESETS['talking-round-pip']));
  // Export the round-pip preset on the real speech video.
  const ctrlSpeech = { ...base720, clips: [{ id: 'c', source: SPEECH_VIDEO, in: 0, out: 12.744, speed: 1, volume: 1 }], transitions: [] };
  await exportProject(ctrlSpeech, `${DIR}p1-preset-ctrl.mp4`, { preset: PRESETS['720p30'], fontfile: FONT_CJK });
  const pipProj = { ...base720, clips: [pip], transitions: [] };
  const rep = await exportProject(pipProj, `${DIR}p1-preset-pip.mp4`, { preset: PRESETS['720p30'], fontfile: FONT_CJK });
  check('F preset-pip export duration', rep.durationError < 0.3, `err=${rep.durationError.toFixed(2)}s`);
  check('F preset-pip has audio', rep.actual.hasAudio);
  const yCtrlOn = await yavg(`${DIR}p1-preset-ctrl.mp4`, 2.0, '1280:120:0:600');
  const yPipOn = await yavg(`${DIR}p1-preset-pip.mp4`, 2.0, '1280:120:0:600');
  check('F preset-pip subtitle visible at t=2.0', Math.abs(yPipOn - yCtrlOn) > 2, `YAVG pip=${yPipOn} ctrl=${yCtrlOn}`);
  // Vertical karaoke preset: 9:16 canvas, project-level ASS subtitles.
  const vClip = applyTalkPreset(
    { id: 'c', source: VSRC, in: 0, out: 4, speed: 1, volume: 1 },
    TALK_PRESETS['vertical-karaoke'], [tinyItems[0]],
  );
  const vProj = { version: 1, width: 1080, height: 1920, fps: 30, transitionDuration: 0.5,
    clips: [vClip], transitions: [], subtitles: [tinyItems[0]] };
  const repV = await exportProject(vProj, `${DIR}p1-preset-vertical.mp4`, { preset: PRESETS['douyin-9x16'], fontfile: FONT_CJK });
  check('F vertical-karaoke duration ~4.0s', repV.durationError < 0.3, `err=${repV.durationError.toFixed(2)}s`);
  check('F vertical-karaoke resolution 1080x1920', repV.actual.width === 1080 && repV.actual.height === 1920);
  check('F vertical-karaoke has audio', repV.actual.hasAudio);
  const assText = readFileSync(`${DIR}p1-preset-vertical.mp4.ass`, 'utf8');
  check('F vertical-karaoke ASS has word tags', assText.includes('{\\k'), `${(assText.match(/\\k\d+/g) || []).length} \\k tags`);
}

// --- G. Graph-string checks ---
{
  const mask = { shape: 'circle', x: 0.78, y: 0.72, w: 0.26, h: 0.26, feather: 12 };
  const p = { ...base720, clips: [clip2('c', 0, 4, { mask })], transitions: [] };
  const g = buildFilterGraph(p, FONT, undefined, undefined, new Map([[0, [`${DIR}p1-mask-circle.png`]]]));
  check('G graph: alphamerge + alphaextract + overlay', g.filterComplex.includes('alphamerge')
    && g.filterComplex.includes('alphaextract') && g.filterComplex.includes('overlay=832:352'),
    `extraInputs=${g.extraInputs.length}`);
  check('G graph: 1 extra input', g.extraInputs.length === 1);
  let threw = '';
  try {
    buildFilterGraph(p, FONT);
  } catch (e) {
    threw = e.message;
  }
  check('G mask without prepared PNG throws clearly', /prepareClipMaskFiles/.test(threw), threw.slice(0, 80));
}

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? 'ALL P1 CHECKS PASSED' : `${failed} P1 CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
