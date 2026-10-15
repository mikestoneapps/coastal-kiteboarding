// `node alerts/test.mjs` — (1) scoring parity: the page's inline scoring block must give the same
// dayScore as scoring.js; (2) the alert decision rules on a synthetic forecast.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoring, SPOTS, evaluate, DEFAULT_ALERTS, inQuiet, laNow } from "./lib.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const assert = (c, m) => { if (!c) { fails++; console.error("FAIL:", m); } else console.log("ok  ", m); };
const near = (a, b) => (a == null && b == null) || Math.abs(a - b) < 1e-9;

/* ---------- synthetic forecast ---------- */
const DAYSK = ["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"];   // Sat..Wed
function doc(fn) {
  const time = []; DAYSK.forEach(d => { for (let h = 0; h < 24; h++) time.push(`${d}T${String(h).padStart(2, "0")}:00`); });
  const f = { time, spd: [], gst: [], dir: [], temp: [], pop: [], code: [], vis: [], wh: [], wp: [], m: { gfs: { spd: [] }, icon: { spd: [] } } };
  time.forEach((t, i) => { const v = fn(t.slice(0, 10), +t.slice(11, 13), i); f.spd.push(v.spd); f.gst.push(v.gst ?? v.spd * 1.2); f.dir.push(v.dir ?? 290); f.temp.push(60); f.pop.push(v.pop ?? 0); f.code.push(v.code ?? 1); f.vis.push(20000); f.wh.push(v.wh ?? 1); f.wp.push(10); f.m.gfs.spd.push(v.gfs ?? v.spd); f.m.icon.spd.push(v.icon ?? v.spd); });
  return f;
}
const great = () => ({ spd: 20 });                                  // 20g24 W all week
const varied = (d, h) => ({ spd: 8 + ((h * 7 + d.charCodeAt(9) * 3) % 30), gst: 10 + ((h * 11) % 35), dir: (h * 37) % 360, wh: ((h * 13) % 12) / 1.5, pop: (h * 9) % 100, code: h % 5 === 0 ? 45 : 1, gfs: 10 + (h % 9), icon: 14 + (h % 11) });

/* ---------- 1. parity with the page ---------- */
{
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const a = html.indexOf("/* ---------- scoring ---------- */"), b = html.indexOf("/* ---------- helpers ---------- */");
  assert(a > 0 && b > a, "found the page's scoring block");
  const block = html.slice(a, b);
  const comfort = { minWind: 14, maxWind: 26, maxGust: 30, maxSurf: 5, minHours: 4, stretch: true };
  const overrides = { manzanita: { maxWind: 34, minHours: 2 }, rufus: { maxGust: 20 } };
  const weights = { speed: 1.5, dir: 1, gust: 0.5, wave: 2, wx: 1 };
  const sandbox = { STYLES: scoring.STYLES, DAY_START: 7, DAY_END: 19, NUKE: 35, obsData: {}, Date, Math, Object, Array, Number, String, Set, JSON, console,
    settings: { weights, comfort, overrides }, compass: d => "W", mode: null, m2ft: null };
  sandbox.limitsFor = id => ({ ...comfort, ...(overrides[id] || {}) });
  vm.createContext(sandbox);
  vm.runInContext(block + "\nthis.pageDayScore=dayScore;", sandbox);
  let n = 0, same = 0;
  for (const spot of SPOTS) for (const style of ["freeride", "wave", "foil"]) for (const f of [doc(great), doc(varied)]) for (const d of DAYSK) {
    const p = sandbox.pageDayScore(spot, f, d, style);
    const s = scoring.dayScore(spot, f, d, style, weights, scoring.limitsFor({ comfort, overrides }, spot.id));
    n++;
    const ok = p && s && near(p.score, s.score) && p.from === s.from && p.to === s.to && p.reason === s.reason && p.agree === s.agree && p.window === s.window && !!p.mine === !!s.mine;
    if (ok) same++; else if (same === n - 1) console.error("first mismatch:", spot.id, style, d, p && { score: p.score, from: p.from, reason: p.reason }, s && { score: s.score, from: s.from, reason: s.reason });
  }
  assert(same === n && n > 0, `scoring.js matches the page on ${n} spot/style/day cases (limits, overrides, weights, minHours)`);
  const s0 = scoring.dayScore(SPOTS[0], doc(great), DAYSK[0], "freeride", scoring.DEFAULT_WEIGHTS);
  assert(s0 && s0.score > 0 && s0.window === 3, "dayScore without limits still works (default comfort, 3-hour window)");
}

/* ---------- 2. decision rules ---------- */
{
  const F = {}; SPOTS.forEach(s => { F[s.id] = doc(great); });
  const sat = { date: "2026-10-17", hour: 19, dow: 6 };
  const rider = (alerts = {}, state = {}, extra = {}) => ({ id: "r1", settings: { style: "freeride", alerts: { ...DEFAULT_ALERTS, ...alerts }, ...extra }, state });

  let r = evaluate(rider({ sameDay: false }), F, sat);
  assert(r.notification && /Tomorrow looks great from Lake Oswego/.test(r.notification.body) && /from Bay City/.test(r.notification.body), "19:00: tomorrow's digest for both houses: " + r.notification.body);
  assert(r.notification.url === "./#day=2026-10-18" && Object.keys(r.state.alerted).every(k => k.endsWith("|2026-10-18") || k.endsWith("|2026-10-19") || k.endsWith("|2026-10-20")) && r.state.sent["2026-10-17"] === 1, "deep link to the first day; every qualifying spot-day recorded; daily count 1");
  const keys = Object.keys(r.state.alerted).length;
  assert(keys > 3, `records all ${keys} qualifying spot-days, not only the three named`);

  let r2 = evaluate(rider({ sameDay: false }, r.state), F, { ...sat, hour: 20 });
  assert(!r2.notification && r2.why === "daily cap reached", "same day again: cap of 1 holds");
  const sun = { date: "2026-10-18", hour: 19, dow: 0 };
  r2 = evaluate(rider({ sameDay: false }, r.state), F, sun);
  assert(r2.notification && /^Wednesday looks great/.test(r2.notification.body) && !/Monday|Tuesday/.test(r2.notification.body) && Object.keys(r2.state.alerted).every(k => k.split("|")[1] >= "2026-10-18"), "next day: only the day that rolled into the lead window is new; past days pruned");

  r2 = evaluate(rider({ sameDay: false }), F, { ...sat, hour: 15 });
  assert(!r2.notification && r2.why === "waiting for the delivery hour", "15:00: holds tomorrow's digest until the delivery hour");
  r2 = evaluate(rider({ sameDay: false }), F, { ...sat, hour: 22 });
  assert(!r2.notification && r2.why === "quiet hours", "22:00: quiet hours");
  r2 = evaluate(rider({ sameDay: true }), F, { ...sat, hour: 8 });
  assert(r2.notification && /^Today looks great/.test(r2.notification.body), "08:00 with same-day on: today's digest in the morning");
  r2 = evaluate(rider({ sameDay: true }), F, { ...sat, hour: 14 });
  assert(!r2.notification, "14:00: no same-day alert in the afternoon, tomorrow waits for 19:00");
  r2 = evaluate(rider({ sameDay: false, days: [6] }), F, sat);
  assert(!r2.notification && r2.why === "nothing new", "days-of-week: only Saturdays -> nothing for Sun–Tue");
  r2 = evaluate(rider({ sameDay: false, maxDrive: 60 }), F, sat);
  assert(r2.notification && !/Floras/.test(r2.notification.body) && Object.keys(r2.state.alerted).length < keys, "drive radius trims the digest");
  const F18 = {}; SPOTS.forEach(s => { F18[s.id] = doc(() => ({ spd: 18 })); });
  r2 = evaluate(rider({ sameDay: false, minScore: 10 }), F18, sat);
  assert(!r2.notification && evaluate(rider({ sameDay: false, minScore: 8 }), F18, sat).notification, "threshold above every score -> nothing; lower it -> digest");
  r2 = evaluate(rider({ sameDay: false }, {}, { comfort: { maxWind: 18 } }), F, sat);
  assert(!r2.notification && r2.why === "nothing new", "the rider's own max-wind limit gates the alert (20 kn > 18)");
  r2 = evaluate(rider({ sameDay: false }, {}, { overrides: Object.fromEntries(SPOTS.filter(s => s.id !== "rufus").map(s => [s.id, { maxWind: 18 }])) }), F, sat);
  assert(r2.notification && /Rufus/.test(r2.notification.body) && !/Manzanita/.test(r2.notification.body), "per-spot overrides apply");

  // confidence gate: models disagree -> no alert unless the gate is off
  const Fd = {}; SPOTS.forEach(s => { Fd[s.id] = doc(() => ({ spd: 20, gfs: 30, icon: 10 })); });
  r2 = evaluate(rider({ sameDay: false }), Fd, sat);
  assert(!r2.notification, "models disagree + confidence gate -> nothing");
  r2 = evaluate(rider({ sameDay: false, confidence: false }), Fd, sat);
  assert(!!r2.notification, "confidence gate off -> digest goes out");

  // re-alert only on a >=2 move; fell-apart notice when it drops below the threshold
  const prev = { alerted: Object.fromEntries(Object.keys(r.state.alerted).map(k => [k, { score: 10, at: "x" }])), sent: {} };
  r2 = evaluate(rider({ sameDay: false }, prev), F, sat);
  assert(!r2.notification && r2.why === "nothing new", "already alerted at the same score -> no repeat");
  const prev2 = { alerted: Object.fromEntries(Object.keys(r.state.alerted).map(k => [k, { score: 8, at: "x" }])), sent: {} };
  r2 = evaluate(rider({ sameDay: false }, prev2), F, sat);
  assert(!!r2.notification, "score moved from 8 to 10 -> re-alert");
  const Fdead = {}; SPOTS.forEach(s => { Fdead[s.id] = doc(() => ({ spd: 5 })); });
  r2 = evaluate(rider({ sameDay: false }, { alerted: { "manzanita|2026-10-19": { score: 9.1, at: "x" } }, sent: {} }), Fdead, { ...sun, hour: 9 });
  assert(r2.notification && /^Tomorrow fell apart — Manzanita \/ Nehalem Bay is down to 0\.0 \(too light\)/.test(r2.notification.body) && !r2.state.alerted["manzanita|2026-10-19"], "fell-apart notice, sent outside the delivery hour, clears the key: " + r2.notification.body);
  r2 = evaluate(rider({ sameDay: false }, r2.state), Fdead, { ...sun, hour: 10 });
  assert(!r2.notification, "fell-apart is said once");

  // kept spots score like curated ones
  const kept = { id: "k-test", name: "Test Beach", region: "Kept", lat: 45.5, lon: -123.95, plat: 45.5, plon: -123.95, dir: { best: [[240, 300]], work: [[200, 340]], off: [[60, 120]] }, waves: true, driveLO: 100, driveBC: 20, kept: true };
  const Fk = { ...Fdead, "k-test": doc(great) };
  r2 = evaluate(rider({ sameDay: false }, {}, { kept: [kept] }), Fk, sat);
  assert(r2.notification && /Test Beach 10\.0 \(20 min\)/.test(r2.notification.body), "a kept spot alerts with its own drive time: " + r2.notification.body);

  assert(inQuiet(22, 21, 7) && inQuiet(3, 21, 7) && !inQuiet(8, 21, 7) && inQuiet(13, 12, 14) && !inQuiet(15, 12, 14), "quiet-hours window wraps midnight");
  const n = laNow(new Date("2026-10-17T02:30:00Z"));
  assert(n.date === "2026-10-16" && n.hour === 19 && n.dow === 5, "laNow converts to Pacific time");
}

if (fails) { console.error(fails + " test(s) failed"); process.exit(1); }
console.log("all alert tests passed");
