// End-to-end engine verification (no test framework needed).
// 1. Generates a 10s test source (video test pattern + 440Hz tone).
// 2. Exports a 3-clip project: text overlay, 2x speed, 0.5x + zoom 1.0->1.6,
//    with a 0.5s fade between clip 1 and 2 and a cut between 2 and 3.
// 3. Checks the output with ffprobe: duration, resolution, fps, audio,
//    and checks the zoomed section is not black.
// Expected timeline: 3 + (3/2) + (4/0.5) - 0.5 fade = 12.0s.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { exportProject, PRESETS, probe } from '../dist/export.js';

const exec = promisify(execFile);
const DIR = new URL('.', import.meta.url).pathname;
const SRC = `${DIR}source.mp4`;
const OUT = `${DIR}export-720p30.mp4`;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

const checks = [];
const check = (name, ok, detail = '') =>
  checks.push([`${name}${detail ? ` (${detail})` : ''}`, ok]);

await exec('ffmpeg', [
  '-f', 'lavfi', '-i', 'testsrc2=duration=10:size=1280x720:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', SRC,
]);

const project = {
  version: 1,
  width: 1280,
  height: 720,
  fps: 30,
  clips: [
    {
      id: 'c1', source: SRC, in: 0, out: 3, speed: 1, volume: 1,
      text: [{ text: 'Hello DogSC', x: 0.5, y: 0.85, fontsize: 48, fontcolor: 'white', start: 0, end: 3 }],
    },
    { id: 'c2', source: SRC, in: 3, out: 6, speed: 2, volume: 1 },
    {
      id: 'c3', source: SRC, in: 6, out: 10, speed: 0.5, volume: 1,
      zoom: [
        { t: 0, cx: 0.5, cy: 0.5, scale: 1.0 },
        { t: 8, cx: 0.5, cy: 0.5, scale: 1.6 },
      ],
    },
  ],
  transitions: ['fade', 'cut'],
  transitionDuration: 0.5,
};
writeFileSync(`${DIR}project.json`, JSON.stringify(project, null, 2));

const report = await exportProject(project, OUT, { preset: PRESETS['720p30'], fontfile: FONT });
console.log('report:', JSON.stringify(report, null, 2));

check('duration ~12.0s', report.durationError < 0.3, `err=${report.durationError.toFixed(2)}s`);
check('resolution 1280x720', report.actual.width === 1280 && report.actual.height === 720);
check('fps 30', Math.abs(report.actual.fps - 30) < 0.5, `fps=${report.actual.fps}`);
check('has audio', report.actual.hasAudio);
check('codec h264', report.actual.codec === 'h264');

// Zoomed section (t≈11s, inside clip 3) must not be black: sample frame luma
// (FFmpeg 8: signalstats values only surface via metadata=print, on stderr).
const sig = await exec('ffmpeg', [
  '-ss', '11', '-i', OUT, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
  '-frames:v', '1', '-f', 'null', '-',
]);
const yavg = Number(((sig.stderr ?? '').match(/lavfi\.signalstats\.YAVG=([\d.]+)/) || [])[1]);
check('zoomed frame not black', Number.isFinite(yavg) && yavg > 10, `YAVG=${yavg}`);

// No long black stretches anywhere.
const bd = await exec('ffmpeg', ['-i', OUT, '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-an', '-f', 'null', '-']).catch(
  (e) => e,
);
check('no black segments', !/black_start/.test((bd.stderr ?? '') + (bd.stdout ?? '')));

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
