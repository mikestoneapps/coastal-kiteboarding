#!/usr/bin/env python3
"""Resolve nearest public wind stations per spot (once, cached to stations.json) and fetch latest observations
into obs.json (repo root, or the path given as the first argument):
{fetchedAt, obs: {spotId: [{id,name,kind,dist_mi,time,spd,gst,dir,wvht_ft,age_min}, ...]}}.
Sources: NWS/METAR via api.weather.gov (nearest 2 land stations), NOAA NDBC realtime2 (hand-mapped buoys).
Run hourly by .github/workflows/observations.yml; the page reads obs.json same-origin."""
import json, os, sys, time, math, urllib.request, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_FILE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "obs.json")
UA = {"User-Agent": "CoastalKiteboarding/1.0 (github.com/mikestoneapps/coastal-kiteboarding)", "Accept": "application/geo+json, application/json"}
spots = []
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

STATIONS = {"stevenson":[{"id":"ODT78","name":"I84 WB at Cascade Locks MP44.57","kind":"nws","lat":45.66931,"lon":-121.88484,"dist_mi":1.8},{"id":"LGFO3","name":"LOG CREEK","kind":"nws","lat":45.49658,"lon":-121.89646,"dist_mi":13.7}],"hoodriver":[{"id":"K4S2","name":"Ken Jernstedt Airfield","kind":"nws","lat":45.67457,"lon":-121.53493,"dist_mi":3.0},{"id":"PNGO","name":"PINEGROVE","kind":"nws","lat":45.65222,"lon":-121.50917,"dist_mi":4.4}],"rufus":[{"id":"E2137","name":"EW2137 Wasco","kind":"nws","lat":45.62733,"lon":-120.60017,"dist_mi":7.8},{"id":"E0859","name":"EW0859 Centerville","kind":"nws","lat":45.73917,"lon":-120.92683,"dist_mi":9.9}],"fortstevens":[{"id":"KAST","name":"Astoria, Astoria Regional Airport","kind":"nws","lat":46.15694,"lon":-123.8825,"dist_mi":5.2},{"id":"46029","name":"Columbia River Bar buoy","kind":"ndbc","lat":46.159,"lon":-124.514,"dist_mi":25.6},{"id":"46248","name":"Astoria Canyon buoy","kind":"ndbc","lat":46.133,"lon":-124.64,"dist_mi":31.8}],"gearhart":[{"id":"KAST","name":"Astoria, Astoria Regional Airport","kind":"nws","lat":46.15694,"lon":-123.8825,"dist_mi":9.1},{"id":"ODT09","name":"US26 WB at Quartz Creek MP24.23","kind":"nws","lat":45.84225,"lon":-123.51849,"dist_mi":23.6},{"id":"46029","name":"Columbia River Bar buoy","kind":"ndbc","lat":46.159,"lon":-124.514,"dist_mi":29.4}],"manzanita":[{"id":"TMKO3","name":"TILLAMOOK","kind":"nws","lat":45.45722,"lon":-123.8025,"dist_mi":19.3},{"id":"KTMK","name":"Tillamook, Tillamook Airport","kind":"nws","lat":45.41806,"lon":-123.81444,"dist_mi":21.7},{"id":"46029","name":"Columbia River Bar buoy","kind":"ndbc","lat":46.159,"lon":-124.514,"dist_mi":41.0}],"rockaway":[{"id":"TMKO3","name":"TILLAMOOK","kind":"nws","lat":45.45722,"lon":-123.8025,"dist_mi":12.9},{"id":"KTMK","name":"Tillamook, Tillamook Airport","kind":"nws","lat":45.41806,"lon":-123.81444,"dist_mi":15.0}],"bayocean":[{"id":"TMKO3","name":"TILLAMOOK","kind":"nws","lat":45.45722,"lon":-123.8025,"dist_mi":8.7},{"id":"KTMK","name":"Tillamook, Tillamook Airport","kind":"nws","lat":45.41806,"lon":-123.81444,"dist_mi":10.1}],"oceanside":[{"id":"TMKO3","name":"TILLAMOOK","kind":"nws","lat":45.45722,"lon":-123.8025,"dist_mi":8.1},{"id":"KTMK","name":"Tillamook, Tillamook Airport","kind":"nws","lat":45.41806,"lon":-123.81444,"dist_mi":8.1}],"capelookout":[{"id":"KTMK","name":"Tillamook, Tillamook Airport","kind":"nws","lat":45.41806,"lon":-123.81444,"dist_mi":8.5},{"id":"TMKO3","name":"TILLAMOOK","kind":"nws","lat":45.45722,"lon":-123.8025,"dist_mi":10.5}],"pacificcity":[{"id":"AT297","name":"PACCTY-2 Pacific City","kind":"nws","lat":45.19683,"lon":-123.96733,"dist_mi":0.3},{"id":"CDFO3","name":"CEDAR","kind":"nws","lat":45.21167,"lon":-123.77194,"dist_mi":9.7}],"roadsend":[{"id":"AP682","name":"W7KKE-3 Road's End","kind":"nws","lat":45.011,"lon":-124.00583,"dist_mi":0.2},{"id":"AT297","name":"PACCTY-2 Pacific City","kind":"nws","lat":45.19683,"lon":-123.96733,"dist_mi":13.1},{"id":"46050","name":"Stilwell Bank buoy (Newport)","kind":"ndbc","lat":44.669,"lon":-124.546,"dist_mi":35.3}],"newport":[{"id":"KONP","name":"Newport, Newport Municipal Airport","kind":"nws","lat":44.58028,"lon":-124.05806,"dist_mi":2.1},{"id":"AS531","name":"YACHTS Yachats","kind":"nws","lat":44.34303,"lon":-124.09212,"dist_mi":18.5},{"id":"46050","name":"Stilwell Bank buoy (Newport)","kind":"ndbc","lat":44.669,"lon":-124.546,"dist_mi":23.8}],"florence":[{"id":"AS531","name":"YACHTS Yachats","kind":"nws","lat":44.34303,"lon":-124.09212,"dist_mi":23.1},{"id":"46229","name":"Umpqua offshore buoy","kind":"ndbc","lat":43.772,"lon":-124.549,"dist_mi":26.6}],"floras":[{"id":"46015","name":"Port Orford buoy","kind":"ndbc","lat":42.764,"lon":-124.832,"dist_mi":19.3}]}
def resolve():
    return STATIONS
    out = {}
    for s in spots:
        lst = []
        try:
            pts = json.loads(get(f"https://api.weather.gov/points/{s['lat']},{s['lon']}"))
            st = json.loads(get(pts["properties"]["observationStations"]))
            for f in st["features"][:6]:
                lon, lat = f["geometry"]["coordinates"]
                d = mi(s["lat"], s["lon"], lat, lon)
                if d <= 25: lst.append({"id": f["properties"]["stationIdentifier"], "name": f["properties"]["name"], "kind": "nws", "lat": lat, "lon": lon, "dist_mi": round(d, 1)})
            lst = sorted(lst, key=lambda x: x["dist_mi"])[:2]
        except Exception as e:
            print("nws resolve failed", s["id"], e, file=sys.stderr)
        for bid, (la, lo) in NDBC_LL.items():
            d = mi(s["lat"], s["lon"], la, lo)
            if d <= 45: lst.append({"id": bid, "name": NDBC[bid], "kind": "ndbc", "lat": la, "lon": lo, "dist_mi": round(d, 1)})
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
    with open(OUT_FILE, "w") as fh:
        json.dump({"fetchedAt": now.isoformat(timespec="seconds"), "obs": out}, fh, separators=(",", ":"))
        fh.write("\n")
    return out

if __name__ == "__main__":
    st = resolve()
    obs = fetch_obs(st)
    for k, v in obs.items():
        print(k, [(r["id"], r["dist_mi"], r["spd"], r["dir"], r["age_min"]) for r in v])
