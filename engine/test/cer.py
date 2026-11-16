#!/usr/bin/env python3
"""Character error rate of a Whisper JSON against a ground-truth sentence.

Usage: cer.py TRUTH_TEXT whisper.json
Normalises Traditional -> Simplified (opencc t2s) and strips punctuation
before the Levenshtein distance, so the number measures content errors,
not script variant. Prints: CER%  errors/total_chars
"""
import json
import sys

from opencc import OpenCC

CC = OpenCC("t2s")
DROP = set("，。、；：？！,.!?;: ")


def norm(s: str) -> str:
    return "".join(ch for ch in CC.convert(s) if ch not in DROP)


def lev(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def main() -> int:
    truth = norm(sys.argv[1])
    data = json.load(open(sys.argv[2], encoding="utf-8"))
    hyp = norm("".join(s["text"] for s in data["segments"]))
    d = lev(truth, hyp)
    print(f"{100.0 * d / len(truth):.1f} {d}/{len(truth)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
