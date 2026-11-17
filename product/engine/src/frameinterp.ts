// Smart frame interpolation (P3 batch 5, M4 §8.7 "智能补帧").
// FFmpeg minterpolate (LGPL) raises the frame rate — 24 fps source
// to 60 fps — by motion-compensated interpolation, not by duplicating
// frames. Applied to the assembled timeline ([vout]) at graph build
// time, before subtitle burn / HDR, so every clip benefits at once
// and the timeline duration does not change.
//
// Licence: minterpolate is a native libavfilter filter (LGPL part of
// FFmpeg) — but it has only been verified on this machine's GPL
// 8.1.2 build. Re-check it on the BtbN LGPL 9.0 build at the M2
// gate, like every other new filter in this batch. The probe
// (test/tmp/probe-p3e.mjs, 2026-11-18, testsrc2 24->60 fps): output
// reads 60 fps at the same duration, and an interpolated frame sits
// BETWEEN its neighbours (PSNR 20.72 vs the earlier source frame,
// 31.53 vs the later one, while the two source frames score 19.44
// against each other — the interpolated frame is closer to both
// neighbours than they are to each other, which a frame copy could
// never do: a copy would score Infinity against one of them).
//
// Limits, stated plainly: minterpolate is motion estimation, not
// magic — fast motion, occlusions and scene cuts inside the timeline
// produce warping artefacts (the classic "soap opera" smear); a cut
// on the timeline is the worst case because the interpolator happily
// blends the last frame of clip A with the first of clip B. v1 does
// not add scene-cut awareness; the user turns interpolation off for
// cut-heavy timelines. mi_mode=mci + mc_mode=aobmc + vsbmc=1 is the
// quality preset (slower, fewer block artefacts than the default
// dup mode); the speed cost is real (roughly 3-5x the plain export
// on the probe machine) and is not hidden.

export interface FrameInterpOptions {
  /** Target frame rate, must be greater than the project fps. */
  targetFps: number;
}

/** Validate a frame-interp block against the project fps. */
export function validateFrameInterp(
  opts: FrameInterpOptions | undefined,
  projectFps: number,
): FrameInterpOptions | undefined {
  if (!opts) return undefined;
  if (typeof opts.targetFps !== 'number' || !Number.isFinite(opts.targetFps)) {
    throw new Error(`frameInterp.targetFps ${opts.targetFps} must be a number`);
  }
  if (opts.targetFps <= projectFps) {
    throw new Error(
      `frameInterp.targetFps ${opts.targetFps} must be greater than the project fps ${projectFps}`,
    );
  }
  if (opts.targetFps > 120) {
    throw new Error(`frameInterp.targetFps ${opts.targetFps} outside (project fps, 120]`);
  }
  return opts;
}

/** minterpolate filter string (motion-compensated, quality preset). */
export function minterpolateFilter(targetFps: number): string {
  return `minterpolate=fps=${targetFps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1`;
}
