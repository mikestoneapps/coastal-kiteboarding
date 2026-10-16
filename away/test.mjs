// `node away/test.mjs` — the page's away-from-home block (index.html, "away from home" section) run under Node
// against a mock away-spots.json and mock OpenStreetMap / Open-Meteo / Commons answers from away/fixtures.mjs. No network.
// Checks: the away trigger, filtering the catalogue by radius and de-duplication, facing from the shoreline, the inferred
// direction rules feeding the scorer, webcams and photos, and the discover() state machine (found / empty / missing / error).
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as F from "./fixtures.mjs";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scoring = require(path.join(ROOT, "scoring.js"));
let fails = 0;
const assert = (c, m) => { if (!c) { fails++; console.error("FAIL:", m); } else console.log("ok  ", m); };

/* ---------- load the page's block into a sandbox ---------- */
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const a = html.indexOf("/* ---------- kept spots ---------- */"), b = html.indexOf("/* ---------- settings sync");
assert(a > 0 && b > a && html.slice(a, b).includes("/* ---------- away from home (SPEC §5) ---------- */"), "found the page's kept-spots + away block");
const hav = html.match(/function haversineMi\(.*\n/)[0];
const HOMES = { LO: { name: "Lake Oswego", lat: 45.4207, lon: -122.6706, key: "driveLO" }, BC: { name: "Pacific City", lat: 45.2020, lon: -123.9627, key: "driveBC" } };
function sandbox(net = {}) {
  const store = {};
  const S = {
    console: { log: console.log, error: console.error, warn: () => {} }, Date, Math, Object, Array, Number, String, JSON, Promise, setTimeout, clearTimeout, isNaN, encodeURIComponent, AbortController, Error,
    HOMES, settings: { home: "X", custom: { ...F.HERE }, radius: 90, kept: [], overrides: {}, updatedAt: null }, forecasts: {}, openSpot: null, syncState: { key: null },
    GLYPH: "<svg/>", esc: s => String(s), compass: scoring.compass, mins: m => m + "m", renders: 0,
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    document: { querySelector: () => null, getElementById: () => null }, CSS: { escape: s => s },
    saveSettings() {}, refreshAll() { S.refreshed = (S.refreshed || 0) + 1; }, keepSheet(pre) { S.sheetPre = pre; }, render() { S.renders++; },
    driveMins: s => Math.round(S.haversineMi(F.HERE.lat, F.HERE.lon, s.plat, s.plon) * 1.35 / 47 * 60 / 5) * 5,
    allSpots() { return S.settings.kept.concat(S.awaySpots()); },
    fetchJSON: async url => { if (net.json) return net.json(url); throw new Error("no network in tests"); },
    fetch: async (url, opts) => {
      const body = opts && opts.body ? decodeURIComponent(String(opts.body).replace(/^data=/, "")) : "";
      if (/^away-spots\.json/.test(String(url))) { S.fileFetches = (S.fileFetches || 0) + 1; const f = net.file ? await net.file() : null; if (f === null || f === undefined) throw new Error("Failed to fetch"); if (f.status) return { ok: false, status: f.status, json: async () => ({}) }; return { ok: true, status: 200, json: async () => f }; }
      const r = net.fetch ? await net.fetch(url, body) : null;
      if (r === undefined || r === null) throw new Error("no network in tests");
      if (r.status && r.status !== 200) return { ok: false, status: r.status, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => r };
    },
    fetchForecasts: async list => { if (!net.forecast) throw new Error("Open-Meteo down"); return net.forecast(list); },
  };
  vm.createContext(S);
  vm.runInContext(hav + html.slice(a, b), S);
  return S;
}

/* ---------- 1. the trigger ---------- */
{
  const S = sandbox();
  assert(S.awayMode() === true, "San Diego (home = Elsewhere) is away mode");
  assert(Math.round(S.milesFromHomes(F.HERE.lat, F.HERE.lon)) > 800, "San Diego is 800+ mi from both houses");
  S.settings.custom = { name: "Seaside", lat: 45.9932, lon: -123.9226 };
  assert(S.awayMode() === false, "Seaside is not away mode (within 150 mi of a house)");
  S.settings.custom = { name: "Bend", lat: 44.0582, lon: -121.3153 };
  assert(S.awayMode() === false, "Bend (≈130 mi from Lake Oswego) is not away mode");
  S.settings.custom = { name: "Boise", lat: 43.615, lon: -116.2 };
  assert(S.awayMode() === true, "Boise (≈340 mi) is away mode");
  S.settings.home = "LO";
  assert(S.awayMode() === false && S.awaySpots().length === 0, "home base Lake Oswego is never away mode; awaySpots() is empty");
  S.settings.home = "X"; S.settings.custom = { ...F.HERE }; S.settings.radius = 90;
  assert(S.searchMiles() === 52, "drive radius 1h30 -> 52 straight-line miles (47 mph, 1.35 road factor)");
  S.settings.radius = 360; assert(S.searchMiles() === 120, "search radius caps at 120 mi");
  S.settings.radius = 30; assert(S.searchMiles() === 30, "search radius floors at 30 mi");
}

/* ---------- 2. picking from the catalogue ---------- */
{
  const S = sandbox();
  const got = S.pickAway(F.AWAY_FILE, F.HERE.lat, F.HERE.lon, 52);
  const names = got.map(x => x.name);
  assert(!names.some(n => /Hood River|Hatteras|Flag Beach/.test(n)), "entries outside the radius (worldwide catalogue) are left out");
  assert(S.pickAway(F.AWAY_FILE, F.HERE.lat, F.HERE.lon, 7).length === 3 && S.pickAway(F.AWAY_FILE, 45.7093, -121.5003, 30).map(x => x.name).join() === "Hood River Event Site", "the radius is straight-line miles from the rider; the same file serves any area");
  assert(names.includes("Sandy Cove Kite Beach") && !names.includes("Sandy Cove"), "a tagged launch wins over the beach it sits on (0.75 mi de-dup)");
  assert(names.includes("Kite launch"), "an unnamed kitesurf node is kept as 'Kite launch'");
  assert(names.includes("South Strand") && names.includes("Border Field Beach"), "ways and relations use their centre");
  assert(!names.includes("Private Cove"), "access=private is skipped");
  assert(got.length === 5, `5 candidates from the fixture (got ${got.length}: ${names.join(", ")})`);
  const sc = got.find(x => x.name === "Sandy Cove Kite Beach");
  assert(sc.kind === "Kite spot" && sc.osm === "n101" && sc.notes === "OpenStreetMap: kitesurfing, windsurfing · sand surface" && sc.mi === 0, "kind, OSM id, notes and distance are filled in");
  assert(got.find(x => x.name === "Bay Windsurf Launch").kind === "Windsurf spot" && got.find(x => x.name === "South Strand").kind === "Beach", "windsurf-only is a 'Windsurf spot', natural=beach is a 'Beach'");
  assert(got.every((x, i) => i === 0 || x.mi >= got[i - 1].mi), "sorted by distance");
  const many = S.pickAway(F.AWAY_FILE_MANY, F.HERE.lat, F.HERE.lon, 120);
  assert(many.length === 40 && many.filter(x => x.sport).length === 3, "capped at 40 with every sport-tagged spot kept");
  assert(S.pickAway(F.AWAY_FILE_EMPTY, 0, 0, 120).length === 0 && S.pickAway(null, 0, 0, 120).length === 0 && S.pickAway({ spots: "junk" }, 0, 0, 120).length === 0, "empty, missing and malformed files pick nothing");
  const spot = S.toAwaySpot(sc);
  assert(spot.id === "a-n101" && spot.auto === true && spot.facing === null && JSON.stringify(spot.dir) === JSON.stringify(S.sectorsFromFacing(0)) === false && JSON.stringify(spot.dir) === `{"best":[],"work":[[0,360]],"off":[]}` && spot.waves === true && spot.photo === false && spot.driveLO > 600, "toAwaySpot: a- id, auto, facing unknown, estimated drives from both houses");
}

/* ---------- 3. facing from the shoreline ---------- */
{
  const S = sandbox();
  const ways = F.OVERPASS_SHORE.elements;
  const west = S.facingFor({ lat: 32.77, lon: -117.25 }, ways);
  assert(west && west.source === "coastline" && Math.abs(west.facing - 270) < 8, `coastline running N->S: the beach faces W (got ${west && west.facing})`);
  const flipped = S.facingFor({ lat: 32.77, lon: -117.25 }, [{ type: "way", tags: { natural: "coastline" }, geometry: [...ways[0].geometry].reverse() }]);
  assert(flipped && Math.abs(flipped.facing - 90) < 8, `the same line drawn S->N faces E (water on the right): ${flipped && flipped.facing}`);
  const lake = S.facingFor({ lat: 32.760, lon: -117.100 }, ways);
  assert(lake && lake.source === "water" && (lake.facing < 8 || lake.facing > 352), `lake: south shore faces N toward the water (got ${lake && lake.facing})`);
  const inside = S.facingFor({ lat: 32.7705, lon: -117.1035 }, [ways[1]]);   // just inside the west shore of the lake
  assert(inside && Math.abs(inside.facing - 90) < 8, `lake west shore faces E (got ${inside && inside.facing})`);
  assert(S.facingFor({ lat: 32.77, lon: -117.10 }, [ways[0]]) === null, "a shoreline 8 mi away says nothing");
  const both = S.facingFor({ lat: 32.7615, lon: -117.1 }, ways);
  assert(both && both.source === "water", "nearest shoreline wins (lake 0.03 mi vs coast 8 mi)");
  // applyFacing on parsed spots
  const spots = S.pickAway(F.AWAY_FILE, F.HERE.lat, F.HERE.lon, 52).map(S.toAwaySpot);
  const n = S.applyFacing(spots, F.OVERPASS_SHORE);
  const sc = spots.find(s => s.id === "a-n101"), bay = spots.find(s => s.id === "a-n107"), far = spots.find(s => s.id === "a-n103");
  assert(n >= 3 && Math.abs(sc.facing - 270) < 8 && sc.facingSrc === "coastline" && sc.waves === true, "Sandy Cove: faces W off the coastline, ocean beach");
  assert(bay.facing === 0 && bay.facingSrc === "water" && bay.waves === false, "bay launch: faces N off the lake, no surf forecast");
  assert(far.facing === null && JSON.stringify(far.dir) === `{"best":[],"work":[[0,360]],"off":[]}`, "a spot with no shoreline nearby keeps 'unknown' rules");
  assert(JSON.stringify(sc.dir) === JSON.stringify(S.sectorsFromFacing(sc.facing)), "direction sectors come from sectorsFromFacing, same as kept spots");
  // and the scorer uses them
  assert(scoring.dirScore(270, sc.dir).v === 1 && scoring.dirScore(94, sc.dir).gate === "Offshore" && scoring.dirScore(200, sc.dir).v === 0.75, "W-facing: W wind best, E wind offshore gate, SSW works");
  assert(scoring.dirScore(90, far.dir).v === 0.75 && !scoring.dirScore(90, far.dir).gate, "unknown facing: every direction 'works' (0.75), nothing gates");
}

/* ---------- 4. webcams and photos ---------- */
{
  const S = sandbox();
  const spots = S.pickAway(F.AWAY_FILE, F.HERE.lat, F.HERE.lon, 52).map(S.toAwaySpot);
  const n = S.applyCams(spots, F.OVERPASS_CAMS);
  const sc = spots.find(s => s.id === "a-n101");
  assert(n >= 1 && sc.cam && sc.cam.url === "https://example.org/sandycove-cam" && sc.cam.name === "Sandy Cove surf cam" && sc.cam.mi < 1, "nearest linked webcam within 8 mi is attached");
  assert(!spots.find(s => s.id === "a-n107").cam, "a spot with no cam within 8 mi gets none");
  const p = S.pickCommonsPhoto(F.COMMONS);
  assert(p && p.url.endsWith("kites.jpg") && p.credit === "Sandy Cove kites.jpg: Jane Doe (CC BY 2.0)", "Commons: first landscape, free-licensed image, credit without HTML");
  assert(S.pickCommonsPhoto({}) === null, "no Commons hits -> null");
  // photo relevance: keywords in the title and categories decide; ties go to the 3:2 frame, then the bigger image; nothing positive -> no photo
  const ks = S.photoKeywordScore;
  assert(ks("Kitesurfing at Windansea") === 1 && ks("Windsurfing off the jetties") === 2 && ks("Bayocean Spit shoreline") === 2 && ks("Beaches of San Diego County") === 1 && ks("Playa del Carmen waterfront") === 2, "positive words count once per word; plurals and compounds (kitesurfing, windsurfing, jetties, shoreline, bayocean, waterfront) included");
  assert(ks("Season ticket, Carlsbad, maple, research, design, surface, plateau, Pierre") === 0, "no false hits on season / Carlsbad / maple / research / design / surface / plateau / Pierre");
  assert(ks("Seagull on a car") === -1 && ks("Road signs in California") === -1 && ks("Beach parking sign") === 0 && ks("Seabirds at Ocean Beach") === 1 && ks("Churches in Pacific City") === -1, "negative words subtract; a seabird is a bird, not a sea");
  const pages = F.COMMONS_SCORED.query.pages, only = (...ids) => ({ query: { pages: Object.fromEntries(Object.entries(pages).filter(([k]) => ids.includes(k))) } }), without = (...ids) => only(...Object.keys(pages).filter(k => !ids.includes(k)));
  const P = S.pickCommonsPhoto(F.COMMONS_SCORED);
  assert(P && P.url.endsWith("ocean-beach-pier-at-sunset.jpg") && P.credit === "Ocean Beach pier at sunset.jpg: Jane Doe (CC BY 2.0)" && /File:Ocean_Beach_pier/.test(P.page), "the most beach-like candidate wins over the nearest one (a rose), a sign and a map");
  assert(S.pickCommonsPhoto(without("3")).url.endsWith("boardwalk-big.jpg"), "same keywords and shape: the bigger image wins");
  assert(S.pickCommonsPhoto(without("3", "5")).url.endsWith("mission-beach-boardwalk.jpg"), "same keywords: the 3:2 frame beats the panorama");
  assert(S.pickCommonsPhoto(only("1", "6", "7")) === null, "a flower, a map and a sign (0 or below): no photo, the neutral tile stays");
  assert(S.pickCommonsPhoto(only("8")) === null && S.pickCommonsPhoto(only("9")) === null, "a keyworded portrait and an unfree image are still skipped");
  assert(S.pickCommonsPhoto(only("10")).url.endsWith("lifeguards.jpg"), "no categories at all: the title alone can carry it");
}
{
  let seen = ""; const S = sandbox({ fetch: async url => { seen = String(url); return F.COMMONS_SCORED; } });
  const p = await S.commonsPhoto(32.77, -117.25);
  assert(p && p.url.endsWith("ocean-beach-pier-at-sunset.jpg") && /ggscoord=32\.77\|-117\.25/.test(seen) && /ggsradius=1500/.test(seen) && /ggslimit=20/.test(seen) && /prop=imageinfo\|categories/.test(seen) && /clshow=!hidden/.test(seen) && /iiurlwidth=640/.test(seen), "commonsPhoto asks for 20 candidates within 1.5 km with their non-hidden categories: " + seen.slice(0, 120));
}

/* ---------- 5. discover(): found / empty / missing / error, forecasts merged, cache ---------- */
{
  const calls = [];
  const S = sandbox({
    file: async () => F.AWAY_FILE,
    fetch: async (url, body) => { calls.push(body.slice(0, 40)); if (/surveillance/.test(body)) return F.OVERPASS_CAMS; if (/coastline/.test(body)) return F.OVERPASS_SHORE; throw new Error("unexpected Overpass query: " + body.slice(0, 60)); },
    forecast: async list => ({ docs: list.map(s => ({ spotId: s.id, fetchedAt: "now", time: ["2026-10-17T12:00"], spd: [18] })), fetchedAt: "now" }),
  });
  S.maybeDiscover();
  assert(S.away.status === "idle" && S.away.key === "32.77,-117.25", "maybeDiscover keys the area and schedules a search");
  await new Promise(r => setTimeout(r, 400));
  assert(["scoring", "done"].includes(S.away.status) && S.away.spots.length === 5, "the list is up (names, distances) before scores");
  await new Promise(r => setTimeout(r, 300));
  assert(S.away.status === "done" && S.away.spots.every(s => S.forecasts[s.id]), "done: one batched forecast call covered every discovered spot");
  assert(Math.abs(S.away.spots.find(s => s.id === "a-n101").facing - 270) < 8 && S.away.spots.find(s => s.id === "a-n101").facingSrc === "coastline", "facing applied from the background shoreline lookup");
  assert(S.fileFetches === 1 && JSON.parse(S.localStorage.getItem("goc.awayspots")).spots.length === 9, "the catalogue was fetched once and cached in localStorage with a date");
  assert(S.renders >= 3, `rendered on search, on list, on scores (${S.renders} renders)`);
  const cached = JSON.parse(S.localStorage.getItem("goc.cache"));
  assert(cached.away && cached.away["32.77,-117.25"].spots.length === 5 && cached.docs.length === 5, "results and forecasts cached per area in goc.cache");
  await new Promise(r => setTimeout(r, 100));
  assert(S.away.spots.find(s => s.id === "a-n101").cam && S.away.spots.find(s => s.id === "a-n101").photoUrl === undefined, "background: webcam attached; photo lookup needs Commons (fetchJSON mocked away here)");
  // same place, a wider radius -> re-search; narrower -> no re-search
  const before = calls.length, files = S.fileFetches; S.settings.radius = 60; S.maybeDiscover(); await new Promise(r => setTimeout(r, 50));
  assert(calls.length === before, "a smaller drive radius doesn't search again");
  S.settings.radius = 240; S.maybeDiscover(); await new Promise(r => setTimeout(r, 400));
  assert(calls.length > before && S.away.radiusMi === 120 && S.fileFetches === files, "a wider drive radius searches again, from the cached catalogue (no refetch)");
  // keep a discovered spot: facing known -> saved at once, forecast carried over, no refetch
  await new Promise(r => setTimeout(r, 300));
  S.keepDiscovered("a-n101");
  const k = S.settings.kept[0];
  assert(k && k.id === "k-sandy-cove-kite-beach" && Math.abs(k.facing - 270) < 8 && k.facingSrc === "coastline" && k.osm === "n101" && k.cam && k.kept === true && S.forecasts[k.id] && !S.refreshed, "Keep this spot: kept with inferred rules, OSM id and cam; forecast copied, no refetch");
  assert(!S.away.spots.some(s => s.id === "a-n101"), "a kept spot leaves the discovered list");
  S.keepDiscovered("a-n103");
  assert(S.sheetPre && S.sheetPre.name === "Kite launch" && S.sheetPre.lat === 32.83 && S.sheetPre.carry.forecastFrom === "a-n103", "unknown facing: Keep opens the sheet prefilled so he picks the facing");
  // a fresh page for the same area starts from the cache
  const S2 = sandbox({ forecast: async list => ({ docs: [] }) }); S2.localStorage.setItem("goc.cache", S.localStorage.getItem("goc.cache"));
  S2.settings.radius = 90; S2.maybeDiscover();
  assert(S2.away.status === "done" && S2.away.spots.length === 4 && S2.away.note === "cached", "reopening the same area is instant from the cache");
}
{
  const S = sandbox({ file: async () => F.AWAY_FILE_FAR, forecast: async () => ({ docs: [] }) });
  await S.discover(S.awayKey(), 52);
  assert(S.away.status === "empty" && S.away.spots.length === 0 && /No spots found here yet/.test(S.awayBanner()) && /list updated Oct 12/.test(S.awayBanner()) && /Add a spot by hand/.test(S.awayBanner()), "nothing in the catalogue near here: 'no spots found here yet' with the list date and add-by-hand");
}
{
  const S = sandbox({ file: async () => F.AWAY_FILE_EMPTY, forecast: async () => ({ docs: [] }) });
  await S.discover(S.awayKey(), 52);
  assert(S.away.status === "empty" && /No spots found here yet/.test(S.awayBanner()), "an empty catalogue: the same 'no spots found' banner");
  assert(S.localStorage.getItem("goc.awayspots") === null, "an empty catalogue is not cached (the next search fetches again)");
}
{
  const S = sandbox({ file: async () => ({ status: 404 }), forecast: async () => ({ docs: [] }) });
  await S.discover(S.awayKey(), 52);
  assert(S.away.status === "empty" && /No spots found here yet/.test(S.awayBanner()) && /Add a spot by hand/.test(S.awayBanner()), "away-spots.json missing (404, workflow not run yet): 'no spots found' banner, not an error");
}
{
  const S = sandbox({ forecast: async () => ({ docs: [] }) });   // no network at all
  await S.discover(S.awayKey(), 52);
  assert(S.away.status === "error" && /Couldn't load the spot list/.test(S.awayBanner()) && /Add a spot by hand/.test(S.awayBanner()), "offline: clear error state with Search again and add-by-hand");
  S.localStorage.setItem("goc.awayspots", JSON.stringify({ at: new Date().toISOString(), spots: F.AWAY_FILE.spots }));
  await S.discover(S.awayKey(), 52);
  assert(S.away.status === "done" && S.away.spots.length === 5, "offline with a cached catalogue: the list still comes up");
  S.localStorage.setItem("goc.awayspots", JSON.stringify({ at: "2026-01-01T00:00:00Z", spots: F.AWAY_FILE.spots }));
  await S.discover("x", 52);
  assert(S.away.status === "error", "a catalogue cached more than 7 days ago is refetched, not reused");
}
{
  const S = sandbox({ file: async () => F.AWAY_FILE, fetch: async (u, body) => { if (/coastline/.test(body)) return F.OVERPASS_SHORE; return { status: 504 }; } });   // Open-Meteo down
  await S.discover(S.awayKey(), 52);
  assert(S.away.status === "done" && S.away.note === "noforecast" && /Couldn't get a forecast/.test(S.awayBanner()) && /no forecast yet/.test(S.pendingRow(S.away.spots[0])), "Open-Meteo down: spots listed without scores and the banner says so");
}
{
  // Overpass down: the list and scores land anyway; the spots stay "auto, facing unknown"
  const S = sandbox({ file: async () => F.AWAY_FILE, fetch: async () => ({ status: 504 }), forecast: async list => ({ docs: list.map(s => ({ spotId: s.id, fetchedAt: "now", time: ["2026-10-17T12:00"], spd: [18] })) }) });
  await S.discover(S.awayKey(), 52);
  await new Promise(r => setTimeout(r, 50));
  assert(S.away.status === "done" && S.away.spots.length === 5 && S.away.spots.every(s => S.forecasts[s.id]) && S.away.spots.every(s => s.facing === null && JSON.stringify(s.dir) === `{"best":[],"work":[[0,360]],"off":[]}`), "Overpass down on both mirrors: scored anyway, every spot 'facing unknown', no error state");
  assert(/5 spots within 52 mi/.test(S.awayBanner()) && /list updated Oct 12/.test(S.awayBanner()), "banner shows the count and the catalogue date");
}
{
  // Overpass slow: scores never wait for the shoreline; facing lands later and re-renders once
  let release; const slow = new Promise(r => { release = r; });
  const S = sandbox({ file: async () => F.AWAY_FILE, fetch: async (u, body) => { if (/coastline/.test(body)) { await slow; return F.OVERPASS_SHORE; } return F.OVERPASS_CAMS; }, forecast: async list => ({ docs: list.map(s => ({ spotId: s.id, fetchedAt: "now", time: ["2026-10-17T12:00"], spd: [18] })) }) });
  await S.discover(S.awayKey(), 52);
  assert(S.away.status === "done" && S.away.spots.every(s => s.facing === null), "done with scores while the shoreline lookup is still out");
  const renders = S.renders; release(); await new Promise(r => setTimeout(r, 50));
  assert(Math.abs(S.away.spots.find(s => s.id === "a-n101").facing - 270) < 8 && S.renders === renders + 1 && JSON.parse(S.localStorage.getItem("goc.cache")).away["32.77,-117.25"].spots.find(s => s.id === "a-n101").facing !== null, "late shoreline answer: facing applied, one re-render, cache updated");
  assert(S.away.spots.find(s => s.id === "a-n101").cam, "then the webcam lookup ran");
}
{
  const S = sandbox({ json: async () => F.NOMINATIM });
  const ps = await S.geocode("San Diego");
  assert(ps.length === 2 && ps[0].name === "San Diego, San Diego County" && ps[0].lat === 32.7174 && ps[0].lon === -117.1628, "Nominatim answer -> short name + coordinates");
}
{
  const S = sandbox(); S.settings.home = "LO";
  assert(S.awayBanner() === "" && S.awaySpots().length === 0, "home mode: no banner, no discovered spots, maybeDiscover is a no-op");
  S.maybeDiscover(); assert(S.away.status === "idle" && S.away.key === null, "maybeDiscover at home does nothing");
}

console.log(fails ? `\n${fails} away test(s) FAILED` : "\nall away tests passed");
process.exit(fails ? 1 : 0);
