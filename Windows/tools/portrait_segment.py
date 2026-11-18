#!/usr/bin/env python3
"""Portrait segmentation helper for the Windows screen-recording editor.

Runs the bundled MediaPipe Selfie Segmentation ONNX model over a video
clip and writes a grayscale mask VIDEO (one frame per sampled source
frame). The TypeScript engine (src/portrait.ts) calls this script; on
Windows the same interface will be served natively by
Microsoft.ML.OnnxRuntime (NuGet) — this script is the Linux reference
implementation, mirroring scripts/transcribe.py for faster-whisper.

Pipeline (all local, no network, no cloud):
  1. ffmpeg decodes the clip range to 256x256 RGB24 raw frames.
  2. onnxruntime (CPU) runs selfie_segmentation_256x256.onnx per frame
     (input [1,256,256,3] float in [0,1], output [1,256,256,1] prob).
  3. Each sampled frame's probability map is written as a grayscale
     frame to a second ffmpeg process that encodes the mask video
     (libx264, qp 0 = lossless luma, yuv420p) at full project size.

Usage:
  portrait_segment.py --video FILE --model FILE --out FILE.mp4
      --fps FLOAT --in FLOAT --dur FLOAT --width INT --height INT
      [--sample-every INT] [--ffmpeg ffmpeg]

Stdout prints one JSON line with the run summary (frames, sampled,
median inference ms). Errors exit 2 with a message on stderr.
"""
import argparse
import json
import subprocess
import sys
import time

import numpy as np

MODEL_IN = 256


def die(msg):
    print(f"portrait_segment: error: {msg}", file=sys.stderr)
    sys.exit(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=float, required=True)
    ap.add_argument("--in", dest="tin", type=float, default=0.0)
    ap.add_argument("--dur", type=float, required=True)
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--height", type=int, required=True)
    ap.add_argument("--sample-every", type=int, default=1)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    args = ap.parse_args()

    if args.sample_every < 1:
        die("--sample-every must be >= 1")
    if args.fps <= 0 or args.dur <= 0:
        die("--fps and --dur must be > 0")
    if args.width < 2 or args.height < 2:
        die("--width/--height must be >= 2")

    try:
        import onnxruntime as ort
    except ImportError:
        die(
            "onnxruntime is not installed for this Python. "
            "Run: python3 -m venv .venv && .venv/bin/pip install onnxruntime "
            "(MIT licensed, CPU wheel), then pass that venv's python to the engine."
        )

    try:
        sess = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    except Exception as e:  # noqa: BLE001 - surface the loader error verbatim
        die(f"cannot load model {args.model}: {e}")
    inp_name = sess.get_inputs()[0].name
    out_name = sess.get_outputs()[0].name

    # Decoder: clip range -> 256x256 RGB24 raw frames at native fps.
    dec = subprocess.Popen(
        [
            args.ffmpeg, "-v", "error",
            "-ss", str(args.tin), "-i", args.video, "-t", str(args.dur),
            "-vf", "scale=256:256", "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-r", str(args.fps), "-",
        ],
        stdout=subprocess.PIPE,
    )
    # Encoder: grayscale mask frames -> lossless mask video at project size.
    mask_fps = args.fps / args.sample_every
    enc = subprocess.Popen(
        [
            args.ffmpeg, "-v", "error",
            "-f", "rawvideo", "-pix_fmt", "gray", "-s", "256x256",
            "-r", str(mask_fps), "-i", "-",
            "-vf", f"scale={args.width}:{args.height}",
            "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p",
            "-r", str(mask_fps), "-y", args.out,
        ],
        stdin=subprocess.PIPE,
    )

    frame_bytes = MODEL_IN * MODEL_IN * 3
    times = []
    frames = 0
    sampled = 0
    try:
        while True:
            chunk = dec.stdout.read(frame_bytes)
            if len(chunk) < frame_bytes:
                break
            if frames % args.sample_every == 0:
                rgb = np.frombuffer(chunk, dtype=np.uint8).reshape(
                    MODEL_IN, MODEL_IN, 3
                ).astype(np.float32) / 255.0
                t0 = time.perf_counter()
                prob = sess.run([out_name], {inp_name: rgb[None, :, :, :]})[0]
                times.append((time.perf_counter() - t0) * 1000.0)
                gray = np.clip(prob[0, :, :, 0] * 255.0, 0, 255).astype(np.uint8)
                try:
                    enc.stdin.write(gray.tobytes())
                except BrokenPipeError:
                    die("mask encoder died; see ffmpeg errors above")
                sampled += 1
            frames += 1
    finally:
        if dec.stdout:
            dec.stdout.close()
        dec.wait()
        if enc.stdin:
            enc.stdin.close()
        enc.wait()

    if dec.returncode != 0:
        die(f"ffmpeg decode failed for {args.video}")
    if enc.returncode != 0:
        die(f"ffmpeg mask encode failed for {args.out}")
    if frames == 0:
        die(f"no frames decoded from {args.video} (in={args.tin}, dur={args.dur})")
    if sampled == 0:
        die("no frames sampled; check --sample-every")

    times.sort()
    mid = times[len(times) // 2]
    print(json.dumps({
        "frames": frames,
        "sampled": sampled,
        "model": args.model,
        "medianMs": round(mid, 2),
        "meanMs": round(sum(times) / len(times), 2),
        "maxMs": round(times[-1], 2),
        "width": args.width,
        "height": args.height,
        "fps": args.fps,
        "sampleEvery": args.sample_every,
        "out": args.out,
    }))


if __name__ == "__main__":
    main()
