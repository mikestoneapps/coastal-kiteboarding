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

Status (2026-10-15): built. `obs.json` was committed empty because the build container's network policy blocks api.weather.gov and ndbc.noaa.gov; the first run of the **Station observations** workflow on `main` (hourly, or Actions → Run workflow) fills it. Until then the page behaves exactly as before, on its direct NWS calls. A reading's age is computed from its own timestamp, so a late job shows "3h ago" greyed rather than a frozen "12 min ago".

## Phase 2 — Settings that follow him, and "Keep this spot"
Goal: rider profile, comfort limits, per-spot overrides, checklist edits and alert settings persist across devices.
- Smallest honest option: a tiny backend (Cloudflare Worker + KV, or Supabase free tier) with magic-link email login. No passwords.
- Migrate existing localStorage (`goc.settings`) up on first login; keep localStorage as the offline cache.
- Add "Keep this spot" for discovered/added spots (Phase 4 uses it).

Status (2026-10-15): built. Backend is a Cloudflare Worker + KV (`sync/worker.js`, free tier, never pauses) with a **device-link** login instead of a magic-link email: the first device generates a random sync key, "Link another device" shares a link carrying it, no mail sender or domain needed. The page works unchanged with sync off; `docs/SETUP-SYNC.md` has the no-terminal dashboard steps, and `.github/workflows/sync-worker.yml` deploys automatically once Cloudflare secrets exist. `goc.settings` migrates forward (gains `updatedAt`, `kept`); `goc.cache` and the daily `goc.check.*` ticks stay local. Conflicts resolve newest-wins via the Worker's 409. "Keep a spot" lives under the list: name + coordinates + which way the beach faces → direction sectors (onshore ±30° best, ±80° works, reverse ±50° offshore), estimated drive times, forecast in the same batched call, `k-` ids. The Worker is not deployed yet: the rider (or whoever sets up the gift) follows SETUP-SYNC.md once.

## Phase 3 — Alerts and the weekly outlook
Goal: SPEC §8. One push digest per refresh run; Sunday 6 pm email.
- Hourly job (extend Phase 1's workflow or a second one) that pulls forecasts for all spots, scores them server-side with `scoring.js` (run under Node) using each user's saved parameters, and decides what to send. Web Push (VAPID) for the PWA; email via a free-tier sender (Resend/Postmark) for the outlook.
- Store "already alerted (spot, day, score)" so nothing repeats.
- Add the Alerts sheet's "Enable notifications" button to the page (push subscription), replacing the mock.

Status (2026-10-15): **push built; the weekly email is the next PR.** The `alerts` job in `.github/workflows/observations.yml` (same hourly schedule, runs beside the observations job) runs `alerts/run.mjs` under Node: it asks the sync Worker for every rider with a push subscription (identified by the Phase 2 sync key, so alert settings and the "already alerted" list are per rider, not per device), pulls one batched Open-Meteo forecast for the curated spots plus everyone's kept spots, scores with `scoring.js` using each rider's style, factor weights, comfort limits and per-spot overrides, and sends one Web Push digest per rider (`web-push`, VAPID). `scoring.js` gained the comfort limits and `minHours` window the page already applied, and `alerts/test.mjs` evaluates the page's inline scoring block against it so the two can't drift again. The Worker (`sync/worker.js`) stores subscriptions (`p:`), alert state (`a:`) and serves the VAPID public key; admin routes for the job are behind an `ADMIN_TOKEN` secret. `sw.js` only shows notifications (no fetch handler, no cache). Setup is in `docs/SETUP-SYNC.md` under "Push alerts"; until the secrets exist the job skips itself. Not done: the Sunday email, station blending in the job (same-day alerts are forecast-only), SMS.

## Phase 4 — Away-from-home mode
Goal: SPEC §5. When outside the home region, discover spots within the drive radius (OpenStreetMap kitesurf/windsurf tags + named beaches), score them from a batched Open-Meteo call, infer direction sectors from coastline orientation, mark rows "auto", and let him Keep them. Photos and webcams enrich in the background (Wikimedia Commons geosearch; standard thumbnail widths; descriptive User-Agent).
- Verify OSM coverage in 3 US regions before relying on it; fall back to named beaches.

## Phase 5 — Polish
Forecast accuracy memory and per-spot bias (SPEC "Add soon after" #7), seasonal context, two-spot compare, post-session feedback, native iOS wrapper for a home-screen widget if push proves unreliable.

## Small fixes queued (do in any phase)
- ~~Drive-radius slider stops at 4 h; Floras Lake is 5 h from Lake Oswego.~~ Slider extended to 6 h (15-min steps) in Phase 2. Spots scoring 8+ already surface up to 2× the radius via the comfort profile's "drive further" toggle.

## Open questions (for the rider, after the surprise)
- Which spots he actually rides; their real launch rules and parking.
- His weight and quiver (defaults: 185 lb; 7/9/12/14 m).
- Riding style (freeride / wave / foil) and comfort limits.
- Whether tide should become a scoring factor at his spots.
- His own photos for the spot tiles.
- Whether the device-link sync is enough, or he wants a real email login (Phase 2 chose device links to avoid an email sender).
- Kept spots: should "beach faces" be inferred from the coastline automatically (Phase 4 plans this) rather than picked from a compass?

## Decisions log
- 2026-10-15: Alert timing. A digest for tomorrow or later goes out on the first hourly run at or after the delivery hour (not only in that exact hour, so a late or skipped run doesn't lose it); a same-day alert only before noon; nothing in quiet hours; the daily cap counts digests, not spots. The "already alerted" list is only advanced when a device actually received the push, so an outage retries next hour.
- 2026-10-15: Push identity is the sync key. No subscription without sync on; "Unlink this device" also unsubscribes it. VAPID keys are generated once with `npx web-push generate-vapid-keys` (the one terminal step in setup).
- 2026-10-15: Harbor look chosen over Chart / Instrument / Poster alternatives. Keep it.
- 2026-10-15: Sort options are Today / Tomorrow / Distance; "Today" sorts by the selected day's score.
- 2026-10-15: Hosted as a static page on GitHub Pages; no app store. Native only if push/widget demand it.
- 2026-10-15: Settings sync on Cloudflare Worker + KV with device-link login (no email, no passwords). Supabase rejected because free projects pause after a week idle, which an off-season rider would hit.
