# Build plan

Phased so the live page never breaks and each phase ships something the rider notices. Each phase is one or two Claude Code sessions. Prompts to paste are at the end of each phase.

## Phase 0 — Land the handoff (done when this file is in the repo)
- `index.html` from the handoff replaces the uploaded one (fixes the tab/home-screen name to "Coastal Kiteboarding").
- `SPEC.md`, `CLAUDE.md`, `scoring.js`, `spots.json`, `stations.json`, scripts, `docs/`.
- Confirm Pages still serves the page.

## Phase 1 — Station readings for every spot (hourly job)
Goal: "Wind measured now" works for all 15 spots, including the buoy-only ones, without the browser calling NOAA.
- Add `.github/workflows/observations.yml`: runs `obs_standalone.py` every hour 05:00–21:00 Pacific, commits `obs.json` to `main` (use the built-in `GITHUB_TOKEN`; the workflow needs `contents: write`).
- `index.html`: on load, fetch `obs.json` (same origin) **in addition to** the direct NWS calls; prefer the fresher reading per station. Keep the direct NWS calls so the page works even if the job is late.
- Show age honestly: "32 min ago"; grey the tile if older than 2 h.
- Also fetch the station's wave height from buoys (`wvht_ft`) and show it beside the marine forecast when present.

Prompt: *"Read CLAUDE.md and SPEC.md. Implement Phase 1 of docs/BUILD-PLAN.md: an hourly GitHub Actions workflow that runs obs_standalone.py and commits obs.json, and make index.html read obs.json alongside its direct NWS fetches. Run the script once locally to generate a first obs.json and commit it. Test the page in a headless browser before opening the PR."*

## Phase 2 — Settings that follow him, and "Keep this spot"
Goal: rider profile, comfort limits, per-spot overrides, checklist edits and alert settings persist across devices.
- Smallest honest option: a tiny backend (Cloudflare Worker + KV, or Supabase free tier) with magic-link email login. No passwords.
- Migrate existing localStorage (`goc.settings`) up on first login; keep localStorage as the offline cache.
- Add "Keep this spot" for discovered/added spots (Phase 4 uses it).

## Phase 3 — Alerts and the weekly outlook
Goal: SPEC §8. One push digest per refresh run; Sunday 6 pm email.
- Hourly job (extend Phase 1's workflow or a second one) that pulls forecasts for all spots, scores them server-side with `scoring.js` (run under Node) using each user's saved parameters, and decides what to send. Web Push (VAPID) for the PWA; email via a free-tier sender (Resend/Postmark) for the outlook.
- Store "already alerted (spot, day, score)" so nothing repeats.
- Add the Alerts sheet's "Enable notifications" button to the page (push subscription), replacing the mock.

## Phase 4 — Away-from-home mode
Goal: SPEC §5. When outside the home region, discover spots within the drive radius (OpenStreetMap kitesurf/windsurf tags + named beaches), score them from a batched Open-Meteo call, infer direction sectors from coastline orientation, mark rows "auto", and let him Keep them. Photos and webcams enrich in the background (Wikimedia Commons geosearch; standard thumbnail widths; descriptive User-Agent).
- Verify OSM coverage in 3 US regions before relying on it; fall back to named beaches.

## Phase 5 — Polish
Forecast accuracy memory and per-spot bias (SPEC "Add soon after" #7), seasonal context, two-spot compare, post-session feedback, native iOS wrapper for a home-screen widget if push proves unreliable.

## Open questions (for the rider, after the surprise)
- Which spots he actually rides; their real launch rules and parking.
- His weight and quiver (defaults: 185 lb; 7/9/12/14 m).
- Riding style (freeride / wave / foil) and comfort limits.
- Whether tide should become a scoring factor at his spots.
- His own photos for the spot tiles.

## Decisions log
- 2026-10-15: Harbor look chosen over Chart / Instrument / Poster alternatives. Keep it.
- 2026-10-15: Sort options are Today / Tomorrow / Distance; "Today" sorts by the selected day's score.
- 2026-10-15: Hosted as a static page on GitHub Pages; no app store. Native only if push/widget demand it.
