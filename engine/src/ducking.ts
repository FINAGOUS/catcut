// Audio ducking (P1, M4): while a sidechain (voice) file is loud, the
// clip's own audio (music) is compressed down. Implemented with FFmpeg
// sidechaincompress (native libavfilter — LGPL part of FFmpeg, but still
// to be re-checked on the BtbN LGPL 9.0 build at the M2 gate, like every
// other new filter; verified present only on this machine's GPL 8.1.2
// build so far).
// Measured behaviour (probe 2026-11-17, voice -6 dBFS sine bursts +
// music -12 dBFS sine, threshold -20 dB / ratio 8 / attack 20 ms /
// release 250 ms): music mean volume -15.0 dB with no ducking; with
// ducking -26.7 dB while the voice speaks (-11.7 dB, bar was >= 6 dB)
// and -15.0 dB in the silent gaps (recovery 0.0 dB, bar was +/- 1 dB).
// The sidechain is a CONTROL signal only — it is never mixed into the
// output. It is used from its own t=0, aligned to the clip-local
// timeline (v1: the caller aligns it, e.g. the mic track of the same
// session).
// Ordering inside the clip audio chain: fades -> denoise -> loudnorm
// -> sidechaincompress -> volume. Ducking MUST sit after loudnorm:
// loudnorm after ducking would re-normalise the ducked passages and
// undo the effect. The final static volume is after ducking (static,
// so it cannot undo it).

import type { Clip, DuckingOptions } from './project.js';

/** Defaults + validation. Returns the resolved options or undefined. */
export function resolveDucking(
  v: DuckingOptions | undefined,
): DuckingOptions | undefined {
  return v;
}

export function validateDucking(clip: Clip): DuckingOptions | undefined {
  const o = clip.ducking;
  if (!o) return undefined;
  if (!o.source || typeof o.source !== 'string') {
    throw new Error(`clip ${clip.id}: ducking.source is required`);
  }
  const range = (name: string, v: number | undefined, lo: number, hi: number) => {
    if (v !== undefined && (v < lo || v > hi)) {
      throw new Error(`clip ${clip.id}: ducking.${name} ${v} outside [${lo}, ${hi}]`);
    }
  };
  range('thresholdDb', o.thresholdDb, -60, 0);
  range('ratio', o.ratio, 1, 20);
  range('attackMs', o.attackMs, 1, 1000);
  range('releaseMs', o.releaseMs, 10, 5000);
  range('duckDb', o.duckDb, 0, 30);
  const ratio = o.ratio ?? 8;
  if (ratio === 1 && (o.duckDb ?? 0) > 0) {
    throw new Error(
      `clip ${clip.id}: ducking.duckDb needs ratio > 1 (ratio 1 compresses nothing)`,
    );
  }
  return o;
}

/**
 * Effective threshold in dB: the plain threshold, lowered by
 * duckDb / (1 - 1/ratio) so that duckDb adds exactly that many dB of
 * extra gain reduction on top of what threshold/ratio alone give, for
 * any sidechain level above threshold. During silence the sidechain
 * sits below threshold and the music is untouched.
 */
export function duckingEffectiveThresholdDb(o: DuckingOptions): number {
  const threshold = o.thresholdDb ?? -20;
  const ratio = o.ratio ?? 8;
  const duckDb = o.duckDb ?? 0;
  if (duckDb === 0) return threshold;
  return threshold - duckDb / (1 - 1 / ratio);
}

/** sidechaincompress filter string (main input is the left-hand label). */
export function duckingFilter(o: DuckingOptions): string {
  const effDb = duckingEffectiveThresholdDb(o);
  // sidechaincompress takes a LINEAR threshold (0.000976563..1).
  // Clamp to the filter's own floor: -60 dB is 0.001, just above it.
  const linear = Math.max(0.000976563, Math.min(1, Math.pow(10, effDb / 20)));
  const ratio = o.ratio ?? 8;
  const attack = o.attackMs ?? 20;
  const release = o.releaseMs ?? 250;
  return (
    `sidechaincompress=threshold=${linear}:ratio=${ratio}` +
    `:attack=${attack}:release=${release}:makeup=1:knee=2.82843` +
    `:link=average:detection=rms:level_in=1:mode=downward:level_sc=1:mix=1`
  );
}
