// Text-to-speech narration (P3 batch 6, M4 §8.3): local Sherpa-ONNX
// TTS (Apache 2.0) + the open vits-icefall-zh-aishell3 voice. No
// cloud: synthesis runs on this machine, the same way P0b's
// transcription runs locally (faster-whisper) and P1e's portrait
// cutout runs locally (ONNX).
//
// Model: test/models/vits-icefall-zh-aishell3 (k2-fsa/sherpa-onnx
// releases, tts-models tag, 30 MB tarball). The voice is a single
// open speaker (sid 0); there is no voice picker in v1.
// Engine layer only — the WPF side owns the narration text box and
// the per-word timing display.
//
// Measured behaviour (probe 2026-11-18, .venv sherpa-onnx 2.0.1):
// - "你好世界，这是一个测试。" (12 chars) -> 2.65 s @ 8000 Hz.
// - "今天我们来讲讲，怎么选平台。" (13 chars) -> 3.45 s @ 8000 Hz.
//   Roughly 0.22-0.27 s per character; the test asserts the duration
//   lands in (0, 0.6 s/char], not an exact value — VITS timing is
//   model-determined, not a formula.
// - The model renders at 8000 Hz (that is the model's native rate,
//   not a bug). The export resamples the narration to the 48 kHz mix
//   bus in the graph, so the low rate does not leak into the mix.
// - Synthesis is fast: ~4.3 s wall for a 13-char line including
//   model load (first call per process loads the model).
// - Empty text and >2000 chars are rejected before any synthesis.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

/** Hard cap on narration text (characters). VITS handles long text,
 *  but a narration line that long belongs in segments, not one call. */
export const TTS_MAX_CHARS = 2000;
/** Sanity band for measured duration per character (seconds). */
export const TTS_MIN_SEC_PER_CHAR = 0.05;
export const TTS_MAX_SEC_PER_CHAR = 0.6;

export const TTS_SETUP = [
  'Local TTS (sherpa-onnx) setup:',
  '1. python3 -m venv .venv && .venv/bin/pip install sherpa-onnx',
  '2. Download the vits-icefall-zh-aishell3 model into test/models/',
  '   (k2-fsa/sherpa-onnx releases, tts-models tag, ~30 MB tarball).',
  '3. Synthesis runs on CPU, no account or network needed at run time.',
  '4. On Windows the same helper runs under the bundled Python; this',
  '   script is the Linux reference implementation.',
].join('\n');

/** Project-level narration (Project.narration): one TTS voice-over
 *  mixed over the timeline starting at `start` (project seconds). */
export interface TtsNarration {
  /** Narration text, 1..2000 characters. */
  text: string;
  /** Project time (seconds) where the narration starts (default 0). */
  start?: number;
  /** Speech speed multiplier, 0.5..2 (default 1). */
  speed?: number;
  /** Narration gain in dB, -30..+12 (default 0). */
  gainDb?: number;
}

export interface SynthesizeOptions {
  /** Python binary with sherpa-onnx installed (default 'python3'). */
  python?: string;
  /** Helper script override (default scripts/tts.py). */
  script?: string;
  /** Model dir override (default test/models/vits-icefall-zh-aishell3). */
  modelDir?: string;
  /** Speech speed multiplier, 0.5..2 (default 1). */
  speed?: number;
}

export function defaultTtsScriptPath(engineRoot: string): string {
  return join(engineRoot, 'scripts', 'tts.py');
}

export function defaultTtsModelDir(engineRoot: string): string {
  return join(engineRoot, 'test', 'models', 'vits-icefall-zh-aishell3');
}

/** Validate narration text/speed/gain. Throws on empty text,
 *  over-long text, or out-of-range speed/gain. */
export function validateTtsNarration(
  narration: TtsNarration | undefined,
  what = 'project',
): TtsNarration | undefined {
  if (!narration) return undefined;
  if (typeof narration.text !== 'string' || narration.text.trim().length === 0) {
    throw new Error(`${what}.narration.text must be non-empty text`);
  }
  if (narration.text.length > TTS_MAX_CHARS) {
    throw new Error(
      `${what}.narration.text is ${narration.text.length} chars, over the ${TTS_MAX_CHARS}-char cap — split it into segments`,
    );
  }
  if (narration.start !== undefined && (!Number.isFinite(narration.start) || narration.start < 0)) {
    throw new Error(`${what}.narration.start ${narration.start} must be >= 0`);
  }
  if (narration.speed !== undefined && (!Number.isFinite(narration.speed) || narration.speed < 0.5 || narration.speed > 2)) {
    throw new Error(`${what}.narration.speed ${narration.speed} outside [0.5, 2]`);
  }
  if (narration.gainDb !== undefined && (!Number.isFinite(narration.gainDb) || narration.gainDb < -30 || narration.gainDb > 12)) {
    throw new Error(`${what}.narration.gainDb ${narration.gainDb} outside [-30, 12]`);
  }
  return narration;
}

/** Synthesize `text` to a WAV file with the local sherpa-onnx VITS
 *  model. Returns the ffprobe-measured duration. Throws with
 *  TTS_SETUP when sherpa-onnx or the model is missing — never
 *  returns silence and calls it speech. */
export async function synthesizeSpeech(
  text: string,
  outWav: string,
  opts: SynthesizeOptions = {},
): Promise<{ file: string; duration: number }> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('synthesizeSpeech: text must be non-empty');
  }
  if (text.length > TTS_MAX_CHARS) {
    throw new Error(`synthesizeSpeech: text is ${text.length} chars, over the ${TTS_MAX_CHARS}-char cap`);
  }
  const speed = opts.speed ?? 1;
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new Error(`synthesizeSpeech: speed ${speed} outside [0.5, 2]`);
  }
  const engineRoot = join(dirname(new URL(import.meta.url).pathname), '..');
  const script = opts.script ?? defaultTtsScriptPath(engineRoot);
  if (!existsSync(script)) {
    throw new Error(`synthesizeSpeech: helper script missing: ${script}`);
  }
  const modelDir = opts.modelDir ?? defaultTtsModelDir(engineRoot);
  if (!existsSync(join(modelDir, 'model.onnx'))) {
    throw new Error(
      `synthesizeSpeech: TTS model missing: ${join(modelDir, 'model.onnx')}\n${TTS_SETUP}`,
    );
  }
  const python = opts.python ?? 'python3';
  try {
    await execFileAsync(python, [
      script, '--text', text, '--out', outWav,
      '--model-dir', modelDir, '--speed', String(speed),
    ], { maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const detail = (err.stderr?.toString() ?? err.message ?? '').trim().slice(-500);
    throw new Error(`synthesizeSpeech failed (sherpa-onnx): ${detail}\n${TTS_SETUP}`);
  }
  if (!existsSync(outWav)) {
    throw new Error(`synthesizeSpeech: helper reported success but ${outWav} is missing`);
  }
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outWav,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`synthesizeSpeech: bad duration ${JSON.stringify(stdout.trim())} for ${outWav}`);
  }
  return { file: outWav, duration };
}
