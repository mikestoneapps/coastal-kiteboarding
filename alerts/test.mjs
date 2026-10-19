// `node alerts/test.mjs` — (1) scoring parity: the page's inline scoring block must give the same
// dayScore as scoring.js; (2) the alert decision rules on a synthetic forecast.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoring, SPOTS, evaluate, DEFAULT_ALERTS, inQuiet, laNow, fetchForecasts, MODEL_IDS } from "./lib.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const assert = (c, m) => { if (!c) { fails++; console.error("FAIL:", m); } else console.log("ok  ", m); };
const near = (a, b) => (a == null && b == null) || Math.abs(a - b) < 1e-9;

/* ---------- synthetic forecast ---------- */
const DAYSK = ["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"];   // Sat..Wed
function doc(fn) {
  const time = []; DAYSK.forEach(d => { for (let h = 0; h < 24; h++) time.push(`${d}T${String(h).padStart(2, "0")}:00`); });
  const f = { time, spd: [], gst: [], dir: [], temp: [], pop: [], code: [], vis: [], wh: [], wp: [], m: { bm: { spd: [], gst: [] }, ecmwf: { spd: [], gst: [] }, nbm: { spd: [], gst: [] }, gfs: { spd: [] }, icon: { spd: [] } } };
  time.forEach((t, i) => { const v = fn(t.slice(0, 10), +t.slice(11, 13), i); const g = v.gst ?? v.spd * 1.2; f.spd.push(v.spd); f.gst.push(g); f.dir.push(v.dir ?? 290); f.temp.push(60); f.pop.push(v.pop ?? 0); f.code.push(v.code ?? 1); f.vis.push(20000); f.wh.push(v.wh ?? 1); f.wp.push(10);
    const or = (x, d) => x === undefined ? d : x;   // null means "this model has no value this hour"
    f.m.bm.spd.push(or(v.bm, v.spd)); f.m.bm.gst.push(or(v.bmg, g)); f.m.ecmwf.spd.push(or(v.ecmwf, v.spd)); f.m.ecmwf.gst.push(or(v.ecmwfg, g)); f.m.nbm.spd.push(or(v.nbm, v.spd)); f.m.nbm.gst.push(or(v.nbmg, g)); f.m.gfs.spd.push(v.gfs ?? v.spd); f.m.icon.spd.push(v.icon ?? v.spd); });
  return f;
}
const great = () => ({ spd: 20 });                                  // 20g24 W all week
const varied = (d, h) => ({ spd: 8 + ((h * 7 + d.charCodeAt(9) * 3) % 30), gst: 10 + ((h * 11) % 35), dir: (h * 37) % 360, wh: ((h * 13) % 12) / 1.5, pop: (h * 9) % 100, code: h % 5 === 0 ? 45 : 1, gfs: 10 + (h % 9), icon: 14 + (h % 11), ecmwf: 6 + (h % 13), nbm: 12 + (h % 7) });
// raw per-model doc (what fetchForecasts builds before consensus): spd is best match, the three score models disagree
const rawDoc = () => doc((d, h) => ({ spd: 12 + (h % 5), gst: 16 + (h % 5), ecmwf: 20 - (h % 4), nbm: h % 6 === 0 ? null : 15 + (h % 3), ecmwfg: 25 - (h % 4), nbmg: h % 6 === 0 ? null : 19 + (h % 3), gfs: 9, icon: 22 }));

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
    settings: { weights, comfort, overrides }, compass: d => "W", mode: null, m2ft: null, wn: v => Math.round(v) + " kn", wnum: v => String(Math.round(v)), wrange: (a, b) => `${a}–${b} kn` };   // the page's unit formatters live outside the block
  sandbox.limitsFor = id => ({ ...comfort, ...(overrides[id] || {}) });
  vm.createContext(sandbox);
  vm.runInContext(block + "\nthis.pageDayScore=dayScore; this.pageConsensus=consensus; this.pageModelSpread=modelSpread;", sandbox);
  let n = 0, same = 0;
  const sameModels = (a, b) => (a == null && b == null) || (a && b && near(a.lo, b.lo) && near(a.hi, b.hi) && a.loLabel === b.loLabel && a.hiLabel === b.hiLabel && a.n === b.n);
  for (const spot of SPOTS) for (const style of ["freeride", "wave", "foil"]) for (const f of [doc(great), doc(varied), scoring.consensus(rawDoc())]) for (const d of DAYSK) {
    const p = sandbox.pageDayScore(spot, f, d, style);
    const s = scoring.dayScore(spot, f, d, style, weights, scoring.limitsFor({ comfort, overrides }, spot.id));
    n++;
    const ok = p && s && near(p.score, s.score) && p.from === s.from && p.to === s.to && p.reason === s.reason && p.agree === s.agree && sameModels(p.models, s.models) && p.window === s.window && !!p.mine === !!s.mine;
    if (ok) same++; else if (same === n - 1) console.error("first mismatch:", spot.id, style, d, p && { score: p.score, from: p.from, reason: p.reason }, s && { score: s.score, from: s.from, reason: s.reason });
  }
  assert(same === n && n > 0, `scoring.js matches the page on ${n} spot/style/day cases (limits, overrides, weights, minHours)`);
  const s0 = scoring.dayScore(SPOTS[0], doc(great), DAYSK[0], "freeride", scoring.DEFAULT_WEIGHTS);
  assert(s0 && s0.score > 0 && s0.window === 3, "dayScore without limits still works (default comfort, 3-hour window)");

  // the median the score runs on: best match / ECMWF / NBM per hour, GFS and ICON never blended in
  const raw = rawDoc(), c = scoring.consensus(raw), pc = sandbox.pageConsensus(raw);
  assert(JSON.stringify(c.spd) === JSON.stringify(pc.spd) && JSON.stringify(c.gst) === JSON.stringify(pc.gst), "consensus(): page and scoring.js build the same median series");
  const i1 = 1, i0 = 0;   // hour 1: bm 13, ecmwf 19, nbm 16 -> 16; hour 0: nbm null -> mean of bm 12 and ecmwf 20 = 16
  assert(c.spd[i1] === 16 && c.gst[i1] === 20 && c.spd[i0] === 16 && c.dir[i0] === raw.dir[i0] && raw.spd[i1] === 13, "median of the three per hour (gusts too); a model missing for an hour drops out; direction stays best match's");
  assert(!c.spd.some(v => v === 9 || v === 22) && c.m.bm.spd[i1] === 13, "GFS (9) and ICON (22) never enter the median; the raw per-model series stay on the doc");
  const legacy = { ...raw, m: { gfs: raw.m.gfs, icon: raw.m.icon } };
  assert(scoring.consensus(legacy) === legacy && scoring.consensus({ ...raw, m: { bm: raw.m.bm } }).spd === raw.spd, "an older cached doc (no ECMWF/NBM) is left as best match");
  assert(scoring.median([3, null, 1, 2]) === 2 && scoring.median([4, 1]) === 2.5 && scoring.median([null]) === null, "median(): odd, even, empty");
  // confidence over all five; the spread names the extremes
  const r5 = scoring.dayScore(SPOTS[0], c, DAYSK[0], "freeride", scoring.DEFAULT_WEIGHTS);
  assert(r5.models && r5.models.n === 5 && r5.models.hiLabel === "ICON" && r5.models.loLabel === "GFS" && near(r5.models.hi, 22) && near(r5.models.lo, 9) && r5.agree === "Models disagree", `five models vote: ${JSON.stringify(r5.models)}`);
  const rl = scoring.dayScore(SPOTS[0], legacy, DAYSK[0], "freeride", scoring.DEFAULT_WEIGHTS);
  assert(rl.models && rl.models.n === 3 && rl.agree === "Models disagree", "legacy doc: best match + GFS + ICON vote, as before");
  const rOne = scoring.dayScore(SPOTS[0], { ...raw, m: {} }, DAYSK[0], "freeride", scoring.DEFAULT_WEIGHTS);
  assert(rOne.agree === null && rOne.models === null, "a single model: no confidence chip");
  // fetchForecasts: one five-model call, consensus applied, three-model fallback if the API rejects a model id
  {
    const calls = [];
    const api = n => Array.from({ length: n }, (_, k) => { const time = DAYSK.flatMap(d => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, "0")}:00`)); const H = { time }; const put = (id, v) => { H["wind_speed_10m_" + id] = time.map(() => v); H["wind_gusts_10m_" + id] = time.map(() => v + 4); H["wind_direction_10m_" + id] = time.map(() => 280); }; put("best_match", 10 + k); put("ecmwf_ifs025", 20); put("ncep_nbm_conus", 14); put("gfs_seamless", 30); put("icon_seamless", 5); for (const x of ["temperature_2m", "precipitation_probability", "weather_code", "visibility"]) H[x + "_best_match"] = time.map(() => 1); return { hourly: H }; });
    const F = await fetchForecasts(SPOTS.slice(0, 2), async url => { calls.push(url); if (/marine/.test(url)) throw new Error("no marine in this test"); return api(2); });
    const u = new URL(calls[0]);
    assert(calls.filter(c => /api\.open-meteo/.test(c)).length === 1 && u.searchParams.get("models") === Object.values(MODEL_IDS).join(",") && u.searchParams.get("wind_speed_unit") === "kn", "one forecast call with the five models, in knots");
    assert(F[SPOTS[0].id].spd[12] === 14 && F[SPOTS[1].id].spd[12] === 14 && F[SPOTS[0].id].m.bm.spd[12] === 10 && F[SPOTS[0].id].m.nbm.gst[12] === 18 && Object.keys(F[SPOTS[0].id].m).join() === "bm,ecmwf,nbm,gfs,icon", "job docs: spd is the median (bm 10 / ecmwf 20 / nbm 14 -> 14), every model kept under f.m");
    let n2 = 0;
    const F3 = await fetchForecasts(SPOTS.slice(0, 1), async url => { if (/marine/.test(url)) throw new Error("x"); n2++; if (n2 === 1) throw new Error("HTTP 400"); const a = api(1); for (const k of Object.keys(a[0].hourly)) if (/ecmwf|nbm/.test(k)) delete a[0].hourly[k]; return a; });
    assert(n2 === 2 && F3[SPOTS[0].id].spd[12] === 10 && Object.keys(F3[SPOTS[0].id].m).join() === "bm,gfs,icon", "a rejected five-model call falls back to three; the doc is then best match alone, with no empty model slots");
  }
}

/* ---------- 2. decision rules ---------- */
{
  const F = {}; SPOTS.forEach(s => { F[s.id] = doc(great); });
  const sat = { date: "2026-10-17", hour: 19, dow: 6 };
  const rider = (alerts = {}, state = {}, extra = {}) => ({ id: "r1", settings: { style: "freeride", alerts: { ...DEFAULT_ALERTS, ...alerts }, ...extra }, state });

  let r = evaluate(rider({ sameDay: false }), F, sat);
  assert(r.notification && /Tomorrow looks great from Lake Oswego/.test(r.notification.body) && /from Pacific City/.test(r.notification.body), "19:00: tomorrow's digest for both houses: " + r.notification.body);
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
