#!/usr/bin/env python3
"""Tests for obs_recent.py:  python3 test_obs_recent.py

Checks: the nearest fresh reading per curated spot is kept (the stale, empty and kept-spot rows are not), the trimmed
fields, one entry per fetchedAt, oldest first, the KEEP_RUNS cap, an unreadable old file is replaced, and the CLI exits 0
on a missing obs.json."""
import datetime as dt
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
import obs_recent as R  # noqa: E402
from test_accuracy import NOW, ISO, obs_doc  # noqa: E402


class ObsRecent(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.obs = os.path.join(self.dir, "obs.json")
        self.out = os.path.join(self.dir, "obs-recent.json")
        with open(self.obs, "w") as fh:
            json.dump(obs_doc(), fh)

    def read(self):
        with open(self.out, encoding="utf-8") as fh:
            return json.load(fh)

    def test_snapshot_keeps_the_nearest_fresh_reading(self):
        doc = R.run(self.obs, self.out, now=NOW)
        self.assertEqual(len(doc["runs"]), 1)
        run = doc["runs"][0]
        self.assertEqual(run["at"], ISO(NOW))
        self.assertEqual(set(run["obs"]), {"manzanita", "fortstevens", "pacificcity"}, "stale rufus, empty stevenson and the kept spot are absent")
        self.assertEqual(run["obs"]["manzanita"], {"id": "TMKO3", "name": "TILLAMOOK", "kind": "nws", "dist_mi": 19.3, "time": ISO(NOW - dt.timedelta(minutes=35)), "spd": 12.3, "gst": 15.1, "dir": 290})
        self.assertEqual(run["obs"]["fortstevens"]["id"], "46029", "second station when the nearest has no wind")
        self.assertNotIn("age_min", run["obs"]["pacificcity"], "only the listed fields, age is read off the timestamp later")
        self.assertEqual(self.read(), doc)

    def test_rolling_history(self):
        R.run(self.obs, self.out, now=NOW)
        R.run(self.obs, self.out, now=NOW + dt.timedelta(hours=1))
        self.assertEqual(len(self.read()["runs"]), 1, "the same obs.json (same fetchedAt) is not recorded twice")
        for h in range(1, 9):
            d = obs_doc()
            d["fetchedAt"] = ISO(NOW + dt.timedelta(hours=h))
            for rows in d["obs"].values():
                for o in rows:
                    o["time"] = ISO(NOW + dt.timedelta(hours=h, minutes=-20))
            with open(self.obs, "w") as fh:
                json.dump(d, fh)
            R.run(self.obs, self.out, now=NOW + dt.timedelta(hours=h))
        runs = self.read()["runs"]
        self.assertEqual(len(runs), R.KEEP_RUNS)
        self.assertEqual([r["at"] for r in runs], [ISO(NOW + dt.timedelta(hours=h)) for h in range(9 - R.KEEP_RUNS, 9)], "the last KEEP_RUNS runs, oldest first")
        self.assertIn("rufus", runs[-1]["obs"], "rufus's reading is fresh in the later runs")

    def test_unreadable_old_file_is_replaced(self):
        with open(self.out, "w") as fh:
            fh.write("{not json")
        doc = R.run(self.obs, self.out, now=NOW)
        self.assertEqual(len(doc["runs"]), 1)
        with open(self.out, "w") as fh:
            json.dump({"runs": [{"bogus": 1}, {"at": ISO(NOW - dt.timedelta(hours=1)), "obs": {}}]}, fh)
        doc = R.run(self.obs, self.out, now=NOW)
        self.assertEqual([r["at"] for r in doc["runs"]], [ISO(NOW - dt.timedelta(hours=1)), ISO(NOW)], "entries without at/obs are dropped, the rest kept in order")

    def test_cli_never_fails(self):
        r = subprocess.run([sys.executable, os.path.join(ROOT, "obs_recent.py"), os.path.join(self.dir, "missing.json"), self.out], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("obs-recent skipped", r.stderr)
        self.assertFalse(os.path.exists(self.out))
        r = subprocess.run([sys.executable, os.path.join(ROOT, "obs_recent.py"), self.obs, self.out], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("spot(s) with a fresh reading", r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=1)
