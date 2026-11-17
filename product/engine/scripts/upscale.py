#!/usr/bin/env python3
"""Frame-wise Real-ESRGAN ONNX upscaling (P3, M4 §8.7).

Reads PNG frames from --in-dir, runs the .onnx model per frame with
onnxruntime (CPU), writes PNG frames to --out-dir with the same names.
Input is RGB float 0..1, NCHW; the model output is clamped to [0, 1].

The model is the official Real-ESRGAN x4plus/x2plus weights (BSD-3-Clause
code; re-check the model licence before redistributing) exported to ONNX
with the project's pytorch2onnx script. No network access, no cloud.
"""
import argparse
import os
import sys

import numpy as np
from PIL import Image


def main() -> int:
    ap = argparse.ArgumentParser(description="Real-ESRGAN ONNX frame upscaler")
    ap.add_argument("--model", required=True, help="Path to the .onnx model")
    ap.add_argument("--in-dir", required=True, help="Directory of input PNG frames")
    ap.add_argument("--out-dir", required=True, help="Directory for output PNG frames")
    ap.add_argument("--scale", type=int, default=4, choices=[2, 4])
    args = ap.parse_args()

    if not os.path.isfile(args.model):
        print(f"upscale.py: model not found: {args.model}", file=sys.stderr)
        return 2
    try:
        import onnxruntime as ort
    except ImportError:
        print("upscale.py: onnxruntime is not installed", file=sys.stderr)
        return 2

    names = sorted(f for f in os.listdir(args.in_dir) if f.lower().endswith(".png"))
    if not names:
        print(f"upscale.py: no PNG frames in {args.in_dir}", file=sys.stderr)
        return 2
    os.makedirs(args.out_dir, exist_ok=True)
    sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    in_name = sess.get_inputs()[0].name
    for name in names:
        img = Image.open(os.path.join(args.in_dir, name)).convert("RGB")
        arr = np.asarray(img, dtype=np.float32) / 255.0
        arr = np.transpose(arr, (2, 0, 1))[None, :, :, :]
        out = sess.run(None, {in_name: arr})[0]
        out = np.clip(out[0], 0.0, 1.0)
        out = np.transpose(out, (1, 2, 0))
        Image.fromarray((out * 255.0 + 0.5).astype(np.uint8)).save(
            os.path.join(args.out_dir, name)
        )
    print(f"upscale.py: {len(names)} frames, scale x{args.scale}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
