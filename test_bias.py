#!/usr/bin/env python3
"""Tests for bias.py:  python3 test_bias.py

Checks: median(observed − forecast) per spot and model, the sign (positive = station reads higher), only pairs with MIN_N or
more samples are written, a model missing on some lines counts only the lines it has, "median" is a series of its own,
unknown spots and lines without a reading are ignored, an empty or missing log gives {}, and the CLI exits 0 on garbage."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
import bias as B  # noqa: E402


def line(spot, obs, fc, median=None, i=0):
    return {"spot": spot, "time": f"2026-10-{1 + i // 24:02d}T{i % 24:02d}:00", "run": "2026-10-19T22:35:17+00:00", "station": "S", "dist_mi": 5,
            "obs": obs, "obs_gst": None, "obs_dir": 290, "fc": fc, "fc_gst": {}, "fc_dir": 280, "median": median}


def log():
    lines = []
    # manzanita: 45 lines; the station reads 4 kn over best match on most hours, 1 kn over ECMWF, NBM missing on every third line
    for i in range(45):
        bm = 10.0 + (i % 5)
        nbm = None if i % 3 == 0 else bm + 1.0
        lines.append(line("manzanita", bm + 4.0 + (0.5 if i % 7 == 0 else 0), {"bm": bm, "ecmwf": bm + 3.0, "nbm": nbm, "gfs": bm - 2.0, "icon": None}, median=bm + 2.0, i=i))
    # rockaway: 39 lines, one short of the threshold
    for i in range(39):
        lines.append(line("rockaway", 12.0, {"bm": 8.0, "ecmwf": 8.0, "nbm": 8.0, "gfs": 8.0, "icon": 8.0}, median=8.0, i=i))
    # rufus: 40 lines where the station reads under NBM (negative bias) and exactly matches best match
    for i in range(40):
        lines.append(line("rufus", 15.0, {"bm": 15.0, "ecmwf": 12.0, "nbm": 18.0, "gfs": 11.0, "icon": 10.0}, median=15.0, i=i))
    # junk: a kept spot, a line without a reading, a line without fc
    lines += [line("k-test", 10.0, {"bm": 5.0}) for _ in range(50)]
    lines.append(line("manzanita", None, {"bm": 1.0}))
    lines.append({"spot": "manzanita", "obs": 10.0})
    return lines


class Bias(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.log = os.path.join(self.dir, "accuracy.jsonl")
        self.out = os.path.join(self.dir, "bias.json")

    def write_log(self, lines):
        with open(self.log, "w", encoding="utf-8") as fh:
            for ln in lines:
                fh.write(json.dumps(ln) + "\n")

    def test_compute(self):
        d = B.compute(log(), spots={"manzanita", "rockaway", "rufus"})
        self.assertEqual(set(d), {"manzanita", "rufus"}, "rockaway has 39 pairs, one short; the kept spot is not curated")
        m = d["manzanita"]
        self.assertEqual(m["bm"], {"kn": 4.0, "n": 45}, "median(observed − best match): the station reads 4 kn high")
        self.assertEqual(m["ecmwf"], {"kn": 1.0, "n": 45})
        self.assertEqual(m["median"], {"kn": 2.0, "n": 45}, "the median series has its own bias")
        self.assertEqual(m["gfs"]["kn"], 6.0)
        self.assertNotIn("nbm", m, "NBM is missing on 15 of 45 lines: 30 pairs, under the threshold")
        self.assertNotIn("icon", m, "a model that never had a value has no entry")
        r = d["rufus"]
        self.assertEqual((r["bm"], r["nbm"], r["ecmwf"]), ({"kn": 0.0, "n": 40}, {"kn": -3.0, "n": 40}, {"kn": 3.0, "n": 40}), "exactly 40 counts; negative when the station reads under the model")
        self.assertEqual(B.compute(log(), spots={"manzanita", "rockaway", "rufus"}, min_n=39)["rockaway"]["bm"], {"kn": 4.0, "n": 39})
        self.assertIn("k-test", B.compute(log()), "without a spot filter every spot in the log is computed")

    def test_run_writes_file(self):
        self.write_log(log())
        d = B.run(self.log, self.out)
        with open(self.out, encoding="utf-8") as fh:
            on_disk = json.load(fh)
        self.assertEqual(on_disk, d)
        self.assertEqual(set(d), {"manzanita", "rufus"}, "spots.json's ids only")
        self.assertEqual(on_disk["manzanita"]["bm"], {"kn": 4.0, "n": 45})

    def test_empty_and_missing_log(self):
        self.assertEqual(B.run(self.log, self.out), {}, "no log yet: an empty object, never a crash")
        with open(self.out, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "{}\n")
        self.write_log([])
        self.assertEqual(B.run(self.log, self.out), {})

    def test_cli_never_fails(self):
        with open(self.log, "w") as fh:
            fh.write("{broken\n")
        r = subprocess.run([sys.executable, os.path.join(ROOT, "bias.py"), self.log, self.out], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("bias:", r.stdout)
        with open(self.out, encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), {})
        r = subprocess.run([sys.executable, os.path.join(ROOT, "bias.py"), self.log, os.path.join(self.dir, "no", "such", "dir", "bias.json")], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, "an unwritable output path is reported, not fatal")
        self.assertIn("bias skipped", r.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
