// Alert evaluation, kept free of network and secrets so alerts/test.mjs can drive it.
// Mirrors alertDigest()/digestText() in index.html and SPEC.md §8:
//   one digest per rider per run, best first; a (spot, day) already alerted is not repeated unless its
//   score moves by >= 2 or it drops below the threshold (then one "fell apart" notice).
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const scoring = require(path.join(ROOT, "scoring.js"));
export const SPOTS = require(path.join(ROOT, "spots.json"));

export const TZ = "America/Los_Angeles", DAYS = 5;
export const HOMES = { LO: { name: "Lake Oswego", key: "driveLO" }, BC: { name: "Bay City", key: "driveBC" } };
export const DEFAULT_WEIGHTS = scoring.DEFAULT_WEIGHTS;
export const DEFAULT_ALERTS = { minScore: 8, maxDrive: 180, days: [0, 1, 2, 3, 4, 5, 6], hour: 19, lead: 3, cap: 1, confidence: true, sameDay: true, quietFrom: 21, quietTo: 7, email: true };
const RESCORE = 2;        // a repeat alert needs the score to move this much
const SAMEDAY_UNTIL = 12; // a same-day ("this morning") alert is only useful before noon

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
export async function fetchForecasts(spots, fetchJSON = getJSON) {
  const lat = spots.map(s => s.lat).join(","), lon = spots.map(s => s.lon).join(",");
  const q = `latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,precipitation_probability,weather_code,visibility&models=best_match,gfs_seamless,icon_seamless&wind_speed_unit=kn&temperature_unit=fahrenheit&forecast_days=${DAYS}&timezone=${encodeURIComponent(TZ)}`;
  const w = await fetchJSON("https://api.open-meteo.com/v1/forecast?" + q);
  const arr = Array.isArray(w) ? w : [w];
  const now = new Date().toISOString().slice(0, 19) + "+00:00";
  const docs = {};
  spots.forEach((s, i) => {
    const d = arr[i]; if (!d || !d.hourly) return; const h = d.hourly;
    const col = (n, m = "best_match") => h[`${n}_${m}`] || h[n] || new Array(h.time.length).fill(null);
    docs[s.id] = { spotId: s.id, fetchedAt: now, time: h.time, spd: rnd(col("wind_speed_10m")), gst: rnd(col("wind_gusts_10m")), dir: rnd(col("wind_direction_10m"), 0), temp: rnd(col("temperature_2m"), 0), pop: rnd(col("precipitation_probability"), 0), code: col("weather_code"), vis: rnd(col("visibility"), 0),
      m: { gfs: { spd: rnd(col("wind_speed_10m", "gfs_seamless")) }, icon: { spd: rnd(col("wind_speed_10m", "icon_seamless")) } } };
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

// Pure decision. Returns {notification: {title, body, url} | null, state, hits, why}.
export function evaluate(rider, forecasts, now) {
  const S = rider.settings || {};
  const A = { ...DEFAULT_ALERTS, ...(S.alerts || {}) };
  const style = ["freeride", "wave", "foil"].includes(S.style) ? S.style : "freeride";
  const weights = { ...DEFAULT_WEIGHTS, ...(S.weights || {}) };
  const limitsOf = id => scoring.limitsFor({ comfort: S.comfort, overrides: S.overrides }, id);
  const spots = riderSpots(S);
  const dayKeys = dayKeysOf(forecasts).filter(d => d >= now.date);
  const state = { alerted: { ...((rider.state && rider.state.alerted) || {}) }, sent: { ...((rider.state && rider.state.sent) || {}) } };
  // prune state for days that have passed
  for (const k of Object.keys(state.alerted)) if (k.split("|")[1] < now.date) delete state.alerted[k];
  for (const k of Object.keys(state.sent)) if (k !== now.date) delete state.sent[k];

  const score = (spot, d) => { const f = forecasts[spot.id]; return f ? scoring.dayScore(spot, f, d, style, weights, limitsOf(spot.id)) : null; };
  // hits per home, like alertDigest() in the page
  const byHome = [];
  const cand = {};   // "spot|day" -> {spot, d, r}
  for (const hk of Object.keys(HOMES)) {
    const hits = [];
    dayKeys.slice(0, A.lead + 1).forEach((d, di) => {
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

  const out = { notification: null, state, hits: byHome, why: "" };
  if (inQuiet(now.hour, A.quietFrom, A.quietTo)) { out.why = "quiet hours"; return out; }
  if ((state.sent[now.date] || 0) >= A.cap) { out.why = "daily cap reached"; return out; }
  const deliverable = k => { const d = cand[k].d; return d === now.date ? now.hour < SAMEDAY_UNTIL : now.hour >= A.hour; };
  const send = newKeys.filter(deliverable);
  if (!send.length && !fell.length) { out.why = newKeys.length ? "waiting for the delivery hour" : "nothing new"; return out; }

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
  const at = new Date().toISOString();
  for (const k of send) state.alerted[k] = { score: cand[k].r.score, at };
  for (const f of fell) delete state.alerted[f.spot.id + "|" + f.d];
  state.sent[now.date] = (state.sent[now.date] || 0) + 1;
  out.notification = { title: "Bistué Boarding", body: parts.join(" "), url: "./#day=" + firstDay, tag: "bb-" + now.date };
  return out;
}
