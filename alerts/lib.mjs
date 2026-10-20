// Alert evaluation, kept free of network and secrets so alerts/test.mjs can drive it.
// Mirrors alertDigest()/digestText() in index.html and SPEC.md §8:
//   one digest per rider per run, best first; a (spot, day) already alerted is not repeated unless its
//   score moves by >= 2 or it drops below the threshold (then one "fell apart" notice).
//   "Blowing now" (blowingNow()): a spot whose nearest station has read inside the rider's wind range from a working
//   direction on the last two hourly runs (obs-recent.json, written by obs_recent.py) is said once, in the same digest.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const scoring = require(path.join(ROOT, "scoring.js"));
export const SPOTS = require(path.join(ROOT, "spots.json"));

export const TZ = "America/Los_Angeles", DAYS = 7;   // seven forecast days, like the page
export const ALERT_DAYS = 5;   // alerts only ever cover the first five forecast days: days 6–7 are a trend (the page labels them so and applies the same cap to its preview)
export const HOMES = { LO: { name: "Lake Oswego", key: "driveLO" }, BC: { name: "Pacific City", key: "driveBC" } };
export const DEFAULT_WEIGHTS = scoring.DEFAULT_WEIGHTS;
export const DEFAULT_ALERTS = { minScore: 8, maxDrive: 180, days: [0, 1, 2, 3, 4, 5, 6], hour: 19, lead: 3, cap: 1, confidence: true, sameDay: true, quietFrom: 21, quietTo: 7, email: true, blowing: true };
const RESCORE = 2;        // a repeat alert needs the score to move this much
const SAMEDAY_UNTIL = 12; // a same-day ("this morning") alert is only useful before noon
export const BLOW_RUNS = 2;          // "Blowing now" needs the station inside the band on this many consecutive hourly runs
export const OBS_MAX_AGE = 120;      // minutes; a station reading older than this is never used (the page's rule for scoring too)
const RUN_GAP = [30, 150];           // minutes between two runs for them to count as consecutive hourly runs (the cron is hourly; a skipped hour breaks the streak)
const RECENT_MAX_AGE = 90;           // minutes; an obs-recent.json whose latest run is older than this is stale (the observations job did not run) and never fires

/* ---------- time ---------- */
// {date:"YYYY-MM-DD", hour:0-23, dow:0-6} in Los Angeles for a Date (default now).
export function laNow(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short" }).formatToParts(d).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: +parts.hour % 24, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday) };
}
export function dayLabel(d, today) {
  const dt = new Date(d + "T12:00:00Z");
  if (d === today) return "Today";
  const tm = new Date(new Date(today + "T12:00:00Z").getTime() + 864e5).toISOString().slice(0, 10);
  if (d === tm) return "Tomorrow";
  return dt.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}
export function hhmm(h) { const x = ((h + 11) % 12) + 1; return x + (h < 12 ? "a" : "p"); }
// Decimal Pacific hour of an ISO timestamp (for the daylight check), or null.
export function laHour(iso) { const t = Date.parse(iso); if (isNaN(t)) return null; const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(t)).map(x => [x.type, x.value])); return (+p.hour % 24) + (+p.minute) / 60; }
// Wind for a message, in the rider's display unit (settings.units "mph" or knots; everything stored is knots).
export function windText(spd, gst, units) { const mph = units === "mph", u = mph ? "mph" : "kn", c = v => String(Math.round(mph ? v * 1.150779 : v)); return gst != null && gst > spd + 1 ? `${c(spd)}g${c(gst)} ${u}` : `${c(spd)} ${u}`; }
export function mins(m) { return m < 60 ? m + " min" : Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0"); }
export function inQuiet(hour, from, to) { return from > to ? (hour >= from || hour < to) : (hour >= from && hour < to); }

/* ---------- forecasts (same query and doc shape as fetchForecasts() in index.html) ---------- */
const rnd = (xs, nd = 1) => xs.map(v => v == null ? null : +v.toFixed(nd));
async function getJSON(url, tries = 4) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(40000) }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
    catch (e) { if (i >= tries - 1) throw e; await new Promise(res => setTimeout(res, 2000 * (i + 1))); }
  }
}
// Open-Meteo model ids -> f.m keys, as in the page. best match, ECMWF and NBM feed the score (hourly median, scoring.consensus; NBM alone at the Gorge spots); GFS and ICON only vote on confidence.
export const MODEL_IDS = { bm: "best_match", ecmwf: "ecmwf_ifs025", nbm: "ncep_nbm_conus", gfs: "gfs_seamless", icon: "icon_seamless" };
// daily sunrise/sunset -> f.sun = {"YYYY-MM-DD":[riseISO,setISO]}: the hours the score looks at (scoring.daylightIdx). With several models the API may suffix the daily keys; any copy will do.
export function sunOf(d) { const D = d && d.daily; if (!D || !Array.isArray(D.time)) return undefined; const pick = n => D[n] || D[n + "_best_match"] || D[Object.keys(D).find(k => k.startsWith(n + "_")) || ""]; const R = pick("sunrise"), S = pick("sunset"); if (!R || !S) return undefined; const o = {}; D.time.forEach((day, i) => { if (R[i] && S[i]) o[day] = [R[i], S[i]]; }); return Object.keys(o).length ? o : undefined; }
export async function fetchForecasts(spots, fetchJSON = getJSON) {
  const lat = spots.map(s => s.lat).join(","), lon = spots.map(s => s.lon).join(",");
  const query = models => `latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,precipitation_probability,weather_code,visibility&daily=sunrise,sunset&models=${models}&wind_speed_unit=kn&temperature_unit=fahrenheit&forecast_days=${DAYS}&timezone=${encodeURIComponent(TZ)}`;
  let w;
  try { w = await fetchJSON("https://api.open-meteo.com/v1/forecast?" + query(Object.values(MODEL_IDS).join(","))); }
  catch (e) { console.warn("five-model forecast call failed, retrying with three:", e.message); w = await fetchJSON("https://api.open-meteo.com/v1/forecast?" + query("best_match,gfs_seamless,icon_seamless")); }
  const arr = Array.isArray(w) ? w : [w];
  const now = new Date().toISOString().slice(0, 19) + "+00:00";
  const docs = {};
  spots.forEach((s, i) => {
    const d = arr[i]; if (!d || !d.hourly) return; const h = d.hourly;
    const col = (n, m = "best_match") => h[`${n}_${m}`] || h[n] || new Array(h.time.length).fill(null);
    const m = {}; for (const [k, id] of Object.entries(MODEL_IDS)) { if (k !== "bm" && !h[`wind_speed_10m_${id}`]) continue; m[k] = { spd: rnd(col("wind_speed_10m", id)), gst: rnd(col("wind_gusts_10m", id)), dir: rnd(col("wind_direction_10m", id), 0) }; }
    docs[s.id] = scoring.consensus({ spotId: s.id, fetchedAt: now, time: h.time, spd: rnd(col("wind_speed_10m")), gst: rnd(col("wind_gusts_10m")), dir: rnd(col("wind_direction_10m"), 0), temp: rnd(col("temperature_2m"), 0), pop: rnd(col("precipitation_probability"), 0), code: col("weather_code"), vis: rnd(col("visibility"), 0), m, sun: sunOf(d) }, s.model);   // a Gorge spot scores on NBM (spots.json `model`), the rest on the median
  });
  const wave = spots.filter(s => s.waves && docs[s.id]);
  if (wave.length) {
    try {
      const mq = `latitude=${wave.map(s => s.lat).join(",")}&longitude=${wave.map(s => s.lon).join(",")}&hourly=wave_height,wave_period&forecast_days=${DAYS}&timezone=${encodeURIComponent(TZ)}`;
      const m = await fetchJSON("https://marine-api.open-meteo.com/v1/marine?" + mq); const marr = Array.isArray(m) ? m : [m];
      wave.forEach((s, i) => { const d = marr[i]; if (!d || !d.hourly) return; Object.assign(docs[s.id], { wh: rnd(d.hourly.wave_height, 2), wp: rnd(d.hourly.wave_period, 1) }); });
    } catch (e) { console.warn("marine forecast failed; scoring without surf:", e.message); }
  }
  return docs;
}

/* ---------- per-rider evaluation ---------- */
export function riderSpots(settings) {
  const kept = Array.isArray(settings && settings.kept) ? settings.kept.filter(k => k && k.id && k.dir && k.lat != null) : [];
  const ids = new Set(kept.map(k => k.id));
  return SPOTS.filter(s => !ids.has(s.id)).concat(kept);
}
export function dayKeysOf(forecasts) {
  const first = Object.values(forecasts)[0]; if (!first) return [];
  return [...new Set(first.time.map(t => t.slice(0, 10)))];
}

/* ---------- "Blowing now": the station, not the forecast ---------- */
// recent = obs-recent.json ({runs: [{at, obs: {spotId: {id, name, dist_mi, time, spd, gst, dir}}}], oldest first; obs_recent.py keeps the
// nearest station with a reading under 2 h old per spot per run). A spot qualifies when, on each of the last BLOW_RUNS runs, that
// reading was inside the rider's wind range (comfort minWind..maxWind, per-spot override), under the gust limit, from a best or work
// sector, and the two readings are distinct (a station that has not updated between runs is one reading, not two). The latest reading
// must still be under OBS_MAX_AGE, in daylight when the forecast carries the day's sunrise/sunset (nobody rides a 6am reading in October),
// and the spot within maxDrive of a house. Returns [{spot, o, drive, home}] nearest drive first; the forecasts are only used for daylight.
export function blowingNow(spots, recent, now, A, limitsOf, forecasts) {
  const runs = ((recent && Array.isArray(recent.runs)) ? recent.runs : []).filter(r => r && r.at && r.obs && !isNaN(Date.parse(r.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-BLOW_RUNS);
  if (runs.length < BLOW_RUNS) return [];
  const nowMs = now.ms != null ? now.ms : Date.now(), min = 60000;
  const latest = runs[runs.length - 1];
  if (nowMs - Date.parse(latest.at) > RECENT_MAX_AGE * min) return [];   // the observations job has not run this hour: the file is stale
  for (let i = 1; i < runs.length; i++) { const gap = (Date.parse(runs[i].at) - Date.parse(runs[i - 1].at)) / min; if (gap < RUN_GAP[0] || gap > RUN_GAP[1]) return []; }   // not consecutive hourly runs
  const out = [];
  for (const spot of spots) {
    if (!spot.dir || !Array.isArray(spot.dir.best)) continue;
    const L = limitsOf(spot.id);
    const inBand = o => o && typeof o.spd === "number" && o.spd >= L.minWind && o.spd <= L.maxWind && (o.gst == null || o.gst <= L.maxGust) && o.dir != null && scoring.dirScore(o.dir, spot.dir).v >= 0.75;
    const rs = runs.map(r => r.obs[spot.id]);
    if (!rs.every(inBand)) continue;
    if (new Set(rs.map(o => o.time)).size < rs.length) continue;   // the same reading seen twice
    const o = rs[rs.length - 1];
    const t = Date.parse(o.time); if (isNaN(t) || nowMs - t > OBS_MAX_AGE * min) continue;
    const f = forecasts && forecasts[spot.id], sun = f ? scoring.sunHours(f, now.date) : null, h = laHour(o.time);
    if (sun && h != null && (h < sun[0] || h > sun[1])) continue;   // dark
    const homes = Object.entries(HOMES).map(([hk, H]) => ({ home: H.name, drive: spot[H.key] })).filter(x => x.drive != null && x.drive <= A.maxDrive).sort((a, b) => a.drive - b.drive);
    if (!homes.length) continue;
    out.push({ spot, o, drive: homes[0].drive, home: homes[0].home });
  }
  return out.sort((a, b) => a.drive - b.drive || b.o.spd - a.o.spd);
}
export function blowingText(hits, units) {
  return "Blowing now: " + hits.slice(0, 3).map(x => `${x.spot.name} ${windText(x.o.spd, x.o.gst, units)} ${scoring.compass(x.o.dir)} at the ${x.o.name || x.o.id} station — ${mins(x.drive)} from ${x.home}`).join("; ") + ".";
}

// Pure decision. Returns {notification: {title, body, url} | null, state, hits, blowing, why}.
// recent: obs-recent.json's content (optional; without it there is no "Blowing now").
export function evaluate(rider, forecasts, now, recent) {
  const S = rider.settings || {};
  const A = { ...DEFAULT_ALERTS, ...(S.alerts || {}) };
  const style = ["freeride", "wave", "foil"].includes(S.style) ? S.style : "freeride";
  const weights = { ...DEFAULT_WEIGHTS, ...(S.weights || {}) };
  const limitsOf = id => scoring.limitsFor({ comfort: S.comfort, overrides: S.overrides }, id);
  const spots = riderSpots(S);
  const dayKeys = dayKeysOf(forecasts).filter(d => d >= now.date).slice(0, ALERT_DAYS);   // never days 6–7: a trend is not something to clear a calendar for
  const state = { alerted: { ...((rider.state && rider.state.alerted) || {}) }, sent: { ...((rider.state && rider.state.sent) || {}) }, blowing: { ...((rider.state && rider.state.blowing) || {}) } };
  // prune state for days that have passed
  for (const k of Object.keys(state.alerted)) if (k.split("|")[1] < now.date) delete state.alerted[k];
  for (const k of Object.keys(state.sent)) if (k !== now.date) delete state.sent[k];
  // "Blowing now": said once per blow; a spot drops out of the list when it stops qualifying, so a new blow later can be said again (under the cap)
  const blowing = A.blowing !== false && A.days.includes(now.dow) ? blowingNow(spots, recent, now, A, limitsOf, forecasts) : [];
  const blowingIds = new Set(blowing.map(x => x.spot.id));
  for (const k of Object.keys(state.blowing)) if (!blowingIds.has(k) || (now.ms != null ? now.ms : Date.now()) - Date.parse(state.blowing[k].at) > 24 * 3600 * 1000) delete state.blowing[k];
  const blowNew = blowing.filter(x => !state.blowing[x.spot.id]);

  const score = (spot, d) => { const f = forecasts[spot.id]; return f ? scoring.dayScore(spot, f, d, style, weights, limitsOf(spot.id)) : null; };
  // hits per home, like alertDigest() in the page
  const byHome = [];
  const cand = {};   // "spot|day" -> {spot, d, r}
  for (const hk of Object.keys(HOMES)) {
    const hits = [];
    dayKeys.slice(0, Math.min(A.lead + 1, ALERT_DAYS)).forEach((d, di) => {
      if (di === 0 && !A.sameDay) return;
      if (!A.days.includes(new Date(d + "T12:00:00Z").getUTCDay())) return;
      const rows = spots.map(spot => { const drive = spot[HOMES[hk].key]; if (drive == null || drive > A.maxDrive) return null; const r = score(spot, d); return r ? { spot, r, drive } : null; })
        .filter(x => x && x.r.score >= A.minScore && (!A.confidence || di === 0 || x.r.agree === "Models agree"))
        .sort((a, b) => b.r.score - a.r.score || a.drive - b.drive);
      if (rows.length) { hits.push({ d, rows }); rows.forEach(x => { cand[x.spot.id + "|" + d] = { spot: x.spot, d, r: x.r }; }); }
    });
    if (hits.length) byHome.push({ home: HOMES[hk].name, hits });
  }
  const isNew = k => { const p = state.alerted[k]; return !p || Math.abs(cand[k].r.score - p.score) >= RESCORE; };
  const newKeys = Object.keys(cand).filter(isNew);
  // fell apart: alerted before, now under the threshold (regardless of drive)
  const fell = [];
  for (const [k, p] of Object.entries(state.alerted)) {
    if (cand[k]) continue;
    const [sid, d] = k.split("|"); const spot = spots.find(s => s.id === sid); if (!spot || !dayKeys.includes(d)) continue;
    const r = score(spot, d); if (r && r.score < A.minScore && p.score >= A.minScore) fell.push({ spot, d, r, prev: p.score });
  }

  const out = { notification: null, state, hits: byHome, blowing, why: "" };
  if (inQuiet(now.hour, A.quietFrom, A.quietTo)) { out.why = "quiet hours"; return out; }
  if ((state.sent[now.date] || 0) >= A.cap) { out.why = "daily cap reached"; return out; }
  const deliverable = k => { const d = cand[k].d; return d === now.date ? now.hour < SAMEDAY_UNTIL : now.hour >= A.hour; };
  const send = newKeys.filter(deliverable);
  if (!send.length && !fell.length && !blowNew.length) { out.why = newKeys.length ? "waiting for the delivery hour" : blowing.length ? "already said it's blowing" : "nothing new"; return out; }

  const parts = [], sendSet = new Set(send);
  let firstDay = null;
  for (const h of byHome) {
    const days = h.hits.filter(x => x.rows.some(r => sendSet.has(r.spot.id + "|" + x.d))).slice(0, 2);
    for (const x of days) {
      if (!firstDay) firstDay = x.d;
      parts.push(`${dayLabel(x.d, now.date)} looks great from ${h.home} — ${x.rows.slice(0, 3).map(r => `${r.spot.name} ${r.r.score.toFixed(1)} (${mins(r.drive)})`).join(", ")}. Window ${hhmm(x.rows[0].r.from)}–${hhmm(x.rows[0].r.to)}.`);
    }
  }
  for (const f of fell) { if (!firstDay) firstDay = f.d; parts.push(`${dayLabel(f.d, now.date)} fell apart — ${f.spot.name} is down to ${f.r.score.toFixed(1)}${f.r.reason ? ` (${f.r.reason.toLowerCase()})` : ""}.`); }
  if (blowNew.length) { if (!firstDay) firstDay = now.date; parts.push(blowingText(blowNew, S.units)); }   // the station's word, in the same digest; it is about today
  const at = new Date(now.ms != null ? now.ms : Date.now()).toISOString();
  for (const k of send) state.alerted[k] = { score: cand[k].r.score, at };
  for (const f of fell) delete state.alerted[f.spot.id + "|" + f.d];
  for (const x of blowNew) state.blowing[x.spot.id] = { spd: x.o.spd, station: x.o.id, at };
  state.sent[now.date] = (state.sent[now.date] || 0) + 1;
  out.notification = { title: "Bistué Boarding", body: parts.join(" "), url: "./#day=" + firstDay, tag: "bb-" + now.date };
  return out;
}

/* ---------- delivery ---------- */
// Send one notification to every device of a rider. Returns what the Worker needs to keep its subscription list clean:
//   pushed:    [{endpoint, status}] for every device (status 201 or the push service's code; 404/410 = the subscription is gone, the Worker deletes it)
//   delivered: how many devices accepted it (the "already alerted" state is only advanced when that is > 0)
//   failures:  devices that failed for any other reason (a job exit code concern, not a subscription one)
// `send(sub, payload)` is web-push's sendNotification in the job and a stub in the tests.
export const GONE = new Set([404, 410]);
export async function deliver(subs, notification, send) {
  const payload = JSON.stringify(notification), pushed = [];
  let delivered = 0, failures = 0;
  for (const sub of subs || []) {
    try { const r = await send(sub, payload); pushed.push({ endpoint: sub.endpoint, status: (r && r.statusCode) || 201 }); delivered++; }
    catch (e) { const status = +(e && e.statusCode) || 0; pushed.push({ endpoint: sub.endpoint, status, error: status ? undefined : String(e && e.message || e).slice(0, 120) }); if (!GONE.has(status)) failures++; }
  }
  return { pushed, delivered, failures };
}
