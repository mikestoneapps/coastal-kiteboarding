# Coastal Kiteboarding — project instructions for Claude Code

Read `SPEC.md` before any work. It is the product spec and the source of truth for scope and scoring. `docs/BUILD-PLAN.md` is the phased plan; work one phase at a time.

## What this is
A kiteboarding spot-finder for one rider in Portland, OR (gift for his 50th). The app, tab and home-screen name is **"Bistué Boarding"** (manifest + title); the repo and URL stay `coastal-kiteboarding`. One screen: spots ranked by a 0–10 score for the selected day, with drive time from his two houses (Lake Oswego and Pacific City on the coast; the coast house moved from Bay City in Oct 2026 and keeps the internal key `BC`/`driveBC` so saved settings still work) or his current location.

## Hard rules
- **`index.html` is live at https://mikestoneapps.github.io/coastal-kiteboarding/ and installed on a phone. It must keep working after every change.** Never break the GitHub Pages deploy (branch `main`, root folder). Test the page in a browser before committing; never commit a page that throws on load.
- **Scores never wait for enrichment.** Photos, webcams and station readings load in the background; the ranked list renders from forecasts alone.
- **No AI calls at runtime.** The narrative line is rule-based. Claude is used to write the code, not inside the product.
- **Everything free-tier.** Open-Meteo, NOAA (NDBC, NWS), OpenStreetMap, Wikimedia Commons, GitHub Actions/Pages. Google Maps only behind a server-side key and only on user action. No paid services without asking.
- **Adding a spot requires only name, coordinates and direction sectors.** Everything else optional.
- **Don't re-litigate what the prototype settled** (SPEC.md §10). Keep the Harbor look: the current tokens, fonts and layout in `index.html`.
- **Settings sync (phase 2) must not lose what is in the phone's localStorage today**: migrate `goc.settings` and `goc.cache` keys forward.

## Layout of the repo
- `index.html` — the whole app (single file; CSS, markup and JS inline). Fetches Open-Meteo and NWS stations in the browser.
- `img/` — spot photos (480×320 JPEG, CC-licensed; credits in `img/credits.json`). Missing photo ⇒ neutral tile, by design.
- `manifest.webmanifest`, `icon-*.png` — home-screen install.
- `spots.json` — the 15 curated spots (schema in SPEC.md §4). `index.html` currently embeds a copy as `const SPOTS`; keep them in sync, or make the page load the JSON (preferred once there is a build step).
- `scoring.js` — the scoring model as a standalone module, identical logic to the page (including comfort limits and per-spot overrides). If you change scoring, change both; `node alerts/test.mjs` fails if they differ.
- `stations.json` — nearest public wind stations per spot (NWS ids and NDBC buoy ids with distances).
- `stations.py`, `obs_standalone.py` — fetch station observations (NWS via api.weather.gov; NDBC via realtime2 text feed). NDBC has no CORS, so buoys must be fetched server-side.
- `fetch_forecast.py` — reference Open-Meteo fetch (3 models + marine).
- `checklist-defaults.json` — default checklist items.
- `sync/` — settings-sync + push Cloudflare Worker (`worker.js`, `wrangler.toml`, `test.mjs`). Optional; the page runs on localStorage alone until a Worker URL is entered in the Rider sheet. Also stores push subscriptions and the per-rider "already alerted" state. Setup in `docs/SETUP-SYNC.md`.
- `alerts/` — hourly push-alert job (`run.mjs` sends, `lib.mjs` decides, `test.mjs` checks the rules and that the page's inline scoring still matches `scoring.js`). Runs in `.github/workflows/observations.yml`; skips itself until the secrets exist.
- `away_spots.py`, `away-spots.json` — the away-mode spot catalogue: OpenStreetMap kitesurf/kiteboard/windsurf features worldwide plus named beaches in the US, Canada and Mexico, fetched weekly from Overpass by `.github/workflows/away-spots.yml` and committed. The page filters this file by drive radius; it never queries Overpass for the list (public mirrors are too slow from a browser). Overpass is only used in the background for shoreline facing and webcams.
- `away/` — tests for the page's away-from-home mode (Phase 4; the code itself is inline in `index.html` under "away from home"). `test.mjs` runs that block under Node with the mock catalogue and OpenStreetMap / Open-Meteo / Commons answers in `fixtures.mjs`; `browser-test.mjs` drives the page in headless Chromium with every external host intercepted (`--live` lets them through) and checks home mode against a baseline copy of the page (`BASELINE_DIR=<dir with main's index.html>`).
- `sw.js` — service worker for push only: shows the notification and opens the app on the right day. No fetch handler, no cache (so it can never serve a stale page).
- `docs/` — build plan and setup notes.

## Conventions
- Plain HTML/CSS/JS for the page; no framework unless a phase needs one and the plan says so. Any build step must still produce a static `index.html` that GitHub Pages serves.
- Python 3 for jobs (GitHub Actions). Keep jobs idempotent; commit generated data files (`obs.json`, `forecast.json`) to the repo so the page can read them same-origin.
- Units: knots for wind, feet for surf, °F for air, miles for distance, America/Los_Angeles for time.
- Spot ids are lowercase slugs; never rename an existing id (localStorage overrides key on it).
- Commit messages: imperative, one line of what and why. Small PRs, one phase step each.

## When unsure
Prefer the simplest thing that keeps the live page working, and leave a note in `docs/BUILD-PLAN.md` under "Open questions" rather than guessing at the rider's preferences (we don't know his quiver, weight or favorite spots yet).
