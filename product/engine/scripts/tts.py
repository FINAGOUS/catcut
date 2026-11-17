#!/usr/bin/env python3
"""Offline text-to-speech for engine narration (sherpa-onnx VITS, local only).

Usage:
  python scripts/tts.py --text "TEXT" --out out.wav [--model-dir DIR] [--speed 1.0]

Model: vits-icefall-zh-aishell3 (k2-fsa/sherpa-onnx releases, tts-models
tag, 30 MB tarball) — Apache 2.0, open voice. Default model dir is
test/models/vits-icefall-zh-aishell3 under the engine root.
No network service is used at synthesis time.
"""
import argparse
import sys
from pathlib import Path

import sherpa_onnx


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model-dir", default="")
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()

    here = Path(__file__).resolve().parent.parent
    model_dir = Path(args.model_dir) if args.model_dir else (
        here / "test" / "models" / "vits-icefall-zh-aishell3"
    )
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=str(model_dir / "model.onnx"),
                lexicon=str(model_dir / "lexicon.txt"),
                tokens=str(model_dir / "tokens.txt"),
                data_dir=str(model_dir),
            ),
            num_threads=2,
            debug=False,
        ),
        rule_fsts=",".join(
            str(model_dir / f)
            for f in ("date.fst", "phone.fst", "number.fst", "new_heteronym.fst")
        ),
        rule_fars=str(model_dir / "rule.far"),
    )
    tts = sherpa_onnx.OfflineTts(cfg)
    audio = tts.generate(args.text, sid=0, speed=args.speed)
    sherpa_onnx.write_wave(args.out, audio.samples, audio.sample_rate)
    print(f"wrote {args.out}: {len(audio.samples) / audio.sample_rate:.2f}s @ {audio.sample_rate}Hz")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
