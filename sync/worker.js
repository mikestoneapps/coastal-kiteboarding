// Coastal Kiteboarding — settings sync Worker (Cloudflare Workers + KV, free tier).
//
// One document per sync key. The key is a long random string the page generates on the first
// device and passes to other devices in a link ("Link another device"); the Worker only ever sees
// its SHA-256 hash, which is the KV key. No accounts, no passwords, no email.
//
//   GET  /v1/settings   Authorization: Bearer <key>   -> 200 {settings, updatedAt} | 404 {empty:true}
//   PUT  /v1/settings   Authorization: Bearer <key>   body {settings, updatedAt, base}
//        base = the updatedAt this device last saw from the server (null for a first push).
//        If the stored copy has moved past base -> 409 with the stored document, so the client
//        merges instead of overwriting another device's change.
//
// Bindings (wrangler.toml): SETTINGS (KV namespace). Optional var ALLOWED_ORIGINS: comma-separated
// list of page origins allowed by CORS (defaults below).

const DEFAULT_ORIGINS = ["https://mikestoneapps.github.io", "http://localhost:8000", "http://127.0.0.1:8000"];
const MAX_BODY = 256 * 1024;   // settings are a few KB; this is a generous ceiling
const MIN_KEY = 32;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(",").map(s => s.trim()) : DEFAULT_ORIGINS);
    const cors = corsHeaders(origin, allowed);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/v1/health") return json({ ok: true, service: "coastal-kiteboarding-sync" }, 200, cors);
    if (url.pathname !== "/v1/settings") return json({ error: "not found" }, 404, cors);
    if (origin && !allowed.includes(origin)) return json({ error: "origin not allowed" }, 403, cors);

    const key = bearer(request);
    if (!key || key.length < MIN_KEY) return json({ error: "missing or short sync key" }, 401, cors);
    const kv = "s:" + await sha256(key);

    if (request.method === "GET") {
      const doc = await env.SETTINGS.get(kv, "json");
      if (!doc) return json({ empty: true }, 404, cors);
      return json(doc, 200, cors);
    }

    if (request.method === "PUT") {
      const len = +(request.headers.get("Content-Length") || 0);
      if (len > MAX_BODY) return json({ error: "too large" }, 413, cors);
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400, cors); }
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
};

function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+([A-Za-z0-9_\-]+)$/);
  return m ? m[1] : null;
}

function corsHeaders(origin, allowed) {
  const h = {
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
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
