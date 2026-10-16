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
export const NOMINATIM = [
  { place_id: 1, lat: "32.7174", lon: "-117.1628", display_name: "San Diego, San Diego County, California, United States" },
  { place_id: 2, lat: "32.7157", lon: "-117.1611", display_name: "San Diego, CA, USA" },
];

// One Open-Meteo multi-location answer for `n` points, `days` days, built from a per-hour function. Shape as the page parses it.
export function openMeteo(n, fn = () => ({}), days = 5, start = new Date()) {
  const d0 = start.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const time = []; for (let d = 0; d < days; d++) { const day = new Date(new Date(d0 + "T12:00:00Z").getTime() + d * 864e5).toISOString().slice(0, 10); for (let h = 0; h < 24; h++) time.push(`${day}T${String(h).padStart(2, "0")}:00`); }
  const loc = (i) => {
    const hourly = { time }; const cols = { wind_speed_10m: [], wind_gusts_10m: [], wind_direction_10m: [], temperature_2m: [], precipitation_probability: [], weather_code: [], visibility: [] };
    time.forEach((t, k) => { const v = { spd: 18, gst: 22, dir: 270, temp: 66, pop: 5, code: 1, vis: 24000, ...fn(i, +t.slice(11, 13), t.slice(0, 10), k) }; cols.wind_speed_10m.push(v.spd); cols.wind_gusts_10m.push(v.gst); cols.wind_direction_10m.push(v.dir); cols.temperature_2m.push(v.temp); cols.precipitation_probability.push(v.pop); cols.weather_code.push(v.code); cols.visibility.push(v.vis); });
    for (const [k, a] of Object.entries(cols)) { hourly[k + "_best_match"] = a; hourly[k + "_gfs_seamless"] = a.map(x => x == null ? null : x); hourly[k + "_icon_seamless"] = a.map(x => x == null ? null : x); }
    return { latitude: 0, longitude: 0, hourly, current: { time: time[12], wind_speed_10m_best_match: 15, wind_gusts_10m_best_match: 19, wind_direction_10m_best_match: 270, temperature_2m_best_match: 64, weather_code_best_match: 1 } };
  };
  return Array.from({ length: n }, (_, i) => loc(i));
}
export function marine(n, days = 5, start = new Date()) {
  const base = openMeteo(1, () => ({}), days, start)[0].hourly.time;
  return Array.from({ length: n }, () => ({ hourly: { time: base, wave_height: base.map(() => 1.0), wave_period: base.map(() => 11), wave_direction: base.map(() => 280), swell_wave_height: base.map(() => 0.8), swell_wave_period: base.map(() => 12) } }));
}
