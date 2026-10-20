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
    if (/\/obs\.json/.test(u)) return json(opts.obs || { obs: {} });   // station readings arrive at their own pace; keep the comparison deterministic (opts.obs: a fixed set)
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
    if (/\/\/api\.open-meteo\.com/.test(u)) { const P = new URL(u).searchParams, n = (P.get("latitude") || "").split(",").length; log.push("models=" + P.get("models")); const a = (opts.forecast || forecastFor)(n); return a && a.status ? json({ error: true, reason: "test: rejected" }, a.status) : json(a); }
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
const first = (page, sel) => page.locator(sel).first().innerText().catch(() => "");   // first match (text() is strict: one element or nothing)
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
      const norm = s => s.replace(/(\d+g\d+) (kn|mph)\b/g, "$1");   // Oct 2026 added the unit after the wind shorthand; an older baseline still has to compare on everything else
      for (const k of Object.keys(theirs)) { const same = norm(mine[k]) === norm(theirs[k]); let diff = ""; if (!same) { const A = norm(theirs[k]).split("\n"), B = norm(mine[k]).split("\n"); for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) { diff += `\n  line ${i}: baseline ${JSON.stringify(A[i])} / now ${JSON.stringify(B[i])}`; if (diff.length > 1500) break; } } assert(same, `home mode ${k} identical to the baseline page` + diff); }
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
    const pngOf = async seed => Buffer.from((await page.evaluate(s => { const c = document.createElement("canvas"); c.width = 1600; c.height = 1200; const g = c.getContext("2d"); const gr = g.createLinearGradient(0, 0, 1600, 1200); gr.addColorStop(0, "#1b6ca8"); gr.addColorStop(1, "#f2d388"); g.fillStyle = gr; g.fillRect(0, 0, 1600, 1200); let x = s; for (let i = 0; i < 4000; i++) { x = (x * 48271) % 2147483647; g.fillStyle = `hsl(${x % 360} 70% ${30 + x % 50}%)`; g.fillRect(x % 1600, (x >> 8) % 1200, 20 + x % 60, 20 + (x >> 4) % 60); } return c.toDataURL("image/png"); }, seed)).split(",")[1], "base64");   // a busy "camera" picture: compresses like a real one
    const png = await pngOf(1);
    const stored = (pg, id) => pg.evaluate(async id => { const db = await new Promise((res, rej) => { const r = indexedDB.open("goc.photos", 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); const rec = await new Promise((res, rej) => { const rq = db.transaction("photos").objectStore("photos").get(id); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); db.close(); if (!rec) return null; const bmp = await createImageBitmap(rec.blob); return { size: rec.blob.size, type: rec.blob.type, w: bmp.width, h: bmp.height, updatedAt: rec.updatedAt, photos: JSON.parse(localStorage.getItem("goc.settings")).photos || {} }; }, id);   // the IndexedDB record for a spot
    await page.click('button[data-open="stevenson"]'); await page.waitForSelector("#detail-stevenson .actions");
    assert((await page.locator('#detail-stevenson [data-photo]').count()) === 1 && (await page.locator('#detail-stevenson [data-unphoto]').count()) === 0, "a curated spot's detail offers Use my photo (and no Remove photo yet)");
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('#detail-stevenson [data-photo]')]);
    assert(!chooser.isMultiple() && (await page.getAttribute("#photoFile", "accept")) === "image/*", "Use my photo opens the phone's camera / photo picker (one image)");
    await chooser.setFiles({ name: "beach.png", mimeType: "image/png", buffer: png });
    await page.waitForFunction(() => document.querySelector('#row-stevenson .pic img')?.src.startsWith("blob:"), null, { timeout: 15000 });
    const mine = await stored(page, "stevenson");
    assert(mine && mine.type === "image/jpeg" && mine.w === 480 && mine.h === 320 && mine.size > 8 * 1024 && mine.size <= 48 * 1024 && mine.photos.stevenson, `shrunk to a 480×320 JPEG of ${mine && Math.round(mine.size / 1024)} KB, cached in IndexedDB, listed in settings.photos`);
    assert((await page.locator('#row-stevenson .pic img').getAttribute("src")).startsWith("blob:") && (await page.locator('#detail-stevenson [data-unphoto]').count()) === 1, "the tile shows his photo instead of the built-in one; Remove photo appears");
    await page.waitForFunction(() => document.querySelector('#hero .hpic img')?.src.startsWith("blob:") || !document.querySelector('#hero .hpic[data-spot="stevenson"]'), null, { timeout: 5000 });
    await page.waitForTimeout(1500);
    const up = sync.log.filter(l => /^PUT \/v1\/photo\/stevenson/.test(l)), bytes = sync.log.find(l => /^photo bytes/.test(l));
    assert(up.length === 1 && bytes && +bytes.split(" ")[2] === mine.size && /image\/jpeg/.test(bytes) && sync.doc.settings.photos.stevenson, "uploaded once to the Worker as image/jpeg, and the settings copy lists it");
    assert(errors.length === 0, "own photo: no page errors (" + errors.join(" | ") + ")");

    // "This spot is killer" with a photo: picked in the sheet (same picker and resize), previewed, saved with the spot on Save
    await page.click("#openHere"); await page.waitForSelector("#ksKeep");
    await page.waitForFunction(() => document.getElementById("ksll")?.value === "45.61, -122.41", null, { timeout: 10000 });
    assert((await page.locator("#ksThumb").isHidden()) && (await text(page, "#ksPhoto")) === "Add a photo" && (await page.locator("#ksUnphoto").isHidden()), "the add-spot sheet offers Add a photo (optional): no thumbnail, no Remove yet");
    await page.fill("#ksname", "Photo Beach"); await page.click('#ksface button[data-deg="270"]');
    let [ch2] = await Promise.all([page.waitForEvent("filechooser"), page.click("#ksPhoto")]);
    assert(!ch2.isMultiple() && (await page.getAttribute("#photoFile", "accept")) === "image/*", "Add a photo opens the same camera / photo picker (one image)");
    await ch2.setFiles({ name: "beach.png", mimeType: "image/png", buffer: png });
    await page.waitForFunction(() => document.getElementById("ksThumb")?.src.startsWith("blob:") && !document.getElementById("ksThumb").hidden, null, { timeout: 15000 });
    const th = await page.evaluate(async () => { const im = document.getElementById("ksThumb"); const b = await (await fetch(im.src)).blob(); const bmp = await createImageBitmap(b); return { w: bmp.width, h: bmp.height, type: b.type, size: b.size, btn: document.getElementById("ksPhoto").textContent, rm: !document.getElementById("ksUnphoto").hidden, kept: JSON.parse(localStorage.getItem("goc.settings")).kept.length }; });
    assert(th.w === 480 && th.h === 320 && th.type === "image/jpeg" && th.size > 8 * 1024 && th.size <= 48 * 1024 && th.btn === "Change photo" && th.rm && th.kept === 2, `the thumbnail is the shrunk 480×320 JPEG (${Math.round(th.size / 1024)} KB), Change photo and Remove offered, nothing saved yet`);
    await page.click("#ksUnphoto");
    assert((await page.locator("#ksThumb").isHidden()) && (await text(page, "#ksPhoto")) === "Add a photo" && (await page.locator("#ksUnphoto").isHidden()), "Remove in the sheet drops the pending photo (the spot could still be saved without one)");
    [ch2] = await Promise.all([page.waitForEvent("filechooser"), page.click("#ksPhoto")]); await ch2.setFiles({ name: "beach.png", mimeType: "image/png", buffer: png });
    await page.waitForFunction(() => document.getElementById("ksThumb")?.src.startsWith("blob:"), null, { timeout: 15000 });
    await page.click("#ksKeep"); await page.waitForSelector("#row-k-photo-beach", { timeout: 10000 });
    assert((await page.locator("#sheet").count()) === 0 && (await page.locator('#row-k-photo-beach .pic img').getAttribute("src") || "").startsWith("blob:"), "Save: the sheet closes and the new tile shows his photo from its first paint");
    const pb = await stored(page, "k-photo-beach");
    assert(pb && pb.type === "image/jpeg" && pb.w === 480 && pb.h === 320 && pb.size === th.size && pb.photos["k-photo-beach"] === pb.updatedAt, "kept in IndexedDB under the new spot's id (the very bytes previewed) and listed in settings.photos");
    await page.waitForFunction(() => document.querySelector('#row-k-photo-beach .pic img')?.src.startsWith("blob:"), null, { timeout: 10000 });
    await page.waitForTimeout(2500);
    const up2 = sync.log.filter(l => /^PUT \/v1\/photo\/k-photo-beach/.test(l));
    assert(up2.length === 1 && sync.photos["k-photo-beach"] && sync.photos["k-photo-beach"].length === pb.size && sync.doc.settings.photos["k-photo-beach"] && sync.doc.settings.kept.some(k => k.id === "k-photo-beach" && k.facing === 270), "uploaded once to the Worker as image/jpeg; the settings copy carries the spot and lists its photo");
    assert((await page.locator('#row-k-photo-beach .pic img').getAttribute("src")).startsWith("blob:"), "the background Commons lookup never displaces his photo");
    // "Use my photo" in its detail still changes it later
    await page.click('button[data-open="k-photo-beach"]'); await page.waitForSelector('#detail-k-photo-beach [data-unphoto]');
    assert((await page.locator('#detail-k-photo-beach [data-photo]').count()) === 1 && /Photo: yours/.test(await text(page, "#detail-k-photo-beach")), "its detail offers Use my photo and Remove photo like any other spot, and says the photo is his");
    const [ch3] = await Promise.all([page.waitForEvent("filechooser"), page.click('#detail-k-photo-beach [data-photo]')]);
    await ch3.setFiles({ name: "beach2.png", mimeType: "image/png", buffer: await pngOf(7) });
    await page.waitForFunction(at => (JSON.parse(localStorage.getItem("goc.settings")).photos || {})["k-photo-beach"] > at, pb.updatedAt, { timeout: 15000 });
    const pb2 = await stored(page, "k-photo-beach");
    assert(pb2 && pb2.size !== pb.size && pb2.updatedAt > pb.updatedAt && pb2.w === 480, "Use my photo in the detail replaces it: new bytes, newer timestamp");
    await page.waitForTimeout(2500);
    assert(sync.log.filter(l => /^PUT \/v1\/photo\/k-photo-beach/.test(l)).length === 2 && sync.photos["k-photo-beach"].length === pb2.size, "and the replacement goes up to the Worker too");
    assert(errors.length === 0, "add with photo: no page errors (" + errors.join(" | ") + ")");

    // a second linked device fetches the missing photo in the background
    const two = await newPage(browser, url, { width: 390, sync, init: () => { localStorage.setItem("goc.sync", JSON.stringify({ url: "https://sync.test.workers.dev", key: "k".repeat(40), remoteUpdatedAt: null })); } });
    await two.page.waitForSelector(".row", { timeout: 20000 });
    await two.page.waitForFunction(() => document.querySelector('#row-stevenson .pic img')?.src.startsWith("blob:"), null, { timeout: 15000 }).catch(() => {});
    assert((await two.page.locator('#row-stevenson .pic img').getAttribute("src") || "").startsWith("blob:") && sync.log.filter(l => /^GET \/v1\/photo\/stevenson/.test(l)).length >= 1, "another linked device pulls the settings, sees the photo listed, fetches it in the background and shows it");
    await two.page.waitForSelector("#row-k-killer-beach", { timeout: 10000 }).catch(() => {});
    assert((await two.page.locator("#row-k-killer-beach").count()) === 1 && (await two.page.locator('#row-k-killer-beach .pic img[src*="kites.jpg"]').count()) === 1, "the kept spot and its Commons photo came along in the settings");
    await two.page.waitForFunction(() => document.querySelector('#row-k-photo-beach .pic img')?.src.startsWith("blob:"), null, { timeout: 15000 }).catch(() => {});
    assert((await two.page.locator('#row-k-photo-beach .pic img').getAttribute("src") || "").startsWith("blob:") && sync.log.filter(l => /^GET \/v1\/photo\/k-photo-beach/.test(l)).length >= 1, "the spot added with a photo shows that photo on the other device too");
    // Remove photo on the second device: gone from the Worker, and the first device drops it on its next sync
    await two.page.click('button[data-open="stevenson"]'); await two.page.waitForSelector('#detail-stevenson [data-unphoto]');
    await two.page.click('#detail-stevenson [data-unphoto]'); await two.page.waitForTimeout(2500);
    assert(!sync.photos.stevenson && sync.log.some(l => /^DELETE \/v1\/photo\/stevenson/.test(l)) && !(sync.doc.settings.photos || {}).stevenson && (await two.page.locator('#row-stevenson .pic img').getAttribute("src")).endsWith("img/stevenson.jpg"), "Remove photo: deleted from the Worker, dropped from the settings list, built-in photo back");
    await page.evaluate(() => syncPull());
    await page.waitForFunction(() => (document.querySelector('#row-stevenson .pic img')?.src || "").endsWith("img/stevenson.jpg"), null, { timeout: 15000 }).catch(() => {});
    assert((await page.locator('#row-stevenson .pic img').getAttribute("src")).endsWith("img/stevenson.jpg") && (await page.evaluate(() => Object.keys(riderPhotos).sort().join())) === "k-photo-beach", "the first device drops it too on its next sync and restores the default; the added spot's photo stays");
    assert(errors.length === 0 && two.errors.length === 0, "two devices: no page errors (" + errors.concat(two.errors).join(" | ") + ")");
    await two.ctx.close(); await ctx.close();
  }

  /* ---------- 1c. units, the three-model median, the five-model spread, older caches, the three-model fallback ---------- */
  {
    // five models that disagree at every hour: best match 12, ECMWF 20, NBM 16 (median 16g19), GFS 30, ICON 8
    const five = (m, s, g) => d => { const h = d.hourly; h["wind_speed_10m_" + m] = h.time.map(() => s); h["wind_gusts_10m_" + m] = h.time.map(() => g); };
    const spread = n => { const a = F.openMeteo(n, () => ({ spd: 12, gst: 15, dir: 280 })); for (const d of a) { five("ecmwf_ifs025", 20, 24)(d); five("ncep_nbm_conus", 16, 19)(d); five("gfs_seamless", 30, 36)(d); five("icon_seamless", 8, 10)(d); } return a; };
    const { page, errors, log, ctx } = await newPage(browser, url, { forecast: spread });
    await page.waitForSelector(".row", { timeout: 20000 }); await page.waitForTimeout(800);
    assert(log.filter(l => /^models=/.test(l)).length === 1 && log.includes("models=best_match,ecmwf_ifs025,ncep_nbm_conus,gfs_seamless,icon_seamless"), "one Open-Meteo call asks for the five models");
    const wind1 = await first(page, ".row .wind");
    assert(/^16g19 kn /.test(wind1), "the row scores and shows the median of best match / ECMWF / NBM (12 / 20 / 16 -> 16g19), with its unit: " + wind1);
    assert(/16g19 kn /.test(await text(page, "#hero")) && /16g19 kn/.test(await text(page, "#narr")) && / · knots · /.test(await text(page, "#sub")), "hero, narrative and the header line carry the unit");
    const firstId = await page.getAttribute(".row", "id");
    await page.click(".row .head"); await page.waitForTimeout(200);
    let det = await text(page, "#" + firstId.replace("row-", "detail-"));
    assert(/Models\nModels say 8–30 kn; the score uses (NBM|the middle)$/im.test(det) && /Confidence\nModels disagree/i.test(det), "detail shows the five-model spread in one line and the Confidence verdict: " + (det.match(/Models\n[^\n]*/i) || [""])[0]);
    assert((/^hoodriver|stevenson|rufus$/.test(firstId.replace("row-", "")) ? /NBM, for/ : /3-model median, for/).test(det) && /in 16 kn/.test(det), "the next-hour tiles say what they are (NBM at a Gorge spot, else 3-model median) and the kite tile has its unit");
    assert(/Station reads|Wind measured now\n/i.test(det), "station rows still render");
    // Rider -> mph: display only, everything else unchanged
    await page.click("#openSettings"); await page.waitForSelector("#units button");
    assert((await page.getAttribute('#units button[data-u="kn"]', "aria-pressed")) === "true" && /32 kn/.test(await text(page, "#cl-maxWind")), "Rider sheet: knots selected by default, comfort chips in knots");
    await page.click('#units button[data-u="mph"]'); await page.waitForSelector('#units button[data-u="mph"][aria-pressed="true"]');
    assert(/37 mph/.test(await text(page, "#cl-maxWind")) && /39 mph/.test(await text(page, "#cl-maxGust")), "comfort chips convert (32 kn -> 37 mph, 34 kn -> 39 mph); the sliders stay in knots");
    assert((await page.evaluate(() => JSON.parse(localStorage.getItem("goc.settings")).units)) === "mph" && (await page.evaluate(() => JSON.parse(localStorage.getItem("goc.settings")).comfort.maxWind)) === 32, "units saved with the settings; stored limits still in knots");
    await page.click("#closeSheet"); await page.waitForTimeout(200);
    assert(/^18g22 mph /.test(await first(page, ".row .wind")) && /18g22 mph /.test(await text(page, "#hero")) && / · mph · /.test(await text(page, "#sub")), "rows, hero and header switch to mph (16 kn -> 18, 19 -> 22)");
    det = await text(page, "#" + firstId.replace("row-", "detail-"));
    assert(/Models say 9–35 mph; the score uses/i.test(det) && /in 18 mph/.test(det) && /18 mph/.test(det), "the open detail converts too (spread 8–30 kn -> 9–35 mph)");
    assert(/18g22 mph/.test(await page.locator(".row [data-share]").first().getAttribute("data-share")), "the share text carries the unit");
    const scoresKn = await page.evaluate(() => [...document.querySelectorAll(".row .score")].map(e => e.textContent));
    await page.reload(); await page.waitForSelector(".row", { timeout: 20000 }); await page.waitForTimeout(800);
    assert(/^18g22 mph /.test(await first(page, ".row .wind")) && JSON.stringify(await page.evaluate(() => [...document.querySelectorAll(".row .score")].map(e => e.textContent))) === JSON.stringify(scoresKn), "mph survives a reload; scores identical in either unit");
    await page.click("#openSettings"); await page.waitForSelector("#units button"); await page.click('#units button[data-u="kn"]'); await page.waitForTimeout(100); await page.click("#closeSheet"); await page.waitForTimeout(200);
    assert(/^16g19 kn /.test(await first(page, ".row .wind")), "and back to knots");
    assert(errors.length === 0, "units/models: no page errors (" + errors.join(" | ") + ")");
    await ctx.close();

    // an older cache (best match alone, GFS and ICON for confidence) and no `units` in the saved settings, with the forecast service down
    const SPOTS = require(path.join(ROOT, "spots.json"));
    const oldCache = `(() => { const T = ${JSON.stringify(F.openMeteo(1)[0].hourly.time)}; const c = v => T.map(() => v);
      const docs = ${JSON.stringify(SPOTS.map(s => s.id))}.map(id => ({ spotId: id, fetchedAt: new Date().toISOString(), time: T, spd: c(18), gst: c(22), dir: c(275), temp: c(60), pop: c(0), code: c(1), vis: c(20000), m: { gfs: { spd: c(10) }, icon: { spd: c(26) } } }));
      localStorage.setItem("goc.cache", JSON.stringify({ docs, fetchedAt: new Date().toISOString(), obs: {} }));
      localStorage.setItem("goc.settings", JSON.stringify({ home: "LO", radius: 90, style: "freeride", weightLb: 185, kites: [7, 9, 12, 14] })); })()`;
    const old = await newPage(browser, url, { init: oldCache, forecast: () => ({ status: 503 }) });
    await old.page.waitForSelector(".row", { timeout: 20000 }); await old.page.waitForTimeout(1200);
    assert(/^18g22 kn /.test(await first(old.page, ".row .wind")) && / · knots · /.test(await text(old.page, "#sub")), "older cache + no units setting: renders from the cache in knots");
    await old.page.click(".row .head"); await old.page.waitForTimeout(200);
    const odet = await text(old.page, "#" + (await old.page.getAttribute(".row", "id")).replace("row-", "detail-"));
    assert(/Models say 10–26 kn; the score uses best match/i.test(odet) && /model, for/.test(odet) && !/3-model|NBM, for/.test(odet), "legacy doc: best match + GFS + ICON vote, and the tiles don't claim a median or NBM: " + (odet.match(/Models\n[^\n]*/i) || [""])[0]);
    assert(old.log.filter(l => /^models=/.test(l)).length === 2 && old.log.filter(l => /^models=/.test(l)).every(l => /best_match/.test(l)), "five-model call rejected (503) -> one retry with the three models -> the cache stays on screen");
    assert(old.errors.length === 0, "older cache: no page errors (" + old.errors.join(" | ") + ")");
    await old.ctx.close();

    // the API rejects the five-model query (400): the page falls back to the three-model call and still scores
    let calls = 0;
    const three = n => { const a = F.openMeteo(n); for (const d of a) for (const k of Object.keys(d.hourly)) if (/ecmwf|nbm/.test(k)) delete d.hourly[k]; return a; };
    const fb = await newPage(browser, url, { forecast: n => (++calls === 1 ? { status: 400 } : three(n)) });
    await fb.page.waitForSelector(".row", { timeout: 20000 }); await fb.page.waitForTimeout(800);
    assert(calls === 2 && fb.log.includes("models=best_match,gfs_seamless,icon_seamless") && /^18g22 kn /.test(await first(fb.page, ".row .wind")), "400 on the five-model call -> three-model call -> scored as before");
    await fb.page.click(".row .head"); await fb.page.waitForTimeout(200);
    const fdet = await text(fb.page, "#" + (await fb.page.getAttribute(".row", "id")).replace("row-", "detail-"));
    assert(/Models say 18 kn; the score uses best match/i.test(fdet) && /Models agree/.test(fdet), "three identical models: 'Models say 18 kn; the score uses best match', Models agree");
    assert(fb.errors.length === 0, "fallback: no page errors (" + fb.errors.join(" | ") + ")");
    await fb.ctx.close();
  }

  /* ---------- 1d. the selected day: detail rows, sort labels, hero format, station scoring only today ---------- */
  {
    // Day keys as the page builds them (LA calendar days from today); names computed here, not read back from the page.
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const key = d => new Date(Date.parse(today + "T12:00:00Z") + d * 864e5).toISOString().slice(0, 10);
    const short = d => new Date(key(d) + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
    const long = d => new Date(key(d) + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    const dayOf = day => Math.round((Date.parse(day + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 864e5);
    // Within 1h30 of Lake Oswego only Stevenson (point 0) and Hood River (point 1) qualify. Today Stevenson blows (20g24, the freeride peak), Hood River is light (12);
    // tomorrow the reverse; the day after Stevenson again; the last two days both 18. W all week.
    const byDay = n => F.openMeteo(n, (i, h, day) => { const d = dayOf(day); const s = i === 0 ? [20, 12, 20, 18, 18][d] : i === 1 ? [12, 20, 12, 18, 18][d] : 18; return { spd: s, gst: s + 4, dir: 270 }; });
    // A fresh, trusted station 1.8 mi from Stevenson reading 5 kn against the 20 kn forecast: a disagreement, today only.
    const obs = { fetchedAt: new Date().toISOString(), obs: { stevenson: [{ id: "TEST1", name: "Test station", kind: "nws", dist_mi: 1.8, time: new Date(Date.now() - 10 * 60000).toISOString(), spd: 5, gst: 7, dir: 270 }] } };
    const { page, errors, ctx } = await newPage(browser, url, { forecast: byDay, obs });
    await page.waitForSelector(".row", { timeout: 20000 }); await page.waitForTimeout(800);
    const sortBtn = k => page.locator(`[data-sort="${k}"]`);
    const detailOf = async () => text(page, "#" + (await page.getAttribute(".row", "id")).replace("row-", "detail-"));
    const openFirst = async () => { if ((await page.getAttribute(".row .head", "aria-expanded")) !== "true") { await page.click(".row .head"); await page.waitForTimeout(200); } };

    // today
    assert((await text(page, '#days button[aria-pressed="true"]')).startsWith("Today"), "today is selected on load");
    assert((await sortBtn("score").innerText()) === short(0) && (await sortBtn("tomorrow").innerText()) === short(1) && (await sortBtn("tomorrow").isVisible()) && (await sortBtn("distance").innerText()) === "Distance", `sort buttons read ${short(0)} / ${short(1)} / Distance with today selected`);
    assert((await sortBtn("score").getAttribute("aria-pressed")) === "true", "the day sort is pressed by default");
    const hero0 = await text(page, "#hero");
    assert(new RegExp(`^\\d+\\.\\d\nBest bet · ${short(0)} · within 1h30\nStevenson\n`, "i").test(hero0), "hero: score, then 'BEST BET · " + short(0).toUpperCase() + " · WITHIN 1H30', then Stevenson on top today: " + hero0.split("\n").slice(0, 3).join(" | "));
    assert((await page.getAttribute(".row", "id")) === "row-stevenson" && /Station reads 5 kn/.test(await first(page, ".row .wind")), "today's list: Stevenson first, with the 'Station reads 5 kn' chip (station 5 kn vs the 20 kn forecast hour): " + JSON.stringify(await first(page, ".row .wind")));
    await openFirst(); let det = await detailOf();
    assert(new RegExp(`^${long(0)}, hour by hour\n`, "i").test(det), `the chart is titled '${long(0)}, hour by hour': ` + det.split("\n")[0]);
    assert(/Wind measured now\n5 kn gusting 7 from the W/i.test(det) && /Wind forecast · next hour/i.test(det) && /Wind forecast · in 3 hours/i.test(det) && /Wind forecast · in 5 hours/i.test(det), "today's detail keeps 'Wind measured now' and the next-hour / 3-hour / 5-hour rows");
    assert(!/morning ·|midday ·|afternoon ·|Lead time/i.test(det), "and has no morning / midday / afternoon rows or lead-time line");
    assert(/Station disagrees:/.test(det) && /Today's score uses the station/.test(det) && /the best 3-hour stretch today;/.test(det), "'Station disagrees' is shown and says today's score uses the station");

    // tomorrow
    await page.click("#days button >> nth=1"); await page.waitForTimeout(300);
    assert((await sortBtn("score").innerText()) === short(1) && (await sortBtn("tomorrow").innerText()) === short(2) && (await sortBtn("tomorrow").isVisible()), `tomorrow selected: sort buttons read ${short(1)} / ${short(2)}`);
    const hero1 = await text(page, "#hero");
    assert(new RegExp(`^\\d+\\.\\d\nBest bet · ${short(1)} · within 1h30\nHood River`, "i").test(hero1), "hero keeps the one format and names tomorrow's best (Hood River): " + hero1.split("\n").slice(0, 3).join(" | "));
    assert((await page.getAttribute(".row", "id")) === "row-hoodriver" && !/Station reads/.test(await text(page, "#list")), "tomorrow's list: Hood River first; no 'Station reads' chip on any row");
    await openFirst(); det = await detailOf();
    assert(new RegExp(`^${long(1)}, hour by hour\n`, "i").test(det), `chart titled '${long(1)}, hour by hour'`);
    assert(!/Wind measured|next hour|in 3 hours|in 5 hours|Station disagrees/i.test(det), "tomorrow's detail has no station row, no next-hour rows, no 'Station disagrees'");
    const block = new RegExp(`${short(1)} morning · 7a–10a\n20 kn gusting 24 from the W ?\n(?:3-model median|NBM), ${long(1)} 7a–10a average\n${short(1)} midday · 11a–2p\n20 kn gusting 24 from the W ?\n[^\n]*\n${short(1)} afternoon · 3p–6p\n20 kn gusting 24 from the W`, "i");
    assert(block.test(det), `morning / midday / afternoon rows for ${long(1)} (median model, gusts, direction): ` + (det.match(new RegExp(`${short(1)} morning[^]*?average`, "i")) || [""])[0].replace(/\n/g, " | "));
    assert(/Lead time\nTomorrow: hour-by-hour timing is usually good\./i.test(det), "lead-time line for tomorrow");
    assert(new RegExp(`the best 3-hour stretch ${long(1)};`).test(det), "the best-window row names the day");
    assert(!/Models agree/.test(await first(page, ".row .wind")) && /Confidence\nModels agree/i.test(det), "identical models: no confidence chip on the tile (the spread can't move the score), the detail keeps the Confidence row");
    // the second sort button: the day after the selected one
    await sortBtn("tomorrow").click(); await page.waitForTimeout(300);
    { const id = await page.getAttribute(".row", "id"), w = await first(page, ".row .wind"), sk = await page.evaluate(() => JSON.parse(localStorage.getItem("goc.settings")).sort);
      assert(id === "row-stevenson" && new RegExp(`${short(2)} \\d+\\.\\d`).test(w) && sk === "tomorrow", `'${short(2)}' sorts by ${long(2)}'s score (Stevenson first) and shows that day's score chip; stored key still 'tomorrow' (${id}, ${JSON.stringify(w)}, ${sk})`); }
    assert((await page.locator(".row .score").first().innerText()) === (await page.evaluate(() => { const r = computeAll().find(x => x.spot.id === "stevenson"); return r.r.score.toFixed(1); })), "the tile's main score is still the selected day's");

    // two and three days out
    await page.click("#days button >> nth=2"); await page.waitForTimeout(300); await openFirst(); det = await detailOf();
    assert(/Lead time\n2–3 days out: expect the window to shift an hour or two\./i.test(det) && new RegExp(`${short(2)} morning · 7a–10a`, "i").test(det), "two days out: '2–3 days out' lead line, rows labelled " + short(2));
    assert((await sortBtn("score").innerText()) === short(2) && (await sortBtn("tomorrow").innerText()) === short(3), `sort buttons read ${short(2)} / ${short(3)}`);

    // the last forecast day
    await page.click("#days button >> nth=4"); await page.waitForTimeout(300);
    assert((await sortBtn("score").innerText()) === short(4) && (await sortBtn("tomorrow").isHidden()) && (await sortBtn("distance").isVisible()), `last day: first button reads ${short(4)}, the second is hidden, Distance stays`);
    assert((await sortBtn("score").getAttribute("aria-pressed")) === "true" && (await page.evaluate(() => JSON.parse(localStorage.getItem("goc.settings")).sort)) === "tomorrow", "with no next day the day sort is pressed; the stored key is untouched");
    assert(!new RegExp(`\\b(${short(0)}|${short(1)}|${short(2)}|${short(3)}|${short(4)}|${short(5)}) \\d+\\.\\d`).test(await text(page, "#list")), "no next-day score chips on the last day");
    await openFirst(); det = await detailOf();
    assert(/Lead time\n4–5 days out: trust the pattern, not the hour\./i.test(det) && new RegExp(`^${long(4)}, hour by hour`, "i").test(det), "last day: '4–5 days out' lead line, chart titled with the day");
    assert(new RegExp(`^\\d+\\.\\d\nBest bet · ${short(4)} · within 1h30\n`, "i").test(await text(page, "#hero")), "hero format holds on the last day");
    // nothing qualifies: same hero layout
    await page.evaluate(() => { settings.radius = 30; render(); }); await page.waitForTimeout(200);
    const heroN = await text(page, "#hero");
    assert(new RegExp(`^–\nBest bet · ${short(4)} · within 30 min\nNothing worth the drive\n(Further out: Stevenson scores \\d+\\.\\d at 1h05\\.|No spot in the forecast scores above 4 on ${long(4)}\\.)`, "i").test(heroN), "nothing in range: same layout (score slot, label, name, line), 'Nothing worth the drive': " + heroN.split("\n").slice(0, 4).join(" | "));
    await page.click("#days button >> nth=0"); await page.waitForTimeout(300);
    assert((await sortBtn("tomorrow").isVisible()) && (await sortBtn("tomorrow").innerText()) === short(1) && (await sortBtn("tomorrow").getAttribute("aria-pressed")) === "true", "back on today the second button returns, labelled " + short(1) + ", pressed again since the stored sort is still 'tomorrow'");
    assert(errors.length === 0, "selected day: no page errors (" + errors.join(" | ") + ")");
    await ctx.close();
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
