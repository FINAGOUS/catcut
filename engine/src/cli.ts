// CLI:
//   node dist/cli.js <project.json> <output.mp4> [--preset 720p30]
//       [--fontfile PATH] [--srt PATH]
//       Prints a JSON export report to stdout.
//   node dist/cli.js transcribe <audio> [--model tiny|small|...]
//       [--language zh] [--out subtitles.json]
//       Transcribes locally (faster-whisper) and prints subtitle JSON.
//       Python binary: $TRANSCRIBE_PYTHON or the venv python; script:
//       scripts/transcribe.py next to this package.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportProject, PRESETS, FasterWhisperTranscriber } from './export.js';
import type { Project } from './project.js';

const argv = process.argv.slice(2);

async function cmdTranscribe(rest: string[]): Promise<void> {
  const audio = rest[0];
  if (!audio) {
    console.error('usage: cli.js transcribe <audio> [--model NAME] [--language LANG] [--out FILE]');
    process.exit(2);
  }
  const args = new Map<string, string>();
  for (let i = 1; i < rest.length; i += 2) args.set(rest[i], rest[i + 1]);
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'transcribe.py');
  const python = process.env.TRANSCRIBE_PYTHON ?? 'python3';
  const t = new FasterWhisperTranscriber(script, python);
  const items = await t.transcribe(audio, {
    model: args.get('--model') ?? 'tiny',
    language: args.get('--language') ?? 'zh',
  });
  const out = args.get('--out');
  const json = JSON.stringify(items, null, 2);
  if (out) writeFileSync(out, json, 'utf8');
  else console.log(json);
}

async function cmdExport(): Promise<void> {
  const [projectPath, output, ...rest] = argv;
  if (!projectPath || !output) {
    console.error('usage: cli.js <project.json> <output.mp4> [--preset NAME] [--fontfile PATH] [--srt PATH]');
    process.exit(2);
  }
  const args = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) args.set(rest[i], rest[i + 1]);
  const presetName = args.get('--preset') ?? '720p30';
  const preset = PRESETS[presetName];
  if (!preset) {
    console.error(`unknown preset: ${presetName} (have: ${Object.keys(PRESETS).join(', ')})`);
    process.exit(2);
  }
  const project = JSON.parse(readFileSync(projectPath, 'utf8')) as Project;
  const report = await exportProject(project, output, {
    preset,
    fontfile: args.get('--fontfile') ?? '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    srtPath: args.get('--srt'),
  });
  console.log(JSON.stringify(report, null, 2));
}

if (argv[0] === 'transcribe') await cmdTranscribe(argv.slice(1));
else await cmdExport();
