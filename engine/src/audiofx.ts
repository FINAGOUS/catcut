// Audio effects (P3 batch 1, M4 §8.3): built-in EQ, compressor, voice
// effects and a one-key voice-beautify chain. Engine layer only — the
// WPF side owns the EQ curve UI (draggable nodes), the compressor
// knobs and the voice-effect picker.
//
// Chain order inside one clip's audio (see filtergraph.ts
// clipAudioChains — the audioFx block sits between the fades and
// denoise, i.e. AFTER the speed/reverse segment stage and AFTER the
// freeze/shift stages, and BEFORE loudnorm):
//   voice effects -> beautify -> EQ -> compressor -> afftdn -> loudnorm
//   -> sidechaincompress (ducking, P1) -> volume -> gainDb
// Two ordering rules, both measured, not guessed:
// - EQ/compressor sit BEFORE loudnorm: loudnorm after them only sets
//   the overall level, so the EQ band ratios survive it (probe
//   2026-11-17: +6 dB @3000 Hz still reads as a +5.86 dB band ratio
//   after loudnorm, baseline ratio 0.00). The reverse order would be
//   fine too, but this one keeps "tone first, level last".
// - Ducking sits AFTER loudnorm (P1 rule, unchanged): loudnorm after
//   ducking would re-normalise the ducked passages and undo it.
//   gainDb (the -30..+30 dB clip trim) sits after loudnorm for the
//   same reason: it is a trim, and loudnorm before it would eat it.
// - Voice pitch sits after the speed/reverse stage by construction
//   (the audioFx block is downstream of the segment assembly), so the
//   asetrate/atempo pair never sees a mid-chain sample-rate change.
//   The pitch shifter first resamples to 48 kHz, so it does not depend
//   on the source's native rate.
//
// Measured behaviour (probe 2026-11-17, FFmpeg 8.1.2, sine sources at
// -21.07 dB Goertzel RMS unless noted):
// - highpass f=500 on 100 Hz: -28.0 dB; lowpass f=5000 on 10 kHz:
//   -14.3 dB (both 2-pole defaults — assert a drop, not an exact value).
// - equalizer g is in dB units: +6 -> +6.00 dB, -6 -> -6.01 dB at the
//   band centre; two bands compose (+6 @1000 with -6 @100 -> +5.93 dB
//   at 1000 Hz).
// - volume=-30dB is exact (-21.1 -> -51.1 mean); +30 dB clips a -21 dB
//   sine (mean -0.5 dB), so the +30 assertion uses a -41 dB source.
// - acompressor threshold -20 dB / ratio 4 on a two-level source
//   (loud -9.03 / quiet -29.03, 20 dB range): loud -18.85 (reduction
//   9.8 dB), quiet unchanged, range 20.00 -> 10.19 dB.
// - Pitch +12 semitones (asetrate 96k + aresample + atempo 0.5):
//   880 Hz at -21.71 (source 440 Hz at -21.07), 440 Hz gone (-92 dB),
//   duration 3.982 s vs 4.000 (atempo frame rounding, err 0.018 s).
//   Without the atempo compensation the duration halves (2.000 s) —
//   that is why the compensation is part of the filter, not optional.
//   Pitch -12: 220 Hz at -21.09, 440 Hz gone (-102 dB).
// - aecho is a FEED-FORWARD multi-tap delay (one copy per delay, no
//   feedback): a single 250 ms tap puts exactly one echo at +250 ms
//   (tail window 2.05-2.30 s after a 2 s tone: -32.13 dB vs silence
//   -240). A tail window at 2.5-3.5 s is correctly SILENT — the first
//   probe's tail assertion there was wrong, not the filter.
// - deesser alone (i=0.5, f=0.5): 6000 Hz -4.84 dB, 440 Hz -1.10 dB.
//   But inside the beautify chain its default f=0.5 also cuts 3000 Hz
//   by -3.32 dB relative — it eats the presence band the chain is
//   trying to boost. Measured fix: f=0.85 moves the split up, so the
//   chain reads 100 Hz -4.55 dB, presence (3000 vs 440) +1.85 dB,
//   sibilance (6000 vs 440) -1.33 dB. The chain therefore uses f=0.85.
// - vibrato f=5 d=0.5: 440 Hz Goertzel -8.61 dB (FM spreads the tone),
//   mean volume unchanged (-21.1). chorus (defaults: in/out 0.5,
//   delays 50|60 ms, speeds 2|1.5 Hz, depths 0.4): 440 Hz -6.33 dB.
//   tremolo f=5 d=0.5: 440 Hz -2.50 dB, mean -23.3.
// - The beautify chain's compressor sits BEFORE the presence EQ on
//   purpose: with the EQ first, the compressor ate the boost (probe
//   round 2: presence relative -1.79 dB); EQ last reads +1.85 dB.
//
// LGPL notes (all filters below are native libavfilter, LGPL part of
// FFmpeg — but only verified on this machine's GPL 8.1.2 build so far;
// re-check each on the BtbN LGPL 9.0 build at the M2 gate):
// highpass, lowpass, equalizer, acompressor, asetrate, aresample,
// atempo, aecho, vibrato, chorus, tremolo, deesser, volume, afftdn.
// - rubberband (pitch shift WITHOUT tempo change, i.e. the
//   professional voice-change route) is GPL and NOT in LGPL builds.
//   This batch deliberately does NOT use it: the asetrate+atempo
//   route changes tempo and then restores it, which is LGPL-safe and
//   measured exact. rubberband stays a "evaluate after the LGPL
//   re-check" note, not a dependency.

import type { Clip } from './project.js';

/** Clip/project gain range (user's words, 2026-11-17): -30..+30 dB.
 *  This is NOT the Roles range: Roles gain stays -60..+12 dB
 *  (roles.ts ROLE_GAIN_DB_MIN/MAX, verified P2c). The two ranges are
 *  separate on purpose — clip trim vs role mix — and must not be
 *  merged or "unified". */
export const CLIP_GAIN_DB_MIN = -30;
export const CLIP_GAIN_DB_MAX = 30;

/** One parametric EQ band (FFmpeg `equalizer`, one filter per band). */
export interface EqBand {
  /** Centre frequency in Hz, 20..20000. */
  frequency: number;
  /** Band gain in dB, -30..+30. */
  gainDb: number;
  /** Q factor, 0.1..10 (default 1). Narrower = more surgical. */
  width?: number;
}

/** Built-in EQ: low cut (highpass), high cut (lowpass), parametric bands. */
export interface AudioEq {
  /** Low-cut frequency in Hz, 20..20000 (highpass). Removes rumble. */
  lowCutHz?: number;
  /** High-cut frequency in Hz, 20..20000 (lowpass). Removes hiss/air. */
  highCutHz?: number;
  /** Parametric bands, applied after the cuts, in array order. */
  bands?: EqBand[];
}

/** Single-track compressor (FFmpeg `acompressor`). Distinct from the
 *  P1 ducking sidechaincompress, which only compresses background
 *  music while a voice sidechain is loud — this one compresses the
 *  clip's own audio. */
export interface AudioCompressor {
  /** Threshold in dBFS, -60..0 (default -18). Converted to linear
   *  for acompressor the same way ducking.ts does (10^(dB/20)). */
  thresholdDb?: number;
  /** Compression ratio, 1..20 (default 3). */
  ratio?: number;
  /** Attack in ms, 0.1..2000 (default 10). */
  attackMs?: number;
  /** Release in ms, 0.1..9000 (default 100). */
  releaseMs?: number;
  /** Make-up gain in dB, 0..30 (default 0). */
  makeupDb?: number;
}

export type VoiceEffectKind =
  | 'pitch'
  | 'reverb'
  | 'echo'
  | 'chorus'
  | 'tremolo'
  | 'vibrato';

/** One voice effect. Unused fields are ignored per kind. */
export interface VoiceEffect {
  kind: VoiceEffectKind;
  /** pitch only: semitones, -12..+12 (default +6). +12 = one octave
   *  up (440 Hz -> 880 Hz, measured). Tempo is restored with atempo,
   *  so duration is preserved (err 0.018 s on a 4 s clip). */
  semitones?: number;
  /** vibrato/tremolo/chorus: LFO rate in Hz (default 5). */
  rateHz?: number;
  /** vibrato/tremolo/chorus: depth 0..1 (default 0.5). */
  depth?: number;
  /** echo/reverb: delay in ms (echo default 250). */
  delayMs?: number;
  /** echo/reverb: decay 0..1 (default 0.5). */
  decay?: number;
  /** chorus/echo/reverb: wet/dry mix 0..1 (default 0.5). */
  mix?: number;
}

/** Per-clip audio effects (Clip.audioFx). All fields optional; an
 *  empty object is a no-op. */
export interface AudioFx {
  /** Clip gain trim in dB, -30..+30. Applied AFTER loudnorm and
   *  ducking (with the static `volume`), so loudnorm cannot eat it. */
  gainDb?: number;
  /** Built-in EQ (cuts + parametric bands). Before loudnorm. */
  eq?: AudioEq;
  /** Single-track compressor. Before loudnorm. */
  compressor?: AudioCompressor;
  /** Voice effect(s), applied in array order. After speed/reverse. */
  voice?: VoiceEffect | VoiceEffect[];
  /** One-key voice beautify: highpass 80 Hz -> deesser -> light
   *  compression -> +3 dB presence @3000 Hz. See enhanceFilter(). */
  enhance?: boolean;
}

/** Beautify chain constants (measured, see header). */
export const BEAUTY_HIGHPASS_HZ = 80;
export const BEAUTY_PRESENCE_HZ = 3000;
export const BEAUTY_PRESENCE_DB = 3;
export const BEAUTY_DEESSER_F = 0.85;
export const BEAUTY_COMP_THRESHOLD_DB = -18;
export const BEAUTY_COMP_RATIO = 2;

function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function range(
  clipId: string,
  field: string,
  v: number | undefined,
  lo: number,
  hi: number,
): void {
  if (v !== undefined && (v < lo || v > hi || !Number.isFinite(v))) {
    throw new Error(`clip ${clipId}: audioFx.${field} ${v} outside [${lo}, ${hi}]`);
  }
}

/** Validate an AudioFx block. Returns it (or undefined) for chaining.
 *  Throws on any out-of-range value — the export refuses the clip
 *  instead of silently clamping, matching ducking/roles validation. */
export function validateAudioFx(
  fx: AudioFx | undefined,
  clipId: string,
): AudioFx | undefined {
  if (!fx) return undefined;
  range(clipId, 'gainDb', fx.gainDb, CLIP_GAIN_DB_MIN, CLIP_GAIN_DB_MAX);
  const eq = fx.eq;
  if (eq) {
    range(clipId, 'eq.lowCutHz', eq.lowCutHz, 20, 20000);
    range(clipId, 'eq.highCutHz', eq.highCutHz, 20, 20000);
    if (
      eq.lowCutHz !== undefined &&
      eq.highCutHz !== undefined &&
      eq.lowCutHz >= eq.highCutHz
    ) {
      throw new Error(
        `clip ${clipId}: audioFx.eq.lowCutHz ${eq.lowCutHz} must be below highCutHz ${eq.highCutHz}`,
      );
    }
    (eq.bands ?? []).forEach((b, i) => {
      range(clipId, `eq.bands[${i}].frequency`, b.frequency, 20, 20000);
      range(clipId, `eq.bands[${i}].gainDb`, b.gainDb, -30, 30);
      range(clipId, `eq.bands[${i}].width`, b.width, 0.1, 10);
    });
  }
  const c = fx.compressor;
  if (c) {
    range(clipId, 'compressor.thresholdDb', c.thresholdDb, -60, 0);
    range(clipId, 'compressor.ratio', c.ratio, 1, 20);
    range(clipId, 'compressor.attackMs', c.attackMs, 0.1, 2000);
    range(clipId, 'compressor.releaseMs', c.releaseMs, 0.1, 9000);
    range(clipId, 'compressor.makeupDb', c.makeupDb, 0, 30);
  }
  const voices = fx.voice === undefined ? [] : Array.isArray(fx.voice) ? fx.voice : [fx.voice];
  voices.forEach((v, i) => {
    const p = `voice[${i}]`;
    if (!v || typeof v.kind !== 'string') {
      throw new Error(`clip ${clipId}: audioFx.${p}.kind is required`);
    }
    const known: VoiceEffectKind[] = ['pitch', 'reverb', 'echo', 'chorus', 'tremolo', 'vibrato'];
    if (!known.includes(v.kind)) {
      throw new Error(`clip ${clipId}: audioFx.${p}.kind "${v.kind}" is unknown`);
    }
    range(clipId, `${p}.semitones`, v.semitones, -12, 12);
    range(clipId, `${p}.rateHz`, v.rateHz, 0.1, 20000);
    range(clipId, `${p}.depth`, v.depth, 0, 1);
    range(clipId, `${p}.delayMs`, v.delayMs, 1, 1000);
    range(clipId, `${p}.decay`, v.decay, 0, 1);
    range(clipId, `${p}.mix`, v.mix, 0, 1);
  });
  return fx;
}

/** Validate the project master gain (-30..+30 dB). */
export function validateMasterGainDb(v: number | undefined, what = 'project'): void {
  if (v !== undefined && (v < CLIP_GAIN_DB_MIN || v > CLIP_GAIN_DB_MAX || !Number.isFinite(v))) {
    throw new Error(
      `${what}.masterGainDb ${v} outside [${CLIP_GAIN_DB_MIN}, ${CLIP_GAIN_DB_MAX}]`,
    );
  }
}

/** EQ filter string (cuts first, then one `equalizer` per band). */
export function eqFilter(eq: AudioEq): string {
  const parts: string[] = [];
  if (eq.lowCutHz !== undefined) parts.push(`highpass=f=${eq.lowCutHz}`);
  if (eq.highCutHz !== undefined) parts.push(`lowpass=f=${eq.highCutHz}`);
  for (const b of eq.bands ?? []) {
    parts.push(
      `equalizer=f=${b.frequency}:width_type=q:width=${fmt(b.width ?? 1)}:g=${fmt(b.gainDb)}`,
    );
  }
  return parts.join(',');
}

/** Compressor filter string (dB values converted to acompressor's
 *  linear threshold / linear makeup, same conversion as ducking.ts). */
export function compressorFilter(c: AudioCompressor): string {
  const thresholdDb = c.thresholdDb ?? -18;
  const linear = Math.max(0.000976563, Math.min(1, Math.pow(10, thresholdDb / 20)));
  const makeup = Math.max(1, Math.min(64, Math.pow(10, (c.makeupDb ?? 0) / 20)));
  return (
    `acompressor=threshold=${fmt(linear)}:ratio=${fmt(c.ratio ?? 3)}` +
    `:attack=${fmt(c.attackMs ?? 10)}:release=${fmt(c.releaseMs ?? 100)}` +
    `:makeup=${fmt(makeup)}:knee=2.82843:link=average:detection=rms:mix=1`
  );
}

/** One voice effect's filter string. */
export function voiceFilter(v: VoiceEffect): string {
  switch (v.kind) {
    case 'pitch': {
      const st = v.semitones ?? 6;
      if (st === 0) return '';
      // Resample to 48 kHz first so the rate math does not depend on
      // the source's native rate; asetrate shifts pitch AND tempo,
      // aresample restores the rate label, atempo restores the duration.
      const factor = Math.pow(2, st / 12);
      const rate = Math.round(48000 * factor);
      return (
        `aresample=48000,asetrate=${rate},aresample=48000,` +
        `atempo=${fmt(1 / factor)}`
      );
    }
    case 'reverb':
      // Multi-tap feed-forward delay (aecho has no feedback): four
      // short taps read as a small room, not distinct echoes.
      return 'aecho=0.8:0.7:60|90|120|180:0.5|0.4|0.3|0.2';
    case 'echo': {
      const delay = v.delayMs ?? 250;
      const decay = v.decay ?? 0.5;
      return `aecho=0.8:0.7:${delay}:${fmt(decay)}`;
    }
    case 'chorus': {
      // chorus options (positional): in_gain, out_gain, delays,
      // decays, speeds, depths — exactly six groups. rateHz maps to
      // the two LFO speeds, depth to the two depths.
      const rate = v.rateHz ?? 2;
      const depth = v.depth ?? 0.4;
      const outGain = v.mix ?? 0.5;
      return (
        `chorus=0.5:${fmt(outGain)}:50|60:0.4|0.3:` +
        `${fmt(rate)}|${fmt(rate * 0.75)}:${fmt(depth)}|${fmt(depth)}`
      );
    }
    case 'tremolo':
      return `tremolo=f=${fmt(v.rateHz ?? 5)}:d=${fmt(v.depth ?? 0.5)}`;
    case 'vibrato':
      return `vibrato=f=${fmt(v.rateHz ?? 5)}:d=${fmt(v.depth ?? 0.5)}`;
    default:
      throw new Error(`unknown voice effect kind "${(v as VoiceEffect).kind}"`);
  }
}

/**
 * One-key voice beautify chain. Order is load-bearing (measured):
 * highpass 80 Hz (rumble out) -> deesser (sibilance out, f=0.85 so
 * the 3000 Hz presence band survives) -> light compression
 * (threshold -18 dB, ratio 2: evens the voice without pumping) ->
 * +3 dB presence @3000 Hz LAST (a compressor after the EQ would eat
 * the boost — probe round 2 measured -1.79 dB relative with the EQ
 * first, +1.85 dB with the EQ last).
 */
export function enhanceFilter(): string {
  return (
    `highpass=f=${BEAUTY_HIGHPASS_HZ},` +
    `deesser=i=0.5:m=0.5:f=${BEAUTY_DEESSER_F},` +
    `acompressor=threshold=${fmt(Math.pow(10, BEAUTY_COMP_THRESHOLD_DB / 20))}` +
    `:ratio=${BEAUTY_COMP_RATIO}:attack=10:release=100:makeup=1,` +
    `equalizer=f=${BEAUTY_PRESENCE_HZ}:width_type=q:width=1:g=${BEAUTY_PRESENCE_DB}`
  );
}

/**
 * The pre-loudnorm audioFx chain, in order: voice effects (array
 * order) -> beautify -> EQ -> compressor. gainDb is NOT here — it is
 * applied after loudnorm/ducking with the static `volume` (see
 * filtergraph.ts). Returns '' when the block is a no-op.
 */
export function audioFxFilter(fx: AudioFx): string {
  const parts: string[] = [];
  const voices = fx.voice === undefined ? [] : Array.isArray(fx.voice) ? fx.voice : [fx.voice];
  for (const v of voices) {
    const s = voiceFilter(v);
    if (s) parts.push(s);
  }
  if (fx.enhance) parts.push(enhanceFilter());
  if (fx.eq) {
    const s = eqFilter(fx.eq);
    if (s) parts.push(s);
  }
  if (fx.compressor) parts.push(compressorFilter(fx.compressor));
  return parts.join(',');
}
