#!/usr/bin/env python3
"""Offline Chinese TTS for engine tests (sherpa-onnx VITS, local only).

Usage:
  .venv/bin/python test/tts-zh.py "TEXT" out.wav [speed]
Model: test/models/vits-icefall-zh-aishell3 (downloaded from
k2-fsa/sherpa-onnx releases, tts-models tag, 30 MB tarball).
No network service is used at synthesis time.
"""
import sys
from pathlib import Path

import sherpa_onnx

HERE = Path(__file__).resolve().parent
MODEL_DIR = HERE / "models" / "vits-icefall-zh-aishell3"


def main() -> int:
    text = sys.argv[1]
    out = sys.argv[2]
    speed = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=str(MODEL_DIR / "model.onnx"),
                lexicon=str(MODEL_DIR / "lexicon.txt"),
                tokens=str(MODEL_DIR / "tokens.txt"),
                data_dir=str(MODEL_DIR),
            ),
            num_threads=2,
            debug=False,
        ),
        rule_fsts=",".join(
            str(MODEL_DIR / f)
            for f in ("date.fst", "phone.fst", "number.fst", "new_heteronym.fst")
        ),
        rule_fars=str(MODEL_DIR / "rule.far"),
    )
    tts = sherpa_onnx.OfflineTts(cfg)
    audio = tts.generate(text, sid=0, speed=speed)
    sherpa_onnx.write_wave(out, audio.samples, audio.sample_rate)
    print(f"wrote {out}: {len(audio.samples) / audio.sample_rate:.2f}s @ {audio.sample_rate}Hz")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
