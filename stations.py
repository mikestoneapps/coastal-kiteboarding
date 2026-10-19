#!/usr/bin/env python3
"""Resolve nearest public wind stations per spot (once, cached to stations.json) and fetch latest observations
into out/obs.json: {spotId: [{id,name,kind,dist_mi,time,spd,gst,dir,wvht,age_min}, ...]}.
Sources: NWS/METAR via api.weather.gov (nearest 2 land stations), NOAA NDBC realtime2 (hand-mapped buoys).
Search radius: NWS_RADIUS_MI miles for land stations, NDBC_RADIUS_MI for buoys, or the spot's own `stationRadiusMi`
(spots.json; Florence has 35 because nothing reports within 25 mi of the south jetty) when that is larger.
`python3 stations.py --resolve florence [id ...]` re-resolves just those spots into stations.json; after that, copy the
new rows into STATIONS in obs_standalone.py and NWS_STATIONS in index.html (both embed the file so the page and the
hourly job need no extra fetch)."""
import json, os, sys, time, math, urllib.request, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out"); os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "GorgeOrCoast/1.0 (prototype kite app; claude.ai)", "Accept": "application/geo+json, application/json"}
spots = json.load(open(os.path.join(HERE, "spots.json")))
CACHE = os.path.join(HERE, "stations.json")

# NDBC buoys / C-MAN near the Oregon coast and Gorge (id: name). Distance computed from spot.
NDBC = {"46029": "Columbia River Bar buoy", "46050": "Stilwell Bank buoy (Newport)", "46089": "Tillamook offshore buoy",
        "46015": "Port Orford buoy", "46229": "Umpqua offshore buoy", "46248": "Astoria Canyon buoy"}
NDBC_LL = {"46029": (46.159, -124.514), "46050": (44.669, -124.546), "46089": (45.925, -125.771),
           "46015": (42.764, -124.832), "46229": (43.772, -124.549), "46248": (46.133, -124.640)}

def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return r.read().decode()
        except Exception as e:
            if i == tries - 1: raise
            time.sleep(2 + 2 * i)

def mi(a, b, c, d):
    R = 3958.8; r = math.pi / 180
    x = math.sin((c - a) * r / 2) ** 2 + math.cos(a * r) * math.cos(c * r) * math.sin((d - b) * r / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))

NWS_RADIUS_MI, NDBC_RADIUS_MI = 25, 45
def radii(s):
    r = s.get("stationRadiusMi")
    return (max(NWS_RADIUS_MI, r), max(NDBC_RADIUS_MI, r)) if r else (NWS_RADIUS_MI, NDBC_RADIUS_MI)

def resolve(only=None):
    cached = json.load(open(CACHE)) if os.path.exists(CACHE) else None
    if cached is not None and not only: return cached
    out = dict(cached or {})
    for s in spots:
        if only and s["id"] not in only: continue
        nws_mi, ndbc_mi = radii(s)
        lst = []
        try:
            pts = json.loads(get(f"https://api.weather.gov/points/{s['lat']},{s['lon']}"))
            st = json.loads(get(pts["properties"]["observationStations"]))
            for f in st["features"][:6]:
                lon, lat = f["geometry"]["coordinates"]
                d = mi(s["lat"], s["lon"], lat, lon)
                if d <= nws_mi: lst.append({"id": f["properties"]["stationIdentifier"], "name": f["properties"]["name"], "kind": "nws", "lat": lat, "lon": lon, "dist_mi": round(d, 1)})
            lst = sorted(lst, key=lambda x: x["dist_mi"])[:2]
        except Exception as e:
            print("nws resolve failed", s["id"], e, file=sys.stderr)
        for bid, (la, lo) in NDBC_LL.items():
            d = mi(s["lat"], s["lon"], la, lo)
            if d <= ndbc_mi: lst.append({"id": bid, "name": NDBC[bid], "kind": "ndbc", "lat": la, "lon": lo, "dist_mi": round(d, 1)})
        out[s["id"]] = sorted(lst, key=lambda x: x["dist_mi"])[:3]
        print(s["id"], [(x["id"], x["dist_mi"]) for x in out[s["id"]]])
        time.sleep(0.6)
    json.dump(out, open(CACHE, "w"), indent=1)
    return out

MS2KN = 1.94384
def fetch_obs(stations):
    now = datetime.datetime.now(datetime.timezone.utc)
    cache = {}
    def nws(sid):
        if sid in cache: return cache[sid]
        try:
            d = json.loads(get(f"https://api.weather.gov/stations/{sid}/observations/latest"))["properties"]
            t = datetime.datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00"))
            spd = d["windSpeed"]["value"]; gst = d["windGust"]["value"]; dr = d["windDirection"]["value"]
            # NWS reports km/h
            o = {"time": d["timestamp"], "spd": None if spd is None else round(spd / 1.852, 1), "gst": None if gst is None else round(gst / 1.852, 1),
                 "dir": dr, "age_min": int((now - t).total_seconds() / 60)}
        except Exception as e:
            print("nws obs failed", sid, e, file=sys.stderr); o = None
        cache[sid] = o; return o
    def ndbc(sid):
        if sid in cache: return cache[sid]
        try:
            lines = [l for l in get(f"https://www.ndbc.noaa.gov/data/realtime2/{sid}.txt").splitlines() if not l.startswith("#")]
            cols = ["YY", "MM", "DD", "hh", "mm", "WDIR", "WSPD", "GST", "WVHT", "DPD", "APD", "MWD", "PRES", "ATMP", "WTMP", "DEWP", "VIS", "PTDY", "TIDE"]
            o = None
            for l in lines[:6]:
                v = dict(zip(cols, l.split()))
                if v.get("WSPD", "MM") == "MM": continue
                t = datetime.datetime(int(v["YY"]), int(v["MM"]), int(v["DD"]), int(v["hh"]), int(v["mm"]), tzinfo=datetime.timezone.utc)
                f = lambda k: None if v.get(k, "MM") == "MM" else float(v[k])
                o = {"time": t.isoformat(), "spd": round(f("WSPD") * MS2KN, 1), "gst": None if f("GST") is None else round(f("GST") * MS2KN, 1),
                     "dir": f("WDIR"), "wvht_ft": None if f("WVHT") is None else round(f("WVHT") * 3.281, 1), "wtmp_f": None if f("WTMP") is None else round(f("WTMP") * 9 / 5 + 32),
                     "age_min": int((now - t).total_seconds() / 60)}
                break
        except Exception as e:
            print("ndbc obs failed", sid, e, file=sys.stderr); o = None
        cache[sid] = o; return o
    out = {}
    for sid, lst in stations.items():
        rows = []
        for st in lst:
            o = nws(st["id"]) if st["kind"] == "nws" else ndbc(st["id"])
            if o: rows.append({**{k: st[k] for k in ("id", "name", "kind", "dist_mi")}, **o})
            time.sleep(0.3)
        out[sid] = rows
    json.dump({"fetchedAt": now.isoformat(timespec="seconds"), "obs": out}, open(os.path.join(OUT, "obs.json"), "w"), separators=(",", ":"))
    return out

if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--resolve":
        st = resolve(only=set(sys.argv[2:]))
        for k in sys.argv[2:]: print(k, json.dumps(st.get(k, [])))
        sys.exit(0)
    st = resolve()
    obs = fetch_obs(st)
    for k, v in obs.items():
        print(k, [(r["id"], r["dist_mi"], r["spd"], r["dir"], r["age_min"]) for r in v])
