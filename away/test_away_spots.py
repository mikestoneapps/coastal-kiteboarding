#!/usr/bin/env python3
"""Tests for away_spots.py with the network replaced by the mock Overpass answers in away/fixtures.mjs.

    python3 away/test_away_spots.py

Checks: tiles are small and cover the coasts he drives to; a tile that fails on every mirror is logged and the
previous file's beaches inside it are carried over; the file is written whenever the sport query succeeded; the
exit status is non-zero only when the sport query failed; the final counts are printed.
"""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import away_spots as A  # noqa: E402

FIX = json.loads(subprocess.run(
    ["node", "--input-type=module", "-e",
     "import * as F from './away/fixtures.mjs'; console.log(JSON.stringify({spots: F.OVERPASS_SPOTS, many: F.OVERPASS_MANY, empty: F.OVERPASS_EMPTY, file: F.AWAY_FILE}))"],
    cwd=ROOT, check=True, capture_output=True, text=True).stdout)

SAN_DIEGO = next(t for t in A.TILES if t[0].startswith("San Diego"))


def fake_overpass(answers_by_tile, fail=(), sport=None, calls=None):
    """An `overpass()` stand-in: the sport query gets `sport`, each beach tile gets its answer or every-mirror failure."""
    def f(query, mirrors=A.MIRRORS, attempts=1, read_timeout=0, backoff=(0,)):
        if calls is not None:
            calls.append((query, list(mirrors), attempts, read_timeout))
        if query == A.SPORT_QUERY:
            if sport is None:
                raise RuntimeError("every Overpass mirror failed; last error: HTTP 504")
            return sport, mirrors[0]
        for t in A.TILES:
            if A.beach_query(t) == query:
                if t[0] in fail:
                    raise RuntimeError(f"every Overpass mirror failed; last error: HTTP 504 ({t[0]})")
                return answers_by_tile.get(t[0], FIX["empty"]), mirrors[-1]
        raise AssertionError("unexpected query: " + query[:120])
    return f


def run_main(path, **kw):
    """main() with the network faked and time not spent; returns (exit code, stdout, stderr)."""
    out, err = io.StringIO(), io.StringIO()
    real = A.overpass, A.TILE_PAUSE_S
    A.overpass, A.TILE_PAUSE_S = fake_overpass(**kw), 0
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = A.main(["away_spots.py", path])
    finally:
        A.overpass, A.TILE_PAUSE_S = real
    return rc, out.getvalue(), err.getvalue()


def read(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class Tiles(unittest.TestCase):
    def test_tiles_are_small(self):
        for label, s, w, n, e in A.TILES:
            self.assertLessEqual(n - s, 5.01, label)
            self.assertLessEqual(e - w, 7.01, label)       # Hawaii is the one wide, sparse tile
            self.assertLess(s, n, label)
            self.assertLess(w, e, label)
        self.assertEqual(len(set(t[0] for t in A.TILES)), len(A.TILES), "labels are unique (they name failed tiles in the log)")

    def test_tiles_cover_where_he_drives(self):
        places = {
            "Tofino": (49.15, -125.9), "Squamish": (49.7, -123.15), "Hood River": (45.71, -121.5), "Floras Lake": (42.9, -124.5),
            "Crissy Field": (37.8, -122.47), "Sherman Island": (38.05, -121.75), "Belmont Shore": (33.76, -118.13), "San Diego": (32.77, -117.25),
            "San Felipe": (31.02, -114.83), "La Ventana": (24.05, -109.99), "Los Barriles": (23.68, -109.7), "Bucerias": (20.75, -105.33),
            "Puerto Escondido": (15.86, -97.07), "Salina Cruz": (16.17, -95.2), "South Padre": (26.1, -97.17), "Pensacola": (30.4, -87.2),
            "Key West": (24.56, -81.78), "Cocoa Beach": (28.32, -80.6), "Hatteras": (35.22, -75.62), "Cape Cod": (41.67, -69.96),
            "Montauk": (41.07, -71.94), "Halifax": (44.65, -63.57), "Cancun": (21.16, -86.85), "Kanaha Beach": (20.9, -156.45),
            "Duluth": (46.78, -92.1), "Chicago": (41.88, -87.63), "Toronto": (43.65, -79.38), "Cleveland": (41.5, -81.7), "Kingston": (44.23, -76.48),
        }
        for name, (lat, lon) in places.items():
            self.assertTrue(any(A.in_tile({"lat": lat, "lon": lon}, t) for t in A.TILES), f"{name} is in no tile")

    def test_beach_query_uses_bbox_and_short_timeout(self):
        q = A.beach_query(SAN_DIEGO)
        self.assertIn("[timeout:90]", q)
        self.assertIn('["natural"="beach"]["name"](29,-119,33,-115)', q)
        self.assertEqual(A.TILE_SERVER_TIMEOUT_S, 90)
        self.assertGreater(A.TILE_PAUSE_S, 0)


class Run(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "away-spots.json")

    def tearDown(self):
        self.dir.cleanup()

    def test_full_success_matches_the_js_fixture(self):
        # The sport features and beaches of the fixture split the way the two queries would return them.
        sport = {"elements": [e for e in FIX["spots"]["elements"] if "sport" in (e.get("tags") or {})]}
        beaches = {"elements": [e for e in FIX["spots"]["elements"] if "sport" not in (e.get("tags") or {})]}
        rc, out, err = run_main(self.path, sport=sport, answers_by_tile={SAN_DIEGO[0]: beaches})
        self.assertEqual(rc, 0, err)
        got = read(self.path)
        want = [s for s in FIX["file"]["spots"] if s["id"] not in ("n9001", "n9002", "n9003")]   # the fixture file adds far-away rows
        self.assertEqual(got["spots"], sorted(want, key=lambda s: (s["id"][0], int(s["id"][1:]))))
        self.assertEqual(got["count"], len(want))
        self.assertIn("sport spots: 3\n", out)
        self.assertIn("beaches: 3 (0 carried over from the previous file)\n", out)
        self.assertIn("failed tiles: 0\n", out)

    def test_failed_tile_keeps_previous_beaches_and_exits_zero(self):
        A.write(self.path, FIX["file"]["spots"])            # last week's file: Sandy Cove beaches + Hatteras + far-away sport spots
        sport = {"elements": [{"type": "node", "id": 7, "lat": 45.71, "lon": -121.5, "tags": {"sport": "kitesurfing", "name": "Event Site"}}]}
        fresh = {"elements": [{"type": "way", "id": 900, "center": {"lat": 35.25, "lon": -75.6}, "tags": {"natural": "beach", "name": "Frisco Beach"}}]}
        hatteras = next(t for t in A.TILES if t[0].startswith("North Carolina"))
        rc, out, err = run_main(self.path, sport=sport, answers_by_tile={hatteras[0]: fresh}, fail=(SAN_DIEGO[0], "Hawaii"))
        self.assertEqual(rc, 0, err)
        ids = [s["id"] for s in read(self.path)["spots"]]
        self.assertIn("n7", ids, "fresh sport spot")
        self.assertIn("w900", ids, "fresh beach from the tile that answered")
        self.assertIn("w204", ids, "previous beach inside the failed San Diego tile is carried over")
        self.assertIn("r308", ids, "previous beach inside the failed San Diego tile is carried over")
        self.assertIn("n102", ids, "previous beach inside the failed San Diego tile is carried over")
        self.assertNotIn("n9002", ids, "previous Hatteras beach is NOT carried over: its tile answered without it")
        self.assertNotIn("n101", ids, "previous sport spots are never carried over; the sport query is the truth")
        self.assertNotIn("n9001", ids)
        self.assertIn("failed tiles: 2 — San Diego, Baja Norte, Salton Sea; Hawaii\n", out)
        self.assertIn("beaches: 4 (3 carried over from the previous file)\n", out)
        self.assertIn("sport spots: 1\n", out)
        self.assertIn("tile failed:", err)

    def test_all_tiles_failing_still_writes(self):
        sport = {"elements": FIX["spots"]["elements"][:1]}
        rc, out, err = run_main(self.path, sport=sport, answers_by_tile={}, fail=tuple(t[0] for t in A.TILES))
        self.assertEqual(rc, 0, err)
        self.assertEqual([s["id"] for s in read(self.path)["spots"]], ["n101"])
        self.assertIn(f"failed tiles: {len(A.TILES)}", out)

    def test_sport_failure_exits_nonzero_and_keeps_file(self):
        A.write(self.path, FIX["file"]["spots"])
        before = read(self.path)
        rc, out, err = run_main(self.path, sport=None, answers_by_tile={})
        self.assertEqual(rc, 1)
        self.assertEqual(read(self.path), before)
        self.assertIn("sport query failed", err)
        self.assertEqual(out, "", "no counts: nothing was built")

    def test_empty_sport_answer_counts_as_failure(self):
        A.write(self.path, FIX["file"]["spots"])
        rc, out, err = run_main(self.path, sport=FIX["empty"], answers_by_tile={})
        self.assertEqual(rc, 1)
        self.assertEqual(read(self.path)["spots"], FIX["file"]["spots"])

    def test_unchanged_file_is_not_rewritten(self):
        sport = {"elements": FIX["spots"]["elements"][:1]}
        rc, _, _ = run_main(self.path, sport=sport, answers_by_tile={})
        self.assertEqual(rc, 0)
        stamp = read(self.path)["generatedAt"]
        with open(self.path, "a", encoding="utf-8") as f:
            f.write("\n")                                  # a marker the rewrite would erase
        rc, _, err = run_main(self.path, sport=sport, answers_by_tile={})
        self.assertEqual(rc, 0)
        self.assertIn("unchanged", err)
        with open(self.path, encoding="utf-8") as f:
            self.assertTrue(f.read().endswith("\n\n"), "file left alone")
        self.assertEqual(read(self.path)["generatedAt"], stamp)

    def test_tiles_use_short_timeout_and_pause_and_prefer_the_last_good_mirror(self):
        sport = {"elements": FIX["spots"]["elements"][:1]}
        real = A.overpass
        # every tile fails: a pause between tiles (not before the first), every tile listed, nothing raised
        sleeps = []
        A.overpass = fake_overpass({}, sport=sport, fail=tuple(t[0] for t in A.TILES))
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                answers, failed = A.fetch_beaches(tiles=A.TILES[:3], mirrors=["https://a/", "https://b/"], pause_s=3, sleep=sleeps.append)
        finally:
            A.overpass = real
        self.assertEqual((answers, len(failed)), ([], 3))
        self.assertEqual(sleeps, [3, 3], "a pause between tiles, not before the first")
        # tiles that answer: overpass() gets the tile timeout and one attempt, and the mirror that answered goes first
        calls = []
        A.overpass = fake_overpass({}, sport=sport, calls=calls)
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                answers, failed = A.fetch_beaches(tiles=A.TILES[:2], mirrors=["https://a/", "https://b/"], sleep=lambda s: None)
        finally:
            A.overpass = real
        self.assertEqual((len(answers), failed), (2, []))
        self.assertEqual([c[3] for c in calls], [A.TILE_READ_TIMEOUT_S] * 2)
        self.assertEqual([c[2] for c in calls], [A.TILE_ATTEMPTS_PER_MIRROR] * 2)
        self.assertEqual(calls[0][1], ["https://a/", "https://b/"])
        self.assertEqual(calls[1][1], ["https://b/", "https://a/"], "the mirror that answered the last tile goes first")

    def test_budget_skips_remaining_tiles(self):
        clock = [0.0]
        def now():
            clock[0] += 100
            return clock[0]
        real = A.overpass
        A.overpass = fake_overpass({}, sport=None)
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                answers, failed = A.fetch_beaches(tiles=A.TILES[:4], budget_s=150, now=now, sleep=lambda s: None)
        finally:
            A.overpass = real
        self.assertEqual(len(answers), 1)
        self.assertEqual([t[0] for t in failed], [t[0] for t in A.TILES[1:4]])

    def test_offline_input_mode_still_works(self):
        p = os.path.join(self.dir.name, "in.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(FIX["many"], f)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            rc = A.main(["away_spots.py", self.path, "--input", p])
        self.assertEqual(rc, 0)
        self.assertEqual(read(self.path)["count"], 3 + 3 + 60)


if __name__ == "__main__":
    unittest.main(verbosity=1)
