// Audio repair (P3 batch 6, M4 §8.3): de-click, mains-hum removal and
// noise reduction, all with FFmpeg native (LGPL-part) filters.
// Engine layer only.
//
// Chain order inside one clip's audio (see filtergraph.ts
// clipAudioChains — the repair block sits after the audioFx block
// and before the plain `denoise` afftdn, which it replaces when
// denoise is set here):
//   adeclick -> highpass (hum) -> afftdn (nr=25, nf=-30)
//
// Measured behaviour (probe 2026-11-18, FFmpeg 8.1.2, sine sources):
// - adeclick on 440 Hz + three single-sample clicks (peak 1.000):
//   click-window peak 1.000 -> 0.150 (the tone level), 440 Hz level
//   -19.49 -> -19.53 dB (tone untouched).
// - highpass f=100 on 440 Hz + 50 Hz hum (amp 0.3): 50 Hz -13.47 ->
//   -25.78 dB (12.3 dB down), 440 Hz -19.49 -> -19.50 dB (untouched).
//   f=80 only gives -8.8 dB, so the hum cutoff defaults to 100 Hz,
//   not 80. A doubled highpass f=100 gives -38.08 dB but also starts
//   to eat low voice fundamentals — v1 uses a single stage.
// - afftdn: the DEFAULT afftdn (nr=12, nf=-50) is near-useless on
//   steady hiss — measured gap-noise RMS -35.19 -> -35.47 dB (0.28 dB),
//   and on pure white noise -24.73 -> -24.76 dB (0.03 dB). The
//   working setting is afftdn=nr=25:nf=-30: gap noise -35.19 ->
//   -60.04 dB (24.9 dB down). nf=-30 is load-bearing: with nf=-50
//   the -35 dB noise sits above the floor and is treated as signal.
//   tn=1 (track noise) DEFEATS the nf setting (-35.73 dB) — never
//   combine tn=1 with nf=-30. The 440 Hz tone survives nr=25:nf=-30
//   (verified in verify-p3f).
// - De-reverb is NOT in v1: there is no LGPL de-reverb filter in
//   FFmpeg (no dereverb filter exists at all in libavfilter); do not
//   claim it. A de-reverb would need a dedicated model (e.g. a
//   neural dereverb) — out of scope for this batch.
//
// LGPL note: adeclick / highpass / afftdn are native libavfilter —
// only verified on the local GPL 8.1.2 build; re-check each on the
// BtbN LGPL 9.0 build at the M2 gate.

/** Per-clip audio repair (Clip.audioRepair). All fields optional;
 *  an empty object is a no-op. */
export interface AudioRepair {
  /** Remove impulsive clicks/pops with adeclick (default false). */
  declick?: boolean;
  /** Remove mains hum with a highpass at this cutoff in Hz
   *  (default off; when set, range 50..200, default 100). This is a
   *  cutoff, not the hum frequency itself: 50 Hz hum sits below the
   *  100 Hz cutoff and is attenuated ~12 dB while voice (440 Hz
   *  probe tone) is untouched. */
  humCutoffHz?: number;
  /** Noise reduction with afftdn nr=25:nf=-30 (default false).
   *  Replaces the plain clip.denoise afftdn when both are set (the
   *  repair setting is the stronger one — see header). */
  denoise?: boolean;
}

/** Measured afftdn settings (see header): nr=25, nf=-30. The
 *  defaults (nr=12, nf=-50) measure ~0.3 dB on steady hiss. */
export const REPAIR_AFFTDN_NR = 25;
export const REPAIR_AFFTDN_NF_DB = -30;
/** Default hum highpass cutoff in Hz (measured 12.3 dB @ 50 Hz). */
export const REPAIR_HUM_CUTOFF_DEFAULT = 100;
export const REPAIR_HUM_CUTOFF_MIN = 50;
export const REPAIR_HUM_CUTOFF_MAX = 200;

function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

/** Validate an AudioRepair block. Throws on any out-of-range value. */
export function validateAudioRepair(
  repair: AudioRepair | undefined,
  clipId: string,
): AudioRepair | undefined {
  if (!repair) return undefined;
  if (repair.humCutoffHz !== undefined) {
    const v = repair.humCutoffHz;
    if (!Number.isFinite(v) || v < REPAIR_HUM_CUTOFF_MIN || v > REPAIR_HUM_CUTOFF_MAX) {
      throw new Error(
        `clip ${clipId}: audioRepair.humCutoffHz ${v} outside [${REPAIR_HUM_CUTOFF_MIN}, ${REPAIR_HUM_CUTOFF_MAX}]`,
      );
    }
  }
  return repair;
}

/** The repair filter string, in chain order: adeclick, highpass,
 *  afftdn. Returns '' when the block is a no-op. */
export function repairFilter(repair: AudioRepair): string {
  const parts: string[] = [];
  if (repair.declick) parts.push('adeclick');
  if (repair.humCutoffHz !== undefined) {
    parts.push(`highpass=f=${fmt(repair.humCutoffHz)}`);
  }
  if (repair.denoise) {
    parts.push(`afftdn=nr=${REPAIR_AFFTDN_NR}:nf=${REPAIR_AFFTDN_NF_DB}`);
  }
  return parts.join(',');
}
