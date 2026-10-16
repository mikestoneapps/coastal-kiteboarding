// Local test for worker.js: runs the fetch handler with an in-memory KV. `node sync/test.mjs`
import worker from "./worker.js";
export const store = new Map();
export const kvStub = {
  get: async (k, t) => { const v = store.get(k); return v == null ? null : (t === "json" ? JSON.parse(v) : v); },   // binary values (photos) are stored and returned as-is
  put: async (k, v) => { store.set(k, v); },
  delete: async (k) => { store.delete(k); },
  list: async ({ prefix = "", cursor } = {}) => ({ keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true, cursor: undefined }),
};
const env = { SETTINGS: kvStub, VAPID_PUBLIC_KEY: "BPUBLICKEY", ADMIN_TOKEN: "admin-token-1234567890" };
const KEY = "k".repeat(40), ORIGIN = "https://mikestoneapps.github.io";
const req = (path, method, body, headers = {}) => worker.fetch(new Request("https://x.workers.dev" + path, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers }, body: body && JSON.stringify(body) }), env);
const call = (method, body, extra = {}) => req("/v1/settings", method, body, { Authorization: "Bearer " + KEY, ...extra });
const push = (method, body, key = KEY) => req("/v1/push", method, body, { Authorization: "Bearer " + key });
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

// push subscriptions
r = await req("/v1/push/vapid", "GET"); assert(r.status === 200 && (await r.json()).publicKey === "BPUBLICKEY", "vapid public key served without auth");
r = await worker.fetch(new Request("https://x.workers.dev/v1/push/vapid", { headers: { Origin: ORIGIN } }), { SETTINGS: kvStub }); assert(r.status === 404, "no VAPID var -> 404");
r = await push("GET"); assert(r.status === 200 && (await r.json()).endpoints.length === 0, "no subscriptions yet");
const sub = e => ({ endpoint: "https://push.example/" + e, keys: { p256dh: "p", auth: "a" } });
r = await push("PUT", { subscription: { endpoint: "http://insecure", keys: { p256dh: "p", auth: "a" } } }); assert(r.status === 400, "bad subscription -> 400");
r = await push("PUT", { subscription: sub("one"), ua: "iPhone" }); assert(r.status === 200 && (await r.json()).count === 1, "subscribe -> 1");
r = await push("PUT", { subscription: sub("one") }); assert((await r.json()).count === 1, "same endpoint again -> still 1");
r = await push("PUT", { subscription: sub("two") }); assert((await r.json()).count === 2, "second device -> 2");
r = await push("GET"); assert((await r.json()).endpoints.includes("https://push.example/two"), "endpoints listed");
r = await push("GET", undefined, "j".repeat(40)); assert((await r.json()).endpoints.length === 0, "other rider sees no subscriptions");

// admin
r = await req("/v1/admin/riders", "GET"); assert(r.status === 401, "admin without token -> 401");
r = await req("/v1/admin/riders", "GET", undefined, { Authorization: "Bearer wrong-token-1234567890" }); assert(r.status === 401, "admin wrong token -> 401");
r = await worker.fetch(new Request("https://x.workers.dev/v1/admin/riders", { headers: { Authorization: "Bearer x" } }), { SETTINGS: kvStub }); assert(r.status === 404, "admin without ADMIN_TOKEN secret -> 404");
const A = { Authorization: "Bearer " + env.ADMIN_TOKEN };
r = await req("/v1/admin/riders", "GET", undefined, A); const L = await r.json();
assert(r.status === 200 && L.riders.length === 1 && L.riders[0].settings.home === "BC" && L.riders[0].subs.length === 2 && /^[0-9a-f]{64}$/.test(L.riders[0].id), "admin lists the subscribed rider with settings, subs and id");
const id = L.riders[0].id;
r = await req("/v1/admin/riders/" + id, "PUT", { subs: [sub("two")], state: { alerted: { "rufus|2026-10-17": { score: 8.4 } }, sent: {} } }, A); assert(r.status === 200, "admin writes back subs + state");
r = await req("/v1/admin/riders", "GET", undefined, A); const L2 = (await r.json()).riders[0];
assert(L2.subs.length === 1 && L2.state.alerted["rufus|2026-10-17"].score === 8.4, "pruned subs and state persisted");
r = await push("DELETE", { endpoint: "https://push.example/two" }); assert((await r.json()).count === 0, "unsubscribe -> 0");
r = await req("/v1/admin/riders", "GET", undefined, A); assert((await r.json()).riders.length === 0, "rider without subscriptions is not listed");

// rider photos (binary JPEG per spot, 100 KB max)
const jpeg = n => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff, 0xe0]); for (let i = 4; i < n; i++) b[i] = (i * 31) & 0xff; return b; };
const photo = (id, method, body, headers = {}, key = KEY) => worker.fetch(new Request("https://x.workers.dev/v1/photo/" + id, { method, headers: { Origin: ORIGIN, Authorization: "Bearer " + key, ...headers }, body }), env);
const small = jpeg(40 * 1024);
r = await photo("manzanita", "GET"); assert(r.status === 404, "no photo yet -> 404");
r = await worker.fetch(new Request("https://x.workers.dev/v1/photo/manzanita", { method: "PUT", headers: { Origin: ORIGIN, "Content-Type": "image/jpeg" }, body: small }), env); assert(r.status === 401, "photo without a sync key -> 401");
r = await photo("manzanita", "PUT", small, { "Content-Type": "image/jpeg" }); assert(r.status === 200 && (await r.json()).bytes === small.length, "40 KB JPEG stored");
r = await photo("manzanita", "GET"); const got = new Uint8Array(await r.arrayBuffer());
assert(r.status === 200 && r.headers.get("Content-Type") === "image/jpeg" && r.headers.get("Access-Control-Allow-Origin") === ORIGIN && got.length === small.length && got.every((v, i) => v === small[i]), "photo served back byte for byte as image/jpeg with CORS");
r = await photo("manzanita", "GET", undefined, {}, "j".repeat(40)); assert(r.status === 404, "another rider's key sees no photo");
r = await photo("k-mission-bay", "PUT", small, { "Content-Type": "image/jpeg" }); assert(r.status === 200, "a kept spot's id (k-…) is a valid photo key");
r = await photo("manzanita", "PUT", jpeg(100 * 1024 + 1), { "Content-Type": "image/jpeg" }); assert(r.status === 413, "over 100 KB -> 413");
r = await photo("manzanita", "PUT", small, { "Content-Type": "image/jpeg", "Content-Length": String(200 * 1024) }); assert(r.status === 413, "Content-Length over the limit -> 413 before reading the body");
r = await photo("manzanita", "PUT", small, { "Content-Type": "image/png" }); assert(r.status === 400, "wrong content type -> 400");
r = await photo("manzanita", "PUT", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]), { "Content-Type": "image/jpeg" }); assert(r.status === 400, "bytes that aren't a JPEG -> 400");
r = await photo("manzanita", "GET"); assert(r.status === 200 && (await r.arrayBuffer()).byteLength === small.length, "rejected uploads left the stored photo alone");
r = await photo("Manzanita", "GET"); assert(r.status === 404, "spot id must be a lowercase slug (route not found)");
r = await photo("a".repeat(60), "GET"); assert(r.status === 404, "spot id longer than 48 chars -> not found");
r = await worker.fetch(new Request("https://x.workers.dev/v1/photo/manzanita", { method: "POST", headers: { Origin: ORIGIN, Authorization: "Bearer " + KEY }, body: small }), env); assert(r.status === 405, "POST -> 405");
r = await photo("manzanita", "DELETE"); assert(r.status === 200, "Remove photo -> 200");
r = await photo("manzanita", "GET"); assert(r.status === 404, "deleted photo is gone");
r = await photo("manzanita", "DELETE"); assert(r.status === 200, "deleting again is harmless");
r = await req("/v1/admin/riders", "GET", undefined, A); assert(r.status === 200 && (await r.json()).riders.length === 0, "photo keys don't show up as riders");
assert([...store.keys()].filter(k => k.startsWith("ph:")).length === 1 && [...store.keys()].every(k => !k.startsWith("ph:") || /^ph:[0-9a-f]{64}:k-mission-bay$/.test(k)), "photos live under ph:<rider hash>:<spot id>");
if (!process.env.WORKER_TEST_QUIET) console.log("all worker tests passed");
