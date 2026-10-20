#!/usr/bin/env node
// Hourly push-alert job (runs from .github/workflows/observations.yml). See alerts/lib.mjs for the rules.
//   node alerts/run.mjs            evaluate every synced rider and send
//   node alerts/run.mjs --dry-run  print what would be sent; nothing is sent or saved
// Env: SYNC_URL (the Worker), SYNC_ADMIN_TOKEN (its ADMIN_TOKEN secret), VAPID_PRIVATE_KEY. The public
// key is read from the Worker's /v1/push/vapid. Missing any of these the job prints a note and exits 0.
import webpush from "web-push";
import { SPOTS, fetchForecasts, evaluate, laNow, riderSpots, deliver, GONE } from "./lib.mjs";

const DRY = process.argv.includes("--dry-run");
const URL_ = (process.env.SYNC_URL || "").replace(/\/+$/, ""), TOKEN = process.env.SYNC_ADMIN_TOKEN || "", PRIV = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "https://mikestoneapps.github.io/coastal-kiteboarding/";
if (!URL_ || !TOKEN || !PRIV) { console.log("Push alerts not configured (need SYNC_URL, SYNC_ADMIN_TOKEN, VAPID_PRIVATE_KEY); nothing to do."); process.exit(0); }

async function api(path, method = "GET", body) {
  const r = await fetch(URL_ + path, { method, headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${d && d.error || ""}`);
  return d;
}

const vapid = await fetch(URL_ + "/v1/push/vapid", { signal: AbortSignal.timeout(20000) }).then(r => r.ok ? r.json() : null).catch(() => null);
if (!vapid || !vapid.publicKey) { console.log("The sync service has no VAPID_PUBLIC_KEY yet; nothing to do."); process.exit(0); }
webpush.setVapidDetails(SUBJECT, vapid.publicKey, PRIV);

const { riders } = await api("/v1/admin/riders");
if (!riders.length) { console.log("No rider has enabled notifications yet."); process.exit(0); }

// one forecast call for the union of curated + every rider's kept spots
const union = new Map(SPOTS.map(s => [s.id, s]));
for (const r of riders) for (const s of riderSpots(r.settings || {})) union.set(s.id, s);
const forecasts = await fetchForecasts([...union.values()]);
const now = laNow();
console.log(`${riders.length} rider(s), ${Object.keys(forecasts).length} spot forecasts, ${now.date} ${now.hour}:00 Pacific${DRY ? " (dry run)" : ""}`);

let failures = 0;
for (const rider of riders) {
  const tag = rider.id.slice(0, 8);
  let res;
  try { res = evaluate(rider, forecasts, now); } catch (e) { console.error(`rider ${tag}: evaluation failed:`, e); failures++; continue; }
  if (!res.notification) { console.log(`rider ${tag}: ${res.why}`); continue; }
  console.log(`rider ${tag}: ${res.notification.body}`);
  if (DRY) continue;
  // Every device's push status goes back to the Worker (PUT {pushed}); it deletes the subscriptions the push service reports gone (404/410)
  // and leaves the rest alone, so a device that subscribed meanwhile is never overwritten. The "already alerted" state is only
  // advanced when at least one device got the digest, so a push outage is retried next hour instead of silently swallowing the alert.
  const d = await deliver(rider.subs, res.notification, (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 6 * 3600, urgency: "normal" }));
  for (const p of d.pushed) { if (GONE.has(p.status)) console.log(`rider ${tag}: subscription gone (${p.status}), asking the sync service to drop it`); else if (p.status >= 400 || !p.status) console.error(`rider ${tag}: push failed (${p.status || p.error})`); }
  failures += d.failures;
  try { await api("/v1/admin/riders/" + rider.id, "PUT", d.delivered ? { pushed: d.pushed, state: res.state } : { pushed: d.pushed }); }
  catch (e) { console.error(`rider ${tag}: could not save alert state:`, e.message); failures++; }
}
process.exit(failures ? 1 : 0);
