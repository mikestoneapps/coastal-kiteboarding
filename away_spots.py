#!/usr/bin/env python3
"""Build away-spots.json: the catalogue the page's away-from-home mode filters by drive radius.

Public Overpass servers answer a browser in 30+ s when they answer at all, so the page no longer asks them
at runtime. This job (weekly, .github/workflows/away-spots.yml) asks once, with long timeouts and retries
across mirrors, for
  (a) every sport=kitesurfing / kiteboarding / windsurfing feature worldwide, and
  (b) every named natural=beach in the United States, Canada and Mexico,
and writes one compact JSON file the page fetches same-origin:

  {"generatedAt": "...", "source": "OpenStreetMap", "count": N,
   "spots": [{"id": "n101", "name": "...", "lat": 32.77, "lon": -117.25, "tags": {"sport": "kitesurfing", ...}}, ...]}

`id` is the OSM type letter + id (the page's `a-` and `k-` ids build on it; never change the scheme). `tags`
holds only what the page's osmNotes() and parser read: sport, natural, surface, description, access, fee, name:en.
Private/no-access features are dropped here; unnamed beaches never come back from the query. Everything else
(naming unnamed launches, de-duplication, the 40-spot cap, facing) stays in the page.

Usage:
  python3 away_spots.py away-spots.json                 # fetch from Overpass and write
  python3 away_spots.py out.json --input a.json b.json  # offline: compact saved Overpass answers instead
Exit status is non-zero if any query fails, so a partial catalogue never replaces the last good one.
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
USER_AGENT = "CoastalKiteboarding/1.0 (https://mikestoneapps.github.io/coastal-kiteboarding/; weekly away-spots job)"
READ_TIMEOUT_S = 900          # a worldwide query can take minutes; the server-side timeout below is the real limit
SERVER_TIMEOUT_S = 800
ATTEMPTS_PER_MIRROR = 2
BACKOFF_S = (20, 60)
KEEP_TAGS = ("sport", "natural", "surface", "description", "access", "fee", "name:en")

QUERIES = [
    ("sport tags, worldwide",
     f'[out:json][timeout:{SERVER_TIMEOUT_S}][maxsize:1073741824];'
     'nwr["sport"~"kitesurf|kiteboard|windsurf"];out center tags qt;'),
] + [
    (f"named beaches, {name}",
     f'[out:json][timeout:{SERVER_TIMEOUT_S}][maxsize:1073741824];'
     f'area["ISO3166-1"="{iso}"]["admin_level"="2"]->.c;'
     'nwr(area.c)["natural"="beach"]["name"];out center tags qt;')
    for iso, name in (("US", "United States"), ("CA", "Canada"), ("MX", "Mexico"))
]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def overpass(query, mirrors=MIRRORS):
    """POST the query to each mirror in turn, a couple of tries each, until one returns valid JSON."""
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for url in mirrors:
        for attempt in range(ATTEMPTS_PER_MIRROR):
            t0 = time.time()
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"})
                with urllib.request.urlopen(req, timeout=READ_TIMEOUT_S) as r:
                    data = json.load(r)
                if "elements" not in data:
                    raise ValueError("no elements in answer: " + str(data)[:200])
                if data.get("remark", "").startswith("runtime error"):
                    raise ValueError(data["remark"][:200])
                log(f"  {url}: {len(data['elements'])} elements in {time.time() - t0:.0f}s")
                return data
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, json.JSONDecodeError, OSError) as e:
                last = e
                log(f"  {url}: attempt {attempt + 1} failed after {time.time() - t0:.0f}s: {e}")
                time.sleep(BACKOFF_S[min(attempt, len(BACKOFF_S) - 1)])
    raise RuntimeError(f"every Overpass mirror failed; last error: {last}")


def compact(answers):
    """Overpass answers -> the page's compact spot list (de-duplicated by OSM id, sorted for stable diffs)."""
    seen = {}
    for data in answers:
        for e in data.get("elements", []):
            t = e.get("tags") or {}
            if t.get("access") in ("private", "no"):
                continue
            lat = e.get("lat", (e.get("center") or {}).get("lat"))
            lon = e.get("lon", (e.get("center") or {}).get("lon"))
            if lat is None or lon is None:
                continue
            sport = "kitesurf" in (t.get("sport") or "").lower() or "kiteboard" in (t.get("sport") or "").lower() or "windsurf" in (t.get("sport") or "").lower()
            name = t.get("name") or t.get("name:en")
            if not name and not sport:
                continue          # a beach with no name tells him nothing
            if not sport and t.get("natural") != "beach":
                continue          # the beach query only returns beaches, but be strict
            sid = e["type"][0] + str(e["id"])
            tags = {k: t[k] for k in KEEP_TAGS if t.get(k)}
            if "name:en" in tags and tags["name:en"] == name:
                del tags["name:en"]
            spot = {"id": sid, "lat": round(float(lat), 4), "lon": round(float(lon), 4), "tags": tags}
            if name:
                spot["name"] = name
            seen[sid] = spot
    return sorted(seen.values(), key=lambda s: (s["id"][0], int(s["id"][1:])))


def unchanged(path, spots):
    """True when the file already holds exactly these spots (so the date alone never makes a commit)."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("spots") == spots
    except (OSError, ValueError):
        return False


def write(path, spots):
    lines = [json.dumps(s, ensure_ascii=False, separators=(",", ":")) for s in spots]
    head = json.dumps({"generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "source": "OpenStreetMap (Overpass), ODbL", "count": len(spots)}, separators=(",", ":"))
    with open(path, "w", encoding="utf-8") as f:
        f.write(head[:-1] + ',"spots":[\n' + ",\n".join(lines) + "\n]}\n")


def main(argv):
    if len(argv) < 2 or argv[1].startswith("-"):
        log(__doc__)
        return 2
    out = argv[1]
    answers = []
    if "--input" in argv:
        for p in argv[argv.index("--input") + 1:]:
            with open(p, encoding="utf-8") as f:
                answers.append(json.load(f))
    else:
        for label, q in QUERIES:
            log(f"query: {label}")
            answers.append(overpass(q))
    spots = compact(answers)
    sport = sum(1 for s in spots if "sport" in s["tags"])
    if not spots:
        log("no spots at all; not writing")
        return 1
    if unchanged(out, spots):
        log(f"{out} unchanged ({len(spots)} spots); not rewriting")
        return 0
    write(out, spots)
    log(f"wrote {out}: {len(spots)} spots ({sport} sport-tagged, {len(spots) - sport} named beaches)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
