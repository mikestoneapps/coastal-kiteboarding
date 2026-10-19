#!/usr/bin/env python3
"""Tests for accuracy.py with Open-Meteo replaced by a fake answer:  python3 test_accuracy.py

Checks: which reading counts (nearest station with wind under 2 h old), the Pacific hour it is matched to, one call with the
page's five models covering that hour, the per-model values and the median the score ran on, no duplicate lines when a
station hasn't updated, the 90-day cap, and that a network failure leaves the file alone and exits 0."""
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
import accuracy as A  # noqa: E402

NOW = dt.datetime(2026, 10, 19, 21, 40, tzinfo=dt.timezone.utc)   # 14:40 Pacific (PDT)
ISO = lambda t: t.isoformat(timespec="seconds")                   # noqa: E731


def obs_doc():
    return {"fetchedAt": ISO(NOW), "obs": {
        # fresh nearest station, 35 min old at :05 -> hour 14:00 Pacific
        "manzanita": [{"id": "TMKO3", "name": "TILLAMOOK", "kind": "nws", "dist_mi": 19.3, "time": ISO(NOW - dt.timedelta(minutes=35)), "spd": 12.3, "gst": 15.1, "dir": 290}],
        # nearest has no wind value; the second (a buoy, 25 min old at :15 -> 14:00) is used
        "fortstevens": [{"id": "KAST", "kind": "nws", "dist_mi": 5.2, "time": ISO(NOW - dt.timedelta(minutes=10)), "spd": None, "gst": None, "dir": None},
                        {"id": "46029", "kind": "ndbc", "dist_mi": 25.6, "time": ISO(NOW - dt.timedelta(minutes=25)), "spd": 5.8, "gst": 7.8, "dir": 150.0}],
        # only a 3-hour-old reading: skipped
        "rufus": [{"id": "E2137", "kind": "nws", "dist_mi": 7.8, "time": ISO(NOW - dt.timedelta(hours=3)), "spd": 20.0, "gst": 25.0, "dir": 270}],
        # reading at 14:35 Pacific -> rounds up to 15:00
        "pacificcity": [{"id": "AT297", "kind": "nws", "dist_mi": 0.3, "time": ISO(NOW.replace(minute=35)), "spd": 9.0, "gst": None, "dir": 300}],
        # not a curated spot: ignored
        "k-somewhere": [{"id": "X", "kind": "nws", "dist_mi": 1, "time": ISO(NOW), "spd": 10}],
        "stevenson": [],
    }}


def fake_answer(n, nbm_null_at=None):
    """Open-Meteo's shape for n points, past_days=1 + forecast_days=1 in Pacific time, five models with distinct values."""
    day0 = (NOW.astimezone(A.LA) - dt.timedelta(days=1)).strftime("%Y-%m-%d")
    times = []
    for d in range(2):
        day = (dt.datetime.fromisoformat(day0) + dt.timedelta(days=d)).strftime("%Y-%m-%d")
        times += [f"{day}T{h:02d}:00" for h in range(24)]
    vals = {"best_match": 10.0, "ecmwf_ifs025": 16.0, "ncep_nbm_conus": 13.0, "gfs_seamless": 20.0, "icon_seamless": 7.0}
    out = []
    for p in range(n):
        h = {"time": times}
        for m, v in vals.items():
            h[f"wind_speed_10m_{m}"] = [v + p for _ in times]
            h[f"wind_gusts_10m_{m}"] = [v + p + 4 for _ in times]
            h[f"wind_direction_10m_{m}"] = [280 for _ in times]
        if nbm_null_at is not None and p == nbm_null_at:
            h["wind_speed_10m_ncep_nbm_conus"] = [None for _ in times]
        out.append({"hourly": h})
    return out


class Accuracy(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.obs = os.path.join(self.dir, "obs.json")
        self.out = os.path.join(self.dir, "accuracy.jsonl")
        with open(self.obs, "w") as fh:
            json.dump(obs_doc(), fh)

    def lines(self):
        return A.read_lines(self.out)

    def raw(self):
        with open(self.out, encoding="utf-8") as fh:
            return fh.read()

    def test_picks_matches_and_logs(self):
        calls = []

        def get(url):
            calls.append(url)
            return fake_answer(3, nbm_null_at=1)
        added = A.run(self.obs, self.out, get=get, now=NOW)
        self.assertEqual(added, 3)
        q = urllib.parse.parse_qs(urllib.parse.urlparse(calls[0]).query)
        self.assertEqual(len(calls), 1)
        self.assertEqual(q["models"], ["best_match,ecmwf_ifs025,ncep_nbm_conus,gfs_seamless,icon_seamless"])
        self.assertEqual((q["wind_speed_unit"], q["past_days"], q["forecast_days"], q["timezone"]), (["kn"], ["1"], ["1"], ["America/Los_Angeles"]))
        self.assertEqual(q["latitude"], ["45.72,46.19,45.2"], "only spots with a fresh reading, in obs.json order")
        L = {ln["spot"]: ln for ln in self.lines()}
        self.assertEqual(set(L), {"manzanita", "fortstevens", "pacificcity"}, "stale rufus, empty stevenson and the kept spot are skipped")
        m = L["manzanita"]
        self.assertEqual((m["time"], m["station"], m["obs"], m["obs_gst"], m["obs_dir"], m["run"]), ("2026-10-19T14:00", "TMKO3", 12.3, 15.1, 290, ISO(NOW)))
        self.assertEqual(m["fc"], {"bm": 10.0, "ecmwf": 16.0, "nbm": 13.0, "gfs": 20.0, "icon": 7.0})
        self.assertEqual(m["fc_gst"]["nbm"], 17.0)
        self.assertEqual((m["median"], m["fc_dir"]), (13.0, 280), "median of best match, ECMWF and NBM; GFS and ICON never enter it")
        f = L["fortstevens"]
        self.assertEqual((f["station"], f["dist_mi"], f["fc"]["nbm"], f["median"]), ("46029", 25.6, None, 14.0), "second station when the nearest has no wind; NBM missing -> mean of the other two")
        self.assertEqual(L["pacificcity"]["time"], "2026-10-19T15:00", "a reading at :35 belongs to the next hour")
        self.assertEqual(L["pacificcity"]["fc"]["bm"], 12.0, "third point of the answer")

    def test_no_duplicates_and_cap(self):
        old = {"spot": "manzanita", "time": "2026-07-01T10:00", "run": ISO(NOW - dt.timedelta(days=100)), "station": "TMKO3", "obs": 1}
        recent = {"spot": "manzanita", "time": "2026-10-10T10:00", "run": ISO(NOW - dt.timedelta(days=9)), "station": "TMKO3", "obs": 2}
        A.write_lines(self.out, [old, recent])
        self.assertEqual(A.run(self.obs, self.out, get=lambda u: fake_answer(3), now=NOW), 3)
        self.assertEqual(A.run(self.obs, self.out, get=lambda u: fake_answer(3), now=NOW + dt.timedelta(hours=1)), 0, "same readings next run: nothing added")
        L = self.lines()
        self.assertEqual(len(L), 4)
        self.assertNotIn(old["run"], [ln["run"] for ln in L], "100-day-old line dropped")
        self.assertIn(recent["run"], [ln["run"] for ln in L], "9-day-old line kept")
        raw = self.raw()
        self.assertTrue(raw.endswith("\n") and all(json.loads(x) for x in raw.strip().split("\n")), "one compact JSON object per line")

    def test_network_failure_leaves_file_and_exits_zero(self):
        A.write_lines(self.out, [{"spot": "x", "time": "t", "run": ISO(NOW), "station": "s"}])
        before = self.raw()

        def boom(u):
            raise RuntimeError("HTTP 500")
        with self.assertRaises(RuntimeError):
            A.run(self.obs, self.out, get=boom, now=NOW)
        self.assertEqual(self.raw(), before)
        # the CLI swallows it (the obs.json commit must not depend on this log)
        env = {**os.environ, "HTTPS_PROXY": "http://127.0.0.1:9", "HTTP_PROXY": "http://127.0.0.1:9", "NO_PROXY": ""}
        r = subprocess.run([sys.executable, os.path.join(ROOT, "accuracy.py"), self.obs, self.out], capture_output=True, text=True, env=env, timeout=300)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("accuracy log skipped", r.stderr)
        self.assertEqual(self.raw(), before)

    def test_no_fresh_readings_writes_empty_file(self):
        with open(self.obs, "w") as fh:
            json.dump({"fetchedAt": ISO(NOW), "obs": {"rufus": obs_doc()["obs"]["rufus"]}}, fh)
        called = []
        self.assertEqual(A.run(self.obs, self.out, get=lambda u: called.append(u), now=NOW), 0)
        self.assertEqual(called, [], "no forecast call without a reading to compare")
        self.assertTrue(os.path.exists(self.out) and self.raw() == "")

    def test_helpers(self):
        self.assertEqual(A.median([3, None, 1, 2]), 2)
        self.assertEqual(A.median([4, 1]), 2.5)
        self.assertIsNone(A.median([None]))
        self.assertEqual(A.hour_key(dt.datetime(2026, 10, 19, 21, 29, tzinfo=dt.timezone.utc)), "2026-10-19T14:00")
        self.assertEqual(A.hour_key(dt.datetime(2026, 10, 19, 21, 30, tzinfo=dt.timezone.utc)), "2026-10-19T15:00")
        self.assertEqual(A.hour_key(dt.datetime(2026, 1, 19, 21, 30, tzinfo=dt.timezone.utc)), "2026-01-19T14:00", "PST in winter")


if __name__ == "__main__":
    unittest.main(verbosity=1)
