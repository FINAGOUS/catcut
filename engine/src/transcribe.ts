// Transcriber interface: speech audio -> timestamped subtitles.
// The product never uploads audio to a cloud service; transcription runs
// locally. The reference implementation shells out to scripts/transcribe.py
// (faster-whisper, CPU int8) after decoding the audio to 16 kHz mono PCM
// with FFmpeg — that decode step also deliberately avoids the PyAV path,
// because faster-whisper 1.2.1 + av 19.x is broken on file input
// (av.open() lost the metadata_errors kwarg; verified 2026-11-17).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubtitleItem } from './subtitles.js';
import { toSRT } from './subtitles.js';

const execFileAsync = promisify(execFile);

export interface TranscribeOptions {
  language?: string;
  /** faster-whisper model: tiny | small | medium | large-v3 … */
  model?: string;
}

export interface Transcriber {
  name: string;
  transcribe(audioFile: string, opts?: TranscribeOptions): Promise<SubtitleItem[]>;
}

export const FASTER_WHISPER_SETUP = [
  'Local transcription (faster-whisper) setup:',
  '1. python3 -m venv .venv && .venv/bin/pip install faster-whisper',
  '2. First run downloads the model from Hugging Face into the HF cache',
  '   (tiny ~75 MB, small ~466 MB, medium ~1.5 GB). No account needed.',
  '3. Transcription runs on CPU (int8). Chinese: use model "small" or above;',
  '   "tiny" was measured 2026-11-17 with a high character error rate on',
  '   Chinese and must not be the default for zh.',
  '4. faster-whisper outputs Traditional characters; convert to Simplified',
  '   (e.g. opencc-python-reimplemented, t2s) before burning subtitles.',
  '5. On Windows the same interface will be served by whisper.cpp or an',
  '   ONNX build; this Python script is the Linux reference implementation.',
].join('\n');

/** Raw faster-whisper JSON segment (as written by scripts/transcribe.py). */
export interface RawSegment {
  text: string;
  start: number;
  end: number;
  words?: { w: string; start: number; end: number }[];
}

export function segmentsToSubtitles(segments: RawSegment[]): SubtitleItem[] {
  return segments.map((s) => ({
    text: s.text,
    start: s.start,
    end: s.end,
    words: (s.words ?? []).map((w) => ({ w: w.w, start: w.start, end: w.end })),
  }));
}

/** Faster-whisper via scripts/transcribe.py (see FASTER_WHISPER_SETUP). */
export class FasterWhisperTranscriber implements Transcriber {
  readonly name = 'faster-whisper';
  /**
   * @param scriptPath path to scripts/transcribe.py
   * @param python python binary with faster-whisper installed (venv python)
   * @param ffmpeg ffmpeg binary for the 16 kHz mono decode
   */
  constructor(
    private scriptPath: string,
    private python = 'python3',
    private ffmpeg = 'ffmpeg',
  ) {}

  async transcribe(audioFile: string, opts: TranscribeOptions = {}): Promise<SubtitleItem[]> {
    const dir = mkdtempSync(join(tmpdir(), 'catcut-transcribe-'));
    try {
      const pcm = join(dir, 'audio-16k.raw');
      const json = join(dir, 'subtitles.json');
      await execFileAsync(this.ffmpeg, [
        '-v', 'error', '-i', audioFile,
        '-ar', '16000', '-ac', '1', '-f', 'f32le', '-y', pcm,
      ]);
      await execFileAsync(this.python, [
        this.scriptPath,
        '--pcm16k', pcm,
        '--model', opts.model ?? 'tiny',
        '--language', opts.language ?? 'zh',
        '--out', json,
      ]);
      const data = JSON.parse(readFileSync(json, 'utf8')) as { segments: RawSegment[] };
      return segmentsToSubtitles(data.segments);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Placeholder used when no transcription model is connected. */
export class StubTranscriber implements Transcriber {
  readonly name = 'stub (no model connected)';
  async transcribe(): Promise<SubtitleItem[]> {
    throw new Error(
      'No transcription model is connected. ' + FASTER_WHISPER_SETUP,
    );
  }
}

/** Write subtitle items to an SRT file (sidecar next to the export). */
export function writeSrtSidecar(items: SubtitleItem[], file: string): void {
  writeFileSync(file, toSRT(items), 'utf8');
}
