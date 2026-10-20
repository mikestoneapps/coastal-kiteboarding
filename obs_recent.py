#!/usr/bin/env python3
"""Rolling record of the last few hourly station readings, for the "Blowing now" alert (SPEC.md §8; alerts/lib.mjs blowingNow()).
Run right after obs_standalone.py in the hourly job (.github/workflows/observations.yml):

    python3 obs_recent.py [obs.json] [obs-recent.json]

obs.json only ever holds the latest fetch, and the alert rule needs two consecutive hourly runs, so this keeps a short
history: for each run, the nearest station per curated spot with a wind reading under 2 h old (the same rule the page uses
before it blends a station into today's score, accuracy.freshest()), as

  {"runs": [{"at": fetchedAt, "obs": {spotId: {"id", "name", "kind", "dist_mi", "time", "spd", "gst", "dir"}}}, ...]}

oldest first, the last KEEP_RUNS runs only, one entry per fetchedAt (a re-run on the same obs.json adds nothing). A spot with
no fresh reading is simply absent from that run. Nothing here can fail the job: any error is printed and the exit status
stays 0, so obs.json is still committed."""
import datetime as dt
import json
import os
import sys

import accuracy   # freshest(), parse_time(): the one definition of "a fresh reading"

HERE = os.path.dirname(os.path.abspath(__file__))
KEEP_RUNS = 6   # six hours of history; the rule looks at the last two
FIELDS = ("id", "name", "kind", "dist_mi", "time", "spd", "gst", "dir")


def read(path):
    if not os.path.exists(path):
        return {"runs": []}
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
        runs = d.get("runs") if isinstance(d, dict) else None
        return {"runs": [r for r in (runs or []) if isinstance(r, dict) and r.get("at") and isinstance(r.get("obs"), dict)]}
    except Exception as e:
        print("obs_recent: starting a fresh file, could not read the old one:", repr(e), file=sys.stderr)
        return {"runs": []}


def snapshot(obs, spots, now):
    """One run's entry from an obs.json document: the nearest fresh reading per curated spot."""
    at = obs.get("fetchedAt") or now.isoformat(timespec="seconds")
    picked = {}
    for sid, rows in (obs.get("obs") or {}).items():
        if sid not in spots:
            continue
        o = accuracy.freshest(rows, now)
        if o:
            picked[sid] = {k: o.get(k) for k in FIELDS}
    return {"at": at, "obs": picked}


def merge(doc, snap):
    """Append the snapshot unless a run with the same fetchedAt is already there; keep the last KEEP_RUNS, oldest first."""
    runs = [r for r in doc.get("runs", []) if r.get("at") != snap["at"]] + [snap]
    runs.sort(key=lambda r: accuracy.parse_time(r["at"]) or dt.datetime.min.replace(tzinfo=dt.timezone.utc))
    return {"runs": runs[-KEEP_RUNS:]}


def write(path, doc):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, separators=(",", ":"))
        fh.write("\n")
    os.replace(tmp, path)


def run(obs_path, out_path, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    spots = {s["id"] for s in json.load(open(os.path.join(HERE, "spots.json"), encoding="utf-8"))}
    with open(obs_path, encoding="utf-8") as fh:
        obs = json.load(fh)
    snap = snapshot(obs, spots, now)
    doc = merge(read(out_path), snap)
    write(out_path, doc)
    print(f"obs_recent: {len(snap['obs'])} spot(s) with a fresh reading at {snap['at']}, {len(doc['runs'])} run(s) kept")
    return doc


if __name__ == "__main__":
    obs_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "obs.json")
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "obs-recent.json")
    try:
        run(obs_path, out_path)
    except Exception as e:   # the observations commit must not depend on this
        print("obs-recent skipped:", repr(e), file=sys.stderr)
    sys.exit(0)
