// `node alerts/test.mjs` — (1) scoring parity: the page's inline scoring block must give the same
// dayScore as scoring.js; (2) the alert decision rules on a synthetic forecast.
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoring, SPOTS, evaluate, DEFAULT_ALERTS, inQuiet, laNow, fetchForecasts, MODEL_IDS, DAYS, ALERT_DAYS, deliver, GONE, sunOf, blowingNow, blowingText, laHour, windText, BLOW_RUNS, OBS_MAX_AGE } from "./lib.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const assert = (c, m) => { if (!c) { fails++; console.error("FAIL:", m); } else console.log("ok  ", m); };
const near = (a, b) => (a == null && b == null) || Math.abs(a - b) < 1e-9;

/* ---------- synthetic forecast ---------- */
const DAYSK = ["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];   // Sat..Fri: seven forecast days, the last two a trend
const SUN = ["07:33", "18:20"];   // sunrise / sunset on every synthetic day: the scored hours are then the 8a..5p slots (an hour counts when its midpoint is in daylight)
function doc(fn, sun = true) {
  const time = []; DAYSK.forEach(d => { for (let h = 0; h < 24; h++) time.push(`${d}T${String(h).padStart(2, "0")}:00`); });
  const f = { time, sun: sun ? Object.fromEntries(DAYSK.map(d => [d, [`${d}T${SUN[0]}`, `${d}T${SUN[1]}`]])) : undefined, spd: [], gst: [], dir: [], temp: [], pop: [], code: [], vis: [], wh: [], wp: [], m: { bm: { spd: [], gst: [] }, ecmwf: { spd: [], gst: [] }, nbm: { spd: [], gst: [] }, gfs: { spd: [] }, icon: { spd: [] } } };
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
  const sandbox = { STYLES: scoring.STYLES, DAY_START: 7, DAY_END: 19, NUKE: 35, obsData: {}, Date, Math, Object, Array, Number, String, Set, JSON, console, RegExp,
    settings: { weights, comfort, overrides }, compass: d => "W", mode: null, m2ft: null, wn: v => Math.round(v) + " kn", wnum: v => String(Math.round(v)), wrange: (a, b) => `${a}–${b} kn` };   // the page's unit formatters live outside the block
  sandbox.limitsFor = id => ({ ...comfort, ...(overrides[id] || {}) });
  vm.createContext(sandbox);
  vm.runInContext(block + "\nthis.pageDayScore=dayScore; this.pageConsensus=consensus; this.pageModelSpread=modelSpread; this.pageDaylightIdx=daylightIdx; this.pageSunHours=sunHours; this.pageSetBias=setBias; this.pageBiasFor=biasFor; this.pageApplyBias=applyBias; this.pageBIAS=[BIAS_MIN_N,BIAS_MIN_KN];", sandbox);
  let n = 0, same = 0;
  const sameModels = (a, b) => (a == null && b == null) || (a && b && near(a.lo, b.lo) && near(a.hi, b.hi) && a.loLabel === b.loLabel && a.hiLabel === b.hiLabel && a.n === b.n && near(a.swing, b.swing));
  for (const spot of SPOTS) for (const style of ["freeride", "wave", "foil"]) for (const f of [doc(great), doc(varied), doc(varied, false), scoring.consensus(rawDoc()), scoring.consensus(rawDoc(), spot.model)]) for (const d of DAYSK) {
    const p = sandbox.pageDayScore(spot, f, d, style);
    const s = scoring.dayScore(spot, f, d, style, weights, scoring.limitsFor({ comfort, overrides }, spot.id));
    n++;
    const ok = p && s && near(p.score, s.score) && p.from === s.from && p.to === s.to && p.reason === s.reason && p.agree === s.agree && sameModels(p.models, s.models) && p.window === s.window && !!p.mine === !!s.mine;
    if (ok) same++; else if (same === n - 1) console.error("first mismatch:", spot.id, style, d, p && { score: p.score, from: p.from, reason: p.reason }, s && { score: s.score, from: s.from, reason: s.reason });
  }
  assert(same === n && n > 0, `scoring.js matches the page on ${n} spot/style/day cases (limits, overrides, weights, minHours)`);
  const s0 = scoring.dayScore(SPOTS[0], doc(great), DAYSK[0], "freeride", scoring.DEFAULT_WEIGHTS);
  assert(s0 && s0.score > 0 && s0.window === 3, "dayScore without limits still works (default comfort, 3-hour window)");

  // daylight: the candidate hours run from the day's sunrise to its sunset (midpoint rule), 7a–7p only for a doc without sun data
  { const g = doc(great), legacy = doc(great, false), hrs = (f, d) => scoring.daylightIdx(f, d).map(i => +f.time[i].slice(11, 13));
    assert(JSON.stringify(hrs(g, DAYSK[0])) === JSON.stringify([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]), "07:33 sunrise, 18:20 sunset -> the 8a..5p slots (the 7a slot's midpoint is before sunrise, the 6p slot's after sunset): " + hrs(g, DAYSK[0]).join(","));
    assert(JSON.stringify(hrs(legacy, DAYSK[0])) === JSON.stringify([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]), "no sunrise/sunset on the doc (an older cache): the fixed 7a–7p as before");
    const june = { ...g, sun: { [DAYSK[0]]: [`${DAYSK[0]}T05:25`, `${DAYSK[0]}T20:55`] } };
    assert(hrs(june, DAYSK[0])[0] === 5 && hrs(june, DAYSK[0]).slice(-1)[0] === 20 && hrs(june, DAYSK[0]).length === 16, "a June day (5:25–8:55pm) scores 5a..8p");
    assert(JSON.stringify(scoring.sunHours(g, DAYSK[0])) === JSON.stringify([7.55, 18 + 20 / 60]) && scoring.sunHours(legacy, DAYSK[0]) === null && scoring.sunHours({ ...g, sun: { [DAYSK[0]]: ["x", "y"] } }, DAYSK[0]) === null, "sunHours(): decimal hours, null without data or on garbage");
    for (const [f, d] of [[g, DAYSK[0]], [legacy, DAYSK[1]], [june, DAYSK[0]]]) assert(JSON.stringify(sandbox.pageDaylightIdx(f, d)) === JSON.stringify(scoring.daylightIdx(f, d)) && JSON.stringify(sandbox.pageSunHours(f, d)) === JSON.stringify(scoring.sunHours(f, d)), "page and scoring.js pick the same daylight hours (" + (f.sun ? Object.values(f.sun)[0].join("–").replace(/\d{4}-\d\d-\d\dT/g, "") : "no sun") + ")");
    const r8 = scoring.dayScore(SPOTS[0], g, DAYSK[0], "freeride", scoring.DEFAULT_WEIGHTS), r7 = scoring.dayScore(SPOTS[0], legacy, DAYSK[0], "freeride", scoring.DEFAULT_WEIGHTS);
    assert(r8.from === 8 && r8.hours.length === 10 && r8.idx.length === 10 && r7.from === 7 && r7.hours.length === 13, "dayScore: with steady wind the first window starts at 8a under the sun rule, 7a without it");
    const dawn = scoring.consensus(doc((d, h) => ({ spd: h === 7 ? 30 : 4, gst: h === 7 ? 33 : 5 })));   // the only wind of the day is at 7am, before sunrise
    assert(scoring.dayScore(SPOTS[0], dawn, DAYSK[0], "freeride", scoring.DEFAULT_WEIGHTS).score === 0, "wind before sunrise never scores");
  }
  // seven forecast days, the first five alertable; the embedded SPOTS and the tide stations
  { const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    assert(DAYS === 7 && ALERT_DAYS === 5 && /const DAYS=7,/.test(html) && /const ALERT_DAYS=5;/.test(html), "the job and the page both ask for seven days and alert on five");
    const embedded = JSON.parse(html.match(/const SPOTS = \/\*SPOTS\*\/(\[.*?\]);\n/)[1]);
    assert(JSON.stringify(embedded) === JSON.stringify(SPOTS), "the page's embedded SPOTS equals spots.json");
    assert(SPOTS.every(s => (s.waves ? /^\d{7}$/.test(s.tideStation || "") : s.tideStation === undefined)), "every coast spot (waves) names a 7-digit NOAA tide station; the Gorge and the lake name none");
    const T = {}; SPOTS.filter(s => s.tideStation).forEach(s => { (T[s.tideStation] = T[s.tideStation] || []).push(s.id); });
    assert(JSON.stringify(T) === JSON.stringify({ "9439011": ["fortstevens", "gearhart"], "9437540": ["manzanita", "rockaway", "bayocean", "oceanside", "capelookout", "pacificcity"], "9435380": ["roadsend", "newport", "florence"] }), "tide stations: Hammond for the Columbia mouth, Garibaldi from Manzanita to Pacific City, South Beach from Roads End to Florence");
    assert(sunOf({ daily: { time: ["2026-10-17"], sunrise_best_match: ["2026-10-17T07:33"], sunset_best_match: ["2026-10-17T18:20"] } })["2026-10-17"][1] === "2026-10-17T18:20" && sunOf({ daily: { time: ["2026-10-17"], sunrise: ["a"], sunset: ["b"] } })["2026-10-17"][0] === "a" && sunOf({ daily: { time: ["2026-10-17"], sunrise_ecmwf_ifs025: ["a"], sunset_ecmwf_ifs025: ["b"] } })["2026-10-17"][0] === "a" && sunOf({}) === undefined && sunOf({ daily: { time: [] } }) === undefined, "sunOf(): plain, best-match-suffixed or any-model-suffixed daily keys; undefined when the answer has none");
  }

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
  // per-spot model: the Gorge spots score on NBM, falling back to the median for an hour NBM lacks
  const gorge = SPOTS.filter(s => s.region === "Gorge").map(s => s.id).sort().join();
  assert(gorge === "hoodriver,rufus,stevenson" && SPOTS.every(s => (s.model === "nbm") === (s.region === "Gorge")), "spots.json: exactly the three Gorge spots carry model \"nbm\"");
  const cn = scoring.consensus(raw, "nbm"), pcn = sandbox.pageConsensus(raw, "nbm");
  assert(JSON.stringify(cn.spd) === JSON.stringify(pcn.spd) && JSON.stringify(cn.gst) === JSON.stringify(pcn.gst) && cn.basis === pcn.basis, "consensus(doc, \"nbm\"): page and scoring.js build the same series");
  assert(cn.basis === "nbm" && cn.spd[9] === 15 && cn.gst[9] === 19 && c.spd[9] === 16 && c.gst[9] === 20 && cn.spd[i0] === 16 && c.basis === "median", "nbm: hour 9 is NBM's 15/19 (bm 16, ECMWF 19: the median would be 16/20); hour 0, where NBM has none, is the median 16; basis says which");
  assert(scoring.consensus({ ...raw, m: { bm: raw.m.bm, ecmwf: raw.m.ecmwf } }, "nbm").basis === "median" && scoring.consensus(legacy, "nbm") === legacy && scoring.consensus(raw, "median").spd[9] === 16, "a doc without an NBM series falls back to the median (or stays best match); \"median\" is the default");
  // the tile's confidence chip: only when the spread moves the score by 2+ (modelSwing)
  const sw = (fn, spot = SPOTS[0]) => { const f = scoring.consensus(doc(fn)); return scoring.dayScore(spot, f, DAYSK[0], "freeride", scoring.DEFAULT_WEIGHTS); };
  const rA = sw(() => ({ spd: 25, gst: 28, gfs: 23, icon: 27 })), rB = sw(() => ({ spd: 12, gst: 14, gfs: 10, icon: 14 }));
  assert(rA.agree === "Models agree" && rA.models.swing < 2 && rB.agree === "Models agree" && rB.models.swing >= 2, `the same 4 kn spread: quiet at 25 kn (swing ${rA.models.swing}), a band at 12 kn (swing ${rB.models.swing}, 10 kn is too light)`);
  const rC = sw(() => ({ spd: 20, gst: 24, gfs: 26, icon: 10 }));   // 30 would gust past the default 34 kn comfort limit and score 0 like the 10
  assert(rC.agree === "Models disagree" && rC.models.swing >= 2 && rC.models.loKey === "icon" && rC.models.hiKey === "gfs", "10 vs 26 kn: swing 2+ and the extremes are keyed (the parity loop above checks the page computes the same swing)");
  assert(scoring.dayScore(SPOTS[0], { ...raw, m: {} }, DAYSK[0], "freeride", scoring.DEFAULT_WEIGHTS).models === null && rl.models.swing != null, "no models: no swing; a legacy doc still gets one (best match is its own series)");
  // fetchForecasts: one five-model call, consensus applied, three-model fallback if the API rejects a model id
  {
    const calls = [];
    const api = n => Array.from({ length: n }, (_, k) => { const time = DAYSK.flatMap(d => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, "0")}:00`)); const H = { time }; const put = (id, v) => { H["wind_speed_10m_" + id] = time.map(() => v); H["wind_gusts_10m_" + id] = time.map(() => v + 4); H["wind_direction_10m_" + id] = time.map(() => 280); }; put("best_match", 10 + k); put("ecmwf_ifs025", 20); put("ncep_nbm_conus", 14); put("gfs_seamless", 30); put("icon_seamless", 5); for (const x of ["temperature_2m", "precipitation_probability", "weather_code", "visibility"]) H[x + "_best_match"] = time.map(() => 1); return { hourly: H }; });
    const withSun = a => { for (const d of a) { const days = [...new Set(d.hourly.time.map(t => t.slice(0, 10)))]; d.daily = { time: days, sunrise_best_match: days.map(x => x + "T07:33"), sunset_best_match: days.map(x => x + "T18:20") }; } return a; };
    const F = await fetchForecasts(SPOTS.slice(0, 2), async url => { calls.push(url); if (/marine/.test(url)) throw new Error("no marine in this test"); return withSun(api(2)); });
    const u = new URL(calls[0]);
    assert(calls.filter(c => /api\.open-meteo/.test(c)).length === 1 && u.searchParams.get("models") === Object.values(MODEL_IDS).join(",") && u.searchParams.get("wind_speed_unit") === "kn", "one forecast call with the five models, in knots");
    assert(u.searchParams.get("forecast_days") === "7" && u.searchParams.get("daily") === "sunrise,sunset" && F[SPOTS[0].id].sun[DAYSK[0]][0] === DAYSK[0] + "T07:33" && Object.keys(F[SPOTS[0].id].sun).length === 7, "seven days with daily sunrise/sunset, parsed onto the doc as f.sun");
    assert(F[SPOTS[0].id].spd[12] === 14 && F[SPOTS[1].id].spd[12] === 14 && F[SPOTS[0].id].m.bm.spd[12] === 10 && F[SPOTS[0].id].m.nbm.gst[12] === 18 && Object.keys(F[SPOTS[0].id].m).join() === "bm,ecmwf,nbm,gfs,icon", "job docs: spd is the median (bm 10 / ecmwf 20 / nbm 14 -> 14), every model kept under f.m");
    let n2 = 0;
    const F3 = await fetchForecasts(SPOTS.slice(0, 1), async url => { if (/marine/.test(url)) throw new Error("x"); n2++; if (n2 === 1) throw new Error("HTTP 400"); const a = api(1); for (const k of Object.keys(a[0].hourly)) if (/ecmwf|nbm/.test(k)) delete a[0].hourly[k]; return a; });
    assert(n2 === 2 && F3[SPOTS[0].id].spd[12] === 10 && Object.keys(F3[SPOTS[0].id].m).join() === "bm,gfs,icon", "a rejected five-model call falls back to three; the doc is then best match alone, with no empty model slots");
    assert(F3[SPOTS[0].id].sun === undefined && scoring.daylightIdx(F3[SPOTS[0].id], DAYSK[0]).length === 13, "an answer without daily data: no f.sun, the fixed 7a–7p hours");
  }

  /* ---------- per-spot forecast bias (Phase 5): page and scoring.js apply the same correction ---------- */
  {
    assert(sandbox.pageBIAS[0] === scoring.BIAS_MIN_N && sandbox.pageBIAS[1] === scoring.BIAS_MIN_KN && scoring.BIAS_MIN_N === 40 && scoring.BIAS_MIN_KN === 2, "both sides apply a bias only at 40+ samples and 2+ kn");
    // stevenson (model nbm): +4 on best match, −3 on the median, +2.5 on NBM (n exactly 40); manzanita: thin on bm (39), small on the median (1.9); rufus: −6 on NBM
    const BIAS = { stevenson: { bm: { kn: 4, n: 61 }, median: { kn: -3, n: 50 }, nbm: { kn: 2.5, n: 40 } }, manzanita: { bm: { kn: 5, n: 39 }, median: { kn: 1.9, n: 100 } }, rufus: { nbm: { kn: -6, n: 45 }, median: { kn: 6, n: 45 } } };
    scoring.setBias(BIAS); sandbox.pageSetBias(BIAS);
    const st = SPOTS.find(s => s.id === "stevenson"), mz = SPOTS.find(s => s.id === "manzanita"), ru = SPOTS.find(s => s.id === "rufus");
    let n = 0, same = 0;
    for (const spot of SPOTS) for (const style of ["freeride", "wave", "foil"]) for (const f of [doc(great), doc(varied), scoring.consensus(rawDoc()), scoring.consensus(rawDoc(), spot.model)]) for (const d of DAYSK) {
      const p = sandbox.pageDayScore(spot, f, d, style), s = scoring.dayScore(spot, f, d, style, weights, scoring.limitsFor({ comfort, overrides }, spot.id));
      n++; const ok = p && s && near(p.score, s.score) && p.from === s.from && p.reason === s.reason && near(p.spd, s.spd) && near(p.gst, s.gst) && sameModels(p.models, s.models);
      if (ok) same++; else if (same === n - 1) console.error("first bias mismatch:", spot.id, style, d, f.basis, p && { score: p.score, spd: p.spd }, s && { score: s.score, spd: s.spd });
    }
    assert(same === n && n > 0, `with bias.json loaded, scoring.js matches the page on ${n} cases`);
    const g = doc(great), gb = scoring.applyBias(st, g), pgb = sandbox.pageApplyBias(st, g);
    assert(gb !== g && gb.biased === 4 && gb.spd[12] === 24 && gb.gst[12] === 28 && g.spd[12] === 20 && JSON.stringify(pgb.spd) === JSON.stringify(gb.spd) && JSON.stringify(pgb.gst) === JSON.stringify(gb.gst), "a doc without a basis is best match: +4 kn on every hour's speed and gust, tagged f.biased; the page builds the same series");
    assert(scoring.applyBias(st, gb) === gb, "an already corrected doc is not corrected again");
    const r0 = scoring.dayScore(st, g, DAYSK[0], "freeride", scoring.DEFAULT_WEIGHTS);
    assert(near(r0.spd, 24) && near(r0.gst, 28) && r0.score !== scoring.dayScore(mz, g, DAYSK[0], "freeride", scoring.DEFAULT_WEIGHTS).score, "dayScore scores the corrected hours (window mean 24 kn) and the window's wind reads corrected too");
    const med = scoring.consensus(rawDoc()), nb = scoring.consensus(rawDoc(), "nbm");
    assert(scoring.biasFor(st, med).key === "median" && scoring.applyBias(st, med).biased === -3 && scoring.applyBias(st, med).spd[1] === 13 && med.spd[1] === 16, "the chosen model is the series the doc scores on: a median doc takes the median's −3");
    assert(scoring.biasFor(st, nb).key === "nbm" && scoring.applyBias(st, nb).biased === 2.5 && scoring.applyBias(st, nb).spd[9] === 17.5 && nb.spd[9] === 15, "an NBM doc takes NBM's +2.5 (n = 40 counts)");
    assert(JSON.stringify(scoring.biasFor(mz, g)) === JSON.stringify({ key: "bm", kn: 5, n: 39, applied: false }) && scoring.applyBias(mz, g) === g, "39 samples: reported, not applied");
    assert(JSON.stringify(scoring.biasFor(mz, med)) === JSON.stringify({ key: "median", kn: 1.9, n: 100, applied: false }) && scoring.applyBias(mz, med) === med && JSON.stringify(sandbox.pageBiasFor(mz, med)) === JSON.stringify(scoring.biasFor(mz, med)), "1.9 kn: reported, not applied; the page says the same");
    assert(scoring.biasFor(SPOTS.find(s => s.id === "rockaway"), g) === null && sandbox.pageBiasFor(SPOTS[3], g) === null && scoring.biasFor(st, { ...g, basis: "nope" }) === null, "no entry for the spot or the series: null");
    const light = scoring.consensus(doc(() => ({ spd: 3, gst: 4 })), "nbm");
    assert(scoring.applyBias(ru, light).spd[12] === 0 && scoring.applyBias(ru, light).gst[12] === 0 && scoring.applyBias(ru, light).dir[12] === light.dir[12], "a negative bias never takes the wind below 0; direction is untouched");
    scoring.setBias(null); assert(scoring.applyBias(st, g) === g, "setBias(null) clears it");
    scoring.setBias([1]); assert(scoring.applyBias(st, g) === g, "a non-object bias file is ignored");
    scoring.setBias({ stevenson: { bm: { kn: "4", n: 61 } } }); assert(scoring.biasFor(st, g) === null, "a malformed entry (kn not a number) is ignored");
    scoring.setBias({}); sandbox.pageSetBias({});
    assert(/blowing:true\}/.test(html.match(/const DEFAULT_ALERTS=\{[^\n]*\n/)[0]) && DEFAULT_ALERTS.blowing === true && /id="al-blowing"/.test(html) && /fetchBiasFile\(\)\.then\(applyBiasFile\)/.test(html) && /setBias\(c\.bias\)/.test(html), "the page: Blowing now defaults on with a checkbox in the Alerts sheet, bias.json is fetched in the background and restored from the cache");
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

  // days 6–7 (the trend) never alert, whatever the lead time; the "already alerted" list never carries them either
  const Ftrend = {}; SPOTS.forEach(s => { Ftrend[s.id] = doc(d => ({ spd: d >= DAYSK[5] ? 20 : 4 })); });   // dead until Thursday, then 20g24 W on days 6–7
  r2 = evaluate(rider({ sameDay: false, lead: 5 }), Ftrend, sat);
  assert(!r2.notification && r2.why === "nothing new" && Object.keys(r2.state.alerted).length === 0, "lead 5: a great Thursday/Friday six and seven days out is not alerted");
  r2 = evaluate(rider({ sameDay: false, lead: 5 }), F, sat);
  assert(r2.notification && Object.keys(r2.state.alerted).every(k => k.split("|")[1] <= DAYSK[4]) && Object.keys(r2.state.alerted).some(k => k.endsWith("|" + DAYSK[4])) && !/Thursday|Friday/.test(r2.notification.body), "lead 5 with a great week: alerts through day 5 (Wednesday), never days 6–7: " + r2.notification.body.slice(0, 80));
  r2 = evaluate(rider({ sameDay: false, lead: 3 }, { alerted: { ["rufus|" + DAYSK[5]]: { score: 9, at: "x" } }, sent: {} }), Fdead, sat);
  assert(!r2.notification, "a stale 'alerted' key for a trend day never produces a fell-apart notice");

  // kept spots score like curated ones
  const kept = { id: "k-test", name: "Test Beach", region: "Kept", lat: 45.5, lon: -123.95, plat: 45.5, plon: -123.95, dir: { best: [[240, 300]], work: [[200, 340]], off: [[60, 120]] }, waves: true, driveLO: 100, driveBC: 20, kept: true };
  const Fk = { ...Fdead, "k-test": doc(great) };
  r2 = evaluate(rider({ sameDay: false }, {}, { kept: [kept] }), Fk, sat);
  assert(r2.notification && /Test Beach 10\.0 \(20 min\)/.test(r2.notification.body), "a kept spot alerts with its own drive time: " + r2.notification.body);


  /* ---------- "Blowing now": the station has read inside the band on the last two hourly runs ---------- */
  {
    // Saturday 2026-10-17, runs at :07 past each hour; Pacific = UTC−7 (PDT). 14:10 PDT = 21:10Z.
    const Z = (h, m = 7) => `2026-10-17T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+00:00`;
    const ms = iso => Date.parse(iso);
    const TMK = { id: "TMKO3", name: "TILLAMOOK", kind: "nws", dist_mi: 12.9 };
    const rd = (hUTC, spd = 18, gst = 22, dir = 315, extra = {}) => ({ ...TMK, time: Z(hUTC, 55), spd, gst, dir, ...extra });   // a reading at :55 from the NW, seen by the :07 run of the next hour
    const run = (hUTC, obs) => ({ at: Z(hUTC), obs });
    const recent = (...runs) => ({ runs });
    const two = recent(run(20, { rockaway: rd(19) }), run(21, { rockaway: rd(20) }));   // 12:55 and 13:55 PDT readings, both 18g22 NW
    const at14 = { date: "2026-10-17", hour: 14, dow: 6, ms: ms(Z(21, 10)) };
    const dead = {}, nosun = {}; SPOTS.forEach(s => { dead[s.id] = doc(() => ({ spd: 5 })); nosun[s.id] = doc(() => ({ spd: 5 }), false); });   // the forecast says nothing; only the station does (nosun: an older doc without sunrise/sunset)
    const limitsOf = () => scoring.DEFAULT_COMFORT;

    let b = blowingNow(SPOTS, two, at14, DEFAULT_ALERTS, limitsOf, dead);
    assert(b.length === 1 && b[0].spot.id === "rockaway" && b[0].o.spd === 18 && b[0].drive === 50 && b[0].home === "Pacific City", "two runs in the band from the NW: Rockaway, 50 min from the nearer house");
    assert(blowingText(b) === "Blowing now: Rockaway Beach 18g22 kn NW at the TILLAMOOK station — 50 min from Pacific City.", "the message: " + blowingText(b));
    assert(windText(18, 22, "mph") === "21g25 mph" && windText(18, 18.5) === "18 kn" && windText(18, null) === "18 kn" && near(laHour("2026-10-17T21:10:00Z"), 14 + 10 / 60), "windText in the rider's unit, gust only when it matters; laHour in Pacific time");

    let r = evaluate(rider({}, {}), dead, at14, two);
    assert(r.notification && r.notification.body === blowingText(b) && r.notification.url === "./#day=2026-10-17" && r.state.sent["2026-10-17"] === 1, "fires at 14:00 with nothing in the forecast, deep-linked to today, counting against the daily cap: " + r.notification.body);
    assert(r.state.blowing.rockaway && r.state.blowing.rockaway.spd === 18 && r.state.blowing.rockaway.station === "TMKO3", "recorded as said");
    const three = recent(...two.runs, run(22, { rockaway: rd(21) }));
    const at15 = { ...at14, hour: 15, ms: ms(Z(22, 10)) };
    let r2 = evaluate(rider({ cap: 3 }, r.state), dead, at15, three);
    assert(!r2.notification && r2.why === "already said it's blowing" && r2.state.blowing.rockaway, "still blowing an hour later: not repeated (cap 3, so it is the suppression, not the cap)");
    r2 = evaluate(rider({}, r.state), dead, at15, three);
    assert(!r2.notification && r2.why === "daily cap reached", "with the default cap of 1 the day's one digest has gone");
    const died = recent(...two.runs, run(22, { rockaway: rd(21, 6, 8) }));
    r2 = evaluate(rider({ cap: 3 }, r.state), dead, at15, died);
    assert(!r2.notification && !r2.state.blowing.rockaway && r2.why === "nothing new", "it stops: nothing sent, and the spot leaves the 'said' list");
    const again = recent(run(22, { rockaway: rd(21, 6, 8) }), run(23, { rockaway: rd(22) }), run(0, { rockaway: rd(23) }));   // dies, then two runs back in the band (15:55, 16:55 PDT)
    r2 = evaluate(rider({ cap: 3 }, r2.state), dead, { ...at14, hour: 17, ms: ms(Z(0, 10)) + 864e5 * 0 }, { runs: again.runs.map((x, i) => i === 2 ? { ...x, at: "2026-10-18T00:07:00+00:00" } : x) });
    assert(r2.notification && /^Blowing now: Rockaway Beach/.test(r2.notification.body), "blows again later the same day: said again (under the cap)");
    r2 = evaluate(rider({ cap: 3 }, { blowing: { rockaway: { spd: 18, station: "TMKO3", at: "2026-10-16T21:00:00.000Z" } } }), dead, at14, two);
    assert(r2.notification && /^Blowing now/.test(r2.notification.body), "a 'said' entry from yesterday has expired");

    // same digest as the forecast: 08:10 with same-day on, a great forecast and the station already reading in the band
    const at8 = { date: "2026-10-17", hour: 8, dow: 6, ms: ms(Z(15, 10)) };
    const morning = recent(run(14, { rockaway: rd(13) }), run(15, { rockaway: rd(14) }));   // 06:55 (dark) and 07:55 PDT readings
    r2 = evaluate(rider({}), F, at8, morning);
    assert(r2.notification && /^Today looks great from Lake Oswego/.test(r2.notification.body) && /Blowing now: Rockaway Beach 18g22 kn NW at the TILLAMOOK station — 50 min from Pacific City\.$/.test(r2.notification.body) && r2.state.sent["2026-10-17"] === 1, "one notification carries the forecast digest and the station's word: " + r2.notification.body);
    const dawn = recent(run(13, { rockaway: rd(12) }), run(14, { rockaway: rd(13) }));   // 05:55 and 06:55 PDT: the latest is before the 07:33 sunrise
    assert(blowingNow(SPOTS, dawn, { ...at8, hour: 7, ms: ms(Z(14, 10)) }, DEFAULT_ALERTS, limitsOf, F).length === 0 && blowingNow(SPOTS, dawn, { ...at8, hour: 7, ms: ms(Z(14, 10)) }, DEFAULT_ALERTS, limitsOf, nosun).length === 1, "a reading before sunrise does not count (when the forecast carries the sun; without sun data the hour is not checked)");

    // no-fire cases
    const none = (rec, why, now = at14, A = DEFAULT_ALERTS, L = limitsOf, F_ = dead) => assert(blowingNow(SPOTS, rec, now, A, L, F_).length === 0, "no fire: " + why);
    none(recent(run(20, { rockaway: rd(19, 8, 10) }), run(21, { rockaway: rd(20) })), "only the latest run in the band (the previous read 8 kn)");
    none(recent(run(20, { rockaway: rd(19) }), run(21, { rockaway: rd(20, 8, 10) })), "only the previous run in the band");
    none(recent(run(20, {}), run(21, { rockaway: rd(20) })), "no reading for the spot on the previous run");
    none(recent(run(20, { rockaway: rd(19) }), run(21, { rockaway: rd(19) })), "the same reading seen by two runs (the station has not updated)");
    none(recent(run(20, { rockaway: rd(19, 18, 22, 90) }), run(21, { rockaway: rd(20, 18, 22, 90) })), "offshore (E)");
    none(recent(run(20, { rockaway: rd(19, 18, 22, 160) }), run(21, { rockaway: rd(20, 18, 22, 160) })), "cross-off (SSE), not a working sector");
    none(recent(run(20, { rockaway: rd(19, 18, 22, null) }), run(21, { rockaway: rd(20, 18, 22, null) })), "no direction");
    none(recent(run(20, { rockaway: rd(19, 11, 13) }), run(21, { rockaway: rd(20, 11, 13) })), "11 kn: under the 12 kn comfort minimum");
    none(recent(run(20, { rockaway: rd(19, 33, 36) }), run(21, { rockaway: rd(20, 33, 36) })), "33 kn: over the 32 kn comfort maximum");
    none(recent(run(20, { rockaway: rd(19, 20, 35) }), run(21, { rockaway: rd(20, 20, 35) })), "gusting 35: over the 34 kn gust limit");
    none(two, "the rider's own range (per-spot override: Rockaway max 16)", at14, DEFAULT_ALERTS, id => scoring.limitsFor({ overrides: { rockaway: { maxWind: 16 } } }, id));
    none(two, "nothing within 30 min of either house", at14, { ...DEFAULT_ALERTS, maxDrive: 30 });
    none(two, "obs-recent.json is stale: the latest run is 2 h old", { ...at14, hour: 16, ms: ms(Z(23, 10)) });
    none(recent(run(20, { rockaway: rd(17) }), run(21, { rockaway: rd(18) })), "the latest reading is over 2 h old (the runs are fresh, the station went quiet)");
    none(recent(run(17, { rockaway: rd(16) }), run(21, { rockaway: rd(20) })), "runs four hours apart are not consecutive hourly runs");
    none(recent(run(21, { rockaway: rd(20) })), "a single run");
    none({ runs: [] }, "an empty file"); none(null, "no file"); none({ runs: "x" }, "garbage");
    assert(BLOW_RUNS === 2, "two consecutive runs");
    r2 = evaluate(rider({ blowing: false }), dead, at14, two);
    assert(!r2.notification && r2.why === "nothing new" && r2.blowing.length === 0, "the toggle off: never evaluated");
    r2 = evaluate(rider({ days: [1, 2, 3, 4, 5] }), dead, at14, two);
    assert(!r2.notification && r2.blowing.length === 0, "not on a day he can't go (Saturday excluded)");
    r2 = evaluate(rider({ quietFrom: 13, quietTo: 15 }), dead, at14, two);
    assert(!r2.notification && r2.why === "quiet hours" && r2.blowing.length === 1 && !r2.state.blowing.rockaway, "quiet hours hold it (and it is not marked said, so it goes out when they end)");
    r2 = evaluate(rider({}, { sent: { "2026-10-17": 1 } }), dead, at14, two);
    assert(!r2.notification && r2.why === "daily cap reached", "the daily cap holds it");
    r2 = evaluate(rider({}, {}, { units: "mph" }), dead, at14, two);
    assert(r2.notification && /Rockaway Beach 21g25 mph NW/.test(r2.notification.body), "the rider's display unit: " + r2.notification.body);
    // several spots: nearest drive first, three at most, one notification
    const many = recent(run(20, { rockaway: rd(19), pacificcity: { id: "AT297", name: "PACCTY-2 Pacific City", dist_mi: 0.3, time: Z(19, 55), spd: 16, gst: 17, dir: 290 }, newport: { id: "KONP", name: "Newport, Newport Municipal Airport", dist_mi: 2.1, time: Z(19, 55), spd: 20, gst: 26, dir: 320 }, floras: { id: "46015", name: "Port Orford buoy", dist_mi: 19.3, time: Z(19, 55), spd: 22, gst: 25, dir: 350 } }),
                        run(21, { rockaway: rd(20), pacificcity: { id: "AT297", name: "PACCTY-2 Pacific City", dist_mi: 0.3, time: Z(20, 55), spd: 15, gst: 16, dir: 300 }, newport: { id: "KONP", name: "Newport, Newport Municipal Airport", dist_mi: 2.1, time: Z(20, 55), spd: 21, gst: 27, dir: 320 }, floras: { id: "46015", name: "Port Orford buoy", dist_mi: 19.3, time: Z(20, 55), spd: 22, gst: 25, dir: 350 } }));
    r2 = evaluate(rider({ maxDrive: 300 }), dead, at14, many);
    assert(r2.notification && r2.notification.body === "Blowing now: Pacific City 15 kn WNW at the PACCTY-2 Pacific City station — 5 min from Pacific City; Rockaway Beach 18g22 kn NW at the TILLAMOOK station — 50 min from Pacific City; Newport South Jetty 21g27 kn NW at the Newport, Newport Municipal Airport station — 1h10 from Pacific City." && Object.keys(r2.state.blowing).length === 4, "four spots blowing: one line, nearest first, three named, all four marked said: " + r2.notification.body);
  }

  assert(inQuiet(22, 21, 7) && inQuiet(3, 21, 7) && !inQuiet(8, 21, 7) && inQuiet(13, 12, 14) && !inQuiet(15, 12, 14), "quiet-hours window wraps midnight");
  const n = laNow(new Date("2026-10-17T02:30:00Z"));
  assert(n.date === "2026-10-16" && n.hour === 19 && n.dow === 5, "laNow converts to Pacific time");
}

/* ---------- 3. delivery: push statuses back to the Worker; the service worker always shows something ---------- */
{
  const subs = ["one", "two", "three", "four"].map(e => ({ endpoint: "https://push.example/" + e, keys: { p256dh: "p", auth: "a" } }));
  const fail = (code) => { const e = new Error("push " + code); e.statusCode = code; return e; };
  const sent = [];
  const d = await deliver(subs, { title: "Bistué Boarding", body: "x" }, async (sub, payload) => { sent.push([sub.endpoint, payload]); if (/two/.test(sub.endpoint)) throw fail(410); if (/three/.test(sub.endpoint)) throw fail(500); if (/four/.test(sub.endpoint)) throw new Error("ECONNRESET"); return { statusCode: 201 }; });
  assert(sent.length === 4 && sent.every(([, p]) => JSON.parse(p).body === "x"), "every device gets the digest once, as JSON");
  assert(JSON.stringify(d.pushed.map(p => [p.endpoint.split("/").pop(), p.status])) === JSON.stringify([["one", 201], ["two", 410], ["three", 500], ["four", 0]]) && d.pushed[3].error === "ECONNRESET", "pushed: the status per endpoint (201 ok, 410 gone, 500 failed, 0 + error for no answer)");
  assert(d.delivered === 1 && d.failures === 2 && GONE.has(410) && GONE.has(404) && !GONE.has(500), "one delivered; 500 and the network error count as failures, a 410 is not a failure (the Worker deletes it)");
  const none = await deliver([], { body: "x" }, async () => { throw new Error("never"); });
  assert(none.delivered === 0 && none.pushed.length === 0 && none.failures === 0, "no devices: nothing sent, nothing failed");
  // sw.js: a push with no payload (or an unreadable one) still shows a notification
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  assert(!/addEventListener\("fetch"/.test(sw) && !/caches\./.test(sw), "sw.js has no fetch handler and no cache (never a stale page)");
  const shown = [], listeners = {};
  const self_ = { addEventListener: (k, fn) => { listeners[k] = fn; }, skipWaiting() {}, clients: { claim() {} }, registration: { scope: "https://mikestoneapps.github.io/coastal-kiteboarding/", showNotification: (title, opts) => { shown.push({ title, ...opts }); return Promise.resolve(); } } };
  vm.runInContext(sw, vm.createContext({ self: self_, URL, console, Promise }));
  const push = data => { const e = { data, waitUntil(p) { this.p = p; } }; listeners.push(e); return e.p; };
  await push(null);
  assert(shown.length === 1 && shown[0].title === "Bistué Boarding" && shown[0].body === "Bistué Boarding: open the app for today's outlook" && shown[0].data.url === self_.registration.scope, "empty payload: the generic notification, opening the app");
  await push({ json: () => ({ title: "Bistué Boarding", body: "Saturday looks great", url: "./#day=2026-10-18", tag: "bb-x" }), text: () => "" });
  assert(shown[1].body === "Saturday looks great" && shown[1].data.url === self_.registration.scope + "#day=2026-10-18" && shown[1].tag === "bb-x", "a digest payload: its body, deep link and tag");
  await push({ json: () => { throw new Error("not json"); }, text: () => "plain text push" });
  assert(shown[2].body === "plain text push" && shown[2].title === "Bistué Boarding", "a plain-text payload becomes the body");
  await push({ json: () => { throw new Error("not json"); }, text: () => { throw new Error("not text"); } });
  await push({ json: () => ({}), text: () => "" });
  assert(shown[3].body === shown[0].body && shown[4].body === shown[0].body && shown.every(n => n.icon === "icon-192.png" && n.renotify), "unreadable or empty JSON payloads: the generic line; every notification carries the icon");
}

if (fails) { console.error(fails + " test(s) failed"); process.exit(1); }
console.log("all alert tests passed");
