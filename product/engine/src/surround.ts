// Multichannel audio (P3 batch 6, M4 §8.3): the Roles mix bus grows
// from stereo to 5.1 / 7.1. P2c v1 was stereo-only.
//
// Design: the mix bus itself stays stereo through assembly (Roles,
// stems, master gain, narration all work in stereo — nothing in the
// P2c chain changes). The surround stage is a single upmix at the
// END of the mix, after master gain, applied to the mix only (role
// stems stay stereo). The upmix is a plain `pan` mapping, no
// decorrelation or reverb — v1 is an upmix, not a surround mix:
//   5.1: FL=c0, FR=c1, FC=0.5*c0+0.5*c1, LFE=silence, BL=c0, BR=c1
//   7.1: FL=c0, FR=c1, FC=0.5*c0+0.5*c1, LFE=silence, BL=c0, BR=c1,
//        SL=c0, SR=c1
//   ...when the mix bus is stereo. When the bus is MONO (all clips
//   mono, no Roles — Roles normalise to stereo, but a plain mono
//   timeline stays mono), every output channel derives from c0
//   instead: the stereo mapping on a mono bus reads a non-existent
//   c1 as silence, so FC drops 6 dB and BR goes silent (measured
//   2026-11-18: FC -25.50, BR -222.96 dB). export.ts probes the bus
//   channel count and picks the mapping; a mixed mono+stereo
//   timeline is rejected.
// The LFE is silent by design (there is no low-frequency-effects
// content in a stereo upmix — inventing one would be a subwoofer
// guess). Per-role surround panning (e.g. dialogue pinned to FC) is
// NOT in v1: that needs per-role channel maps, a WPF mixer job.
//
// Measured behaviour (probe 2026-11-18, FFmpeg 8.1.2):
// - pan=5.1 with the mapping above + AC-3 encode: ffprobe reads
//   codec ac3, 6 channels, channel_layout "5.1(side)" (FFmpeg 8
//   names the 5.1 layout with back channels "5.1(side)"; the channel
//   ORDER is still FL FR FC LFE BL BR — the name is cosmetic, the
//   test asserts channels == 6 and layout starts with "5.1").
// - The pan filter rejects a bare `c3=0` constant ("Expected in
//   channel name") — the silent LFE must be written `c3=0*c0`.
// - The encoder is FFmpeg's built-in AC-3 encoder (ac3) for 5.1;
//   the AC-3 patents have expired. AAC is kept for stereo, for 5.1
//   when the caller explicitly asks for it, and for 7.1 (AC-3 tops
//   out at 5.1 — the encoder silently downmixes 7.1 to 5.1).
//
// LGPL note: pan / ac3 / aac are native libavfilter / native
// encoders — only verified on the local GPL 8.1.2 build; re-check
// each on the BtbN LGPL 9.0 build at the M2 gate. AC-3 encoding
// itself has no GPL dependency (the encoder is native, not libaom).

/** Surround layout of the mix bus. 'stereo' is the P2c default. */
export type SurroundLayout = 'stereo' | '5.1' | '7.1';

export const SURROUND_LAYOUTS: SurroundLayout[] = ['stereo', '5.1', '7.1'];
export const SURROUND_CHANNELS: Record<SurroundLayout, number> = {
  stereo: 2,
  '5.1': 6,
  '7.1': 8,
};
/** Default AC-3 bitrate per layout (bits/s). */
export const SURROUND_AC3_BITRATE: Record<SurroundLayout, string> = {
  stereo: '192k',
  '5.1': '384k',
  '7.1': '448k',
};

/** Validate a surround layout value. Throws on anything else. */
export function validateSurroundLayout(
  layout: SurroundLayout | undefined,
  what = 'project',
): SurroundLayout | undefined {
  if (layout === undefined) return undefined;
  if (!SURROUND_LAYOUTS.includes(layout)) {
    throw new Error(
      `${what}.surroundLayout "${layout}" is unknown — use one of ${SURROUND_LAYOUTS.join(', ')}`,
    );
  }
  return layout;
}

/** The upmix filter for the mix bus (applied after master gain).
 *  `inputChannels` is the mix-bus channel count (probed by
 *  export.ts): 1 = mono — every output channel derives from c0;
 *  2 (default) = stereo — left/right stay separate. The two
 *  mappings MUST NOT be confused: the stereo mapping on a mono bus
 *  reads a non-existent c1 as silence, so FC drops 6 dB and BR
 *  goes silent (measured 2026-11-18: FC -25.50, BR -222.96 dB on a
 *  mono source). A mixed mono+stereo timeline is rejected by the
 *  caller before this filter is built. */
export function surroundUpmixFilter(layout: SurroundLayout, inputChannels = 2): string {
  if (layout === 'stereo') return '';
  if (inputChannels !== 1 && inputChannels !== 2) {
    throw new Error(`surround upmix: inputChannels ${inputChannels} must be 1 (mono) or 2 (stereo)`);
  }
  const mono = inputChannels === 1;
  if (layout === '5.1') {
    return mono
      ? 'pan=5.1|c0=c0|c1=c0|c2=c0|c3=0*c0|c4=c0|c5=c0'
      : 'pan=5.1|c0=c0|c1=c1|c2=0.5*c0+0.5*c1|c3=0*c0|c4=c0|c5=c1';
  }
  return mono
    ? 'pan=7.1|c0=c0|c1=c0|c2=c0|c3=0*c0|c4=c0|c5=c0|c6=c0|c7=c0'
    : 'pan=7.1|c0=c0|c1=c1|c2=0.5*c0+0.5*c1|c3=0*c0|c4=c0|c5=c1|c6=c0|c7=c1';
}

/** Audio codec for the export: surround layouts default to AC-3
 *  (the built-in encoder, patents expired); stereo defaults to AAC.
 *  An explicit caller choice wins over the default. EXCEPTION: AC-3
 *  physically cannot carry 7.1 (the format tops out at 5.1 — the
 *  encoder silently downmixes 7.1 to 5.1, measured 2026-11-18), so
 *  7.1 defaults to AAC, which supports 7.1 in MP4. */
export function surroundAudioCodec(
  layout: SurroundLayout | undefined,
  explicit?: 'aac' | 'ac3',
): 'aac' | 'ac3' {
  if (explicit) return explicit;
  if (layout === '5.1') return 'ac3';
  return 'aac';
}
