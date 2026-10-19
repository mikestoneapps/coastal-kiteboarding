#!/usr/bin/env python3
"""Pull Open-Meteo wind (5 models: best match, GFS, ICON, ECMWF IFS, NBM) + marine forecasts for every spot in spots.json.
Reference only; the page and alerts/lib.mjs score on the per-hour median of best match, ECMWF and NBM (scoring.js consensus()).
Writes one JSON doc per spot to out/forecast_<id>.json plus out/status.json."""
import json, os, sys, time, urllib.request, urllib.parse, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
spots = json.load(open(os.path.join(HERE, "spots.json")))

def get(url, tries=6):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=25) as r:
                return json.load(r)
        except Exception as e:
            if i == tries - 1:
                raise
            time.sleep(2 + 2 * i)

def rnd(xs, nd=1):
    return [None if v is None else round(v, nd) for v in xs]

now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
DAYS = 5
for s in spots:
    if "--force" not in sys.argv and os.path.exists(os.path.join(OUT, f"forecast_{s['id']}.json")): continue
    q = {
        "latitude": s["lat"], "longitude": s["lon"],
        "hourly": "wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,precipitation_probability,weather_code,visibility",
        "current": "wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,weather_code",
        "models": "best_match,gfs_seamless,icon_seamless,ecmwf_ifs025,ncep_nbm_conus",
        "wind_speed_unit": "kn", "temperature_unit": "fahrenheit",
        "forecast_days": DAYS, "timezone": "America/Los_Angeles",
    }
    w = get("https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(q))
    h = w["hourly"]
    def col(name, model="best_match"):
        return h.get(f"{name}_{model}") or h.get(name) or [None] * len(h["time"])
    cur = w.get("current", {})
    def curv(name):
        return cur.get(f"{name}_best_match", cur.get(name))
    doc = {
        "spotId": s["id"], "fetchedAt": now_iso, "time": h["time"],
        "spd": rnd(col("wind_speed_10m")), "gst": rnd(col("wind_gusts_10m")), "dir": rnd(col("wind_direction_10m"), 0),
        "temp": rnd(col("temperature_2m"), 0), "pop": rnd(col("precipitation_probability"), 0),
        "code": col("weather_code"), "vis": rnd(col("visibility"), 0),
        "m": {k: {"spd": rnd(col("wind_speed_10m", m)), "gst": rnd(col("wind_gusts_10m", m)), "dir": rnd(col("wind_direction_10m", m), 0)}
              for k, m in (("bm", "best_match"), ("ecmwf", "ecmwf_ifs025"), ("nbm", "ncep_nbm_conus"), ("gfs", "gfs_seamless"), ("icon", "icon_seamless"))},
        "now": {"time": cur.get("time"), "spd": curv("wind_speed_10m"), "gst": curv("wind_gusts_10m"),
                "dir": curv("wind_direction_10m"), "temp": curv("temperature_2m"), "code": curv("weather_code")},
    }
    if s["waves"]:
        mq = {"latitude": s["lat"], "longitude": s["lon"],
              "hourly": "wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period",
              "forecast_days": DAYS, "timezone": "America/Los_Angeles"}
        try:
            m = get("https://marine-api.open-meteo.com/v1/marine?" + urllib.parse.urlencode(mq))
            mh = m["hourly"]
            doc["wh"] = rnd(mh["wave_height"], 2); doc["wp"] = rnd(mh["wave_period"], 1); doc["wd"] = rnd(mh["wave_direction"], 0)
            doc["sh"] = rnd(mh["swell_wave_height"], 2); doc["sp"] = rnd(mh["swell_wave_period"], 1)
        except Exception as e:
            print("marine failed for", s["id"], e, file=sys.stderr)
    json.dump(doc, open(os.path.join(OUT, f"forecast_{s['id']}.json"), "w"), separators=(",", ":"))
    print(s["id"], "ok", "now", doc["now"]["spd"], "kn", doc["now"]["dir"])
    time.sleep(0.4)

json.dump({"fetchedAt": now_iso, "days": DAYS, "spots": [s["id"] for s in spots]}, open(os.path.join(OUT, "status.json"), "w"))
print("done", now_iso)
