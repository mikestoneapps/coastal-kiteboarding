// Coastal Kiteboarding — settings sync + push alerts Worker (Cloudflare Workers + KV, free tier).
//
// One document per sync key. The key is a long random string the page generates on the first
// device and passes to other devices in a link ("Link another device"); the Worker only ever sees
// its SHA-256 hash, which is the KV key. No accounts, no passwords, no email.
//
// Rider routes (Authorization: Bearer <sync key>):
//   GET    /v1/settings            -> 200 {settings, updatedAt} | 404 {empty:true}
//   PUT    /v1/settings            body {settings, updatedAt, base}
//          base = the updatedAt this device last saw from the server (null for a first push).
//          If the stored copy has moved past base -> 409 with the stored document, so the client
//          merges instead of overwriting another device's change.
//   GET    /v1/push                -> {endpoints:[...]}   push subscriptions registered for this rider
//   PUT    /v1/push                body {subscription}    add/replace this device's subscription (by endpoint)
//   DELETE /v1/push                body {endpoint}        remove one subscription
//   GET    /v1/push/vapid          -> {publicKey}         no auth; 404 until VAPID_PUBLIC_KEY is set
//
// Job routes (Authorization: Bearer <ADMIN_TOKEN>; 404 until the ADMIN_TOKEN secret exists):
//   GET    /v1/admin/riders        -> {riders:[{id, settings, updatedAt, subs, state}]} riders with >=1 subscription
//   PUT    /v1/admin/riders/<id>   body {subs?, state?}   write back pruned subscriptions / alert state
//
// KV keys per rider hash h: s:h settings, p:h push subscriptions, a:h alert state ("already alerted").
// Bindings (wrangler.toml): SETTINGS (KV namespace). Vars: ALLOWED_ORIGINS (CORS, comma-separated),
// VAPID_PUBLIC_KEY. Secret: ADMIN_TOKEN. See docs/SETUP-SYNC.md.

const DEFAULT_ORIGINS = ["https://mikestoneapps.github.io", "http://localhost:8000", "http://127.0.0.1:8000"];
const MAX_BODY = 256 * 1024;   // settings are a few KB; this is a generous ceiling
const MIN_KEY = 32;
const MAX_SUBS = 10;           // devices per rider

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(",").map(s => s.trim()) : DEFAULT_ORIGINS);
    const cors = corsHeaders(origin, allowed);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/" || path === "/v1/health") return json({ ok: true, service: "coastal-kiteboarding-sync" }, 200, cors);
    if (origin && !allowed.includes(origin)) return json({ error: "origin not allowed" }, 403, cors);

    if (path === "/v1/push/vapid") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405, cors);
      return env.VAPID_PUBLIC_KEY ? json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, cors) : json({ error: "push not configured" }, 404, cors);
    }

    if (path.startsWith("/v1/admin/")) return admin(request, env, path, cors);

    if (path !== "/v1/settings" && path !== "/v1/push") return json({ error: "not found" }, 404, cors);

    const key = bearer(request);
    if (!key || key.length < MIN_KEY) return json({ error: "missing or short sync key" }, 401, cors);
    const h = await sha256(key);

    if (path === "/v1/settings") return settingsRoute(request, env, "s:" + h, cors);
    return pushRoute(request, env, "p:" + h, cors);
  }
};

async function settingsRoute(request, env, kv, cors) {
  if (request.method === "GET") {
    const doc = await env.SETTINGS.get(kv, "json");
    if (!doc) return json({ empty: true }, 404, cors);
    return json(doc, 200, cors);
  }
  if (request.method === "PUT") {
    const body = await readBody(request);
    if (body === TOO_LARGE) return json({ error: "too large" }, 413, cors);
    if (body === BAD_JSON) return json({ error: "bad json" }, 400, cors);
    if (!body || typeof body.settings !== "object" || body.settings === null || typeof body.updatedAt !== "string")
      return json({ error: "expected {settings, updatedAt, base}" }, 400, cors);
    if (JSON.stringify(body.settings).length > MAX_BODY) return json({ error: "too large" }, 413, cors);

    const current = await env.SETTINGS.get(kv, "json");
    const base = body.base == null ? null : String(body.base);
    if (current && current.updatedAt !== base) return json(current, 409, cors);

    const doc = { settings: body.settings, updatedAt: body.updatedAt, savedAt: new Date().toISOString() };
    await env.SETTINGS.put(kv, JSON.stringify(doc));
    return json({ ok: true, updatedAt: doc.updatedAt }, 200, cors);
  }
  return json({ error: "method not allowed" }, 405, cors);
}

async function pushRoute(request, env, kv, cors) {
  const subs = (await env.SETTINGS.get(kv, "json")) || [];
  if (request.method === "GET") return json({ endpoints: subs.map(s => s.endpoint) }, 200, cors);
  if (request.method === "PUT") {
    const body = await readBody(request);
    if (body === TOO_LARGE) return json({ error: "too large" }, 413, cors);
    if (body === BAD_JSON) return json({ error: "bad json" }, 400, cors);
    const s = body && body.subscription;
    if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || !s.keys || typeof s.keys.p256dh !== "string" || typeof s.keys.auth !== "string")
      return json({ error: "expected {subscription:{endpoint, keys:{p256dh, auth}}}" }, 400, cors);
    const next = subs.filter(x => x.endpoint !== s.endpoint);
    next.push({ endpoint: s.endpoint, expirationTime: s.expirationTime ?? null, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, ua: String(body.ua || "").slice(0, 200), addedAt: new Date().toISOString() });
    while (next.length > MAX_SUBS) next.shift();   // oldest device drops off
    await env.SETTINGS.put(kv, JSON.stringify(next));
    return json({ ok: true, count: next.length }, 200, cors);
  }
  if (request.method === "DELETE") {
    const body = await readBody(request);
    if (body === TOO_LARGE) return json({ error: "too large" }, 413, cors);
    if (body === BAD_JSON || !body || typeof body.endpoint !== "string") return json({ error: "expected {endpoint}" }, 400, cors);
    const next = subs.filter(x => x.endpoint !== body.endpoint);
    if (next.length) await env.SETTINGS.put(kv, JSON.stringify(next)); else await env.SETTINGS.delete(kv);
    return json({ ok: true, count: next.length }, 200, cors);
  }
  return json({ error: "method not allowed" }, 405, cors);
}

async function admin(request, env, path, cors) {
  if (!env.ADMIN_TOKEN) return json({ error: "not found" }, 404, cors);
  const tok = bearer(request);
  if (!tok || !timingSafeEqual(tok, env.ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401, cors);

  if (path === "/v1/admin/riders" && request.method === "GET") {
    const riders = [];
    let cursor;
    do {
      const page = await env.SETTINGS.list({ prefix: "p:", cursor });
      for (const k of page.keys) {
        const id = k.name.slice(2);
        const subs = (await env.SETTINGS.get("p:" + id, "json")) || [];
        if (!subs.length) continue;
        const doc = (await env.SETTINGS.get("s:" + id, "json")) || null;
        const state = (await env.SETTINGS.get("a:" + id, "json")) || {};
        riders.push({ id, settings: doc ? doc.settings : null, updatedAt: doc ? doc.updatedAt : null, subs, state });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return json({ riders }, 200, cors);
  }

  const m = path.match(/^\/v1\/admin\/riders\/([0-9a-f]{64})$/);
  if (m && request.method === "PUT") {
    const id = m[1];
    const body = await readBody(request);
    if (body === TOO_LARGE) return json({ error: "too large" }, 413, cors);
    if (body === BAD_JSON || !body) return json({ error: "bad json" }, 400, cors);
    if (Array.isArray(body.subs)) { if (body.subs.length) await env.SETTINGS.put("p:" + id, JSON.stringify(body.subs)); else await env.SETTINGS.delete("p:" + id); }
    if (body.state && typeof body.state === "object") await env.SETTINGS.put("a:" + id, JSON.stringify(body.state));
    return json({ ok: true }, 200, cors);
  }
  return json({ error: "not found" }, 404, cors);
}

const TOO_LARGE = Symbol("too large"), BAD_JSON = Symbol("bad json");
async function readBody(request) {
  const len = +(request.headers.get("Content-Length") || 0);
  if (len > MAX_BODY) return TOO_LARGE;
  try { const t = await request.text(); if (t.length > MAX_BODY) return TOO_LARGE; return JSON.parse(t); } catch (e) { return BAD_JSON; }
}

function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+([A-Za-z0-9_\-]+)$/);
  return m ? m[1] : null;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function corsHeaders(origin, allowed) {
  const h = {
    "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
  if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
