#!/usr/bin/env python3
"""Beauty mask filter for the Windows screen-recording editor.

Reads a grayscale person-mask VIDEO (the output of
scripts/portrait_segment.py — MediaPipe Selfie Segmentation, one
frame per sampled source frame) and writes a FILTERED mask video for
the beautify stage (src/beauty.ts):

- mode 'single': keep only the LARGEST connected component per
  frame (the main subject — "单人只修主角").
- mode 'multi': keep every component at or above the minimum area
  (every detected person — "多人全员修").

Labelling is a 4-connectivity union-find on a 64x36 downscale of
each frame (pure numpy + stdlib — no scipy/PIL in the venv), with
components smaller than 0.5% of the frame treated as speckle, not
people. The output is re-encoded at project size (the encoder's
scale filter upscales the 64x36 label mask; soft edges are fine —
the graph stage feathers the mask further with gblur).

Stdout prints one JSON line: {frames, personCount (median across
frames), maxCount, mode, out}. Errors exit 2 with a message on
stderr. No model, no network, no cloud.
"""
import argparse
import json
import subprocess
import sys

import numpy as np

LABEL_W = 64
LABEL_H = 36
THRESHOLD = 128
MIN_AREA_FRAC = 0.005


def die(msg):
    print(f"beauty_mask: error: {msg}", file=sys.stderr)
    sys.exit(2)


def label_components(binary):
    """4-connectivity union-find labelling of a 2D bool array.
    Returns (count, largest_area, areas_desc) for components with
    area >= MIN_AREA_FRAC of the frame. Same algorithm as
    countComponents() in src/beauty.ts (the TS version is the
    unit-testable twin)."""
    h, w = binary.shape
    n = w * h
    parent = [-1] * n

    def find(a):
        r = a
        while parent[r] != r:
            r = parent[r]
        while parent[a] != r:
            parent[a], a = r, parent[a]
        return r

    flat = binary.reshape(-1)
    for y in range(h):
        for x in range(w):
            i = y * w + x
            if not flat[i]:
                continue
            parent[i] = i
            if x > 0 and parent[i - 1] >= 0:
                ra, rb = find(i), find(i - 1)
                if ra != rb:
                    parent[rb] = ra
            if y > 0 and parent[i - w] >= 0:
                ra, rb = find(i), find(i - w)
                if ra != rb:
                    parent[rb] = ra
    areas = {}
    for i in range(n):
        if parent[i] < 0:
            continue
        r = find(i)
        areas[r] = areas.get(r, 0) + 1
    min_area = max(1, int(w * h * MIN_AREA_FRAC))
    kept = sorted((a for a in areas.values() if a >= min_area), reverse=True)
    # Largest-component label: re-scan to find the root of the biggest.
    largest_root = None
    if kept:
        target = kept[0]
        for r, a in areas.items():
            if a == target:
                largest_root = r
                break
    return kept, largest_root, parent, w, h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mask", required=True, help="input grayscale mask video")
    ap.add_argument("--out", required=True)
    ap.add_argument("--mode", choices=["single", "multi"], default="single")
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument("--fps", type=float, required=True, help="mask video fps (must match the input mask video)")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    args = ap.parse_args()
    if args.width < 2 or args.height < 2:
        die("--width/--height must be >= 2")
    if args.fps <= 0:
        die("--fps must be > 0")

    # Decoder: mask video -> 64x36 gray raw frames (native fps).
    dec = subprocess.Popen(
        [
            args.ffmpeg, "-v", "error",
            "-i", args.mask,
            "-vf", f"scale={LABEL_W}:{LABEL_H},format=gray",
            "-f", "rawvideo", "-pix_fmt", "gray", "-",
        ],
        stdout=subprocess.PIPE,
    )
    # Encoder: 64x36 gray frames -> lossless mask video at project size.
    # -r on BOTH sides (like portrait_segment.py): without it ffmpeg
    # guesses 25 fps for the raw input and the mask video comes out
    # 120f/25fps = 4.8 s instead of 4.0 s — the overlay then stretches
    # the export to 4.8 s (measured 2026-11-18, duration error 0.8 s).
    enc = subprocess.Popen(
        [
            args.ffmpeg, "-v", "error",
            "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{LABEL_W}x{LABEL_H}",
            "-r", str(args.fps), "-i", "-",
            "-vf", f"scale={args.width}:{args.height}",
            "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
            "-r", str(args.fps), "-y", args.out,
        ],
        stdin=subprocess.PIPE,
    )

    frame_bytes = LABEL_W * LABEL_H
    counts = []
    frames = 0
    try:
        while True:
            chunk = dec.stdout.read(frame_bytes)
            if len(chunk) < frame_bytes:
                break
            gray = np.frombuffer(chunk, dtype=np.uint8).reshape(LABEL_H, LABEL_W)
            binary = gray >= THRESHOLD
            kept, largest_root, parent, w, h = label_components(binary)
            counts.append(len(kept))
            out = np.zeros((LABEL_H, LABEL_W), dtype=np.uint8)
            if kept:
                flat = binary.reshape(-1)
                if args.mode == "single":
                    for i in range(w * h):
                        if parent[i] >= 0:
                            r = i
                            while parent[r] != r:
                                r = parent[r]
                            if r == largest_root:
                                out.reshape(-1)[i] = 255
                else:
                    # Multi: keep every qualifying component. Re-derive
                    # the root per pixel (parent[] was path-compressed
                    # only partially by label_components' find calls, so
                    # compress fully here).
                    roots = {}
                    for i in range(w * h):
                        if parent[i] < 0:
                            continue
                        r = i
                        while parent[r] != r:
                            r = parent[r]
                        roots[i] = r
                    # Qualifying roots = roots whose area made `kept`.
                    # Recompute areas from the kept list: a root qualifies
                    # if its area is in kept (areas are unique enough at
                    # this scale; ties keep both, which is harmless).
                    area_of = {}
                    for i, r in roots.items():
                        area_of[r] = area_of.get(r, 0) + 1
                    good = {r for r, a in area_of.items() if a in kept}
                    for i, r in roots.items():
                        if r in good:
                            out.reshape(-1)[i] = 255
            try:
                enc.stdin.write(out.tobytes())
            except BrokenPipeError:
                die("mask encoder died; see ffmpeg errors above")
            frames += 1
    finally:
        if dec.stdout:
            dec.stdout.close()
        dec.wait()
        if enc.stdin:
            enc.stdin.close()
        enc.wait()

    if dec.returncode != 0:
        die(f"ffmpeg decode failed for {args.mask}")
    if enc.returncode != 0:
        die(f"ffmpeg mask encode failed for {args.out}")
    if frames == 0:
        die(f"no frames decoded from {args.mask}")

    counts_sorted = sorted(counts)
    median = counts_sorted[len(counts_sorted) // 2]
    print(json.dumps({
        "frames": frames,
        "personCount": median,
        "maxCount": max(counts),
        "mode": args.mode,
        "out": args.out,
    }))


if __name__ == "__main__":
    main()
