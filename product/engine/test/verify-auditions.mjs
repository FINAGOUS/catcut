// W10 per-clip audition alternates verification (auditions.ts).
// Covers: add/remove/rename/update/setActive (incl. every throw),
// resolveClip / resolveProjectAuditions (legacy + multitrack),
// old-format compat (no auditions field -> single implicit audition),
// JSON round-trip persistence, migrateAlternatesToAuditions, and
// the export proof: the ACTIVE audition is what ffmpeg renders
// (frame colour + duration), switching changes the render, and a
// dangling activeAuditionId throws before any ffmpeg work.
//
// Measurement method (fixtures measured first, same as the
// multitrack suite): mt-red/mt-green/mt-blue.mp4 are solid-colour
// 320x180 4 s videos with sine audio. Solid green reads (0,127,0)
// and solid red (255,0,0) through yuv420p within ±5 per channel,
// so pixel asserts use a ±5 tolerance on the centre pixel (160,90).
// Export preset is a 320x180 custom preset so pxAt's 320-wide
// offset math holds. The legacy `alternates` mechanism
// (switchAlternate) is checked for back-compat, not re-proved.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  addAudition,
  clipDuration,
  exportProject,
  getActiveAudition,
  listAuditions,
  migrateAlternatesToAuditions,
  normalizeProjectAuditions,
  probe,
  projectDuration,
  removeAudition,
  renameAudition,
  resolveClip,
  resolveProjectAuditions,
  setActiveAudition,
  switchAlternate,
  updateAudition,
  validateAuditions,
} from '../dist/export.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const RED = `${DIR}mt-red.mp4`;
const GREEN = `${DIR}mt-green.mp4`;
const BLUE = `${DIR}mt-blue.mp4`;
const P320 = { name: 'aud-320', width: 320, height: 180, fps: 30, crf: 20, preset: 'veryfast', audioBitrate: '160k' };

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
const closePx = (px, target, tol = 5) =>
  px.length === 3 && px.every((v, i) => Math.abs(v - target[i]) <= tol);

const mkClip = (id, source, dur = 2, extra = {}) => ({
  id, source, in: 0, out: dur, speed: 1, volume: 1, ...extra,
});
const mkProject = (clips) => ({
  version: 1, width: 320, height: 180, fps: 30,
  clips, transitions: clips.slice(1).map(() => 'cut'), transitionDuration: 0.5,
});
const mkTrackClip = (clip, start) => ({ ...clip, start });
const mkMtProject = (videoClips, audioClips = []) => ({
  version: 1, width: 320, height: 180, fps: 30,
  clips: [], transitions: [], transitionDuration: 0.5,
  tracks: {
    video: [{ id: 'v0', clips: videoClips }],
    audio: audioClips.length > 0 ? [{ id: 'a0', clips: audioClips }] : [],
  },
});
const greenAud = (id = 'aud-g', name = '备选 · 绿') => ({
  id, name, override: { source: GREEN, in: 0, out: 2 },
});

async function main() {
  // --- model: add / validate -------------------------------------------
  const base = mkClip('c0', RED, 2);
  const withAud = addAudition(base, greenAud());
  check('addAudition stores the version',
    withAud.auditions?.length === 1 && withAud.auditions[0].id === 'aud-g' &&
    withAud.auditions[0].name === '备选 · 绿',
    `auditions=${withAud.auditions?.length}`);
  check('addAudition does not mutate the base clip',
    base.auditions === undefined && base.source === RED && base.in === 0 && base.out === 2);
  check('addAudition duplicate id throws',
    throwsSync(() => addAudition(withAud, greenAud()), /duplicate audition id/));
  check('addAudition empty name throws',
    throwsSync(() => addAudition(base, { id: 'a1', name: '  ', override: { source: GREEN, in: 0, out: 2 } }), /non-empty name/));
  check('addAudition empty range throws',
    throwsSync(() => addAudition(base, { id: 'a1', name: 'x', override: { source: GREEN, in: 2, out: 2 } }), /empty range/));
  check('addAudition empty source throws',
    throwsSync(() => addAudition(base, { id: 'a1', name: 'x', override: { source: '', in: 0, out: 2 } }), /non-empty source/));
  check('addAudition forbidden override key throws',
    throwsSync(() => addAudition(base, { id: 'a1', name: 'x', override: { source: GREEN, in: 0, out: 2, auditions: [] } }), /must not carry "auditions"/));

  // --- model: switch / resolve -----------------------------------------
  check('setActiveAudition unknown id throws',
    throwsSync(() => setActiveAudition(withAud, 'nope'), /no audition "nope"/));
  const active = setActiveAudition(withAud, 'aud-g');
  check('getActiveAudition: undefined for base, audition after set',
    getActiveAudition(withAud) === undefined &&
    getActiveAudition(active)?.id === 'aud-g');
  const cleared = setActiveAudition(active, null);
  check('setActiveAudition(null) clears to the base clip',
    cleared.activeAuditionId === undefined && resolveClip(cleared).source === RED);
  const resolvedBase = resolveClip(withAud);
  check('resolveClip with no active audition returns the base clip',
    resolvedBase.source === RED && resolvedBase.in === 0 && resolvedBase.out === 2 &&
    resolvedBase.id === 'c0');
  const resolvedActive = resolveClip(active);
  const resSpeed = resolveClip(setActiveAudition(addAudition(
    mkClip('c1', RED, 2),
    { id: 'a1', name: 'v', override: { source: GREEN, in: 1, out: 3, speed: 2, volume: 0.5 } },
  ), 'a1'));
  check('resolveClip active applies source/in/out/speed/volume, keeps the base id',
    resSpeed.source === GREEN && resSpeed.in === 1 && resSpeed.out === 3 &&
    resSpeed.speed === 2 && resSpeed.volume === 0.5 && resSpeed.id === 'c1' &&
    resolvedActive.source === GREEN && resolvedActive.in === 0 && resolvedActive.out === 2 &&
    resolvedActive.id === 'c0', `source=${resolvedActive.source} speed=${resSpeed.speed}`);
  check('resolveClip strips audition fields (re-resolve is a no-op)',
    resolvedActive.auditions === undefined && resolvedActive.activeAuditionId === undefined &&
    resolveClip(resolvedActive).source === GREEN);
  check('resolveClip dangling activeAuditionId throws',
    throwsSync(() => resolveClip({ ...withAud, activeAuditionId: 'ghost' }), /names no stored audition/));

  // --- model: remove / rename / update ---------------------------------
  const removedActive = removeAudition(active, 'aud-g');
  check('removeAudition of the active version falls back to base',
    removedActive.auditions?.length === 0 && removedActive.activeAuditionId === undefined &&
    resolveClip(removedActive).source === RED);
  check('removeAudition unknown id throws',
    throwsSync(() => removeAudition(withAud, 'nope'), /no audition "nope"/));
  const two = addAudition(withAud, { id: 'aud-b', name: '备选 · 蓝', override: { source: BLUE, in: 0, out: 2 } });
  const twoActive = setActiveAudition(two, 'aud-g');
  const removedOther = removeAudition(twoActive, 'aud-b');
  check('removeAudition of a non-active version keeps the selection',
    removedOther.activeAuditionId === 'aud-g' && resolveClip(removedOther).source === GREEN);
  const renamed = renameAudition(two, 'aud-b', '蓝版');
  check('renameAudition changes the name',
    renamed.auditions?.find((a) => a.id === 'aud-b')?.name === '蓝版');
  check('renameAudition empty name throws',
    throwsSync(() => renameAudition(two, 'aud-b', ''), /non-empty name/));
  const updated = updateAudition(two, 'aud-b', { override: { in: 1, out: 3 } });
  check('updateAudition patches the override window',
    updated.auditions?.find((a) => a.id === 'aud-b')?.override.in === 1 &&
    updated.auditions?.find((a) => a.id === 'aud-b')?.override.out === 3 &&
    updated.auditions?.find((a) => a.id === 'aud-b')?.override.source === BLUE);
  check('updateAudition with an invalid patch throws and leaves the clip unchanged',
    throwsSync(() => updateAudition(two, 'aud-b', { override: { out: 0 } }), /empty range/) &&
    two.auditions?.find((a) => a.id === 'aud-b')?.override.out === 2);
  const listed = listAuditions(two);
  listed.push({ id: 'fake', name: 'fake', override: { source: RED, in: 0, out: 1 } });
  check('listAuditions returns a copy',
    listAuditions(two).length === 2 && (two.auditions?.length ?? 0) === 2);

  // --- project-level resolve: legacy + multitrack ----------------------
  const pLegacy = mkProject([
    setActiveAudition(addAudition(mkClip('c0', RED, 2), greenAud('g0', '绿')), 'g0'),
    mkClip('c1', BLUE, 2),
  ]);
  const rLegacy = resolveProjectAuditions(pLegacy);
  check('resolveProjectAuditions resolves every legacy clip',
    rLegacy.clips[0].source === GREEN && rLegacy.clips[1].source === BLUE &&
    rLegacy.clips[0].auditions === undefined);
  check('resolveProjectAuditions leaves the input project untouched',
    pLegacy.clips[0].source === RED && pLegacy.clips[0].activeAuditionId === 'g0');
  const pMt = mkMtProject(
    [mkTrackClip(setActiveAudition(addAudition(mkClip('v0', RED, 2), greenAud()), 'aud-g'), 0)],
    [mkTrackClip(mkClip('a0', BLUE, 2), 0)],
  );
  const rMt = resolveProjectAuditions(pMt);
  check('resolveProjectAuditions resolves multitrack video+audio clips, keeps track start',
    rMt.tracks?.video[0].clips[0].source === GREEN &&
    rMt.tracks?.video[0].clips[0].start === 0 &&
    (rMt.tracks?.audio[0].clips[0].source ?? '') === BLUE);

  // --- old-format compat + JSON persistence ----------------------------
  const oldProject = mkProject([mkClip('c0', RED, 2), mkClip('c1', GREEN, 2)]);
  const oldParsed = JSON.parse(JSON.stringify(oldProject));
  check('old format (no auditions) normalizes and resolves unchanged',
    normalizeProjectAuditions(oldParsed) === oldParsed &&
    resolveProjectAuditions(oldParsed).clips[0].source === RED &&
    projectDuration(resolveProjectAuditions(oldParsed)) === projectDuration(oldProject));
  const withAudProject = mkProject([
    setActiveAudition(addAudition(mkClip('c0', RED, 2), greenAud()), 'aud-g'),
  ]);
  const roundTripped = JSON.parse(JSON.stringify(withAudProject));
  check('JSON round-trip keeps the active audition',
    roundTripped.clips[0].activeAuditionId === 'aud-g' &&
    resolveProjectAuditions(roundTripped).clips[0].source === GREEN);
  check('duration follows the active audition after resolve',
    projectDuration(resolveProjectAuditions(mkProject([
      setActiveAudition(addAudition(mkClip('c0', RED, 2),
        { id: 'a3', name: '长版', override: { source: GREEN, in: 0, out: 3 } }), 'a3'),
    ]))) === 3 && clipDuration(mkClip('c0', RED, 2)) === 2);

  // --- migration from legacy alternates --------------------------------
  const altClip = { ...mkClip('c0', RED, 2), alternates: [
    { source: GREEN, in: 0, out: 2 },
    { source: BLUE, in: 1, out: 3 },
  ] };
  const migrated = migrateAlternatesToAuditions(altClip);
  check('migrateAlternatesToAuditions converts alternates to named auditions',
    migrated.auditions?.length === 2 &&
    migrated.auditions[0].id === 'aud-1' && migrated.auditions[0].name === '备选 1' &&
    migrated.auditions[1].override.source === BLUE &&
    migrated.alternates === undefined && migrated.source === RED);
  check('migrated auditions switch and resolve',
    resolveClip(setActiveAudition(migrated, 'aud-2')).source === BLUE &&
    resolveClip(setActiveAudition(migrated, 'aud-2')).in === 1);
  check('migrateAlternatesToAuditions throws when auditions already exist',
    throwsSync(() => migrateAlternatesToAuditions(withAud), /already has auditions/));
  check('migrateAlternatesToAuditions is a no-op without alternates',
    JSON.stringify(migrateAlternatesToAuditions(mkClip('c0', RED, 2))) ===
    JSON.stringify(mkClip('c0', RED, 2)));
  const switched = switchAlternate(altClip, 1);
  check('legacy switchAlternate still works on unmigrated clips',
    switched.source === BLUE && switched.in === 1 && switched.out === 3 &&
    switched.alternates?.[1].source === RED);

  // --- export: the ACTIVE audition is what renders ---------------------
  const expAud = async (project, out) =>
    exportProject(project, `${DIR}${out}`, { fontfile: FONT, preset: P320 });
  const pGreen = mkProject([
    setActiveAudition(addAudition(mkClip('c0', RED, 2), greenAud()), 'aud-g'),
  ]);
  const repGreen = await expAud(pGreen, 'aud-green.mp4');
  const pxGreen = await pxAt(`${DIR}aud-green.mp4`, 1, 160, 90);
  check('export renders the ACTIVE audition (green)',
    close(repGreen.actual.duration, 2, 0.05) && closePx(pxGreen, [0, 128, 0]),
    `dur=${repGreen.actual.duration.toFixed(3)} px=${pxGreen}`);
  const repRed = await expAud(mkProject([mkClip('c0', RED, 2)]), 'aud-red.mp4');
  const pxRed = await pxAt(`${DIR}aud-red.mp4`, 1, 160, 90);
  check('export renders the base clip when no audition is active (red)',
    close(repRed.actual.duration, 2, 0.05) && closePx(pxRed, [255, 0, 0]),
    `dur=${repRed.actual.duration.toFixed(3)} px=${pxRed}`);
  const pWindow = mkProject([
    setActiveAudition(addAudition(mkClip('c0', RED, 2),
      { id: 'aw', name: '绿窗', override: { source: GREEN, in: 1, out: 3 } }), 'aw'),
  ]);
  const repWindow = await expAud(pWindow, 'aud-window.mp4');
  const pxWindow = await pxAt(`${DIR}aud-window.mp4`, 1, 160, 90);
  check('export follows the audition window (green 1..3s, 2s long)',
    close(repWindow.actual.duration, 2, 0.05) && closePx(pxWindow, [0, 128, 0]),
    `dur=${repWindow.actual.duration.toFixed(3)} px=${pxWindow}`);
  check('export with a dangling activeAuditionId throws before ffmpeg',
    await throwsAsync(() => expAud(mkProject([
      { ...withAud, activeAuditionId: 'ghost' },
    ]), 'aud-ghost.mp4'), /names no stored audition/));
  const repMt = await expAud(mkMtProject(
    [mkTrackClip(setActiveAudition(addAudition(mkClip('v0', RED, 2), greenAud()), 'aud-g'), 0)],
  ), 'aud-mt.mp4');
  const pxMt = await pxAt(`${DIR}aud-mt.mp4`, 1, 160, 90);
  check('multitrack export renders the active audition (green)',
    close(repMt.actual.duration, 2, 0.05) && closePx(pxMt, [0, 128, 0]),
    `dur=${repMt.actual.duration.toFixed(3)} px=${pxMt}`);

  // validateAuditions is the load gate: bad sets throw, good sets pass.
  check('validateAuditions accepts a good set and the old format',
    (() => { validateAuditions(withAud); validateAuditions(mkClip('c9', RED, 2)); return true; })());
}

await main();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${checks.length} passed`);
for (const [name, ok] of checks) if (!ok) console.log(`FAIL: ${name}`);
if (passed !== checks.length) process.exit(1);
