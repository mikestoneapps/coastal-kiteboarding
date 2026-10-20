// Mock answers for the services the away-from-home mode calls, shaped like the real ones.
// Used by away/test.mjs (Node) and away/browser-test.mjs (headless browser with the network intercepted).
// The build container can't reach Overpass, Open-Meteo, Nominatim or Commons, so everything here is invented:
// the area is "Sandy Cove", a stretch of coast near San Diego. The spot list itself now comes from away-spots.json
// (precomputed by away_spots.py); `awayFile()` below turns an Overpass answer into that file the way the Python does.

export const HERE = { name: "San Diego", lat: 32.77, lon: -117.25 };   // ~900 mi from both houses

// Overpass `out center tags` result: kitesurf/windsurf tags plus named beaches, with the traps the parser must handle.
export const OVERPASS_SPOTS = {
  version: 0.6, generator: "mock", elements: [
    { type: "node", id: 101, lat: 32.7700, lon: -117.2500, tags: { sport: "kitesurfing;windsurfing", name: "Sandy Cove Kite Beach", surface: "sand" } },
    { type: "node", id: 102, lat: 32.7705, lon: -117.2505, tags: { natural: "beach", name: "Sandy Cove" } },              // same place as 101: dropped, the launch wins
    { type: "node", id: 103, lat: 32.8300, lon: -117.3000, tags: { sport: "kitesurfing" } },                               // unnamed launch -> "Kite launch"; 2.7 mi off the coastline, so its facing stays unknown
    { type: "way", id: 204, center: { lat: 32.7000, lon: -117.2600 }, tags: { natural: "beach", name: "South Strand", surface: "sand" } },
    { type: "node", id: 105, lat: 32.9000, lon: -117.2600, tags: { natural: "beach", name: "Private Cove", access: "private" } },   // skipped
    { type: "node", id: 106, lat: 32.9100, lon: -117.2700, tags: { natural: "beach" } },                                   // unnamed beach: skipped (query filters these too)
    { type: "node", id: 107, lat: 32.7600, lon: -117.1000, tags: { sport: "windsurfing", name: "Bay Windsurf Launch", description: "flat water inside the bay" } },
    { type: "relation", id: 308, center: { lat: 32.6500, lon: -117.1500 }, tags: { natural: "beach", name: "Border Field Beach" } },
  ]
};
// 60 named beaches up the coast on top of the above: the parser must keep every sport spot and cap the list at 40.
export const OVERPASS_MANY = { elements: OVERPASS_SPOTS.elements.concat(Array.from({ length: 60 }, (_, i) => ({ type: "node", id: 1000 + i, lat: 33.0 + i * 0.02, lon: -117.3, tags: { natural: "beach", name: "Beach " + i } }))) };
export const OVERPASS_EMPTY = { version: 0.6, generator: "mock", elements: [] };

// away-spots.json as away_spots.py writes it from an Overpass answer: id = type letter + id, name, 4-decimal coordinates,
// only the tags the page reads; private features dropped, unnamed beaches dropped, unnamed sport features kept.
const KEEP_TAGS = ["sport", "natural", "surface", "description", "access", "fee", "name:en"];
export function awayFile(overpass, generatedAt = "2026-10-12T10:13:00Z") {
  const spots = [];
  for (const e of overpass.elements) {
    const t = e.tags || {}; if (t.access === "private" || t.access === "no") continue;
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon; if (lat == null || lon == null) continue;
    const sport = /kitesurf|kiteboard|windsurf/i.test(t.sport || ""), name = t.name || t["name:en"];
    if (!name && !sport) continue;
    const tags = {}; for (const k of KEEP_TAGS) if (t[k]) tags[k] = t[k];
    const s = { id: e.type[0] + e.id, lat: +(+lat).toFixed(4), lon: +(+lon).toFixed(4), tags }; if (name) s.name = name;
    spots.push(s);
  }
  return { generatedAt, source: "OpenStreetMap (Overpass), ODbL", count: spots.length, spots };
}
// The catalogue is worldwide: these far-away entries must never show up near San Diego.
const ELSEWHERE = [
  { type: "node", id: 9001, lat: 45.7093, lon: -121.5003, tags: { sport: "kitesurfing;windsurfing", name: "Hood River Event Site" } },
  { type: "node", id: 9002, lat: 35.2254, lon: -75.6233, tags: { natural: "beach", name: "Cape Hatteras Beach" } },
  { type: "node", id: 9003, lat: 28.6, lon: -13.9, tags: { sport: "kitesurfing", name: "Flag Beach" } },
];
export const AWAY_FILE = awayFile({ elements: OVERPASS_SPOTS.elements.concat(ELSEWHERE) });
export const AWAY_FILE_MANY = awayFile({ elements: OVERPASS_MANY.elements.concat(ELSEWHERE) });
export const AWAY_FILE_EMPTY = awayFile(OVERPASS_EMPTY);
export const AWAY_FILE_FAR = awayFile({ elements: ELSEWHERE });   // a real file with nothing near here

// Overpass `out geom` result for the shoreline query. OSM coastline ways run with the water on the right:
// this one runs north -> south, so the sea is to the west of it. The lake is a natural=water closed way.
export const OVERPASS_SHORE = {
  elements: [
    { type: "way", id: 501, tags: { natural: "coastline" }, geometry: [{ lat: 32.95, lon: -117.253 }, { lat: 32.80, lon: -117.253 }, { lat: 32.65, lon: -117.265 }] },
    // a small lake whose south shore is just north of the bay launch (107): the water lies north of that shore
    { type: "way", id: 502, tags: { natural: "water", water: "lake" }, geometry: [{ lat: 32.762, lon: -117.105 }, { lat: 32.762, lon: -117.095 }, { lat: 32.772, lon: -117.095 }, { lat: 32.772, lon: -117.105 }, { lat: 32.762, lon: -117.105 }] },
  ]
};
export const OVERPASS_CAMS = {
  elements: [
    { type: "node", id: 601, lat: 32.775, lon: -117.252, tags: { man_made: "surveillance", "surveillance:type": "webcam", name: "Sandy Cove surf cam", website: "https://example.org/sandycove-cam" } },
    { type: "node", id: 602, lat: 33.4, lon: -117.6, tags: { man_made: "surveillance", "surveillance:type": "webcam", website: "https://example.org/far-cam" } },     // too far from everything
    { type: "node", id: 603, lat: 32.771, lon: -117.251, tags: { man_made: "surveillance", "surveillance:type": "webcam" } },                                            // no link: useless
  ]
};
export const COMMONS = {
  query: { pages: {
    "1": { pageid: 1, index: 1, title: "File:Sandy Cove tall.jpg", imageinfo: [{ thumburl: "https://upload.wikimedia.org/x/tall.jpg", width: 300, height: 400, descriptionurl: "https://commons.wikimedia.org/wiki/File:Sandy_Cove_tall.jpg", extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, Artist: { value: "<a href='x'>Someone</a>" } } }] },   // portrait: skipped
    "2": { pageid: 2, index: 2, title: "File:Sandy Cove wide.jpg", imageinfo: [{ thumburl: "https://upload.wikimedia.org/x/wide.jpg", width: 640, height: 427, descriptionurl: "https://commons.wikimedia.org/wiki/File:Sandy_Cove_wide.jpg", extmetadata: { LicenseShortName: { value: "All rights reserved" }, Artist: { value: "Nope" } } }] },   // not free: skipped
    "3": { pageid: 3, index: 3, title: "File:Sandy Cove kites.jpg", imageinfo: [{ thumburl: "https://upload.wikimedia.org/x/kites.jpg", width: 640, height: 427, descriptionurl: "https://commons.wikimedia.org/wiki/File:Sandy_Cove_kites.jpg", extmetadata: { LicenseShortName: { value: "CC BY 2.0" }, Artist: { value: "<a href='x'>Jane Doe</a>" } } }] },
  } }
};
// A fuller geosearch answer (categories included, as the page now asks for them): the nearest hit is a rose, then beach photos of
// three shapes, a map, a sign, a portrait, an unfree one and one with no categories at all. pickCommonsPhoto must choose by keywords.
const cpage = (id, title, w, h, lic, cats, artist = "Jane Doe") => [id, { pageid: +id, index: +id, title: "File:" + title, ...(cats ? { categories: cats.map(c => ({ ns: 14, title: "Category:" + c })) } : {}), imageinfo: [{ thumburl: "https://upload.wikimedia.org/x/" + title.toLowerCase().replace(/[^a-z0-9.]+/g, "-"), width: w, height: h, descriptionurl: "https://commons.wikimedia.org/wiki/File:" + title.replace(/ /g, "_"), extmetadata: { LicenseShortName: { value: lic }, Artist: { value: artist } } }] }];
export const COMMONS_SCORED = { query: { pages: Object.fromEntries([
  cpage("1", "Rose in Balboa Park.jpg", 640, 427, "CC BY-SA 4.0", ["Flowers of California", "Balboa Park"]),                          // nearest, but a flower: -1
  cpage("2", "Mission Beach boardwalk.jpg", 640, 427, "CC BY 2.0", ["Beaches of San Diego", "Mission Bay (San Diego)"]),               // 3
  cpage("3", "Ocean Beach pier at sunset.jpg", 640, 427, "CC BY 2.0", ["Piers in California", "Ocean Beach, San Diego"]),             // 6: the pick
  cpage("4", "Mission Beach panorama.jpg", 4000, 600, "CC BY 2.0", ["Beaches of San Diego", "Mission Bay (San Diego)"]),             // 3, but 6.7:1
  cpage("5", "Mission Beach boardwalk big.jpg", 3000, 2000, "CC BY 2.0", ["Beaches of San Diego", "Mission Bay (San Diego)"]),       // 3, 3:2, bigger than 2
  cpage("6", "Lifeguard tower map.png", 800, 600, "Public domain", ["Maps of San Diego"]),                                          // -2
  cpage("7", "Beach parking sign.jpg", 640, 427, "CC BY 2.0", ["Road signs in California", "Beaches of San Diego"]),                   // 0: not positive
  cpage("8", "Surfer at Ocean Beach.jpg", 400, 600, "CC BY 2.0", ["Beaches of San Diego"]),                                           // portrait: skipped
  cpage("9", "Ocean Beach aerial.jpg", 640, 427, "All rights reserved", ["Beaches of San Diego"]),                                    // not free: skipped
  cpage("10", "Ocean Beach lifeguards.jpg", 640, 427, "CC BY 2.0", null),                                                              // 2 from the title alone (no categories)
]) } };
export const NOMINATIM = [
  { place_id: 1, lat: "32.7174", lon: "-117.1628", display_name: "San Diego, San Diego County, California, United States" },
  { place_id: 2, lat: "32.7157", lon: "-117.1611", display_name: "San Diego, CA, USA" },
];

// One Open-Meteo multi-location answer for `n` points, `days` days (seven, like the page asks for), built from a per-hour function. Shape as the page parses it,
// including daily sunrise/sunset suffixed per model the way a multi-model answer comes back (07:33 / 18:20 Pacific: the scored hours are then the 8a..5p slots).
export const SUNRISE = "07:33", SUNSET = "18:20";
export function openMeteo(n, fn = () => ({}), days = 7, start = new Date()) {
  const d0 = start.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const time = []; for (let d = 0; d < days; d++) { const day = new Date(new Date(d0 + "T12:00:00Z").getTime() + d * 864e5).toISOString().slice(0, 10); for (let h = 0; h < 24; h++) time.push(`${day}T${String(h).padStart(2, "0")}:00`); }
  const loc = (i) => {
    const hourly = { time }; const cols = { wind_speed_10m: [], wind_gusts_10m: [], wind_direction_10m: [], temperature_2m: [], precipitation_probability: [], weather_code: [], visibility: [] };
    time.forEach((t, k) => { const v = { spd: 18, gst: 22, dir: 270, temp: 66, pop: 5, code: 1, vis: 24000, ...fn(i, +t.slice(11, 13), t.slice(0, 10), k) }; cols.wind_speed_10m.push(v.spd); cols.wind_gusts_10m.push(v.gst); cols.wind_direction_10m.push(v.dir); cols.temperature_2m.push(v.temp); cols.precipitation_probability.push(v.pop); cols.weather_code.push(v.code); cols.visibility.push(v.vis); });
    for (const [k, a] of Object.entries(cols)) for (const m of ["best_match", "gfs_seamless", "icon_seamless", "ecmwf_ifs025", "ncep_nbm_conus"]) hourly[k + "_" + m] = m === "best_match" ? a : a.map(x => x == null ? null : x);
    const dayList = [...new Set(time.map(t => t.slice(0, 10)))], daily = { time: dayList };
    for (const m of ["best_match", "gfs_seamless", "icon_seamless", "ecmwf_ifs025", "ncep_nbm_conus"]) { daily["sunrise_" + m] = dayList.map(d => `${d}T${SUNRISE}`); daily["sunset_" + m] = dayList.map(d => `${d}T${SUNSET}`); }
    return { latitude: 0, longitude: 0, hourly, daily, current: { time: time[12], wind_speed_10m_best_match: 15, wind_gusts_10m_best_match: 19, wind_direction_10m_best_match: 270, temperature_2m_best_match: 64, weather_code_best_match: 1 } };
  };
  return Array.from({ length: n }, (_, i) => loc(i));
}
export function marine(n, days = 7, start = new Date()) {
  const base = openMeteo(1, () => ({}), days, start)[0].hourly.time;
  return Array.from({ length: n }, () => ({ hourly: { time: base, wave_height: base.map(() => 1.0), wave_period: base.map(() => 11), wave_direction: base.map(() => 280), swell_wave_height: base.map(() => 0.8), swell_wave_period: base.map(() => 12) } }));
}

// NOAA CO-OPS tide predictions (api.tidesandcurrents.noaa.gov datagetter, product=predictions, time_zone=lst_ldt, units=english) for the
// query the page sends: interval=h gives one row per hour, interval=hilo the highs and lows with their exact minute. A 12.42 h sine
// around 4.5 ft (range 0.5–8.5), so each day has two highs and two lows; `station` offsets the phase so the three stations differ.
export function tides(params) {
  const P = typeof params === "string" ? new URL(params).searchParams : params;
  const begin = String(P.get("begin_date") || ""), range = +(P.get("range") || 24), station = String(P.get("station") || "0");
  const d0 = `${begin.slice(0, 4)}-${begin.slice(4, 6)}-${begin.slice(6, 8)}`;
  const phase = (+station.slice(-2) % 12) / 12 * 2 * Math.PI, T = 12.42, A = 4, mid = 4.5;
  const level = h => mid + A * Math.sin(2 * Math.PI * h / T + phase);
  const stamp = h => { const d = new Date(Date.parse(d0 + "T00:00:00Z") + Math.round(h * 60) * 60000); return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`; };
  if (P.get("interval") === "hilo") {
    const out = [];
    for (let k = 0; ; k++) { const peak = (Math.PI / 2 - phase) / (2 * Math.PI) * T + k * T / 2; if (peak >= range) break; if (peak >= 0) out.push({ t: stamp(peak), v: level(peak).toFixed(3), type: level(peak) > mid ? "H" : "L" }); }
    return { predictions: out };
  }
  return { predictions: Array.from({ length: range + 1 }, (_, h) => ({ t: stamp(h), v: level(h).toFixed(3) })) };
}
