// Position keyframes (W10, engine first).
//
// A clip's picture moves across the canvas over clip-local OUTPUT time
// (the same clock as zoom/opacity/rotation keyframes: 0 at the clip
// start, after speed is applied). Each key holds the picture CENTRE as
// fractions of the frame (0..1, same convention as TextOverlay x/y,
// ClipMask x/y and ZoomKeyframe cx/cy): (0.5, 0.5) is dead centre, the
// no-op position. Centres outside [0, 1] are allowed (down to -1 / up
// to 2) so a clip can slide in from off-screen; the picture is then
// partly outside the frame and the uncovered area is black on the
// legacy single track, transparent on multitrack (lower tracks show
// through — see the opacityToAlpha branch in filtergraph.ts).
//
// Render: the finished clip picture (after zoom/rotation/colour/
// opacity/text) is overlaid onto a canvas of the project size with
// animated overlay x/y — see the position stage at the tail of
// clipVideoChains in filtergraph.ts. A clip with no position keys,
// or with every key at dead centre, emits no stage at all, so its
// graph is byte-identical to before this feature.
//
// Interpolation modes (per clip, `positionInterpolation`, default
// 'linear'):
// - 'linear': straight line between neighbouring keys.
// - 'hold': step — the value jumps at each key, holding the previous
//   key's value until the next key's time.
// - 'smooth': smoothstep easing inside each segment (zero velocity at
//   both ends of the segment), same value at the keys as 'linear'.
// Out-of-range evaluation time clamps: before the first key the first
// key's value holds, after the last key the last key's value holds.
// A keyframe time past the clip's duration is a modelling error and
// throws in validatePositionKeyframes (same fail-fast pattern as
// freezeAt / beatFlash), it is NOT silently clamped.
//
// Only the new filters here are `color` + `overlay`, both native
// libavfilter — verified on the local GPL ffmpeg 8.1.2 build only;
// re-check on the BtbN LGPL 9.0 build at the M2 gate.

import type { PositionInterpolation, PositionKeyframe } from './project.js';

/** Centre fraction outside which a key is rejected. -1..2 allows a
 *  full slide-in from off-screen (centre one frame outside) and no
 *  further: a centre at -1 already puts the whole picture off-frame
 *  on that axis, anything beyond it is indistinguishable. */
export const POSITION_MIN = -1;
export const POSITION_MAX = 2;

/** Default interpolation when `positionInterpolation` is unset. */
export const DEFAULT_POSITION_INTERPOLATION: PositionInterpolation = 'linear';

/**
 * Validate a position keyframe list. Throws on: empty is OK (the
 * caller treats it as "no position"); a non-finite or negative time;
 * times not strictly increasing; x/y outside [POSITION_MIN,
 * POSITION_MAX]; a key past `duration` (when given). `duration` is
 * the clip's output duration (clipDuration, freeze included).
 */
export function validatePositionKeyframes(
  keys: PositionKeyframe[],
  clipId: string,
  duration?: number,
): void {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (!Number.isFinite(k.t) || k.t < 0) {
      throw new Error(`clip ${clipId}: position keyframe ${i} has invalid t ${k.t}`);
    }
    if (i > 0 && k.t <= keys[i - 1].t) {
      throw new Error(
        `clip ${clipId}: position keyframes must be strictly increasing in t (${keys[i - 1].t} then ${k.t})`,
      );
    }
    for (const [axis, v] of [['x', k.x], ['y', k.y]] as const) {
      if (!Number.isFinite(v) || v < POSITION_MIN || v > POSITION_MAX) {
        throw new Error(
          `clip ${clipId}: position keyframe ${i} ${axis}=${v} outside [${POSITION_MIN}, ${POSITION_MAX}]`,
        );
      }
    }
    if (duration !== undefined && k.t > duration) {
      throw new Error(
        `clip ${clipId}: position keyframe ${i} t=${k.t} outside clip duration [0, ${duration}]`,
      );
    }
  }
}

/** True when the list needs a render stage at all: at least one key
 *  and at least one key off dead centre. All-centre keys are a no-op
 *  (the picture never leaves the middle) and are skipped so the
 *  graph stays byte-identical to a clip without position keys. */
export function positionNeedsStage(keys: PositionKeyframe[] | undefined): boolean {
  if (!keys || keys.length === 0) return false;
  return keys.some((k) => k.x !== 0.5 || k.y !== 0.5);
}

/**
 * Pure position evaluation: the picture centre {x, y} at clip-local
 * output time `t`. Clamps outside the key range (first/last value
 * holds). A single key is a static offset. This is the exact math
 * the FFmpeg expressions in positionExpr implement — the verify
 * script checks both against each other and against rendered
 * pixels, so a drift between them fails loudly.
 */
export function positionAt(
  keys: PositionKeyframe[],
  t: number,
  mode: PositionInterpolation = DEFAULT_POSITION_INTERPOLATION,
): { x: number; y: number } {
  if (keys.length === 0) return { x: 0.5, y: 0.5 };
  if (keys.length === 1 || t <= keys[0].t) return { x: keys[0].x, y: keys[0].y };
  const last = keys[keys.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y };
  if (mode === 'hold') {
    // Step: the value is the last key whose time is <= t — so AT a
    // key's time the new value already applies, matching the FFmpeg
    // `if(lt(t,tNext),vPrev,...)` expression exactly.
    let cur = keys[0];
    for (const k of keys) if (t >= k.t) cur = k;
    return { x: cur.x, y: cur.y };
  }
  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    if (t < k0.t || t > k1.t) continue;
    const u = (t - k0.t) / (k1.t - k0.t);
    const s = mode === 'smooth' ? u * u * (3 - 2 * u) : u;
    return { x: k0.x + (k1.x - k0.x) * s, y: k0.y + (k1.y - k0.y) * s };
  }
  return { x: last.x, y: last.y };
}

/**
 * FFmpeg expression for one axis across the keys, driven by the
 * per-frame time variable `tv` ('t' in overlay). Mirrors positionAt:
 * before the first key the first value, after the last key the last
 * value, 'hold' steps, 'smooth' smoothsteps, 'linear' lerps.
 * Built innermost-first like filtergraph.ts's lerpExpr, so the
 * segment nesting reads the same way.
 */
export function positionExpr(
  keys: PositionKeyframe[],
  pick: (k: PositionKeyframe) => number,
  mode: PositionInterpolation = DEFAULT_POSITION_INTERPOLATION,
  tv = 't',
): string {
  if (keys.length === 1) return String(pick(keys[0]));
  if (mode === 'hold') {
    let expr = String(pick(keys[keys.length - 1]));
    for (let i = keys.length - 2; i >= 0; i--) {
      expr = `if(lt(${tv},${keys[i + 1].t}),${pick(keys[i])},${expr})`;
    }
    return expr;
  }
  let expr = String(pick(keys[keys.length - 1]));
  for (let i = keys.length - 2; i >= 0; i--) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    const v0 = pick(k0);
    const v1 = pick(k1);
    const u = `(${tv}-${k0.t})/(${k1.t}-${k0.t})`;
    const s = mode === 'smooth' ? `(${u})*(${u})*(3-2*(${u}))` : u;
    expr =
      `if(lt(${tv},${k0.t}),${v0},` +
      `if(gt(${tv},${k1.t}),${expr},${v0}+(${v1}-${v0})*(${s})))`;
  }
  return expr;
}

/**
 * Overlay x/y expressions for a picture of `width`x`height` placed
 * by centre fraction. overlay x/y are the TOP-LEFT corner, so the
 * centre (cx, cy) maps to x = (cx-0.5)*W, y = (cy-0.5)*H (the
 * overlay input is project-sized, w == W). Returns [xExpr, yExpr].
 */
export function positionOverlayExprs(
  keys: PositionKeyframe[],
  mode: PositionInterpolation = DEFAULT_POSITION_INTERPOLATION,
  width: number,
  height: number,
): [string, string] {
  const cx = positionExpr(keys, (k) => k.x, mode);
  const cy = positionExpr(keys, (k) => k.y, mode);
  return [`(${cx}-0.5)*${width}`, `(${cy}-0.5)*${height}`];
}
