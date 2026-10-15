// Local test for worker.js: runs the fetch handler with an in-memory KV. `node sync/test.mjs`
import worker from "./worker.js";
const store = new Map();
const env = { SETTINGS: { get: async (k, t) => { const v = store.get(k); return v == null ? null : (t === "json" ? JSON.parse(v) : v); }, put: async (k, v) => { store.set(k, v); } } };
const KEY = "k".repeat(40), ORIGIN = "https://mikestoneapps.github.io";
const call = (method, body, extra = {}) => worker.fetch(new Request("https://x.workers.dev/v1/settings", { method, headers: { Origin: ORIGIN, Authorization: "Bearer " + KEY, "Content-Type": "application/json", ...extra }, body: body && JSON.stringify(body) }), env);
const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  ", m); };
let r = await call("GET"); assert(r.status === 404 && r.headers.get("Access-Control-Allow-Origin") === ORIGIN, "empty store -> 404 with CORS");
r = await call("PUT", { settings: { home: "LO" }, updatedAt: "2026-10-15T10:00:00Z", base: null }); assert(r.status === 200, "first push -> 200");
r = await call("GET"); const d = await r.json(); assert(r.status === 200 && d.settings.home === "LO" && d.updatedAt === "2026-10-15T10:00:00Z", "get returns stored doc");
r = await call("PUT", { settings: { home: "BC" }, updatedAt: "2026-10-15T11:00:00Z", base: "2026-10-15T09:00:00Z" }); assert(r.status === 409 && (await r.json()).settings.home === "LO", "stale base -> 409 with current doc");
r = await call("PUT", { settings: { home: "BC" }, updatedAt: "2026-10-15T11:00:00Z", base: "2026-10-15T10:00:00Z" }); assert(r.status === 200, "matching base -> 200");
r = await worker.fetch(new Request("https://x.workers.dev/v1/settings", { headers: { Origin: ORIGIN, Authorization: "Bearer short" } }), env); assert(r.status === 401, "short key -> 401");
r = await worker.fetch(new Request("https://x.workers.dev/v1/settings", { headers: { Origin: "https://evil.example", Authorization: "Bearer " + KEY } }), env); assert(r.status === 403 && !r.headers.get("Access-Control-Allow-Origin"), "foreign origin -> 403, no CORS header");
r = await worker.fetch(new Request("https://x.workers.dev/v1/settings", { method: "OPTIONS", headers: { Origin: ORIGIN } }), env); assert(r.status === 204, "preflight -> 204");
r = await worker.fetch(new Request("https://x.workers.dev/v1/settings", { headers: { Origin: ORIGIN, Authorization: "Bearer " + "j".repeat(40) } }), env); assert(r.status === 404, "different key sees nothing");
console.log("all worker tests passed");
