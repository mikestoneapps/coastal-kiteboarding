#!/usr/bin/env python3
"""Forecast-accuracy log, run right after obs_standalone.py in the hourly job (.github/workflows/observations.yml):

    python3 accuracy.py [obs.json] [accuracy.jsonl]

For every curated spot whose nearest station has a wind reading under 2 h old (the same rule the page uses before it
blends a station into today's score), one Open-Meteo call (the page's five models, same ids) covers the hour the
reading falls in, and one JSON line is appended per spot:

  {"spot": id, "time": "YYYY-MM-DDTHH:00" (Pacific hour of the reading), "run": fetchedAt, "station": id, "dist_mi": n,
   "obs": knots, "obs_gst": knots|null, "obs_dir": deg|null,
   "fc": {"bm","ecmwf","nbm","gfs","icon"} (knots per model, null where a model has no value),
   "fc_gst": {...same...}, "fc_dir": best-match degrees, "median": the median of bm/ecmwf/nbm, the knots the score ran on (the Gorge spots score on fc.nbm since Oct 2026)}

Lines whose run is older than 90 days are dropped, and a reading already logged (same spot, station and hour) is not
logged twice when a station hasn't updated between runs. Nothing here can fail the job: any error is printed and the
exit status stays 0, so obs.json is still committed. Phase 5 (docs/BUILD-PLAN.md) turns this file into per-spot,
per-model bias after about four weeks of lines."""
import datetime as dt
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import zoneinfo

HERE = os.path.dirname(os.path.abspath(__file__))
UA = {"User-Agent": "CoastalKiteboarding/1.0 (github.com/mikestoneapps/coastal-kiteboarding)", "Accept": "application/json"}
LA = zoneinfo.ZoneInfo("America/Los_Angeles")
MODEL_IDS = {"bm": "best_match", "ecmwf": "ecmwf_ifs025", "nbm": "ncep_nbm_conus", "gfs": "gfs_seamless", "icon": "icon_seamless"}
SCORE_MODELS = ("bm", "ecmwf", "nbm")   # the median of these is what the page and the alert job score (scoring.js consensus())
MAX_AGE_MIN = 120                       # a reading older than this is never scored by the page either
KEEP_DAYS = 90


def get_json(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                return json.load(r)
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(2 + 2 * i)


def parse_time(s):
    """ISO timestamp (Z or offset) -> aware datetime, or None."""
    try:
        t = dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)
    except Exception:
        return None


def hour_key(t):
    """The Pacific hour a reading belongs to, as Open-Meteo's hourly time string ('YYYY-MM-DDTHH:00'); minutes >= 30 round up."""
    loc = (t.astimezone(LA) + dt.timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0)
    return loc.strftime("%Y-%m-%dT%H:00")


def freshest(rows, now):
    """Nearest station with a wind reading under MAX_AGE_MIN old; rows come nearest-first from obs.json."""
    for o in rows or []:
        if o.get("spd") is None:
            continue
        t = parse_time(o.get("time"))
        if t is None or (now - t).total_seconds() / 60 > MAX_AGE_MIN:
            continue
        return o
    return None


def median(xs):
    a = sorted(x for x in xs if x is not None)
    if not a:
        return None
    m = len(a) // 2
    return a[m] if len(a) % 2 else (a[m - 1] + a[m]) / 2


def forecast_url(points):
    q = {"latitude": ",".join(str(p[0]) for p in points), "longitude": ",".join(str(p[1]) for p in points),
         "hourly": "wind_speed_10m,wind_gusts_10m,wind_direction_10m", "models": ",".join(MODEL_IDS.values()),
         "wind_speed_unit": "kn", "past_days": 1, "forecast_days": 1, "timezone": "America/Los_Angeles"}
    return "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(q)


def build_lines(picked, answer, run_at):
    """picked: [(spot_id, reading)], answer: Open-Meteo's answer for those points in the same order."""
    arr = answer if isinstance(answer, list) else [answer]
    out = []
    for (sid, o), d in zip(picked, arr):
        h = (d or {}).get("hourly") or {}
        times = h.get("time") or []
        key = hour_key(parse_time(o["time"]))
        if key not in times:
            print("accuracy: no forecast hour", key, "for", sid, file=sys.stderr)
            continue
        i = times.index(key)

        def val(var, k):
            col = h.get(f"{var}_{MODEL_IDS[k]}") or (h.get(var) if k == "bm" else None)
            return None if not col or i >= len(col) else col[i]

        fc = {k: val("wind_speed_10m", k) for k in MODEL_IDS}
        fc_gst = {k: val("wind_gusts_10m", k) for k in MODEL_IDS}
        present = [k for k in SCORE_MODELS if h.get(f"wind_speed_10m_{MODEL_IDS[k]}") or (k == "bm" and h.get("wind_speed_10m"))]
        med = median([fc[k] for k in SCORE_MODELS]) if len(present) >= 2 else fc["bm"]
        out.append({"spot": sid, "time": key, "run": run_at, "station": o.get("id"), "dist_mi": o.get("dist_mi"),
                    "obs": o.get("spd"), "obs_gst": o.get("gst"), "obs_dir": o.get("dir"),
                    "fc": fc, "fc_gst": fc_gst, "fc_dir": val("wind_direction_10m", "bm"),
                    "median": None if med is None else round(med, 1)})
    return out


def read_lines(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as fh:
        for ln in fh:
            ln = ln.strip()
            if not ln:
                continue
            try:
                out.append(json.loads(ln))
            except Exception:
                print("accuracy: dropping unreadable line", file=sys.stderr)
    return out


def merge(existing, new, now):
    """Append what isn't logged yet, drop lines older than KEEP_DAYS. Returns (lines, added)."""
    cutoff = now - dt.timedelta(days=KEEP_DAYS)
    kept = [ln for ln in existing if (parse_time(ln.get("run")) or now) >= cutoff]
    seen = {(ln.get("spot"), ln.get("station"), ln.get("time")) for ln in kept}
    added = 0
    for ln in new:
        k = (ln["spot"], ln["station"], ln["time"])
        if k in seen:
            continue
        seen.add(k)
        kept.append(ln)
        added += 1
    return kept, added


def write_lines(path, lines):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        for ln in lines:
            fh.write(json.dumps(ln, separators=(",", ":")) + "\n")
    os.replace(tmp, path)


def run(obs_path, out_path, get=get_json, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    spots = {s["id"]: s for s in json.load(open(os.path.join(HERE, "spots.json"), encoding="utf-8"))}
    with open(obs_path, encoding="utf-8") as fh:
        obs = json.load(fh)
    run_at = obs.get("fetchedAt") or now.isoformat(timespec="seconds")
    picked = [(sid, o) for sid, rows in (obs.get("obs") or {}).items() if sid in spots for o in [freshest(rows, now)] if o]
    new = []
    if picked:
        answer = get(forecast_url([(spots[sid]["lat"], spots[sid]["lon"]) for sid, _ in picked]))
        new = build_lines(picked, answer, run_at)
    lines, added = merge(read_lines(out_path), new, now)
    write_lines(out_path, lines)
    print(f"accuracy: {len(picked)} spot(s) with a fresh reading, {added} line(s) added, {len(lines)} kept ({KEEP_DAYS}-day window)")
    return added


if __name__ == "__main__":
    obs_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "obs.json")
    out_path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "accuracy.jsonl")
    try:
        run(obs_path, out_path)
    except Exception as e:   # the observations commit must not depend on this
        print("accuracy log skipped:", repr(e), file=sys.stderr)
    sys.exit(0)
