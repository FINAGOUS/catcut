#!/usr/bin/env python3
"""Local speech-to-subtitles via faster-whisper (no cloud).

Usage:
  .venv/bin/python scripts/transcribe.py --audio FILE [--model tiny]
      [--language zh] [--out subtitles.json]

- Model is downloaded once from Hugging Face on first run
  (tiny ~75 MB, small ~466 MB, medium ~1.5 GB) into the HF cache.
- Prints a JSON object to stdout (or writes it to --out):
  {"model": ..., "language": ..., "segments": [{"text", "start", "end",
   "words": [{"w", "start", "end"}]}]}
- Word timestamps are estimates (faster-whisper word_timestamps=True);
  the engine always lets the user edit them afterwards.
- Needs the venv in this directory (pip install faster-whisper).
  On Windows the product will bundle the same Python-free approach via
  whisper.cpp or an ONNX build; this script is the Linux reference
  implementation of the Transcriber interface (see src/transcribe.ts).
"""
import argparse
import json
import sys
import time


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", default="")
    ap.add_argument(
        "--pcm16k",
        default="",
        help="16kHz mono float32 raw PCM file (preferred: bypasses PyAV; "
        "decode first with: ffmpeg -i IN -ar 16000 -ac 1 -f f32le OUT.raw). "
        "faster-whisper 1.2.1 + av 19.x is broken on file input "
        "(av.open metadata_errors kwarg removed), so PCM input is the "
        "supported path here.",
    )
    ap.add_argument("--model", default="tiny")
    ap.add_argument("--language", default="zh")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    t0 = time.time()
    model = WhisperModel(args.model, device="cpu", compute_type="int8")
    if args.pcm16k:
        import numpy as np

        with open(args.pcm16k, "rb") as f:
            pcm = np.frombuffer(f.read(), dtype=np.float32)
        audio_input = pcm
    elif args.audio:
        audio_input = args.audio
    else:
        ap.error("need --audio or --pcm16k")
    segments, info = model.transcribe(
        audio_input,
        language=args.language,
        word_timestamps=True,
        vad_filter=False,
    )
    out_segments = []
    for seg in segments:
        words = [
            {"w": w.word, "start": round(w.start, 3), "end": round(w.end, 3)}
            for w in (seg.words or [])
        ]
        out_segments.append(
            {
                "text": seg.text.strip(),
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "words": words,
            }
        )
    result = {
        "model": f"faster-whisper/{args.model}",
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 3),
        "segments": out_segments,
    }
    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        print(text)
    print(
        f"[transcribe] {len(out_segments)} segments in {time.time() - t0:.1f}s",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
