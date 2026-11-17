// Vocal separation (P3 batch 6, M4 §8.3): split a mixed audio file
// into a vocals stem and an accompaniment stem with Demucs, locally.
// Engine layer only — the WPF side owns the two-track UI.
//
// Design (same pattern as P1e portrait cutout): the engine TS side
// does the interface + validation + wiring, the separation itself
// runs in a Python helper (scripts/vocalsep.py) that shells out to
// `python -m demucs`. Nothing about the separation is faked: when
// Demucs (or its model) is missing, separateVocals throws with the
// setup instructions instead of returning empty stems.
//
// - Demucs itself is MIT-licensed. Its MODEL WEIGHTS are a separate
//   artefact: the default htdemucs weights ship under the Demucs
//   repo's terms and MUST be re-checked for redistribution before
//   any public release — the weights are downloaded on first run
//   from Meta's hosting, not bundled here. Do not bundle or
//   redistribute the weights without that check.
// - `mode: 'vocals' | 'accompaniment'` on a clip (Clip.vocalSep)
//   re-points the clip at an intermediate file whose audio is the
//   chosen stem (video re-encoded libx264 CRF 20, same pattern as
//   the Remix intermediate in export.ts). 'both' is not a clip mode:
//   the two stems are returned by separateVocals() for the caller
//   to place on two timeline tracks (WPF work).
// - Separation is CPU-slow (Demucs htdemucs on CPU, no GPU here):
//   a 4 s clip takes on the order of seconds; long files take
//   minutes. The helper prints progress; the engine does not impose
//   a timeout (execFile default maxBuffer is raised instead).
//
// LGPL note: Demucs is Python + PyTorch, not an FFmpeg filter, so
// there is nothing to re-check on the BtbN LGPL 9.0 build — but the
// separated stems are ordinary WAVs and the mux step uses libx264
// (GPL), so the intermediate-file step needs the same LGPL-route
// decision as the proxy/remix intermediates at the M2 gate.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

/** Demucs model name. 'htdemucs' is the default (4-stem hybrid
 *  transformer); 'htdemucs_ft' is the fine-tuned variant;
 *  'mdx_extra' is the MDX-Net extra model. All are downloaded on
 *  first run into the torch hub cache (~300-400 MB each). */
export type DemucsModel = 'htdemucs' | 'htdemucs_ft' | 'mdx_extra';

export const DEMUCS_MODELS: DemucsModel[] = ['htdemucs', 'htdemucs_ft', 'mdx_extra'];
export const DEMUCS_DEFAULT_MODEL: DemucsModel = 'htdemucs';

export const DEMUCS_SETUP = [
  'Vocal separation (Demucs) setup:',
  '1. python3 -m venv .venv && .venv/bin/pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu',
  '   (CPU wheels — the default PyPI torch pulls multi-GB CUDA deps this machine does not need.',
  '   Measured 2026-11-18: download.pytorch.org read-times-out on this machine, so the CPU',
  '   install fell back to the PyPI CUDA torch 2.15.0 (~2.5 GB of nvidia deps, TMPDIR moved',
  '   to $HOME/tmp-pip after /tmp filled up — that route works but is heavy; prefer the CPU index.)',
  '2. .venv/bin/pip install demucs',
  '   (Pulls the remaining runtime deps — sphn, einops, safetensors — once torch is satisfied.',
  '   Do NOT use --no-deps: it leaves sphn missing and `python -m demucs` fails at import.)',
  '3. First run downloads the model weights (~400 MB) into the torch hub cache.',
  '   Model weights licence: re-check before redistributing — Demucs is MIT,',
  '   the weights are a separate artefact (see src/vocalsep.ts header).',
  '4. On Windows the same helper runs under the bundled Python; this script is',
  '   the Linux reference implementation.',
].join('\n');

/** Per-clip vocal separation (Clip.vocalSep). */
export interface VocalSepOptions {
  /** Which stem replaces the clip audio in the export. 'vocals' =
   *  the isolated voice, 'accompaniment' = everything else. */
  mode: 'vocals' | 'accompaniment';
  /** Demucs model (default 'htdemucs'). */
  model?: DemucsModel;
}

export interface SeparateVocalsOptions {
  /** Python binary with demucs installed (default 'python3'). */
  python?: string;
  /** Helper script override (default scripts/vocalsep.py). */
  script?: string;
  /** Demucs model (default 'htdemucs'). */
  model?: DemucsModel;
}

export interface VocalsepResult {
  /** Isolated vocals WAV. */
  vocals: string;
  /** Accompaniment (no_vocals) WAV. */
  accompaniment: string;
  /** Duration of the stems in seconds (ffprobe-measured by the helper). */
  duration: number;
  /** Demucs model that produced the stems. */
  model: DemucsModel;
}

export function defaultVocalsepScriptPath(engineRoot: string): string {
  return join(engineRoot, 'scripts', 'vocalsep.py');
}

/** Validate a clip-level vocalSep block. Throws on a bad mode or
 *  unknown model name. */
export function validateVocalsep(
  opts: VocalSepOptions | undefined,
  clipId: string,
): VocalSepOptions | undefined {
  if (!opts) return undefined;
  if (opts.mode !== 'vocals' && opts.mode !== 'accompaniment') {
    throw new Error(
      `clip ${clipId}: vocalSep.mode must be "vocals" or "accompaniment" (got ${JSON.stringify(opts.mode)})`,
    );
  }
  if (opts.model !== undefined && !DEMUCS_MODELS.includes(opts.model)) {
    throw new Error(
      `clip ${clipId}: vocalSep.model "${opts.model}" is unknown — use one of ${DEMUCS_MODELS.join(', ')}`,
    );
  }
  return opts;
}

/** Run Demucs on `source` and return the two stems. The helper
 *  writes <outDir>/<model>/<basename>/vocals.wav and no_vocals.wav.
 *  Throws with DEMUCS_SETUP when Demucs is not installed or the run
 *  fails — never returns empty stems. */
export async function separateVocals(
  source: string,
  outDir: string,
  opts: SeparateVocalsOptions = {},
): Promise<VocalsepResult> {
  const model = opts.model ?? DEMUCS_DEFAULT_MODEL;
  if (!DEMUCS_MODELS.includes(model)) {
    throw new Error(`unknown Demucs model "${model}" — use one of ${DEMUCS_MODELS.join(', ')}`);
  }
  if (!existsSync(source)) {
    throw new Error(`vocal separation: source file missing: ${source}`);
  }
  const script = opts.script ?? defaultVocalsepScriptPath(
    join(dirname(new URL(import.meta.url).pathname), '..'),
  );
  if (!existsSync(script)) {
    throw new Error(`vocal separation: helper script missing: ${script}`);
  }
  const python = opts.python ?? 'python3';
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(python, [script, '--source', source, '--out', outDir, '--model', model], {
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const detail = (err.stderr?.toString() ?? err.message ?? '').trim().slice(-500);
    throw new Error(
      `vocal separation failed (Demucs): ${detail}\n${DEMUCS_SETUP}`,
    );
  }
  let parsed: { vocals: string; accompaniment: string; duration: number; model: string };
  try {
    parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '') as typeof parsed;
  } catch {
    throw new Error(`vocal separation: helper printed unparseable output: ${stdout.trim().slice(-300)}`);
  }
  if (!existsSync(parsed.vocals) || !existsSync(parsed.accompaniment)) {
    throw new Error(
      `vocal separation: helper reported stems but the files are missing: ${parsed.vocals}, ${parsed.accompaniment}`,
    );
  }
  return {
    vocals: parsed.vocals,
    accompaniment: parsed.accompaniment,
    duration: parsed.duration,
    model: parsed.model as DemucsModel,
  };
}

/** Base name (no extension) of a file, for the Demucs output dir. */
export function vocalsepStemDir(source: string): string {
  return basename(source).replace(/\.[^.]+$/, '');
}
