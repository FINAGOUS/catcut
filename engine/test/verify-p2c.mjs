// P2 batch 3 engine verification (M4, 2026-11-17, LAST P2 batch).
// Covers: Roles (src/roles.ts — FCP-style role-based mixing: each
// clip's audio belongs to a role, per-role gain dB / pan -1..1 / mute /
// solo, mix mode + per-role stems as extra audio tracks in one MP4)
// + proxy editing (src/proxy.ts — 720p low-bitrate proxy generation,
// project proxy refs, export auto-relinks to the original, a missing
// proxy is a hard error, never a silent fallback).
//
// Measurement method (written down so the numbers can be re-derived):
// - Determinism probe was run BEFORE writing assertions (the vidstab
//   lesson). tmp/probe-p2c.mjs: sine sources (dialogue 440 Hz mono,
//   music 660 Hz mono, both -21.1 dB mean volume), the same stems
//   export 3x — every value bit-identical (dur 8.00/8.02/8.00 s,
//   dialogue stem dialogue window -21.1 dB each time; stems-fade dur
//   7.50/7.52 s). This test re-exports the stems project and asserts
//   identical duration and stem volume, so a future nondeterminism
//   fails loudly.
// - Audio windows: dialogue clip occupies 0-4 s, music 4-8 s. Dialogue
//   window = -ss 1 -t 2, music window = -ss 5 -t 2, both clear of the
//   0.5 s crossfade in the stems-fade project (fade ends at 4.25 s).
// - Pan is measured per channel with astats RMS (not volumedetect,
//   which mixes channels): hard-left pan must read L -21.1 +-0.5 dB
//   and R < -60 dB; the untouched dialogue window must read the same
//   on both channels.
// - "Muted" asserts use < -60 dB because digital silence measures
//   -91.0 dB with volumedetect, not -inf (probe 2026-11-17).
// - Stems are checked against the mix in the SAME export (mix track
//   0:a:0, dialogue stem 0:a:1, music stem 0:a:2) and against each
//   other: a stem's own-role window must match the mix's window within
//   0.5 dB, and its other-role window must be < -60 dB.
// - Proxy PSNR uses the psnr filter on full frames at t=2 s (same
//   method as the probe): attached-proxy export vs direct export must
//   be 999 (bit-identical — proves the relink), proxy-as-source export
//   vs direct must be >= 35 and < 999 (proves the proxy is genuinely
//   lower quality, not a copy of the original).
// - Two design findings from the probe are baked into the code and
//   asserted here: (1) the role chain normalises to 48 kHz stereo
//   (mono duplicated with pan at full level — aformat costs 3 dB),
//   otherwise concat downmixes a stereo clip to mono behind a mono
//   clip and a hard-panned clip loses 3 dB (measured -23.99 dB);
//   (2) a filter output feeding two downstream filters without an
//   explicit split costs exactly 3.0 dB in the second consumer
//   (measured -24.1 vs -21.1, reproduced in PCM, fixed by asplit —
//   the stems use [arm<i>] for the mix and [ars<i>_<j>] per stem).
// - LGPL: volume / pan / aresample / anullsrc / asplit / concat /
//   acrossfade / scale / libx264 are native libavfilter/libx264
//   (LGPL part for the filters; libx264 is GPL — the proxy encoder is
//   libx264 because the whole engine encodes with it, see M2 gate).
//   Only verified on the local GPL 8.1.2 build; re-check on the BtbN
//   LGPL 9.0 build at the M2 gate.
// Old M1 / P0 / P0b / P1 / P1b / P1c / P1d / P1e / P2a / P2b checks
// live in their own files and must still pass.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  BUILTIN_ROLES,
  DEFAULT_ROLE,
  effectiveMute,
  exportProject,
  generateProxy,
  panGains,
  PRESETS,
  prepareRoleAudio,
  probe,
  probeAudioChannels,
  resolveRoleConfigs,
  roleFilter,
  useProxies,
  validateProxies,
  validateRoles,
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

async function meanVolume(file, ss, dur, stream = 0) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', file, '-map', `0:a:${stream}`, '-t', String(dur),
    '-af', 'volumedetect', '-vn', '-f', 'null', '-',
  ]).catch((e) => e);
  const m = ((r.stderr ?? '') + (r.stdout ?? '')).match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : null;
}

/** Per-channel RMS dB via astats ({ l, r } or null). */
async function channelVolumes(file, ss, dur, stream = 0) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', file, '-map', `0:a:${stream}`, '-t', String(dur),
    '-af', 'astats=metadata=1:reset=1', '-vn', '-f', 'null', '-',
  ]).catch((e) => e);
  const text = String((r.stderr ?? '') + (r.stdout ?? ''));
  const rms = [...text.matchAll(/RMS level dB:\s*(-?[\d.]+|-\s*inf)/g)]
    .map((m) => (m[1].includes('inf') ? -Infinity : Number(m[1])));
  if (rms.length < 2) return null;
  return { l: rms[0], r: rms[1] };
}

async function streamCounts(file) {
  const r = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,channels',
    '-of', 'json', file,
  ]).catch((e) => e);
  const j = JSON.parse(String(r.stdout ?? '{}'));
  const counts = { video: 0, audio: 0, audioChannels: [] };
  for (const s of j.streams ?? []) {
    if (s.codec_type === 'video') counts.video++;
    if (s.codec_type === 'audio') { counts.audio++; counts.audioChannels.push(s.channels); }
  }
  return counts;
}

async function bitrate(file) {
  const r = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=bit_rate', '-of', 'csv=p=0', file,
  ]).catch((e) => e);
  return Number(String(r.stdout ?? '').trim());
}

async function psnrAt(a, b, ss) {
  const r = await run('ffmpeg', [
    '-ss', String(ss), '-i', a, '-ss', String(ss), '-i', b,
    '-filter_complex', '[0:v][1:v]psnr', '-frames:v', '1', '-f', 'null', '-',
  ]).catch((e) => e);
  const m = ((r.stderr ?? '') + (r.stdout ?? '')).match(/average:([0-9.inf]+)/);
  if (!m) return NaN;
  return m[1] === 'inf' ? 999 : Number(m[1]);
}

const base = { version: 1, width: 640, height: 360, fps: 30, transitions: [], transitionDuration: 0.5 };
const clip = (id, source, extra = {}) => ({ id, source, in: 0, out: 4, speed: 1, volume: 1, ...extra });
const throwsWith = async (fn, re) => {
  try { await fn(); return false; } catch (e) { return re.test(e.message); }
};
const throwsSync = (fn, re) => {
  try { fn(); return false; } catch (e) { return re.test(e.message); }
};
const close = (v, target, tol = 0.5) => v !== null && Math.abs(v - target) <= tol;

// --- 0. validation + API (no encode) ---
{
  check('roles: 4 builtin roles', JSON.stringify(BUILTIN_ROLES) === JSON.stringify(['dialogue', 'music', 'effects', 'narration']), JSON.stringify(BUILTIN_ROLES));
  check('roles: default role is dialogue', DEFAULT_ROLE === 'dialogue');
  const cfg = resolveRoleConfigs({ ...base, clips: [clip('d', '/tmp/x.mp4', { role: 'dialogue' })] });
  const dlg = cfg.get('dialogue');
  check('roles: builtin defaults gain 0 / pan 0 / unmuted / unsoloed',
    dlg.gainDb === 0 && dlg.pan === 0 && dlg.mute === false && dlg.solo === false, JSON.stringify(dlg));
  const cfg2 = resolveRoleConfigs({ ...base, clips: [clip('d', '/tmp/x.mp4', { role: 'dialogue' })], roles: [{ name: 'dialogue', gainDb: -3 }] });
  check('roles: project.roles overrides gain', cfg2.get('dialogue').gainDb === -3 && cfg2.get('dialogue').pan === 0);
  check('roles: custom role config in project.roles is accepted (not an error)',
    !throwsSync(() => validateRoles({ ...base, clips: [clip('d', '/tmp/x.mp4', { role: 'foley' })], roles: [{ name: 'foley' }] }), /./));
  check('roles: unknown clip role throws',
    throwsSync(() => validateRoles({ ...base, clips: [clip('d', '/tmp/x.mp4', { role: 'nope' })] }), /unknown role "nope"/));
  check('roles: duplicate role config throws',
    throwsSync(() => validateRoles({ ...base, clips: [], roles: [{ name: 'music' }, { name: 'music' }] }), /duplicate role config/));
  check('roles: pan 1.5 throws',
    throwsSync(() => validateRoles({ ...base, clips: [], roles: [{ name: 'music', pan: 1.5 }] }), /pan 1\.5 outside \[-1, 1\]/));
  check('roles: gain -70 throws',
    throwsSync(() => validateRoles({ ...base, clips: [], roles: [{ name: 'music', gainDb: -70 }] }), /gainDb -70 outside \[-60, 12\]/));
  check('roles: gain 13 throws',
    throwsSync(() => validateRoles({ ...base, clips: [], roles: [{ name: 'music', gainDb: 13 }] }), /gainDb 13 outside \[-60, 12\]/));
  check('roles: empty role name throws',
    throwsSync(() => validateRoles({ ...base, clips: [], roles: [{ name: '' }] }), /non-empty string name/));
  check('roles: empty clip role throws',
    throwsSync(() => validateRoles({ ...base, clips: [clip('d', '/tmp/x.mp4', { role: '' })] }), /non-empty string/));
  const g = panGains(-1);
  check('roles: panGains(-1) = {1, 0}', g.lg === 1 && g.rg === 0, JSON.stringify(g));
  const g1 = panGains(1);
  check('roles: panGains(1) = {0, 1}', g1.lg === 0 && g1.rg === 1, JSON.stringify(g1));
  const g0 = panGains(0);
  check('roles: panGains(0) = {1, 1}', g0.lg === 1 && g0.rg === 1, JSON.stringify(g0));
  const gh = panGains(-0.5);
  check('roles: panGains(-0.5) = {1, 0.5}', gh.lg === 1 && gh.rg === 0.5, JSON.stringify(gh));
  const muteCfg = new Map([['dialogue', { name: 'dialogue', gainDb: 0, pan: 0, mute: true, solo: false }], ['music', { name: 'music', gainDb: 0, pan: 0, mute: false, solo: false }]]);
  check('roles: effectiveMute true when muted', effectiveMute('dialogue', muteCfg) === true);
  const soloCfg = new Map([['dialogue', { name: 'dialogue', gainDb: 0, pan: 0, mute: false, solo: false }], ['music', { name: 'music', gainDb: 0, pan: 0, mute: false, solo: true }]]);
  check('roles: effectiveMute true for non-soloed when another is soloed', effectiveMute('dialogue', soloCfg) === true);
  check('roles: effectiveMute false for the soloed role itself', effectiveMute('music', soloCfg) === false);
  const plainCfg = new Map([['dialogue', { name: 'dialogue', gainDb: 0, pan: 0, mute: false, solo: false }]]);
  check('roles: effectiveMute false with no mute/solo', effectiveMute('dialogue', plainCfg) === false);
  const fMono = roleFilter({ name: 'dialogue', gainDb: 0, pan: 0, mute: false, solo: false }, false, 1);
  check('roles: mono default chain duplicates at full level',
    fMono === 'aresample=48000,volume=0dB,pan=stereo|c0=1*c0|c1=1*c0', fMono);
  const fStereo = roleFilter({ name: 'music', gainDb: -3, pan: -1, mute: false, solo: false }, false, 2);
  check('roles: stereo -3dB pan-1 chain',
    fStereo === 'aresample=48000,volume=-3dB,pan=stereo|c0=1*c0|c1=0*c1', fStereo);
  const fMute = roleFilter({ name: 'dialogue', gainDb: 0, pan: 0, mute: false, solo: false }, true, 1);
  check('roles: muted mono chain is stereo silence',
    fMute === 'aresample=48000,pan=stereo|c0=c0|c1=c0,volume=0', fMute);
  const fStereo0 = roleFilter({ name: 'music', gainDb: 0, pan: 0, mute: false, solo: false }, false, 2);
  check('roles: stereo pan 0 gets no pan filter', fStereo0 === 'aresample=48000,volume=0dB', fStereo0);
  const ch = await probeAudioChannels('/tmp/does-not-exist-p2c.mp4').catch(() => null);
  check('roles: probeAudioChannels on missing file throws (caught here)', ch === null);
}
{
  const proj = { ...base, clips: [clip('d', '/tmp/d.mp4', { role: 'dialogue' }), clip('m', '/tmp/m.mp4', { role: 'music' })] };
  const g = buildFilterGraph(proj, FONT, undefined, undefined, undefined, undefined, undefined, undefined, new Map([[0, 1], [1, 1]]), false);
  check('graph: mono dialogue role chain', g.filterComplex.includes('[a0]aresample=48000,volume=0dB,pan=stereo|c0=1*c0|c1=1*c0[ar0]'));
  check('graph: mono music role chain', g.filterComplex.includes('[a1]aresample=48000,volume=0dB,pan=stereo|c0=1*c0|c1=1*c0[ar1]'));
  check('graph: mix uses role streams', g.filterComplex.includes('[ar0][ar1]concat=n=2:v=0:a=1[aout]'));
  check('graph: no asplit without stems', !g.filterComplex.includes('asplit'));
  const gs = buildFilterGraph(proj, FONT, undefined, undefined, undefined, undefined, undefined, undefined, new Map([[0, 1], [1, 1]]), true);
  check('graph: stems use asplit mix branch', gs.filterComplex.includes('[ar0]asplit=2[arm0][ars0_0]'));
  check('graph: stems use asplit stem branch', gs.filterComplex.includes('[ar1]asplit=2[arm1][ars1_1]'));
  check('graph: stems mix uses arm branches', gs.filterComplex.includes('[arm0][arm1]concat=n=2:v=0:a=1[aout]'));
  check('graph: stem labels dialogue/music',
    gs.audioStems instanceof Map && gs.audioStems.get('dialogue') === '[stem0]' && gs.audioStems.get('music') === '[stem1]',
    JSON.stringify([...(gs.audioStems ?? new Map())]));
  check('graph: stems have anullsrc silence', gs.filterComplex.includes('anullsrc=r=48000:cl=stereo'));
  check('graph: unknown role throws at graph build',
    throwsSync(() => buildFilterGraph({ ...base, clips: [clip('d', '/tmp/d.mp4', { role: 'nope' })] }, FONT), /unknown role "nope"/));
  check('graph: roleStems without roles throws',
    throwsSync(() => buildFilterGraph({ ...base, clips: [clip('d', '/tmp/d.mp4')] }, FONT, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true), /roleStems requested but the project uses no roles/));
}

// --- A. test sources: dialogue 440 Hz + music 660 Hz, 4 s each ---
const SRC = {};
for (const [name, freq] of [['dlg', 440], ['mus', 660]]) {
  const f = `${DIR}p2c-${name}.mp4`;
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:duration=4:rate=30',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=4`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-t', '4', '-y', f]);
  SRC[name] = f;
  const p = await probe(f);
  check(`source: ${name} 4s 640x360 30fps with audio`, p.duration === 4 && p.width === 640 && p.fps === 30 && p.hasAudio, JSON.stringify(p));
}
await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:duration=4:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-t', '4', '-y', `${DIR}p2c-1080p.mp4`]);
SRC.hd = `${DIR}p2c-1080p.mp4`;
{
  const p = await probe(SRC.hd);
  check('source: 1080p 4s 1920x1080 30fps with audio', p.duration === 4 && p.width === 1920 && p.height === 1080 && p.fps === 30 && p.hasAudio, JSON.stringify(p));
}
const ch0 = await probeAudioChannels(SRC.dlg);
check('roles: probeAudioChannels reads mono source as 1', ch0 === 1, `channels=${ch0}`);
{
  const m = await prepareRoleAudio({ ...base, clips: [clip('d', SRC.dlg, { role: 'dialogue' }), clip('m', SRC.mus, { role: 'music' })] });
  check('roles: prepareRoleAudio maps both clips to 1 channel', m.get(0) === 1 && m.get(1) === 1, JSON.stringify([...m]));
}

const twoClip = (roles) => ({
  ...base,
  clips: [clip('d', SRC.dlg, { role: 'dialogue' }), clip('m', SRC.mus, { role: 'music' })],
  ...(roles ? { roles } : {}),
});

// --- B. mix exports ---
{
  const r = await exportProject(twoClip(), `${DIR}p2c-mix-base.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: mix-base duration err < 0.3s', Math.abs(r.durationError) < 0.3, `err=${r.durationError.toFixed(2)}s`);
  check('export: mix-base has audio', r.actual.hasAudio);
  const sc = await streamCounts(`${DIR}p2c-mix-base.mp4`);
  check('export: mix-base is stereo (48kHz mix bus)', sc.audio === 1 && sc.audioChannels[0] === 2, JSON.stringify(sc));
  const vDlg = await meanVolume(`${DIR}p2c-mix-base.mp4`, 1, 2);
  check('export: mix-base dialogue window -21.1 +-0.5 dB', close(vDlg, -21.1), `vol=${vDlg}`);
  const vMus = await meanVolume(`${DIR}p2c-mix-base.mp4`, 5, 2);
  check('export: mix-base music window -21.1 +-0.5 dB', close(vMus, -21.1), `vol=${vMus}`);
}
{
  const r = await exportProject(twoClip([{ name: 'dialogue', gainDb: -3 }]), `${DIR}p2c-mix-gain.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: mix-gain duration err < 0.3s', Math.abs(r.durationError) < 0.3, `err=${r.durationError.toFixed(2)}s`);
  const vDlg = await meanVolume(`${DIR}p2c-mix-gain.mp4`, 1, 2);
  check('export: mix-gain dialogue window -24.1 +-0.5 dB (exactly -3.0)', close(vDlg, -24.1), `vol=${vDlg}`);
  const vMus = await meanVolume(`${DIR}p2c-mix-gain.mp4`, 5, 2);
  check('export: mix-gain music window unchanged -21.1 +-0.5 dB', close(vMus, -21.1), `vol=${vMus}`);
}
{
  const r = await exportProject(twoClip([{ name: 'music', pan: -1 }]), `${DIR}p2c-mix-pan.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: mix-pan duration err < 0.3s', Math.abs(r.durationError) < 0.3, `err=${r.durationError.toFixed(2)}s`);
  const musCh = await channelVolumes(`${DIR}p2c-mix-pan.mp4`, 5, 2);
  check('export: mix-pan music window L -21.1 +-0.5 dB', musCh !== null && close(musCh.l, -21.1), `L=${musCh?.l} R=${musCh?.r}`);
  check('export: mix-pan music window R < -60 dB', musCh !== null && musCh.r < -60, `L=${musCh?.l} R=${musCh?.r}`);
  const dlgCh = await channelVolumes(`${DIR}p2c-mix-pan.mp4`, 1, 2);
  check('export: mix-pan dialogue window L/R both -21.1 +-0.5 dB',
    dlgCh !== null && close(dlgCh.l, -21.1) && close(dlgCh.r, -21.1), `L=${dlgCh?.l} R=${dlgCh?.r}`);
}
{
  const r = await exportProject(twoClip([{ name: 'dialogue', mute: true }]), `${DIR}p2c-mix-mute.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: mix-mute duration err < 0.3s', Math.abs(r.durationError) < 0.3, `err=${r.durationError.toFixed(2)}s`);
  const vDlg = await meanVolume(`${DIR}p2c-mix-mute.mp4`, 1, 2);
  check('export: mix-mute dialogue window < -60 dB (gone)', vDlg !== null && vDlg < -60, `vol=${vDlg}`);
  const vMus = await meanVolume(`${DIR}p2c-mix-mute.mp4`, 5, 2);
  check('export: mix-mute music window -21.1 +-0.5 dB', close(vMus, -21.1), `vol=${vMus}`);
}
{
  const r = await exportProject(twoClip([{ name: 'music', solo: true }]), `${DIR}p2c-mix-solo.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: mix-solo duration err < 0.3s', Math.abs(r.durationError) < 0.3, `err=${r.durationError.toFixed(2)}s`);
  const vDlg = await meanVolume(`${DIR}p2c-mix-solo.mp4`, 1, 2);
  check('export: mix-solo dialogue window < -60 dB (soloed out)', vDlg !== null && vDlg < -60, `vol=${vDlg}`);
  const vMus = await meanVolume(`${DIR}p2c-mix-solo.mp4`, 5, 2);
  check('export: mix-solo music window -21.1 +-0.5 dB', close(vMus, -21.1), `vol=${vMus}`);
}

// --- C. stems exports ---
{
  const r = await exportProject(twoClip(), `${DIR}p2c-stems.mp4`, { preset: PRESETS['720p30'], fontfile: FONT, roleStems: true });
  check('export: stems duration err < 0.3s', Math.abs(r.durationError) < 0.3, `err=${r.durationError.toFixed(2)}s`);
  check('export: stems report lists dialogue+music', JSON.stringify(r.audioStems) === JSON.stringify(['dialogue', 'music']), JSON.stringify(r.audioStems));
  const sc = await streamCounts(`${DIR}p2c-stems.mp4`);
  check('export: stems file has 1 video + 3 audio streams (mix + 2 stems)', sc.video === 1 && sc.audio === 3, JSON.stringify(sc));
  const mixDlg = await meanVolume(`${DIR}p2c-stems.mp4`, 1, 2, 0);
  check('export: stems mix dialogue window -21.1 +-0.5 dB', close(mixDlg, -21.1), `vol=${mixDlg}`);
  const mixMus = await meanVolume(`${DIR}p2c-stems.mp4`, 5, 2, 0);
  check('export: stems mix music window -21.1 +-0.5 dB', close(mixMus, -21.1), `vol=${mixMus}`);
  const dlgDlg = await meanVolume(`${DIR}p2c-stems.mp4`, 1, 2, 1);
  check('export: dialogue stem dialogue window -21.1 +-0.5 dB', close(dlgDlg, -21.1), `vol=${dlgDlg}`);
  const dlgMus = await meanVolume(`${DIR}p2c-stems.mp4`, 5, 2, 1);
  check('export: dialogue stem music window < -60 dB', dlgMus !== null && dlgMus < -60, `vol=${dlgMus}`);
  const musDlg = await meanVolume(`${DIR}p2c-stems.mp4`, 1, 2, 2);
  check('export: music stem dialogue window < -60 dB', musDlg !== null && musDlg < -60, `vol=${musDlg}`);
  const musMus = await meanVolume(`${DIR}p2c-stems.mp4`, 5, 2, 2);
  check('export: music stem music window -21.1 +-0.5 dB (no -3dB split loss)', close(musMus, -21.1), `vol=${musMus}`);
  // Determinism: re-export the same stems project; duration + stem level must match.
  const r2 = await exportProject(twoClip(), `${DIR}p2c-stems-again.mp4`, { preset: PRESETS['720p30'], fontfile: FONT, roleStems: true });
  const dlgDlg2 = await meanVolume(`${DIR}p2c-stems-again.mp4`, 1, 2, 1);
  check('probe: stems re-export duration identical', r2.actual.duration === r.actual.duration, `dur=${r2.actual.duration} vs ${r.actual.duration}`);
  check('probe: stems re-export dialogue stem volume identical', dlgDlg2 === dlgDlg, `vol=${dlgDlg2} vs ${dlgDlg}`);
}
{
  // Stems survive a crossfade transition (audio acrossfade + stem assemblies).
  const fadeProj = { ...twoClip(), transitions: ['fade'], transitionDuration: 0.5 };
  const r = await exportProject(fadeProj, `${DIR}p2c-stems-fade.mp4`, { preset: PRESETS['720p30'], fontfile: FONT, roleStems: true });
  check('export: stems-fade duration 7.5s err < 0.3s', Math.abs(r.durationError) < 0.3 && Math.abs(r.actual.duration - 7.5) < 0.3, `dur=${r.actual.duration} err=${r.durationError.toFixed(2)}`);
  const sc = await streamCounts(`${DIR}p2c-stems-fade.mp4`);
  check('export: stems-fade has 1 video + 3 audio streams', sc.video === 1 && sc.audio === 3, JSON.stringify(sc));
  const dlgDlg = await meanVolume(`${DIR}p2c-stems-fade.mp4`, 1, 2, 1);
  check('export: stems-fade dialogue stem dialogue window -21.1 +-0.5 dB', close(dlgDlg, -21.1), `vol=${dlgDlg}`);
  const musMus = await meanVolume(`${DIR}p2c-stems-fade.mp4`, 5, 2, 2);
  check('export: stems-fade music stem music window -21.1 +-0.5 dB', close(musMus, -21.1), `vol=${musMus}`);
}

// --- D. proxy editing ---
let proxyInfo;
{
  proxyInfo = await generateProxy(SRC.hd, `${DIR}p2c-proxy.mp4`);
  check('proxy: generated 1280x720', proxyInfo.width === 1280 && proxyInfo.height === 720, `${proxyInfo.width}x${proxyInfo.height}`);
  const pSrc = await probe(SRC.hd);
  const pPrx = await probe(proxyInfo.file);
  const brSrc = await bitrate(SRC.hd);
  const brPrx = await bitrate(proxyInfo.file);
  check('proxy: bitrate lower than source', brPrx < brSrc, `src=${brSrc} proxy=${brPrx}`);
  check('proxy: duration matches source within 0.1s', Math.abs(pPrx.duration - pSrc.duration) < 0.1, `src=${pSrc.duration} proxy=${pPrx.duration}`);
  check('proxy: keeps audio', pPrx.hasAudio);
  check('proxy: info duration matches source', Math.abs(proxyInfo.duration - proxyInfo.sourceDuration) < 0.1, `dur=${proxyInfo.duration} src=${proxyInfo.sourceDuration}`);
  check('proxy: generateProxy on missing source throws',
    await throwsWith(() => generateProxy('/tmp/does-not-exist.mp4', `${DIR}p2c-proxy-missing.mp4`), /failed|No such file|does not exist|ENOENT/i));
  const swapped = useProxies({ ...base, clips: [clip('a', SRC.hd, { proxy: { file: proxyInfo.file, width: 1280, height: 720 } })] });
  check('proxy: useProxies swaps source to proxy file', swapped.clips[0].source === proxyInfo.file, swapped.clips[0].source);
  const kept = useProxies({ ...base, clips: [clip('a', SRC.hd)] });
  check('proxy: useProxies keeps source when no proxy declared', kept.clips[0].source === SRC.hd);
  check('proxy: validateProxies throws on compound clip with proxy',
    await throwsWith(() => validateProxies({ ...base, clips: [{ id: 'c', source: '', in: 0, out: 2, speed: 1, volume: 1, proxy: { file: proxyInfo.file, width: 1280, height: 720 }, compound: { project: { ...base, clips: [clip('a', SRC.dlg)] } } }] }), /compound/));
  check('proxy: validateProxies throws on multicam clip with proxy',
    await throwsWith(() => validateProxies({ ...base, clips: [clip('m', SRC.dlg, { proxy: { file: proxyInfo.file, width: 1280, height: 720 }, multicam: { angles: [SRC.dlg, SRC.mus], cuts: [] } })] }), /multicam/));
  check('proxy: validateProxies throws on size mismatch',
    await throwsWith(() => validateProxies({ ...base, clips: [clip('a', SRC.hd, { proxy: { file: proxyInfo.file, width: 640, height: 360 } })] }), /size|dimension|mismatch/i));
}
{
  const hdClip = (extra = {}) => ({ id: 'a', source: SRC.hd, in: 0, out: 4, speed: 1, volume: 1, ...extra });
  const rDirect = await exportProject({ ...base, clips: [hdClip()] }, `${DIR}p2c-direct.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: direct 1080p export duration err < 0.3s', Math.abs(rDirect.durationError) < 0.3, `err=${rDirect.durationError.toFixed(2)}s`);
  const rAttached = await exportProject(
    { ...base, clips: [hdClip({ proxy: { file: proxyInfo.file, width: 1280, height: 720 } })] },
    `${DIR}p2c-attached.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
  );
  check('export: proxy-attached export duration err < 0.3s', Math.abs(rAttached.durationError) < 0.3, `err=${rAttached.durationError.toFixed(2)}s`);
  const psnrRelink = await psnrAt(`${DIR}p2c-attached.mp4`, `${DIR}p2c-direct.mp4`, 2);
  check('export: proxy-attached vs direct PSNR 999 (relink is exact)', psnrRelink === 999, `PSNR=${psnrRelink}`);
  const rProxySrc = await exportProject({ ...base, clips: [hdClip({ source: proxyInfo.file })] }, `${DIR}p2c-proxy-src.mp4`, { preset: PRESETS['720p30'], fontfile: FONT });
  check('export: proxy-as-source export duration err < 0.3s', Math.abs(rProxySrc.durationError) < 0.3, `err=${rProxySrc.durationError.toFixed(2)}s`);
  const psnrProxy = await psnrAt(`${DIR}p2c-proxy-src.mp4`, `${DIR}p2c-direct.mp4`, 2);
  check('export: proxy-as-source vs direct PSNR >= 35 and < 999', Number.isFinite(psnrProxy) && psnrProxy >= 35 && psnrProxy < 999, `PSNR=${psnrProxy}`);
  check('reject: missing proxy file throws at export (no silent fallback)',
    await throwsWith(() => exportProject(
      { ...base, clips: [hdClip({ proxy: { file: `${DIR}p2c-proxy-gone.mp4`, width: 1280, height: 720 } })] },
      `${DIR}p2c-missing.mp4`, { preset: PRESETS['720p30'], fontfile: FONT },
    ), /proxy/i));
}

// --- report ---
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exit(1);
