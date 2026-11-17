// Text-based editing (P3 batch 5, M4 §8.3 "按文字剪片").
// Delete a word / sentence and the corresponding time span is cut
// from the clip — the same split-the-clip machinery as the silence
// cut (timeline.ts replaceClipWithSplits).
//
// Word-level precision: P0b's faster-whisper transcriber DOES emit
// word-level timestamps — transcribe.ts RawSegment.words and
// subtitles.ts SubtitleWord (segmentsToSubtitles maps them through).
// So when the subtitle items carry `words`, cuts are word-exact.
// When they do not (e.g. an SRT round-trip, which drops words — see
// subtitles.ts parseSRT), the cut falls back to whole-sentence
// spans and says so in the result: `precision: 'word' | 'sentence'`.
// Nothing here pretends to word precision it does not have.
//
// Multi-speaker labels: pyannote-audio (MIT) is the planned local
// diarizer. The runner (PyannoteDiarizer, scripts/diarize.py) is NOT
// wired to a model in this batch — there is no pyannote install on
// this machine and the model needs a Hugging Face token — so it
// throws with setup instructions, the same honest-stub pattern as
// transcribe.ts StubTranscriber. What IS implemented and tested:
// annotateSpeakers(), the pure merge of diarization segments onto
// subtitle items (speaker labels by time overlap), so the day a
// diarizer runs, the labels land on the right words. Speaker
// filtering (cut only speaker B's lines) works on annotated items
// today.
//
// Limits: cuts are on clip-local OUTPUT time (subtitle times are
// output times — the same base as clip subtitles in subtitles.ts).
// A clip with a speed curve / beatSpeed / reverse / freeze cannot be
// text-cut (output time -> source time is not a single scale there);
// cut those clips first, then add the effects. Word boundaries are
// trusted as transcribed — a wrong ASR timestamp cuts the wrong
// audio, which is why the result reports the precision used.

import type { Clip } from './project.js';
import type { SubtitleItem, SubtitleWord } from './subtitles.js';

/** One diarization segment: who spoke, when (clip-local seconds). */
export interface SpeakerSegment {
  speaker: string;
  start: number;
  end: number;
}

/** pyannote-audio (MIT) local setup — the runner is not connected yet. */
export const PYANNOTE_SETUP = [
  'Local speaker diarization (pyannote-audio, MIT) setup:',
  '1. python3 -m venv .venv && .venv/bin/pip install pyannote-audio',
  '2. Accept the model terms and set a Hugging Face token:',
  '   pyannote/speaker-diarization-3.1 needs a token (gated model).',
  '3. Run scripts/diarize.py --audio <file> --token <hf-token> --out <json>.',
  '4. Feed the JSON segments to annotateSpeakers() below.',
  'Until then PyannoteDiarizer.transcribe() throws with this text.',
].join('\n');

/** Stub diarizer: throws until pyannote-audio is installed + tokened. */
export class PyannoteDiarizer {
  readonly name = 'pyannote-audio (not connected)';
  async diarize(): Promise<SpeakerSegment[]> {
    throw new Error('No diarization model is connected. ' + PYANNOTE_SETUP);
  }
}

/** True when every subtitle item carries word-level timestamps. */
export function hasWordTimestamps(items: SubtitleItem[]): boolean {
  return items.length > 0 && items.every((it) => (it.words ?? []).length > 0);
}

/**
 * Merge diarization segments onto subtitle items: each item (and each
 * of its words, when present) gets the speaker whose segment overlaps
 * it most. Items with no overlapping speaker keep speaker undefined
 * — never guessed. Returns new items with a `speaker` field.
 */
export function annotateSpeakers(
  items: SubtitleItem[],
  speakers: SpeakerSegment[],
): (SubtitleItem & { speaker?: string })[] {
  const overlap = (a0: number, a1: number, b: SpeakerSegment): number =>
    Math.max(0, Math.min(a1, b.end) - Math.max(a0, b.start));
  const pick = (start: number, end: number): string | undefined => {
    let best: SpeakerSegment | undefined;
    let bestOv = 0;
    for (const s of speakers) {
      const ov = overlap(start, end, s);
      if (ov > bestOv) {
        bestOv = ov;
        best = s;
      }
    }
    return bestOv > 0 ? best?.speaker : undefined;
  };
  return items.map((it) => {
    const words = it.words?.map((w) => ({ ...w, speaker: pick(w.start, w.end) }));
    return { ...it, speaker: pick(it.start, it.end), ...(words ? { words } : {}) } as SubtitleItem & { speaker?: string };
  });
}

/** Project-level text-cut descriptor (applied at export prep):
 *  which clip, which transcript (clip-local output times), which
 *  words/sentences to remove. */
export interface TextCutOptions {
  /** Clip id the transcript belongs to. */
  clipId: string;
  /** Transcript items (clip-local output time; word timestamps when
   *  the transcriber provided them). */
  subtitles: SubtitleItem[];
  /** Words / sentences to delete (exact match, case-insensitive). */
  remove: string[];
  /** Only cut lines annotated with this speaker (see annotateSpeakers). */
  speaker?: string;
}

export interface TextCutResult {
  /** Clips kept after the cut (same effects as the input clip). */
  clips: Clip[];
  /** 'word' when every removed span came from word timestamps,
   *  'sentence' when any span fell back to a whole sentence. */
  precision: 'word' | 'sentence';
  /** Removed spans in clip-local OUTPUT seconds (audit trail). */
  removed: { start: number; end: number; text: string }[];
  /** Input text that matched nothing (typo? ASR mismatch?). */
  unmatched: string[];
}

function outputToSource(clip: Clip, tOut: number): number {
  // Constant-speed only (enforced by the caller): source = in + t*speed.
  return clip.in + tOut * clip.speed;
}

/**
 * Cut spans out of one clip by text. `remove` lists the words or
 * sentences to delete (matched case-insensitively, exact word match
 * when word timestamps exist, exact sentence-text match otherwise).
 * A `speaker` filter narrows the match to items/words annotated with
 * that speaker (annotateSpeakers first; unannotated items never
 * match a speaker filter).
 *
 * Returns the kept clips (source-time splits, same effects) plus the
 * removed spans and the precision actually used. An empty result
 * (everything removed) returns clips: [] — the caller deletes the
 * clip. Text that matches nothing is reported in `unmatched`,
 * never silently ignored.
 */
export function cutClipByText(
  clip: Clip,
  subtitles: SubtitleItem[],
  remove: string[],
  opts: { speaker?: string } = {},
): TextCutResult {
  if ((clip.speedCurve ?? []).length > 0 || clip.beatSpeed || clip.reverse || clip.freezeAt !== undefined) {
    throw new Error(`clip ${clip.id}: text cut does not support speedCurve/beatSpeed/reverse/freeze yet`);
  }
  const dur = (clip.out - clip.in) / clip.speed;
  const words = hasWordTimestamps(subtitles);
  const removed: { start: number; end: number; text: string }[] = [];
  const unmatched: string[] = [];
  let precision: 'word' | 'sentence' = words ? 'word' : 'sentence';
  const norm = (s: string) => s.trim().toLowerCase();
  const speakerOf = (it: SubtitleItem & { speaker?: string }): string | undefined =>
    (it as SubtitleItem & { speaker?: string }).speaker;
  for (const target of remove) {
    const q = norm(target);
    let matched = false;
    if (words) {
      for (const it of subtitles) {
        if (opts.speaker && speakerOf(it) !== opts.speaker) continue;
        for (const w of it.words ?? []) {
          if (opts.speaker && (w as SubtitleWord & { speaker?: string }).speaker !== undefined &&
            (w as SubtitleWord & { speaker?: string }).speaker !== opts.speaker) continue;
          if (norm(w.w) === q) {
            removed.push({ start: w.start, end: w.end, text: w.w });
            matched = true;
          }
        }
      }
    }
    if (!matched) {
      // Sentence fallback (also the whole path when there are no
      // word timestamps): match the whole item text.
      for (const it of subtitles) {
        if (opts.speaker && speakerOf(it) !== opts.speaker) continue;
        if (norm(it.text) === q) {
          removed.push({ start: it.start, end: it.end, text: it.text });
          matched = true;
          precision = 'sentence';
        }
      }
    }
    if (!matched) unmatched.push(target);
  }
  removed.sort((a, b) => a.start - b.start);
  // Merge overlapping removed spans, then invert to kept spans.
  const merged: { start: number; end: number; text: string }[] = [];
  for (const r of removed) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1e-9) {
      last.end = Math.max(last.end, r.end);
      last.text += ` ${r.text}`;
    } else {
      merged.push({ ...r });
    }
  }
  const kept: { start: number; end: number }[] = [];
  let cur = 0;
  for (const r of merged) {
    const s = Math.max(0, r.start);
    const e = Math.min(dur, r.end);
    if (s > cur + 0.001) kept.push({ start: cur, end: s });
    cur = Math.max(cur, e);
  }
  if (cur < dur - 0.001) kept.push({ start: cur, end: dur });
  const clips = kept
    .filter((k) => k.end - k.start >= 0.05)
    .map((k, i) => ({
      ...clip,
      id: kept.length === 1 ? clip.id : `${clip.id}-t${i + 1}`,
      in: outputToSource(clip, k.start),
      out: outputToSource(clip, k.end),
    }));
  return { clips, precision, removed: merged, unmatched };
}
