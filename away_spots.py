#!/usr/bin/env python3
"""Build away-spots.json: the catalogue the page's away-from-home mode filters by drive radius.

Public Overpass servers answer a browser in 30+ s when they answer at all, so the page no longer asks them
at runtime. This job (weekly, .github/workflows/away-spots.yml) asks once, with retries across mirrors, for
  (a) every sport=kitesurfing / kiteboarding / windsurfing feature worldwide (one query, long timeout), and
  (b) every named natural=beach along the coasts and Great Lakes of the US, Canada and Mexico, in small
      bounding-box tiles (about 4°×4°, TILES below) with a 90 s timeout each: the first live run showed a single
      country-wide beach query times out on every mirror, while the sport query finishes in about a minute,
and writes one compact JSON file the page fetches same-origin:

  {"generatedAt": "...", "source": "OpenStreetMap", "count": N,
   "spots": [{"id": "n101", "name": "...", "lat": 32.77, "lon": -117.25, "tags": {"sport": "kitesurfing", ...}}, ...]}

`id` is the OSM type letter + id (the page's `a-` and `k-` ids build on it; never change the scheme). `tags`
holds only what the page's osmNotes() and parser read: sport, natural, surface, description, access, fee, name:en.
Private/no-access features are dropped here; unnamed beaches never come back from the query. Everything else
(naming unnamed launches, de-duplication, the 40-spot cap, facing) stays in the page.

Partial runs are fine: the file is written whenever the sport query succeeded. A beach tile that fails on every
mirror is logged, and the previous file's beaches inside that tile are carried over so a flaky tile never empties
a coastline. Exit status is non-zero only when the sport query itself failed (the file is then left untouched).

Usage:
  python3 away_spots.py away-spots.json                 # fetch from Overpass and write
  python3 away_spots.py out.json --input a.json b.json  # offline: compact saved Overpass answers instead
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
KEEP_TAGS = ("sport", "natural", "surface", "description", "access", "fee", "name:en")

# The worldwide sport query: one request, minutes allowed (the live run took 66 s).
SPORT_SERVER_TIMEOUT_S = 800
SPORT_READ_TIMEOUT_S = 900
SPORT_ATTEMPTS_PER_MIRROR = 2
SPORT_BACKOFF_S = (20, 60)
SPORT_QUERY = (f'[out:json][timeout:{SPORT_SERVER_TIMEOUT_S}][maxsize:1073741824];'
               'nwr["sport"~"kitesurf|kiteboard|windsurf"];out center tags qt;')

# Beach tiles: short server timeout, one try per mirror, a pause between tiles so we are a polite client.
TILE_SERVER_TIMEOUT_S = 90
TILE_READ_TIMEOUT_S = 120
TILE_ATTEMPTS_PER_MIRROR = 1
TILE_BACKOFF_S = (5,)
TILE_PAUSE_S = 3
TILE_BUDGET_S = 80 * 60       # stop starting new tiles after this; the workflow is killed at 120 min

# (label, south, west, north, east) — about 4°×4° each, covering only coast and Great Lakes shoreline.
# Pacific from the BC north coast to Oaxaca including the Sea of Cortez; Gulf of Mexico; Atlantic from the Keys
# to Newfoundland; the Great Lakes; Hawaii. Overlaps are harmless (de-duplicated by OSM id). Inland water
# (Tahoe, Great Salt Lake) and Alaska are left out on purpose: the sport query still covers tagged launches there.
TILES = [
    # Pacific
    ("BC north coast", 53, -134, 57, -130),
    ("BC north coast, mainland inlets", 53, -130, 57, -126),
    ("Haida Gwaii, BC central coast", 49, -133, 53, -129),
    ("BC central coast, north Vancouver Island", 49, -129, 53, -125),
    ("Vancouver, Strait of Georgia", 49, -125, 53, -121),
    ("Washington coast, Puget Sound, Columbia Gorge", 45, -125, 49, -121),
    ("Oregon coast, north California", 41, -125, 45, -121),
    ("north California, San Francisco Bay", 37, -125, 41, -121),
    ("central and south California", 33, -122, 37, -118),
    ("San Diego, Baja Norte, Salton Sea", 29, -119, 33, -115),
    ("north Sea of Cortez", 29, -115, 33, -111),
    ("Baja Pacific, mid peninsula", 25, -116, 29, -112),
    ("Sea of Cortez mid, Sonora", 25, -112, 29, -108),
    ("Baja Sur, La Paz, Los Cabos", 21, -113, 25, -109),
    ("Sinaloa, Mazatlan", 21, -109, 25, -105),
    ("Nayarit, Jalisco, Colima", 17, -106, 21, -102),
    ("Michoacan, Guerrero", 15, -102, 19, -98),
    ("Oaxaca", 14, -98, 18, -94),
    ("Hawaii", 18, -161, 23, -154),
    # Gulf of Mexico
    ("south Texas", 25, -99, 29, -95),
    ("Galveston, west Louisiana", 28, -97, 32, -93),
    ("Louisiana, Mississippi", 28, -93, 32, -89),
    ("Alabama, Florida panhandle west", 28, -89, 32, -85),
    ("Florida panhandle east, Big Bend", 28, -86, 32, -82),
    ("Florida Gulf coast, Keys, Miami", 24, -83, 28, -79),
    ("Florida east coast, Georgia coast", 28, -83, 32, -79),
    ("Tamaulipas", 21, -99, 25, -95),
    ("Veracruz", 17, -97, 21, -93),
    ("Tabasco, Campeche", 17, -93, 22, -89),
    ("Yucatan, Quintana Roo", 18, -89, 22, -85),
    # Atlantic
    ("Georgia, South Carolina", 31, -82, 35, -78),
    ("North Carolina, Virginia", 33, -79, 37, -75),
    ("Chesapeake, Delaware, New Jersey", 37, -77, 41, -73),
    ("Long Island, southern New England", 40, -73, 44, -69),
    ("Maine", 43, -71, 47, -67),
    ("New Brunswick, Nova Scotia", 43, -67, 47, -63),
    ("Cape Breton, PEI, Magdalen Islands", 44, -64, 48, -60),
    ("Gaspe, Baie des Chaleurs", 47, -68, 51, -64),
    ("St. Lawrence estuary", 46, -72, 50, -68),
    ("Newfoundland west", 46, -60, 50, -56),
    ("Newfoundland east", 46, -56, 50, -52),
    # Great Lakes
    ("Lake Superior west", 45, -93, 49, -89),
    ("Lake Superior central", 45, -89, 49, -85),
    ("Lake Superior east, Georgian Bay north", 45, -85, 49, -81),
    ("Lake Michigan", 41, -88, 45, -84),
    ("Lake Huron, Lake Erie west", 41, -84, 45, -80),
    ("Lake Erie east, Lake Ontario", 41, -80, 45, -76),
]


def beach_query(tile):
    _, s, w, n, e = tile
    return (f'[out:json][timeout:{TILE_SERVER_TIMEOUT_S}][maxsize:536870912];'
            f'nwr["natural"="beach"]["name"]({s},{w},{n},{e});out center tags qt;')


def in_tile(spot, tile):
    _, s, w, n, e = tile
    return s <= spot["lat"] <= n and w <= spot["lon"] <= e


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def overpass(query, mirrors=MIRRORS, attempts=SPORT_ATTEMPTS_PER_MIRROR, read_timeout=SPORT_READ_TIMEOUT_S, backoff=SPORT_BACKOFF_S):
    """POST the query to each mirror in turn, `attempts` tries each, until one returns valid JSON.

    Returns (data, mirror_url) so the caller can start the next query on the mirror that just worked."""
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for url in mirrors:
        for attempt in range(attempts):
            t0 = time.time()
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"})
                with urllib.request.urlopen(req, timeout=read_timeout) as r:
                    data = json.load(r)
                if "elements" not in data:
                    raise ValueError("no elements in answer: " + str(data)[:200])
                if data.get("remark", "").startswith("runtime error"):
                    raise ValueError(data["remark"][:200])
                log(f"  {url}: {len(data['elements'])} elements in {time.time() - t0:.0f}s")
                return data, url
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError, json.JSONDecodeError, OSError) as e:
                last = e
                log(f"  {url}: attempt {attempt + 1} failed after {time.time() - t0:.0f}s: {e}")
                time.sleep(backoff[min(attempt, len(backoff) - 1)])
    raise RuntimeError(f"every Overpass mirror failed; last error: {last}")


def compact(answers):
    """Overpass answers -> {id: spot} in the page's compact form (private dropped, unnamed beaches dropped)."""
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
    return seen


def sorted_spots(by_id):
    return sorted(by_id.values(), key=lambda s: (s["id"][0], int(s["id"][1:])))


def is_sport(spot):
    return "sport" in spot["tags"]


def read_previous(path):
    """The spots in the file we are about to replace ([] if missing or unreadable)."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f).get("spots") or []
    except (OSError, ValueError):
        return []


def fetch_sport():
    log("query: sport tags, worldwide")
    data, _ = overpass(SPORT_QUERY)
    return data


def fetch_beaches(tiles=TILES, mirrors=MIRRORS, budget_s=TILE_BUDGET_S, pause_s=None, now=time.time, sleep=time.sleep):
    """One Overpass answer per tile. Returns (answers, failed_tiles). Never raises: a failed tile is just listed."""
    if pause_s is None:
        pause_s = TILE_PAUSE_S
    answers, failed = [], []
    order = list(mirrors)
    t_start = now()
    for i, tile in enumerate(tiles):
        label = tile[0]
        if now() - t_start > budget_s:
            log(f"tile {i + 1}/{len(tiles)} {label}: skipped, out of time")
            failed.append(tile)
            continue
        if i:
            sleep(pause_s)
        log(f"tile {i + 1}/{len(tiles)}: named beaches, {label} {tile[1:]}")
        try:
            data, good = overpass(beach_query(tile), order, TILE_ATTEMPTS_PER_MIRROR, TILE_READ_TIMEOUT_S, TILE_BACKOFF_S)
            answers.append(data)
            order.remove(good)
            order.insert(0, good)       # start the next tile on the mirror that just answered
        except RuntimeError as e:
            log(f"  tile failed: {e}")
            failed.append(tile)
    return answers, failed


def merge(sport_answer, beach_answers, failed_tiles, previous):
    """Fresh sport spots + fresh beaches + the previous file's beaches inside the tiles that failed."""
    by_id = compact([sport_answer] + beach_answers)
    carried = 0
    for s in previous:
        if is_sport(s) or s["id"] in by_id:
            continue
        if any(in_tile(s, t) for t in failed_tiles):
            by_id[s["id"]] = s
            carried += 1
    return sorted_spots(by_id), carried


def unchanged(path, spots):
    """True when the file already holds exactly these spots (so the date alone never makes a commit)."""
    return read_previous(path) == spots and spots != []


def write(path, spots):
    lines = [json.dumps(s, ensure_ascii=False, separators=(",", ":")) for s in spots]
    head = json.dumps({"generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "source": "OpenStreetMap (Overpass), ODbL", "count": len(spots)}, separators=(",", ":"))
    with open(path, "w", encoding="utf-8") as f:
        f.write(head[:-1] + ',"spots":[\n' + ",\n".join(lines) + "\n]}\n")


def summary(spots, failed_tiles, carried):
    sport = sum(1 for s in spots if is_sport(s))
    print(f"sport spots: {sport}")
    print(f"beaches: {len(spots) - sport} ({carried} carried over from the previous file)")
    print(f"failed tiles: {len(failed_tiles)}" + (" — " + "; ".join(t[0] for t in failed_tiles) if failed_tiles else ""))


def main(argv):
    if len(argv) < 2 or argv[1].startswith("-"):
        log(__doc__)
        return 2
    out = argv[1]
    previous = read_previous(out)
    failed = []
    carried = 0
    if "--input" in argv:
        answers = []
        for p in argv[argv.index("--input") + 1:]:
            with open(p, encoding="utf-8") as f:
                answers.append(json.load(f))
        spots = sorted_spots(compact(answers))
    else:
        try:
            sport_answer = fetch_sport()
        except RuntimeError as e:
            log(f"sport query failed: {e}; leaving {out} untouched")
            return 1
        if not sport_answer.get("elements"):
            log(f"sport query returned no elements; that is not a real answer, leaving {out} untouched")
            return 1
        beach_answers, failed = fetch_beaches()
        spots, carried = merge(sport_answer, beach_answers, failed, previous)
    if not spots:
        log("no spots at all; not writing")
        summary(spots, failed, carried)
        return 1
    if unchanged(out, spots):
        log(f"{out} unchanged ({len(spots)} spots); not rewriting")
    else:
        write(out, spots)
        log(f"wrote {out}: {len(spots)} spots")
    summary(spots, failed, carried)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
