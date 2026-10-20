#!/usr/bin/env python3
"""Per-spot, per-model forecast bias from the accuracy log (Phase 5, SPEC.md §3). Run after accuracy.py in the hourly job:

    python3 bias.py [accuracy.jsonl] [bias.json]

For every curated spot and every model the log carries (bm, ecmwf, nbm, gfs, icon, and "median", the series the coast spots
score on), the paired samples are the log lines where both the station reading and that model's forecast for the hour exist.
With at least MIN_N of them the bias is median(observed − forecast) in knots, so positive means the station has been reading
higher than the model. The file is

  {spotId: {model: {"kn": knots, "n": samples}}}

with only the (spot, model) pairs that reached MIN_N; a spot with none is absent, and with no log at all the file is {}.
The page and scoring.js read it same-origin like obs.json and add the chosen model's bias to the hourly wind before scoring,
only when n >= 40 and |kn| >= 2 (BIAS_MIN_N / BIAS_MIN_KN there); a thinner or smaller bias changes nothing. Nothing here can
fail the job: any error is printed and the exit status stays 0."""
import json
import os
import sys

import accuracy   # read_lines(), median(): the same readers the log was written with

HERE = os.path.dirname(os.path.abspath(__file__))
MIN_N = 40
MODELS = ("bm", "ecmwf", "nbm", "gfs", "icon")


def pairs(lines):
    """{spot: {model: [observed − forecast, ...]}} over every line with a station reading."""
    out = {}
    for ln in lines:
        sid, obs = ln.get("spot"), ln.get("obs")
        if not sid or not isinstance(obs, (int, float)):
            continue
        fc = ln.get("fc") or {}
        series = {k: fc.get(k) for k in MODELS}
        series["median"] = ln.get("median")
        for k, v in series.items():
            if isinstance(v, (int, float)):
                out.setdefault(sid, {}).setdefault(k, []).append(obs - v)
    return out


def compute(lines, spots=None, min_n=MIN_N):
    """bias.json's content: only pairs with min_n or more samples, median error rounded to 0.1 kn."""
    out = {}
    for sid, by_model in pairs(lines).items():
        if spots is not None and sid not in spots:
            continue
        for k, errs in by_model.items():
            if len(errs) >= min_n:
                out.setdefault(sid, {})[k] = {"kn": round(accuracy.median(errs), 1), "n": len(errs)}
    return out


def write(path, doc):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, separators=(",", ":"), sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def run(log_path, out_path):
    spots = {s["id"] for s in json.load(open(os.path.join(HERE, "spots.json"), encoding="utf-8"))}
    lines = accuracy.read_lines(log_path)
    doc = compute(lines, spots)
    write(out_path, doc)
    n_pairs = sum(len(v) for v in doc.values())
    print(f"bias: {len(lines)} log line(s), {len(doc)} spot(s) with {n_pairs} model bias(es) at {MIN_N}+ samples")
    return doc


if __name__ == "__main__":
    log_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "accuracy.jsonl")
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "bias.json")
    try:
        run(log_path, out_path)
    except Exception as e:   # the observations commit must not depend on this
        print("bias skipped:", repr(e), file=sys.stderr)
    sys.exit(0)
