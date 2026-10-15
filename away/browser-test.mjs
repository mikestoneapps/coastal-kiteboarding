// `node away/browser-test.mjs [--live]` — drives index.html in headless Chromium (Playwright).
// Default: every external host is intercepted and answered from away/fixtures.mjs, so it runs offline and
// deterministically. Home mode is compared against a second copy of the page (BASELINE_DIR, e.g. `main`'s
// index.html) to prove nothing changed there. `--live` lets Open-Meteo, Overpass, Nominatim and Commons
// through for the real check (pending: the build container can't reach them, see docs/BUILD-PLAN.md).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as F from "./fixtures.mjs";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = process.argv.includes("--live");
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
function mock(page, opts = {}) {
  const log = [];
  page.route(/.*/, async route => {
    const u = route.request().url(), body = route.request().postData() || "";
    const json = (o, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(o) });
    if (/\/obs\.json/.test(u)) return json({ obs: {} });   // station readings arrive at their own pace; keep the comparison deterministic
    if (u.startsWith("http://127.0.0.1")) return route.continue();
    if (LIVE && !/fonts\.|api\.weather\.gov/.test(u)) return route.continue();
    log.push(u.split("?")[0] + (body ? " " + body.slice(0, 30) : ""));
    if (/api\.open-meteo\.com/.test(u)) { const n = (new URL(u).searchParams.get("latitude") || "").split(",").length; return json(forecastFor(n)); }
    if (/marine-api\.open-meteo\.com/.test(u)) { const n = (new URL(u).searchParams.get("latitude") || "").split(",").length; return json(F.marine(n)); }
    if (/overpass/.test(u)) { if (opts.overpass === "down") return json({}, 504); if (/surveillance/.test(body)) return json(F.OVERPASS_CAMS); if (/coastline/.test(body)) return json(F.OVERPASS_SHORE); return json(opts.overpass === "empty" ? F.OVERPASS_EMPTY : F.OVERPASS_SPOTS); }
    if (/commons\.wikimedia\.org/.test(u)) return json(F.COMMONS);
    if (/upload\.wikimedia\.org/.test(u)) return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64") });
    if (/nominatim/.test(u)) return json(F.NOMINATIM);
    return route.abort();   // fonts, NWS, anything else: the page must cope
  });
  return log;
}
async function newPage(browser, url, opts) {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 860 }, geolocation: opts && opts.geo, permissions: opts && opts.geo ? ["geolocation"] : [] });
  const page = await ctx.newPage();
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
    assert(!log.some(l => /overpass|nominatim|commons/.test(l)), "home: no OpenStreetMap, Nominatim or Commons calls");
    assert(errors.length === 0, "home: no page errors (" + errors.join(" | ") + ")");
    const mine = { list: await text(page, "#list"), hero: await text(page, "#hero"), narr: await text(page, "#narr"), sub: await text(page, "#sub") };
    await page.click("#homeBC"); await page.waitForTimeout(200); mine.bc = await text(page, "#list");
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
    // Elsewhere within Oregon: still home behaviour (no discovery), just estimated drives
    await page.click("#homeX"); await page.waitForSelector("#plFind");
    assert((await page.locator("#plq").count()) === 1, "Elsewhere sheet has the place-name search");
    await page.click('#places button[data-p="Newport"]'); await page.click("#plSave"); await page.waitForTimeout(300);
    assert((await page.locator("#away").count()) === 0 && !log.some(l => /overpass/.test(l)), "Elsewhere = Newport (within 150 mi): no discovery, curated list as before");
    assert(errors.length === 0, "still no page errors");
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
    assert(log.filter(l => /api\.open-meteo/.test(l)).length >= 2 && log.filter(l => /overpass/.test(l)).length >= 2, "one Overpass search + one shoreline query + one batched forecast");
    assert(!names.some(n => /Manzanita|Rufus/.test(n)), "curated Oregon spots are beyond the radius, not in the list");
    assert(/15 more spots beyond|more spots beyond/.test(await text(page, "#beyond")), "the curated spots are counted as 'beyond'");
    assert(/Best bet|Nothing worth the drive/i.test(await text(page, "#hero")), "hero renders in away mode");
    // open Sandy Cove: auto paragraph, Keep button, cam link
    await page.click('button[data-open="a-n101"]'); await page.waitForSelector("#detail-a-n101 .actions");
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
    assert(/last search/.test(await text(page, "#away")) && log.filter(l => /overpass/.test(l)).length === logN, "reopening the same area uses the cached search, no new Overpass call");
    assert(errors.length === 0, "away: no page errors (" + errors.join(" | ") + ")");
    await ctx.close();
  }

  /* ---------- 3. away mode by GPS; nothing on OSM; OSM down ---------- */
  {
    const { page, errors, ctx } = await newPage(browser, url, { geo: { latitude: 32.77, longitude: -117.25 }, overpass: "empty" });
    await page.waitForSelector(".row", { timeout: 20000 });
    await page.click("#homeX"); await page.waitForSelector("#plGPS"); await page.click("#plGPS");
    await page.waitForSelector("#away", { timeout: 10000 });
    await page.waitForFunction(() => /No spots found here yet/.test(document.querySelector("#away")?.textContent || ""), null, { timeout: 10000 });
    assert(true, "GPS 900 mi from home -> away mode; empty Overpass -> 'No spots found here yet'");
    assert((await page.locator("#awayHand").count()) === 1 && (await page.locator(".row").count()) === 0 && (await page.locator(".empty").count()) === 0, "empty state: add-by-hand offered, no rows, no 'widen the slider' message");
    await page.click("#awayHand"); await page.waitForSelector("#ksKeep");
    await page.fill("#ksname", "Hand Beach"); await page.fill("#ksll", "32.80, -117.26"); await page.click('#ksface button[data-deg="270"]'); await page.click("#ksKeep");
    await page.waitForSelector("#row-k-hand-beach", { timeout: 10000 });
    assert((await page.locator("#row-k-hand-beach").count()) === 1, "a spot added by hand (name + coordinates + facing) shows up and gets scored");
    assert(errors.length === 0, "empty state: no page errors (" + errors.join(" | ") + ")");
    await ctx.close();
  }
  {
    const { page, errors, ctx } = await newPage(browser, url, { geo: { latitude: 32.77, longitude: -117.25 }, overpass: "down" });
    await page.waitForSelector(".row", { timeout: 20000 });
    await page.click("#homeX"); await page.waitForSelector("#plGPS"); await page.click("#plGPS");
    await page.waitForFunction(() => /Couldn't reach OpenStreetMap/.test(document.querySelector("#away")?.textContent || ""), null, { timeout: 15000 });
    assert((await page.locator("#awayAgain").count()) === 1 && (await page.locator("#awayHand").count()) === 1, "Overpass down on both mirrors: clear error with Search again + Add by hand");
    assert(errors.length === 0, "error state: no page errors (" + errors.join(" | ") + ")");
    await ctx.close();
  }
} finally {
  await browser.close(); server.close(); if (base) base.server.close();
}
console.log(fails ? `\n${fails} browser check(s) FAILED` : "\nall browser checks passed");
process.exit(fails ? 1 : 0);
