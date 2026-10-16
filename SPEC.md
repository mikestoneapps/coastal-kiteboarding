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
3. **Day tabs** — Today, Tomorrow, then weekday names, five days.
4. **Best bet card** — the top-scoring spot within radius for the selected day: photo, score, name, wind summary (`18g24 NW`), best window (`2p–5p`), drive time, suggested kite size. If nothing scores ≥4 in radius: "Nothing worth the drive," and if something scores ≥4 beyond radius, say so with its drive time.
5. **Controls** — riding style (*Freeride · Wave · Foil*), drive-radius slider (30 min–4 h, default 1h30 Today / 3 h planning).
6. **Ranked list** — one row per spot inside the radius, sorted by score then drive time. Row = photo tile with score badge · name · region · wind summary · window · surf height · reason chip ("Offshore", "Too light", "Gusty", "Fog") · model-agreement chip (planning days only) · drive time. Below the list: "N more spots beyond 1h30 · show them."
7. **Row detail (tap to expand)** — hourly wind bars with gust whiskers and direction arrows, best window highlighted; Now (nearest station, with distance) / Forecast now / Window / Kite / Air / Surf / Confidence tiles; "what's holding it back" sentence; spot notes; parking; nearest **webcam** link with distance (if one was found, §6b); **Directions** (Google Maps or Apple Maps deep link with traffic, from the current home base); **Share** (native share sheet: "Heading to Manzanita Sat 1–5pm, 18g24 NW — directions: <maps link>", so a buddy gets the plan and the route in one tap); **Checklist for this spot**.
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

Every daylight hour (07:00–19:00 local) at every spot gets a 0–10 score. The **day score is the best 3-hour window**, and that window is what the row shows.

**Hard gates** (score = 0, not adjustable): offshore wind for that spot · sustained ≥35 kn or gusts ≥38 kn · thunderstorms (WMO code ≥95).

**Factors**, each 0–1, combined as a weighted geometric mean (Π factor^weight × 10), so any one bad factor drags the score down and weight 0 removes a factor entirely:
1. **Wind speed** vs a style band — freeride 14–27 kn (peak 20), wave 14–24 (peak 19), foil 9–18 (peak 13). Linear ramps below/above; "Light"/"Strong"/"Too light"/"Too strong" reasons.
2. **Direction** vs the spot's sectors: `best` = 1.0, `work` = 0.75, else 0.4 ("Cross-off"), `off` = gate.
3. **Gusts** — gust/avg ≤1.3 clean; linear penalty to 0.3 at 1.9×; "Gusty" chip above 1.5×.
4. **Surf** (coast spots only) — wave style: <1.5 ft 0.7 ("Flat"), 1.5–7 ft 1.0, 7–9 ft 0.8, >9 ft 0.5. Freeride: ≤5 ft 1.0, ≤8 ft 0.8, else 0.5. Foil: ≤3 ft 1.0, ≤5 ft 0.75, else 0.5.
5. **Weather** — fog (codes 45/48 or visibility <1.6 km) ×0.5; precip probability >60 % ×0.85.

**Reason chip** = the lowest-weighted factor's label in the window, or the gate. In the row detail, expand the chip into a sentence that names the number and whose limit it is, OutDare-style: "Gusts 28 kn, over **your** 24 kn limit" vs "Offshore at this spot (E wind)". A limit that is the rider's is tappable to adjust; a limit that is the spot's is not.

**Confidence** (planning days) — compare best-window mean speed across best_match / GFS / ICON: within 4 kn "Models agree", 8 kn "Models mixed", else "Models disagree".

Open questions for the rider after launch: the style bands, whether tide should become a factor (display-only today), and per-spot overrides (Manzanita runs ~10 mph hotter than neighbours).

## 4. Spot data model (`spots.json`)

```
id, name, region, lat, lon          // forecast point (just offshore is fine)
plat, plon, parking                 // parking pin + description
dir: { best:[[from,to]…], work:[…], off:[…] }   // compass sectors, degrees, wind FROM
waves: bool                         // pull marine forecast?
pass: bool                          // Oregon State Parks pass needed
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

- **Forecasts:** Open-Meteo forecast API (models `best_match,gfs_seamless,icon_seamless`; hourly `wind_speed_10m, wind_gusts_10m, wind_direction_10m, temperature_2m, precipitation_probability, weather_code, visibility`; `wind_speed_unit=kn`; 5 days; tz America/Los_Angeles) + Marine API (`wave_height, wave_period, wave_direction, swell_wave_height, swell_wave_period`). Free, no key. `fetch_forecast.py` is the working reference.
- **Live observations (v1):** forecasts and observations are both shown; observations are the trust signal. For every spot, resolve the nearest public wind stations at spot-creation time and store them with distance: NOAA NDBC buoys and C-MAN stations, NWS/METAR airports via api.weather.gov, CDIP wave buoys, WeatherFlow/Tempest public stations where an open feed exists. Show the nearest one or two in the row detail as "Garibaldi C-MAN · 4.2 mi · 14g19 NW · 10 min ago". Station trust: distance-graded (≤3 mi full weight, 3–10 mi partial, >10 mi informational only). **Disagreement flag:** when the nearest trusted station differs from the forecast's current-hour wind by >6 kn or >60°, show a chip on the row ("Station reads 8 kn") and in the best-bet card. Today's score blends the station reading into the current hour (station weight by trust) but planning days stay forecast-only. NOAA CO-OPS for tides (display only at first).
- **Refresh:** server-side job hourly, 05:00–20:00 local (overnight runs are wasted), plus the **Refresh now** button (anyone using the app can trigger; debounce to one in-flight run). Store per-spot forecast documents with `fetchedAt`; the client subscribes and redraws when it changes.
- **Drive times:** curated minutes for home bases; live traffic via Google Maps Distance Matrix only when the user opens the app (not on every refresh), behind a server-side key. Directions = Maps deep link with current traffic.

## 8. Alerts and the weekly outlook (v1, the birthday feature)

**Delivery:** push notifications from the installed app (web push on the PWA; APNs if native). No phone number required. SMS via Twilio is an optional fallback the rider can turn on. Email for the weekly outlook only.

**One notification per run, never one per spot.** After each forecast refresh, evaluate every spot within the rider's alert radius for the next *lead time* days. If any qualify, send a single digest, best first: "Saturday looks great — Manzanita 9.1 (1h40), Rockaway 8.6 (1h35), Oceanside 8.2 (1h45). Window 1–6pm." Tapping opens Home on that day. A (spot, day) already alerted is not re-alerted unless its score moves by ≥2 or it drops below the threshold (then one "Saturday fell apart" notice).

**Rider-set parameters** (Alerts sheet, all with defaults): minimum score (default 8) · maximum drive from each home base (default = planning radius, 3 h) · days of the week he can go · delivery hour (default 7 pm, for tomorrow+; and a "same-day" toggle that allows a morning alert for today) · lead time (1–5 days, default 3) · minimum session length (from the comfort profile) · daily cap (default 1) · confidence gate (default on: only alert when models agree within 4 kn) · quiet hours (default 21:00–07:00).

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
- Enrichment (photos, webcams, stations) is always background work; scores never wait.
- Dead-light October test data: expect most rows at 0–2 ("Offshore"/"Too light") outside the season. Rufus Sat 2026-10-17 at 6.9 (18g26 W) was the validation case.

## 11. Open items for the rider (after the surprise)

Which spots he actually rides and their real launch rules · his weight and quiver · riding style · whether tide matters at his spots · his own photos.
