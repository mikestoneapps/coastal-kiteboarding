// `node away/browser-test.mjs [--live]` — drives index.html in headless Chromium (Playwright).
// Default: every external host is intercepted and answered from away/fixtures.mjs, and the same-origin
// away-spots.json is served from the fixture too (opts.file: ok | far | empty | missing | fail), so it runs offline and
// deterministically. Home mode is compared against a second copy of the page (BASELINE_DIR, e.g. `main`'s
// index.html) to prove nothing changed there. `--live` lets Open-Meteo, Overpass, Nominatim and Commons
// through for the real check (the build container can't reach them, see docs/BUILD-PLAN.md); the catalogue
// still comes from the fixture unless the repo has a real away-spots.json and you pass --real-file.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as F from "./fixtures.mjs";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = process.argv.includes("--live"), REAL_FILE = process.argv.includes("--real-file");
const BASELINE = process.env.BASELINE_DIR || "";
const pw = (() => { for (const p of [process.env.PLAYWRIGHT_MODULE, "playwright", "/opt/node-tools/node_modules/playwright"]) { if (!p) continue; try { return require(p); } catch (e) {} } throw new Error("playwright not found; set PLAYWRIGHT_MODULE"); })();
let fails = 0;
const assert = (c, m) => { if (!c) { fails++; console.error("FAIL:", m); } else console.log("ok  ", m); };
const TYPES = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".png": "image/png", ".jpg": "image/jpeg" };
function serve(dir) {
  return new Promise(res => { const s = http.createServer((req, r) => { const p = path.join(dir, decodeURIComponent(req.url.split("?")[0]).replace(/^\/$/, "/index.html")); fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" }); r.end(d); }); }); s.listen(0, "127.0.0.1", () => res({ server: s, url: `http://127.0.0.1:${s.address().port}/` })); });
}
// Deterministic forecast: W wind 18g22 at every point, 25 kn at point index 1 (so the ranking is stable and non-trivial).
const forecastFor = n => F.openMeteo(n, (i, h) => ({ spd: i === 1 ? 25 : 18, gst: i === 1 ? 30 : 22, dir: h >= 12 && h <= 17 ? 290 : 270 }));
const SYNC_URL = "https://sync.test.workers.dev", SYNC_KEY = "k".repeat(40);
const syncStore = () => ({ doc: null, photos: {}, log: [] });   // one per "rider": pass the same object to every device's mock
function mock(page, opts = {}) {
  const log = [];
  page.route(/.*/, async route => {
    const u = route.request().url(), body = route.request().postData() || "", method = route.request().method();
    const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, DELETE, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type" };
    const json = (o, status = 200) => route.fulfill({ status, contentType: "application/json", headers: CORS, body: JSON.stringify(o) });
    if (u.startsWith(SYNC_URL)) {   // the settings-sync Worker, as sync/worker.js answers (settings newest-wins via 409; photos as bytes)
      const S = opts.sync; if (!S) return route.abort();
      const path = new URL(u).pathname, auth = route.request().headers()["authorization"] || "";
      if (method === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      if (auth !== "Bearer " + SYNC_KEY) return json({ error: "unauthorized" }, 401);
      S.log.push(method + " " + path);
      if (path === "/v1/settings") {
        if (method === "GET") return S.doc ? json(S.doc) : json({ empty: true }, 404);
        const b = JSON.parse(body); if (S.doc && S.doc.updatedAt !== (b.base ?? null)) return json(S.doc, 409);
        S.doc = { settings: b.settings, updatedAt: b.updatedAt }; return json({ ok: true, updatedAt: b.updatedAt });
      }
      const m = path.match(/^\/v1\/photo\/([a-z0-9][a-z0-9_-]{0,47})$/); if (!m) return json({ error: "not found" }, 404);
      if (method === "PUT") { const buf = route.request().postDataBuffer(); const ct = route.request().headers()["content-type"] || ""; if (!/^image\/jpeg/.test(ct)) return json({ error: "expected image/jpeg" }, 400); if (buf.length > 100 * 1024) return json({ error: "too large" }, 413); S.photos[m[1]] = buf; S.log.push("photo bytes " + buf.length + " " + ct); return json({ ok: true, bytes: buf.length }); }
      if (method === "GET") return S.photos[m[1]] ? route.fulfill({ status: 200, contentType: "image/jpeg", headers: CORS, body: S.photos[m[1]] }) : json({ error: "no photo" }, 404);
      if (method === "DELETE") { delete S.photos[m[1]]; return json({ ok: true }); }
      return json({ error: "method not allowed" }, 405);
    }
    if (/\/obs\.json/.test(u)) return json({ obs: {} });   // station readings arrive at their own pace; keep the comparison deterministic
    if (/\/away-spots\.json/.test(u) && !REAL_FILE) {
      log.push("away-spots.json");
      const f = opts.file || "ok";
      if (f === "missing") return json({ error: "not found" }, 404);
      if (f === "fail") return route.abort("failed");
      return json(f === "far" ? F.AWAY_FILE_FAR : f === "empty" ? F.AWAY_FILE_EMPTY : F.AWAY_FILE);
    }
    if (u.startsWith("http://127.0.0.1")) return route.continue();
    if (LIVE && !/fonts\.|api\.weather\.gov/.test(u)) return route.continue();
    log.push(u.split("?")[0] + (body ? " " + decodeURIComponent(body.replace(/^data=/, "")).slice(0, 200) : ""));
    if (/api\.open-meteo\.com/.test(u)) { const n = (new URL(u).searchParams.get("latitude") || "").split(",").length; return json((opts.forecast || forecastFor)(n)); }
    if (/marine-api\.open-meteo\.com/.test(u)) { const n = (new URL(u).searchParams.get("latitude") || "").split(",").length; return json(F.marine(n)); }
    if (/overpass/.test(u)) { if (opts.overpass === "down") return json({}, 504); if (opts.overpass === "slow") await new Promise(r => setTimeout(r, 4000)); if (/surveillance/.test(body)) return json(F.OVERPASS_CAMS); if (/coastline/.test(body)) return json(F.OVERPASS_SHORE); return json({}, 400); }
    if (/commons\.wikimedia\.org/.test(u)) return json(F.COMMONS);
    if (/upload\.wikimedia\.org/.test(u)) return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64") });
    if (/nominatim/.test(u)) return json(F.NOMINATIM);
    return route.abort();   // fonts, NWS, anything else: the page must cope
  });
  return log;
}
async function newPage(browser, url, opts) {
  const ctx = await browser.newContext({ viewport: { width: (opts && opts.width) || 420, height: 860 }, geolocation: opts && opts.geo, permissions: opts && opts.geo ? ["geolocation"] : [] });
  const page = await ctx.newPage();
  if (opts && opts.init) await page.addInitScript(opts.init);
  const errors = []; page.on("pageerror", e => errors.push(String(e))); page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });   // aborted fonts/NWS requests are expected offline
  const log = mock(page, opts);
  await page.goto(url);
  return { ctx, page, errors, log };
}
const text = (page, sel) => page.locator(sel).innerText().catch(() => "");
const scored = page => page.locator(".row:not(.pending)").count();

const { server, url } = await serve(ROOT);
const base = BASELINE ? await serve(BASELINE) : null;
const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  /* ---------- 1. home mode, compared with the baseline page ---------- */
  {
    const { page, errors, log, ctx } = await newPage(browser, url);
    await page.waitForSelector(".row", { timeout: 20000 });
    await page.waitForTimeout(800);
    const rows = await scored(page);
    assert(rows > 0 && rows <= 15, `home: ${rows} curated rows within 1h30 of Lake Oswego`);
    assert((await page.locator("#away").count()) === 0 && (await page.locator(".row.pending").count()) === 0, "home: no away banner, no pending rows");
    assert(!log.some(l => /overpass|nominatim|commons|away-spots/.test(l)), "home: no OpenStreetMap, Nominatim or Commons calls, no catalogue fetch");
    assert(errors.length === 0, "home: no page errors (" + errors.join(" | ") + ")");
    const mine = { list: await text(page, "#list"), hero: await text(page, "#hero"), narr: await text(page, "#narr"), sub: await text(page, "#sub") };
    await page.click("#homeBC"); await page.waitForTimeout(200); mine.bc = await text(page, "#list");
    assert((await text(page, "#homeBC")) === "Pacific City" && /Pacific CityCentral Coast\n[^\n]*\n5 min/.test(mine.bc) && /Cape LookoutTillamook Bay\n[^\n]*\n20 min/.test(mine.bc), "coast house is Pacific City: its own spot is 5 min, Cape Lookout 20 min");
    await page.click(".row .head"); await page.waitForTimeout(200); mine.detail = await text(page, ".row .detail");
    if (base) {
      const b = await newPage(browser, base.url);
      await b.page.waitForSelector(".row", { timeout: 20000 }); await b.page.waitForTimeout(800);
      const theirs = { list: await text(b.page, "#list"), hero: await text(b.page, "#hero"), narr: await text(b.page, "#narr"), sub: await text(b.page, "#sub") };
      await b.page.click("#homeBC"); await b.page.waitForTimeout(200); theirs.bc = await text(b.page, "#list");
      await b.page.click(".row .head"); await b.page.waitForTimeout(200); theirs.detail = await text(b.page, ".row .detail");
      for (const k of Object.keys(theirs)) { const same = mine[k] === theirs[k]; let diff = ""; if (!same) { const A = theirs[k].split("\n"), B = mine[k].split("\n"); for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) { diff += `\n  line ${i}: baseline ${JSON.stringify(A[i])} / now ${JSON.stringify(B[i])}`; if (diff.length > 1500) break; } } assert(same, `home mode ${k} identical to the baseline page` + diff); }
      await b.ctx.close();
    } else console.log("(no BASELINE_DIR: skipped the identical-to-baseline comparison)");
    // Two buttons under the list. "Look up a new spot": the sheet finds a place by name; the kept spot shows in Rider and can be removed there
    assert((await text(page, "#openKeep")) === "Look up a new spot" && (await text(page, "#openHere")) === "This spot is killer", "two buttons under the list: 'Look up a new spot' and 'This spot is killer'");
    await page.click("#openHere"); await page.waitForSelector("#ksKeep");
    assert(/^This spot is killer/.test(await text(page, "#sheet h2")) && (await page.locator("#ksname").count()) === 1 && (await page.locator("#ksface button").count()) === 8, "'This spot is killer' opens the same sheet (name, location, facing)");
    await page.waitForFunction(() => /Couldn't get your location/.test(document.getElementById("ksLLNote")?.textContent || ""), null, { timeout: 10000 });
    assert((await page.locator("#ksFindBox").isVisible()) && (await page.inputValue("#ksll")) === "", "location refused: says so and offers the place search instead");
    await page.click("#closeSheet");
    await page.click("#openKeep"); await page.waitForSelector("#ksKeep");
    assert(/^Add a spot/.test(await text(page, "#sheet h2")) && (await page.locator("#ksq").count()) === 1 && (await page.locator("#ksGPS").count()) === 1 && (await page.locator("#ksMap").isHidden()) && (await page.getAttribute("#ksll", "readonly")) !== null, "Add a spot: place search, Use my location, read-only coordinates, no map link yet");
    await page.click("#ksKeep"); await page.waitForTimeout(100);
    assert((await page.locator("#ksKeep").count()) === 1 && (await page.evaluate(() => JSON.parse(localStorage.getItem("goc.settings")).kept.length)) === 0, "nothing is added without a name and a location");
    await page.fill("#ksq", "San Diego"); await page.press("#ksq", "Enter"); await page.waitForSelector("#ksHits button", { timeout: 10000 });
    await page.click("#ksHits button"); await page.waitForTimeout(100);
    assert((await page.inputValue("#ksname")) === "San Diego" && (await page.inputValue("#ksll")) === "32.7174, -117.1628" && (await page.locator("#ksMap").isVisible()) && /maps\/search\/\?api=1&query=32\.7174%2C-117\.1628$/.test(await page.getAttribute("#ksMap", "href")), "picking a Nominatim match fills the name and coordinates and points Check on map at them");
    await page.click("#ksKeep"); await page.waitForTimeout(400);
    let kept = await page.evaluate(() => JSON.parse(localStorage.getItem("goc.settings")).kept);
    assert(kept.length === 1 && kept[0].id === "k-san-diego" && kept[0].lat === 32.7174 && kept[0].facing === 270 && kept[0].driveLO > 600 && kept[0].driveBC > 600 && kept[0].kept === true, "added like a kept spot: k- id, facing, estimated drives from both houses");
    assert(/more spots? beyond/.test(await text(page, "#beyond")), "it sits beyond the home radius, counted like any other spot");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("goc.settings")).kept[0]?.photoChecked, null, { timeout: 10000 }).catch(() => {});
    kept = await page.evaluate(() => JSON.parse(localStorage.getItem("goc.settings")).kept);
    assert(log.some(l => /commons\.wikimedia\.org/.test(l)) && kept[0].photoChecked && /kites\.jpg$/.test(kept[0].photoUrl || "") && /Jane Doe/.test(kept[0].photoCredit), "a spot added at home gets the background Commons lookup: scored pick saved with its credit");
    await page.click("#openSettings"); await page.waitForSelector("#riderKept button");
    assert(/San Diego ×/.test(await text(page, "#riderKept")), "Rider sheet lists the added spot");
    await page.click("#riderKept button"); await page.waitForTimeout(200);
    kept = await page.evaluate(() => JSON.parse(localStorage.getItem("goc.settings")).kept);
    assert(kept.length === 0 && (await page.locator("#riderKept").count()) === 0, "removed from the Rider sheet");
    await page.click("#closeSheet");
    // Elsewhere within Oregon: still home behaviour (no discovery), just estimated drives
    await page.click("#homeX"); await page.waitForSelector("#plFind");
    assert((await page.locator("#plq").count()) === 1, "Elsewhere sheet has the place-name search");
    await page.click('#places button[data-p="Newport"]'); await page.click("#plSave"); await page.waitForTimeout(300);
    assert((await page.locator("#away").count()) === 0 && !log.some(l => /overpass|away-spots/.test(l)), "Elsewhere = Newport (within 150 mi): no discovery, curated list as before");
    assert(errors.length === 0, "still no page errors");
    await ctx.close();
  }

  /* ---------- 1b. narrow phone (390 px): tile layout, "This spot is killer", the rider's own photos ---------- */
  {
    const longKept = () => { if (localStorage.getItem("goc.settings")) return; localStorage.setItem("goc.settings", JSON.stringify({ home: "LO", radius: 150, sort: "score", kept: [{ id: "k-long", name: "Mission Bay South Shores launch beach", region: "Kept", lat: 45.60, lon: -122.40, plat: 45.60, plon: -122.40, facing: 270, dir: { best: [[240, 300]], work: [[190, 350]], off: [[40, 140]] }, waves: true, pass: false, photo: false, notes: "", parking: "", driveLO: 45, driveBC: 120, kept: true, photoChecked: "2026-10-16T00:00:00Z", addedAt: "2026-10-16T00:00:00Z" }] })); };
    const sync = syncStore();
    const gusty = n => F.openMeteo(n, (i, h) => ({ spd: 12 + (i % 3), gst: 22 + (i % 5), dir: 280 }));   // light and gusty: every row carries a reason chip
    const { page, errors, log, ctx } = await newPage(browser, url, { width: 390, geo: { latitude: 45.61, longitude: -122.41 }, init: longKept, sync, forecast: gusty });
    await page.waitForSelector(".row", { timeout: 20000 }); await page.waitForTimeout(800);
    const tiles = await page.evaluate(() => [...document.querySelectorAll(".row")].map(r => { const h = r.querySelector(".head").getBoundingClientRect(), p = r.querySelector(".pic").getBoundingClientRect(), n = r.querySelector(".name").getBoundingClientRect(), chips = [...r.querySelectorAll(".wind .chip")], last = chips.length ? chips[chips.length - 1].getBoundingClientRect() : null; return { id: r.id, head: h.height, pic: p.height, nameLines: Math.round(n.height / 18), clear: last ? h.bottom - last.bottom : null, picTop: p.top - h.top, picBottom: h.bottom - p.bottom }; }));
    const wrapped = tiles.filter(t => t.nameLines > 1), chipped = tiles.filter(t => t.clear != null);
    assert(tiles.length >= 10 && wrapped.length >= 2 && chipped.length >= 5, `390 px: ${tiles.length} rows, ${wrapped.length} with a wrapped name, ${chipped.length} with a chip`);
    assert(tiles.every(t => t.head >= 72), "every tile is at least 72 px tall");
    assert(chipped.every(t => t.clear >= 8), "the status chip always clears the tile's bottom edge by 8 px or more (was flush when the name wrapped): " + chipped.map(t => `${t.id} ${Math.round(t.clear)}`).join(", "));
    assert(tiles.every(t => Math.abs(t.pic - t.head) < 1 && Math.abs(t.picTop) < 1 && Math.abs(t.picBottom) < 1), "the photo stretches to the tile's full height on every row");
    assert((await page.locator('#row-k-long .pic img').count()) === 0 && (await page.locator('#row-k-long .pic.nophoto').count()) === 1, "the long-named kept spot (Commons already checked, nothing found) keeps the neutral tile");
    assert(errors.length === 0, "390 px: no page errors (" + errors.join(" | ") + ")");

    // "This spot is killer" with location allowed: coordinates land by themselves, cursor in the name
    await page.click("#openHere"); await page.waitForSelector("#ksKeep");
    await page.waitForFunction(() => document.getElementById("ksll")?.value === "45.61, -122.41", null, { timeout: 10000 });
    assert((await page.locator("#ksFindBox").isHidden()) && (await page.locator("#ksMap").isVisible()) && (await page.evaluate(() => document.activeElement && document.activeElement.id)) === "ksname" && /Your location now/.test(await text(page, "#ksLLNote")), "'This spot is killer': phone location filled in, Check on map ready, name field focused, no place search");
    await page.keyboard.type("Killer Beach"); await page.click('#ksface button[data-deg="315"]'); await page.click("#ksKeep");
    await page.waitForSelector("#row-k-killer-beach", { timeout: 10000 });
    let kb = await page.evaluate(() => JSON.parse(localStorage.getItem("goc.settings")).kept.find(k => k.id === "k-killer-beach"));
    assert(kb && kb.lat === 45.61 && kb.lon === -122.41 && kb.facing === 315 && kb.kept === true, "saved at the phone's coordinates with the chosen facing, scored like any other spot");
    await page.waitForFunction(() => document.querySelector('#row-k-killer-beach .pic img[src*="kites.jpg"]'), null, { timeout: 10000 }).catch(() => {});
    assert((await page.locator('#row-k-killer-beach .pic img[src*="kites.jpg"]').count()) === 1, "its Commons photo lands in the tile in the background, no re-sort");

    // the rider's own photo: picked from the camera roll, shrunk to 480×320 JPEG, cached in IndexedDB, uploaded through sync
    await page.evaluate(() => { localStorage.setItem("goc.sync", JSON.stringify({ url: "https://sync.test.workers.dev", key: "k".repeat(40), remoteUpdatedAt: null })); });
    await page.reload(); await page.waitForSelector(".row", { timeout: 20000 });
    await page.waitForFunction(() => /Synced/.test((typeof syncState !== "undefined" && syncState.status) || ""), null, { timeout: 10000 });
    assert(sync.doc && sync.doc.settings.kept.length === 2, "sync on: this device's settings (both kept spots) are the server copy");
    const png = Buffer.from((await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 1600; c.height = 1200; const g = c.getContext("2d"); const gr = g.createLinearGradient(0, 0, 1600, 1200); gr.addColorStop(0, "#1b6ca8"); gr.addColorStop(1, "#f2d388"); g.fillStyle = gr; g.fillRect(0, 0, 1600, 1200); let x = 1; for (let i = 0; i < 4000; i++) { x = (x * 48271) % 2147483647; g.fillStyle = `hsl(${x % 360} 70% ${30 + x % 50}%)`; g.fillRect(x % 1600, (x >> 8) % 1200, 20 + x % 60, 20 + (x >> 4) % 60); } return c.toDataURL("image/png"); })).split(",")[1], "base64");
    await page.click('button[data-open="stevenson"]'); await page.waitForSelector("#detail-stevenson .actions");
    assert((await page.locator('#detail-stevenson [data-photo]').count()) === 1 && (await page.locator('#detail-stevenson [data-unphoto]').count()) === 0, "a curated spot's detail offers Use my photo (and no Remove photo yet)");
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('#detail-stevenson [data-photo]')]);
    assert(!chooser.isMultiple() && (await page.getAttribute("#photoFile", "accept")) === "image/*", "Use my photo opens the phone's camera / photo picker (one image)");
    await chooser.setFiles({ name: "beach.png", mimeType: "image/png", buffer: png });
    await page.waitForFunction(() => document.querySelector('#row-stevenson .pic img')?.src.startsWith("blob:"), null, { timeout: 15000 });
    const mine = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open("goc.photos", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); const rec = await new Promise((res, rej) => { const rq = db.transaction("photos").objectStore("photos").get("stevenson"); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); db.close(); if (!rec) return null; const bmp = await createImageBitmap(rec.blob); return { size: rec.blob.size, type: rec.blob.type, w: bmp.width, h: bmp.height, photos: JSON.parse(localStorage.getItem("goc.settings")).photos }; });
    assert(mine && mine.type === "image/jpeg" && mine.w === 480 && mine.h === 320 && mine.size > 8 * 1024 && mine.size <= 48 * 1024 && mine.photos.stevenson, `shrunk to a 480×320 JPEG of ${mine && Math.round(mine.size / 1024)} KB, cached in IndexedDB, listed in settings.photos`);
    assert((await page.locator('#row-stevenson .pic img').getAttribute("src")).startsWith("blob:") && (await page.locator('#detail-stevenson [data-unphoto]').count()) === 1, "the tile shows his photo instead of the built-in one; Remove photo appears");
    await page.waitForFunction(() => document.querySelector('#hero .hpic img')?.src.startsWith("blob:") || !document.querySelector('#hero .hpic[data-spot="stevenson"]'), null, { timeout: 5000 });
    await page.waitForTimeout(1500);
    const up = sync.log.filter(l => /^PUT \/v1\/photo\/stevenson/.test(l)), bytes = sync.log.find(l => /^photo bytes/.test(l));
    assert(up.length === 1 && bytes && +bytes.split(" ")[2] === mine.size && /image\/jpeg/.test(bytes) && sync.doc.settings.photos.stevenson, "uploaded once to the Worker as image/jpeg, and the settings copy lists it");
    assert(errors.length === 0, "own photo: no page errors (" + errors.join(" | ") + ")");

    // a second linked device fetches the missing photo in the background
    const two = await newPage(browser, url, { width: 390, sync, init: () => { localStorage.setItem("goc.sync", JSON.stringify({ url: "https://sync.test.workers.dev", key: "k".repeat(40), remoteUpdatedAt: null })); } });
    await two.page.waitForSelector(".row", { timeout: 20000 });
    await two.page.waitForFunction(() => document.querySelector('#row-stevenson .pic img')?.src.startsWith("blob:"), null, { timeout: 15000 }).catch(() => {});
    assert((await two.page.locator('#row-stevenson .pic img').getAttribute("src") || "").startsWith("blob:") && sync.log.filter(l => /^GET \/v1\/photo\/stevenson/.test(l)).length >= 1, "another linked device pulls the settings, sees the photo listed, fetches it in the background and shows it");
    await two.page.waitForSelector("#row-k-killer-beach", { timeout: 10000 }).catch(() => {});
    assert((await two.page.locator("#row-k-killer-beach").count()) === 1 && (await two.page.locator('#row-k-killer-beach .pic img[src*="kites.jpg"]').count()) === 1, "the kept spot and its Commons photo came along in the settings");
    // Remove photo on the second device: gone from the Worker, and the first device drops it on its next sync
    await two.page.click('button[data-open="stevenson"]'); await two.page.waitForSelector('#detail-stevenson [data-unphoto]');
    await two.page.click('#detail-stevenson [data-unphoto]'); await two.page.waitForTimeout(2500);
    assert(!sync.photos.stevenson && sync.log.some(l => /^DELETE \/v1\/photo\/stevenson/.test(l)) && !(sync.doc.settings.photos || {}).stevenson && (await two.page.locator('#row-stevenson .pic img').getAttribute("src")).endsWith("img/stevenson.jpg"), "Remove photo: deleted from the Worker, dropped from the settings list, built-in photo back");
    await page.evaluate(() => syncPull());
    await page.waitForFunction(() => (document.querySelector('#row-stevenson .pic img')?.src || "").endsWith("img/stevenson.jpg"), null, { timeout: 15000 }).catch(() => {});
    assert((await page.locator('#row-stevenson .pic img').getAttribute("src")).endsWith("img/stevenson.jpg") && (await page.evaluate(() => Object.keys(riderPhotos).length)) === 0, "the first device drops it too on its next sync and restores the default");
    assert(errors.length === 0 && two.errors.length === 0, "two devices: no page errors (" + errors.concat(two.errors).join(" | ") + ")");
    await two.ctx.close(); await ctx.close();
  }

  /* ---------- 2. away mode by place name ---------- */
  {
    const { page, errors, log, ctx } = await newPage(browser, url);
    await page.waitForSelector(".row", { timeout: 20000 });
    await page.click("#homeX"); await page.waitForSelector("#plq");
    await page.fill("#plq", "San Diego"); await page.press("#plq", "Enter");
    await page.waitForSelector("#plHits button", { timeout: 10000 });
    assert(/San Diego County/.test(await text(page, "#plHits")), "Nominatim hits shown");
    await page.click("#plHits button");
    await page.waitForSelector("#away", { timeout: 5000 });
    assert(/Away from home/i.test(await text(page, "#away")), "away banner appears as soon as the place is set");
    await page.waitForFunction(() => document.querySelectorAll('.row .name span').length && [...document.querySelectorAll('.row .name span')].some(s => /auto/.test(s.textContent)), null, { timeout: 15000 });
    await page.waitForFunction(() => /spots within .* from OpenStreetMap/.test(document.querySelector("#away")?.textContent || ""), null, { timeout: 15000 });
    const names = await page.locator(".row .name").allInnerTexts();
    assert(names.some(n => /Sandy Cove Kite Beach/.test(n)) && names.some(n => /Kite launch/.test(n)) && !names.some(n => /Private Cove/.test(n)), "discovered rows listed: " + names.join(" / "));
    assert((await page.locator(".row.pending").count()) === 0, "every discovered spot got a score from the batched forecast call");
    assert(log.filter(l => /away-spots/.test(l)).length === 1 && log.filter(l => /api\.open-meteo/.test(l)).length >= 2 && !log.some(l => /overpass.*sport/.test(l)), "one catalogue fetch + one batched forecast; no Overpass spot search");
    await page.waitForFunction(() => /faces W/.test(document.querySelector("#detail-a-n101")?.textContent || "") || !document.querySelector("#detail-a-n101"), null, { timeout: 100 }).catch(() => {});
    assert(log.filter(l => /overpass/.test(l) && /coastline/.test(l)).length === 1, "shoreline lookup went to Overpass in the background");
    assert((await page.evaluate(() => { const c = JSON.parse(localStorage.getItem("goc.awayspots") || "null"); return c && c.spots.length; })) === 9, "catalogue cached in localStorage with a date");
    assert(!names.some(n => /Manzanita|Rufus/.test(n)), "curated Oregon spots are beyond the radius, not in the list");
    assert(/15 more spots beyond|more spots beyond/.test(await text(page, "#beyond")), "the curated spots are counted as 'beyond'");
    assert(/Best bet|Nothing worth the drive/i.test(await text(page, "#hero")), "hero renders in away mode");
    // open Sandy Cove: auto paragraph, Keep button, cam link
    await page.click('button[data-open="a-n101"]'); await page.waitForSelector("#detail-a-n101 .actions");
    await page.waitForFunction(() => /faces W/.test(document.querySelector("#detail-a-n101")?.textContent || ""), null, { timeout: 10000 }).catch(() => {});
    const d = await text(page, "#detail-a-n101");
    assert(/Auto · found on OpenStreetMap/.test(d) && /faces W/.test(d) && /Keep this spot/.test(d), "detail: auto paragraph with inferred facing and Keep button");
    await page.waitForFunction(() => /Cam · Sandy Cove surf cam/.test(document.querySelector("#detail-a-n101")?.textContent || ""), null, { timeout: 10000 }).catch(() => {});
    assert(/Cam · Sandy Cove surf cam/.test(await text(page, "#detail-a-n101")), "webcam from OSM attached in the background");
    await page.waitForFunction(() => document.querySelector('#row-a-n101 .pic img[src*="kites.jpg"]'), null, { timeout: 10000 }).catch(() => {});
    assert((await page.locator('#row-a-n101 .pic img[src*="kites.jpg"]').count()) === 1, "Commons photo patched into the tile in the background");
    const orderBefore = await page.locator(".row .name").allInnerTexts();
    await page.waitForTimeout(500);
    assert(JSON.stringify(orderBefore) === JSON.stringify(await page.locator(".row .name").allInnerTexts()), "photos never re-sort the list");
    // Keep it
    await page.click('button[data-keep="a-n101"]'); await page.waitForTimeout(300);
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("goc.settings")).kept);
    assert(kept.length === 1 && kept[0].id === "k-sandy-cove-kite-beach" && Math.abs(kept[0].facing - 270) < 8 && kept[0].cam && kept[0].photoUrl, "Keep this spot: saved to settings (synced by Phase 2) with facing, cam and photo");
    assert((await page.locator("#row-k-sandy-cove-kite-beach").count()) === 1 && (await page.locator("#row-a-n101").count()) === 0, "kept row replaces the discovered row, with its score");
    // the unknown-facing spot opens the sheet prefilled
    await page.click('button[data-open="a-n103"]'); await page.click('button[data-keep="a-n103"]'); await page.waitForSelector("#ksKeep");
    assert((await page.inputValue("#ksname")) === "Kite launch" && /32\.83/.test(await page.inputValue("#ksll")), "unknown facing: Keep opens the sheet prefilled with name and coordinates");
    await page.click('#ksface button[data-deg="180"]'); await page.click("#ksKeep"); await page.waitForTimeout(300);
    const kept2 = await page.evaluate(() => JSON.parse(localStorage.getItem("goc.settings")).kept);
    assert(kept2.length === 2 && kept2[1].facing === 180 && kept2[1].osm === "n103", "picked a facing and kept it");
    // back home: exactly as before
    await page.click("#homeLO"); await page.waitForTimeout(300);
    const home = await page.locator(".row .name").allInnerTexts();
    assert((await page.locator("#away").count()) === 0 && !home.some(n => /auto/.test(n)) && home.some(n => /Stevenson|Hood River/.test(n)), "back to Lake Oswego: no banner, no auto rows, curated list");
    assert(!home.some(n => /Sandy Cove Kite Beach/.test(n)) && /more spots beyond/.test(await text(page, "#beyond")), "kept San Diego spots sit beyond the radius at home");
    // reopen: cached, instant
    await page.click("#homeX"); await page.waitForTimeout(300); await page.click("#closeSheet");
    const logN = log.filter(l => /overpass/.test(l)).length;
    await page.reload(); await page.waitForSelector("#away", { timeout: 10000 }); await page.waitForTimeout(500);
    assert(/last search/.test(await text(page, "#away")) && log.filter(l => /overpass/.test(l)).length === logN && log.filter(l => /away-spots/.test(l)).length === 1, "reopening the same area uses the cached search: no new Overpass call, no catalogue refetch");
    // Search again: refetches the catalogue and re-scores
    await page.click("#awayAgain"); await page.waitForFunction(() => /spots within .* from OpenStreetMap/.test(document.querySelector("#away")?.textContent || "") && !/last search/.test(document.querySelector("#away")?.textContent || ""), null, { timeout: 15000 });
    assert(log.filter(l => /away-spots/.test(l)).length === 2 && (await page.locator(".row.pending").count()) === 0, "Search again refetches the catalogue and scores the rows");
    assert(errors.length === 0, "away: no page errors (" + errors.join(" | ") + ")");
    await ctx.close();
  }

  /* ---------- 3. away mode by GPS; nothing nearby; file missing; Overpass down; offline ---------- */
  {
    const { page, errors, ctx } = await newPage(browser, url, { geo: { latitude: 32.77, longitude: -117.25 }, file: "far" });
    await page.waitForSelector(".row", { timeout: 20000 });
    await page.click("#homeX"); await page.waitForSelector("#plGPS"); await page.click("#plGPS");
    await page.waitForSelector("#away", { timeout: 10000 });
    await page.waitForFunction(() => /No spots found here yet/.test(document.querySelector("#away")?.textContent || ""), null, { timeout: 10000 });
    assert(/list updated Oct 12/.test(await text(page, "#away")), "GPS 900 mi from home -> away mode; nothing in the catalogue nearby -> 'No spots found here yet' with the list date");
    assert((await page.locator("#awayHand").count()) === 1 && (await page.locator(".row").count()) === 0 && (await page.locator(".empty").count()) === 0, "empty state: add-by-hand offered, no rows, no 'widen the slider' message");
    await page.click("#awayHand"); await page.waitForSelector("#ksKeep");
    await page.click("#ksGPS"); await page.waitForFunction(() => document.getElementById("ksll")?.value === "32.77, -117.25", null, { timeout: 10000 });
    assert((await page.locator("#ksMap").isVisible()) && /query=32\.77%2C-117\.25$/.test(await page.getAttribute("#ksMap", "href")), "Use my location fills the coordinates from GPS and enables Check on map");
    await page.click("#ksEdit"); await page.fill("#ksll", "32.80, -117.26"); await page.waitForTimeout(50);
    assert(/query=32\.8%2C-117\.26$/.test(await page.getAttribute("#ksMap", "href")), "Edit makes the coordinates typeable; the map link follows");
    await page.fill("#ksname", "Hand Beach"); await page.click('#ksface button[data-deg="270"]'); await page.click("#ksKeep");
    await page.waitForSelector("#row-k-hand-beach", { timeout: 10000 });
    assert((await page.locator("#row-k-hand-beach").count()) === 1, "a spot added by hand (name + location + facing) shows up and gets scored");
    const hand = await page.evaluate(() => JSON.parse(localStorage.getItem("goc.settings")).kept[0]);
    assert(hand.lat === 32.8 && hand.lon === -117.26 && hand.facing === 270, "saved with the typed coordinates");
    assert(errors.length === 0, "empty state: no page errors (" + errors.join(" | ") + ")");
    await ctx.close();
  }
  for (const f of ["missing", "empty"]) {
    const { page, errors, ctx } = await newPage(browser, url, { geo: { latitude: 32.77, longitude: -117.25 }, file: f });
    await page.waitForSelector(".row", { timeout: 20000 });
    await page.click("#homeX"); await page.waitForSelector("#plGPS"); await page.click("#plGPS");
    await page.waitForFunction(() => /No spots found here yet/.test(document.querySelector("#away")?.textContent || ""), null, { timeout: 15000 });
    assert((await page.locator("#awayHand").count()) === 1 && (await page.locator("#awayAgain").count()) === 1, `away-spots.json ${f}: the 'nothing found' banner with Add by hand + Search again`);
    assert(errors.length === 0, `${f} catalogue: no page errors (` + errors.join(" | ") + ")");
    await ctx.close();
  }
  {
    const { page, errors, ctx } = await newPage(browser, url, { geo: { latitude: 32.77, longitude: -117.25 }, overpass: "down" });
    await page.waitForSelector(".row", { timeout: 20000 });
    await page.click("#homeX"); await page.waitForSelector("#plGPS"); await page.click("#plGPS");
    await page.waitForFunction(() => /spots within .* from OpenStreetMap/.test(document.querySelector("#away")?.textContent || ""), null, { timeout: 15000 });
    await page.waitForTimeout(500);
    assert((await page.locator(".row:not(.pending) .name span", { hasText: "auto" }).count()) >= 5 && (await page.locator(".row.pending").count()) === 0, "Overpass down on both mirrors: the catalogue spots are still listed and scored");
    await page.click('button[data-open="a-n101"]'); await page.waitForSelector("#detail-a-n101 .actions");
    assert(/shoreline direction unknown/.test(await text(page, "#detail-a-n101")) && /Keep this spot/.test(await text(page, "#detail-a-n101")), "no shoreline answer: the spot stays 'auto, facing unknown' with Keep");
    assert(errors.length === 0, "Overpass down: no page errors (" + errors.join(" | ") + ")");
    await ctx.close();
  }
  {
    const { page, errors, ctx } = await newPage(browser, url, { geo: { latitude: 32.77, longitude: -117.25 }, overpass: "slow" });
    await page.waitForSelector(".row", { timeout: 20000 });
    await page.click("#homeX"); await page.waitForSelector("#plGPS"); await page.click("#plGPS");
    const t0 = Date.now();
    await page.waitForFunction(() => /spots within .* from OpenStreetMap/.test(document.querySelector("#away")?.textContent || "") && !document.querySelector(".row.pending"), null, { timeout: 15000 });
    assert(Date.now() - t0 < 3500, `Overpass slow (4 s): scores landed without waiting for the shoreline (${Date.now() - t0} ms)`);
    await page.click('button[data-open="a-n101"]'); await page.waitForSelector("#detail-a-n101 .actions");
    assert(/shoreline direction unknown/.test(await text(page, "#detail-a-n101")), "facing unknown while the shoreline lookup is still out");
    await page.waitForFunction(() => /faces W/.test(document.querySelector("#detail-a-n101")?.textContent || ""), null, { timeout: 10000 });
    assert(true, "facing lands later from the background lookup");
    assert(errors.length === 0, "Overpass slow: no page errors (" + errors.join(" | ") + ")");
    await ctx.close();
  }
  {
    const { page, errors, ctx } = await newPage(browser, url, { geo: { latitude: 32.77, longitude: -117.25 }, file: "fail" });
    await page.waitForSelector(".row", { timeout: 20000 });
    await page.click("#homeX"); await page.waitForSelector("#plGPS"); await page.click("#plGPS");
    await page.waitForFunction(() => /Couldn't load the spot list/.test(document.querySelector("#away")?.textContent || ""), null, { timeout: 15000 });
    assert((await page.locator("#awayAgain").count()) === 1 && (await page.locator("#awayHand").count()) === 1, "catalogue fetch fails (offline): clear error with Search again + Add by hand");
    assert(errors.length === 0, "error state: no page errors (" + errors.join(" | ") + ")");
    await ctx.close();
  }
} finally {
  await browser.close(); server.close(); if (base) base.server.close();
}
console.log(fails ? `\n${fails} browser check(s) FAILED` : "\nall browser checks passed");
process.exit(fails ? 1 : 0);
