# Coastal Kiteboarding ("Bistué Boarding") — product spec

App name: Coastal Kiteboarding; the heading inside the app reads "Bistué Boarding". A kiteboarding spot-finder built as a 50th-birthday gift for a Portland rider with a second house in Pacific City, OR. One question, answered in one screen: **where should I go, today or in the next few days, and is it worth the drive?**

Prototype (claude.ai artifact, Oct 2026) validated the scoring model, spot list, checklist and layout. **A standalone version is live on GitHub Pages at https://mikestoneapps.github.io/coastal-kiteboarding/** (`index.html` in this folder; it fetches Open-Meteo and NWS stations directly in the browser, installs to the home screen via `manifest.webmanifest`, and must keep working throughout the build). This spec is the handoff to the production build.

**Suggested first steps for the build:** (1) hourly GitHub Action that fetches NOAA NDBC buoys (no CORS from the browser) + NWS stations into `obs.json`, and have index.html read it; (2) account-synced settings; (3) alerts job + push.

Files here: `index.html` (live site), `scoring.js` (scoring model, drop-in), `spots.json` (15 curated spots), `stations.json` (nearest public stations per spot), `stations.py` / `obs_standalone.py` (station observation fetchers, NDBC + NWS), `fetch_forecast.py` (Open-Meteo reference), `checklist-defaults.json`, `img/` + `credits.json`, `manifest.webmanifest` + icons.

---

## 1. Users and jobs

- **Primary user:** one experienced rider, ~50, iPhone, based in Lake Oswego with a coast house in Pacific City. Rides the Columbia Gorge and the north/central Oregon coast. Travels.
- **Job 1 — Today:** "I have the afternoon. Where's the best session within my drive radius right now?"
- **Job 2 — Planning:** "Next 3–5 days, which day and which spot look best? How confident is the forecast?"
- **Job 3 — Alerts:** "Tell me when somewhere nearby is going to be great so I can clear my calendar."
- **Job 4 — Away:** "I'm in San Diego (or anywhere). Same question, same app, with no setup."

Non-goals: session tracking / jump stats (Surfr, Hoolan own that), social features, a spot wiki.

## 2. Screens

### 2.1 Home (the only screen that matters)
Top to bottom:
1. **Header** — app name, "Forecast 40 min ago" freshness stamp (flags >6 h as stale), **Refresh now** button.
2. **Home base selector** — segmented: *Lake Oswego · Pacific City · Elsewhere*. Elsewhere = current GPS location (ask permission) or a typed place; drive times and directions origin follow it.
3. **Day tabs** — Today, Tomorrow, then weekday names, seven days. The last two are tagged **trend** in the tab (and the detail's lead-time line says so): the models rarely agree that far out, so they are for planning the week, never for clearing a calendar, and alerts never cover them (§8).
4. **Best bet card** — the top-scoring spot within radius for the selected day: photo, score, name, wind summary (`18g24 NW`), best window (`2p–5p`), drive time, suggested kite size. If nothing scores ≥4 in radius but a later forecast day's best spot within radius scores ≥6, the card shows that day instead ("Nothing worth it Monday. Friday looks like the day: Rufus 9.6, 19g23 kn W, 11a–2p"; the best-scoring such day, earliest on a tie) and tapping it selects that day. Otherwise: "Nothing worth the drive," and if something scores ≥4 beyond radius, say so with its drive time.
5. **Controls** — riding style (*Freeride · Wave · Foil*), drive-radius slider (30 min–4 h, default 1h30 Today / 3 h planning).
6. **Ranked list** — one row per spot inside the radius, sorted by score then drive time. Row = photo tile with score badge · name · region · wind summary · window (a "Too light" row shows the day's peak instead: "peak 5 kn at 2p") · surf height · reason chip ("Offshore", "Too light", "Gusty", "Fog") · model-agreement chip (planning days only, and only when the spread crosses a score band, §3) · station chip today ("Station reads 8 kn" when it disagrees; "station 4h old" when the nearest reading is past the 2 h freshness limit and so not scored) · drive time. Below the list: "N more spots beyond 1h30 · show them."
7. **Row detail (tap to expand)** — hourly wind bars with gust whiskers and direction arrows, best window highlighted (a green tint), the night before sunrise and after sunset in a cool grey diagonal hatch with a sun / moon marker and the time on the hour axis ("☀ 7:25a", "☾ 6:15p") and a one-line legend under the chart (the hour either side of daylight is drawn grey: forecast, not scored); on coast spots a light **tide curve** under the bars with each high and low labelled with its time and height (NOAA CO-OPS predictions for the spot's nearest tide station, display only); Now (nearest station, with distance) / Forecast now / Window / Kite / Air / Surf / Confidence tiles; "what's holding it back" sentence; spot notes; parking; nearest **webcam** link with distance (if one was found, §6b); **Directions** (Google Maps or Apple Maps deep link with traffic, from the current home base); **Share** (native share sheet: "Heading to Manzanita Sat 1–5pm, 18g24 NW — directions: <maps link>", so a buddy gets the plan and the route in one tap); **Checklist for this spot**.
8. **Home-screen widget** — best-bet spot, score and window for today, plus the saved home base's name. Updates with the refresh. (A PWA cannot do this; it is the strongest reason to ship native iOS after the PWA.)
9. **Dock** — Checklist · Rider · Alerts · How it scores.

### 2.2 Sheets
- **Checklist** — Gear / Wear / Logistics sections, tick boxes that reset daily. Dynamic hints from the forecast ("Bring the 9m first; 18g24 forecast", "52°F air, water in the 50s"). Spot-specific auto-items (state-parks pass, Gorge day-use fee, "gas before the coast range"). **Edit mode:** add/remove items per section, restore defaults; edits persist to his account.
- **Rider** — two parts.
  - *Basics:* weight (lb), kites owned (m²). Kite suggestion = weight_kg × 2.175 ÷ wind_kn, snapped to nearest owned kite.
  - *Comfort profile (personal limits):* the style selector on Home says what kind of day he wants; this says what he is comfortable with. Sliders with sensible defaults, all optional: wind range he'll ride (min/max kn), max gust he'll tolerate (kn), max surf height (ft), minimum session length (h, replaces the fixed 3-hour window), and "I'll drive further for a great day" (extra radius allowed when score ≥ 8). Each limit can be overridden **per spot** from that spot's detail ("Manzanita: happy at 30 kn"; "Floras: only for 4+ hours"). Unknown preferences are the point: defaults are conservative and the app learns as he adjusts.
- **How it scores** — plain-language explanation plus a **weight slider per factor** (0 = ignored … 2 = double), reset button. Gates are not adjustable. Photo credits at the bottom.
- **Where are you?** (Elsewhere) — use current location, pick from recent/preset places, or paste coordinates.

### 2.3 Settings persistence
Rider profile, factor weights, checklist edits, saved spots, home bases, radius and style all sync to the user's account (server-side), not device storage. Prototype used localStorage; that was the one thing that didn't carry between his phone and laptop.

## 3. Scoring model (`scoring.js` — drop-in, validated on real data)

Every daylight hour at every spot gets a 0–10 score: from that day's sunrise to its sunset (Open-Meteo's `daily=sunrise,sunset`, carried on the forecast doc as `f.sun[day]`; an hour counts when its midpoint is in daylight, so 07:33–18:20 scores the 8a–5p slots and a June day 5a–8p; a cached doc without sun data falls back to the fixed 07:00–19:00). `daylightIdx()` in `scoring.js` and the page. The **day score is the best 3-hour window**, and that window is what the row shows.

**Hard gates** (score = 0, not adjustable): offshore wind for that spot · sustained ≥35 kn or gusts ≥38 kn · thunderstorms (WMO code ≥95).

**Factors**, each 0–1, combined as a weighted geometric mean (Π factor^weight × 10), so any one bad factor drags the score down and weight 0 removes a factor entirely:
1. **Wind speed** vs a style band — freeride 14–27 kn (peak 20), wave 14–24 (peak 19), foil 9–18 (peak 13). Linear ramps below/above; "Light"/"Strong"/"Too light"/"Too strong" reasons.
2. **Direction** vs the spot's sectors: `best` = 1.0, `work` = 0.75, else 0.4 ("Cross-off"), `off` = gate.
3. **Gusts** — gust/avg ≤1.3 clean; linear penalty to 0.3 at 1.9×; "Gusty" chip above 1.5×.
4. **Surf** (coast spots only) — wave style: <1.5 ft 0.7 ("Flat"), 1.5–7 ft 1.0, 7–9 ft 0.8, >9 ft 0.5. Freeride: ≤5 ft 1.0, ≤8 ft 0.8, else 0.5. Foil: ≤3 ft 1.0, ≤5 ft 0.75, else 0.5.
5. **Weather** — fog (codes 45/48 or visibility <1.6 km) ×0.5; precip probability >60 % ×0.85.

**Reason chip** = the lowest-weighted factor's label in the window, or the gate. In the row detail, expand the chip into a sentence that names the number and whose limit it is, OutDare-style: "Gusts 28 kn, over **your** 24 kn limit" vs "Offshore at this spot (E wind)". A limit that is the rider's is tappable to adjust; a limit that is the spot's is not.

**Which wind gets scored (Oct 2026).** Open-Meteo is asked for five models in the one call (`best_match`, `ecmwf_ifs025`, `ncep_nbm_conus`, `gfs_seamless`, `icon_seamless`). The speed and gust the scorer sees for every hour is the **median of best match, ECMWF and NBM** (`consensus()` in `scoring.js`, applied to the forecast doc right after the fetch, in the page and in `alerts/lib.mjs` alike; direction stays best match's; a model with no value for an hour drops out of that hour's median, and a doc with fewer than two of the three is left as best match). Why the median rather than best match alone: at the Gorge and the coast spots the single models routinely disagree by 5–10 kn for the same hour, and best match (the HRRR/NBM blend) is the outlier as often as any other. The median discards the outlier whichever side it falls on, so it is not inflation; it is the least surprising number, and it is what the observations are later compared against. Why not all five: GFS and ICON are the coarsest of the set here and would drag the median toward themselves on half the days; they vote on confidence only. Per-spot, per-model bias from `accuracy.jsonl` (§7, Phase 5) refines this once there is a month of data; see **Forecast bias** below.

**Per-spot model (Oct 2026).** A spot may name the series it scores on: `model: "median"` (the default above) or `"nbm"`. The three Gorge spots (Stevenson, Hood River, Rufus) are `"nbm"`: their wind is the gap wind, a pressure-gradient flow through a river canyon a few miles wide, which the 9–13 km global models (ECMWF, GFS, ICON, and best match where it leans on them) smooth away; NBM, which the NWS builds on the 3 km HRRR and the local forecasters' grids, resolves it. For those spots `consensus()` takes NBM's speed and gust for every hour it has one and the three-model median for any hour it lacks, so a missing model never blanks a day. The page, `scoring.js` and `alerts/lib.mjs` all apply it from the spot record, and the doc carries `basis: "nbm" | "median"` so the detail can say which ("the score uses NBM" / "the middle").

**Forecast bias (Phase 5, Oct 2026).** The hourly observations job runs `bias.py` after `accuracy.py`: for every curated spot and every series in the log (`bm`, `ecmwf`, `nbm`, `gfs`, `icon` and `median`) with at least 40 paired samples (a station reading under 2 h old beside that model's forecast for the same hour), the bias is the **median of observed − forecast** in knots, positive when the station has been reading higher than the model, written to `bias.json` as `{spotId: {model: {kn, n}}}` and committed with `obs.json`. The page fetches it same-origin in the background (never on the critical path; cached in `goc.cache` like the readings) and the alert job reads it from the checkout. `applyBias()` in `scoring.js` and the page's scoring block (parity-tested by `alerts/test.mjs`) adds the **chosen model's** bias, the series the doc scores on (`basis: "nbm"` at the Gorge spots, `"median"` elsewhere, best match for an older cached doc), to every hour's speed and gust before `dayScore()` runs, and only when **n ≥ 40 and |bias| ≥ 2 kn**; the same offset goes on the gust so the gust ratio is not distorted, and the wind never goes below 0. Thinner or smaller, the forecast is scored as it came, so with no `bias.json` nothing changes. The hourly chart, the hour rows and the tile's wind show the corrected series (what the score saw); the per-model spread stays raw. The spot detail says what the stations have been reading whenever there is an entry: "Manzanita has been running +4 kn vs forecast (n=61) · the score uses 4 kn more than the 3-model median forecast", or "· fewer than 40 readings, so the score leaves it" / "· under 2 kn, so the score leaves it". Open for later: weighting by station distance (the Tillamook stations are 8–20 mi from the beaches they stand in for), and dropping a model from the median where it is consistently worst.

**Confidence** (planning days) — compare best-window mean speed across all five models: spread within 4 kn "Models agree", 8 kn "Models mixed", else "Models disagree". The row detail always shows the row ("Models say 11–20 kn; the score uses the middle"). The chip on the tile is shown only when the spread crosses a score band: the best window is re-scored on the lowest model alone and on the highest alone, and the chip appears when those two scores differ by 2 or more (`models.swing`). A 4 kn spread at 25 kn changes nothing and stays quiet; the same spread at 12 kn is the difference between a session and none, and shows.

**Units.** Everything internal is knots: forecasts, station readings, comfort limits, alert thresholds, this file. The Rider sheet has a knots / mph switch (`settings.units`, default knots, synced like every other setting) that changes display only, and every wind figure on the page shows its unit.

Open questions for the rider after launch: the style bands, whether tide should become a factor (display-only today), and per-spot overrides (Manzanita runs ~10 mph hotter than neighbours).

## 4. Spot data model (`spots.json`)

```
id, name, region, lat, lon          // forecast point (just offshore is fine)
plat, plon, parking                 // parking pin + description
dir: { best:[[from,to]…], work:[…], off:[…] }   // compass sectors, degrees, wind FROM
waves: bool                         // pull marine forecast?
pass: bool                          // Oregon State Parks pass needed
model: "median" | "nbm"            // optional; which forecast series the score runs on (§3). "nbm" for the Gorge spots
stationRadiusMi: number             // optional; widens the station search from the default 25 mi (land) / 45 mi (buoys). Florence: 35
tideStation: "9437540"              // optional, coast spots: the nearest NOAA CO-OPS harmonic tide station (hourly predictions). Display only (§7)
notes                               // launch rules, hazards, local knowledge
driveLO, driveBC                    // typical minutes from each home base (curated; BC = the coast house, Pacific City since Oct 2026, key kept so saved settings still work)
photo: optional                     // see §6
```

**Rule: adding a spot requires only name + coordinates + direction sectors.** Everything else is optional and can be filled in later. Direction sectors are **pre-filled from coastline orientation** (onshore = facing the water ± 60°, offshore = the reverse) so a new spot is confirm-or-adjust, not a form.

Starter set: 15 spots — Gorge (Stevenson, Hood River Sandbar, Rufus), North Coast (Fort Stevens, Gearhart, Manzanita, Rockaway), Tillamook Bay (Bayocean Spit, Oceanside, Cape Lookout), Central Coast (Pacific City, Roads End, Newport S. Jetty, Florence S. Jetty), South Coast (Floras Lake). Direction rules and notes are drafted from spot guides, not local knowledge; the rider corrects them in-app.

## 5. Away-from-home mode

Triggered when the chosen home base is outside the home region (or GPS says so).

1. **Spot search** (~1–2 s): filter a precomputed OpenStreetMap catalogue (`away-spots.json`, refreshed weekly by a GitHub Actions job; `sport=kitesurfing|kiteboarding|windsurfing` worldwide plus named beaches in the US, Canada and Mexico) to the drive radius (haversine × 1.35 road factor ÷ 47 mph). Querying Overpass from the browser was tried first and dropped: public servers take 30+ s or fail. The list renders immediately with names, distances and neutral tiles. If OSM tagging is thin in an area, named beaches are the fallback catalogue — verify coverage in a few US regions during the build.
2. **Forecasts** (~1–3 s): one batched Open-Meteo call for all coordinates (the API accepts multiple lat/lon per request). Scores appear and the list re-sorts once.
3. **Direction rules** inferred from coastline orientation; rows marked **auto** so he knows they're inferred.
4. **Photos** load in the background (§6). Never re-sort for a photo.
5. **Keep**: tapping Keep saves the spot to his account with anything he adds; a San Diego trip builds a San Diego list that is there next time.
6. Last-seen results are cached per area so reopening is instant.

**Hard rule: no visual element may delay scores.** Target: spots visible <2 s, scores <4 s, photos trickle in afterwards.

## 6. Photos

- Curated spots ship with a 480×320 photo (`img/`, ~27 KB each; credits in `img/credits.json`, all CC/public domain from Wikimedia Commons — keep the credit line in How it scores).
- Any spot may have no photo. The tile then shows a neutral gradient with a wind glyph and the score badge; layout is identical.
- For discovered/added spots, look up Wikimedia Commons by coordinates (`geosearch` within ~1 km, landscape, CC-licensed) in the background, a few at a time, cached forever per spot. Use standard thumbnail widths (320/640) and a descriptive User-Agent; Commons rate-limits aggressively otherwise.
- He can replace any photo from his camera roll; kept spots store the photo permanently.

## 6b. Webcams

Same rule as photos: **background enrichment, never on the critical path.** When a spot is created or discovered, look for the nearest public webcam within ~8 mi and store the link, name and distance: Windfinder's webcam index, Windy.com webcams, surf-forecast.com cams, state DOT coastal/highway cams (ODOT TripCheck for Oregon), and any cam the rider adds by URL. Show it as a link ("Cam · Manzanita beach · 1.1 mi") in the row detail, opening in the browser; do not embed streams. Many spots will have none (Hood River Event Site currently has no public cam on Windfinder); the row simply omits the link. Re-check quarterly in the background since cams come and go.

## 7. Data pipeline

- **Forecasts:** Open-Meteo forecast API (models `best_match,gfs_seamless,icon_seamless,ecmwf_ifs025,ncep_nbm_conus` in one call; the score runs on the median of best match, ECMWF and NBM, §3; hourly `wind_speed_10m, wind_gusts_10m, wind_direction_10m, temperature_2m, precipitation_probability, weather_code, visibility`; `wind_speed_unit=kn`; `daily=sunrise,sunset` for the scored hours; 7 days, the last two shown as a trend; tz America/Los_Angeles) + Marine API (`wave_height, wave_period, wave_direction, swell_wave_height, swell_wave_period`). Free, no key. `fetch_forecast.py` is the working reference.
- **Live observations (v1):** forecasts and observations are both shown; observations are the trust signal. For every spot, resolve the nearest public wind stations at spot-creation time and store them with distance: NOAA NDBC buoys and C-MAN stations, NWS/METAR airports via api.weather.gov, CDIP wave buoys, WeatherFlow/Tempest public stations where an open feed exists. Show the nearest one or two in the row detail as "Garibaldi C-MAN · 4.2 mi · 14g19 NW · 10 min ago". Station trust: distance-graded (≤3 mi full weight, 3–10 mi partial, >10 mi informational only). **Disagreement flag:** when the nearest trusted station differs from the forecast's current-hour wind by >6 kn or >60°, show a chip on the row ("Station reads 8 kn") and in the best-bet card. Today's score blends the station reading into the current hour (station weight by trust) but planning days stay forecast-only.
- **Tides (display only, Oct 2026):** every coast spot names its nearest NOAA CO-OPS harmonic station (`tideStation`: Hammond 9439011 for the Columbia mouth, Garibaldi 9437540 from Manzanita to Pacific City, South Beach 9435380 from Roads End to Florence). After the scores are on screen the page fetches each station's hourly predictions and its highs/lows for the forecast span (`api.tidesandcurrents.noaa.gov`, `product=predictions`, MLLW, local time), once per day, cached in localStorage `goc.tides`, and draws the curve under the hourly chart. A station that doesn't answer changes nothing. Making tide a scoring factor is a Rider toggle for later (§11).
- **Accuracy log:** the hourly observations job also runs `accuracy.py`: for every curated spot whose nearest station has a reading under 2 h old, one line per run in `accuracy.jsonl` (spot, Pacific hour, observed knots, each of the five models' forecast for that hour from a fetch made in that run, and the median the score used), capped at 90 days and committed beside `obs.json`. Nothing reads it yet; after about four weeks Phase 5 computes per-spot, per-model bias from it and applies it.
- **Refresh:** server-side job hourly, 05:00–20:00 local (overnight runs are wasted), plus the **Refresh now** button (anyone using the app can trigger; debounce to one in-flight run). Store per-spot forecast documents with `fetchedAt`; the client subscribes and redraws when it changes.
- **Drive times:** curated minutes for home bases; live traffic via Google Maps Distance Matrix only when the user opens the app (not on every refresh), behind a server-side key. Directions = Maps deep link with current traffic.

## 8. Alerts and the weekly outlook (v1, the birthday feature)

**Delivery:** push notifications from the installed app (web push on the PWA; APNs if native). No phone number required. SMS via Twilio is an optional fallback the rider can turn on. Email for the weekly outlook only.

**One notification per run, never one per spot.** After each forecast refresh, evaluate every spot within the rider's alert radius for the next *lead time* days. If any qualify, send a single digest, best first: "Saturday looks great — Manzanita 9.1 (1h40), Rockaway 8.6 (1h35), Oceanside 8.2 (1h45). Window 1–6pm." Tapping opens Home on that day. A (spot, day) already alerted is not re-alerted unless its score moves by ≥2 or it drops below the threshold (then one "Saturday fell apart" notice).

**Rider-set parameters** (Alerts sheet, all with defaults): minimum score (default 8) · maximum drive from each home base (default = planning radius, 3 h) · days of the week he can go · delivery hour (default 7 pm, for tomorrow+; and a "same-day" toggle that allows a morning alert for today) · lead time (1–5 days, default 3; never the trend days 6–7) · minimum session length (from the comfort profile) · daily cap (default 1) · confidence gate (default on: only alert when models agree within 4 kn) · quiet hours (default 21:00–07:00) · "Tell me when it's already blowing" (default on, below).

**Blowing now (Oct 2026): the station's word, not the forecast's.** The observations job keeps the last six runs' nearest fresh station reading per spot in `obs-recent.json` (`obs_recent.py`; a reading counts when it is under 2 h old, the page's own rule). On each hourly run the alert job (`blowingNow()` in `alerts/lib.mjs`) fires for a spot when, on the **last two consecutive hourly runs** (30–150 min apart; a skipped hour breaks the streak), its nearest station read **inside the rider's wind range** (comfort min/max, per-spot override), **under his gust limit**, **from a best or work sector**, and the two readings are distinct (a station that has not updated between runs is one reading, not two). The latest reading must still be under 2 h old, in daylight when the forecast carries the day's sunrise and sunset, and the spot within the alert drive of a house; an `obs-recent.json` whose latest run is over 90 min old (the observations job did not run) never fires. Message, nearest house first, up to three spots in one line, in the rider's display unit: "Blowing now: Rockaway 18g22 kn NW at the TILLAMOOK station — 50 min from Pacific City." It rides in the **same single notification** as any forecast digest due that run, is subject to the **same daily cap, quiet hours and days-he-can-go**, is never held for the delivery hour (it is about now; the deep link opens today), and is said **once per blow**: the spot goes on the rider's "already alerted" state (`state.blowing`, stored by the sync Worker beside the forecast keys) and comes off when it stops qualifying, so a new blow later can be said again under the cap; an entry older than 24 h expires. The Alerts sheet shows the toggle with what the stations read this minute ("Reading in your range now: …"). Tests: `alerts/test.mjs` (fire, every no-fire reason, repeat suppression, the combined digest), `python3 test_obs_recent.py`.

**Weekly outlook email** (Sunday 6 pm, opt-in): one screen's worth. The narrative line for the week, a 7-day strip per home base showing the best spot and score each day, and the two or three days worth planning around. Plain HTML, links back into the app.

**Narrative line.** A one-sentence, auto-generated summary at the top of Home and the alert/email: built from rules over the scored data, not an LLM ("Thermal pattern holds through Friday; the Gorge is the call Saturday, coast goes offshore Sunday."). Also link iKitesurf's meteorologist-written Gorge forecast from the Gorge spots.

## 9. Platform and cost

- PWA (installs to home screen, web push on iOS 16.4+); native later only if push proves unreliable.
- Hosting + hourly job on a free tier (Vercel/Netlify/Cloudflare/Fly); DB free tier; Open-Meteo/NOAA/OSM/Commons free; Google Maps inside the $200/mo credit. Expected run cost ≈ $0–1/month + domain.
- No AI calls at runtime.

## 10. What the prototype settled (don't re-litigate)

- One ranked list beats a map as the primary view; the map is a tap away (directions).
- Score 0–10 with a one-word reason chip is the right level of explanation; raw numbers live in the detail.
- Three fixed gates + five weighted factors; the rider can tune weights but not gates.
- Photos make it feel like a product; absence of a photo must cost nothing.
- Alerts are a digest, not a stream; parameters belong to the rider.
- The page is consistent about which day is selected (Oct 2026). The sort control's first button is the selected day's short name ("Mon", "Fri") and sorts by that day's score; the second is the day after it and sorts by that day's score, showing its score chip on the tiles; it is hidden on the last forecast day; Distance is unchanged, and the stored sort keys stay `score` / `tomorrow` / `distance`. The best-bet card has one format for every day ("BEST BET · FRI · WITHIN 4H00", then score, name, line) whether or not a spot qualifies. The spot detail shows "Wind measured now" and the next-hour / 3-hour / 5-hour rows only when the selected day is today; any other day gets that day's Morning (7–10a), Midday (11a–2p) and Afternoon (3–6p) rows plus a lead-time line (tomorrow: hour-by-hour timing is usually good; 2–3 days: expect the window to shift an hour or two; 4 days: trust the pattern, not the hour; 5–6 days: a trend, not a forecast), and the hourly chart is titled with the day ("Friday, hour by hour"). Station readings (the blend into the current hour and the "Station disagrees" flag) apply only when the selected day is today; planning days are forecast-only, as §7 says.
- Enrichment (photos, webcams, stations) is always background work; scores never wait.
- Dead-light October test data: expect most rows at 0–2 ("Offshore"/"Too light") outside the season. Rufus Sat 2026-10-17 at 6.9 (18g26 W) was the validation case.

## 11. Open items for the rider (after the surprise)

Which spots he actually rides and their real launch rules · his weight and quiver · riding style · whether tide matters at his spots · his own photos.
