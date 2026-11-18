#!/usr/bin/env python3
"""Local vocal separation via Demucs (MIT), two stems only.

Usage:
  .venv/bin/python scripts/vocalsep.py --source MIX.wav --out DIR [--model htdemucs]

- Runs `python -m demucs --two-stems=vocals -n MODEL -o DIR SOURCE`
  (Demucs downloads the model weights on first run into the torch
  hub cache). Prints one JSON line to stdout:
  {"vocals": ..., "accompaniment": ..., "duration": ..., "model": ...}
- The weights are NOT bundled here: Demucs is MIT, but the model
  weights are a separate artefact — re-check their terms before
  redistributing (see src/vocalsep.ts).
- No network service is used at separation time beyond the
  first-run weight download.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="htdemucs")
    args = ap.parse_args()

    src = Path(args.source)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        [sys.executable, "-m", "demucs", "--two-stems=vocals",
         "-n", args.model, "-o", str(out), str(src)],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(r.stdout[-2000:], file=sys.stderr)
        print(r.stderr[-2000:], file=sys.stderr)
        return 1
    stem_dir = out / args.model / src.stem
    vocals = stem_dir / "vocals.wav"
    accomp = stem_dir / "no_vocals.wav"
    if not vocals.exists() or not accomp.exists():
        print(f"demucs ran but stems missing under {stem_dir}", file=sys.stderr)
        return 1
    print(json.dumps({
        "vocals": str(vocals),
        "accompaniment": str(accomp),
        "duration": probe_duration(vocals),
        "model": args.model,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
