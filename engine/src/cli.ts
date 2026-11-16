// CLI: node dist/cli.js <project.json> <output.mp4> [--preset 720p30] [--fontfile path]
// Prints a JSON export report to stdout.
import { readFileSync } from 'node:fs';
import { exportProject, PRESETS } from './export.js';
import type { Project } from './project.js';

const [projectPath, output, ...rest] = process.argv.slice(2);
if (!projectPath || !output) {
  console.error('usage: cli.js <project.json> <output.mp4> [--preset NAME] [--fontfile PATH]');
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
});
console.log(JSON.stringify(report, null, 2));
