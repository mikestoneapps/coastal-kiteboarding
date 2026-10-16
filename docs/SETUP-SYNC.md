# Settings sync and push alerts — one-time setup

Sync keeps the rider profile, comfort limits, per-spot overrides, checklist edits, alert settings, kept spots and the rider's own spot photos the same on every device. It runs on a free Cloudflare Worker with a small KV store; the page works exactly as before until you turn it on, and keeps working offline afterwards (the phone's copy is the cache).

There is no login. The first device makes a long random sync key; "Link another device" gives you a link carrying that key to open on the next device. The Worker only ever stores a hash of the key. Anyone with the link can read and change the settings, so text or AirDrop it to yourself rather than posting it.

## 1. Create the Worker (about 10 minutes)
1. Sign up or sign in at https://dash.cloudflare.com (free plan).
2. Left menu → **Workers & Pages** → **Create** → **Create Worker**. Name it `coastal-kiteboarding-sync` → **Deploy** (it deploys a hello-world first).
3. Click **Edit code**. Select everything in the editor, delete it, and paste the contents of `sync/worker.js` from this repo. Click **Deploy**.
4. Make the store: left menu → **Storage & Databases** → **KV** → **Create a namespace** → name `SETTINGS` → **Add**.
5. Bind it: back in **Workers & Pages** → your Worker → **Settings** → **Bindings** → **Add** → **KV namespace**. Variable name `SETTINGS` (exactly), namespace `SETTINGS` → **Deploy**.
6. On the Worker's overview page copy its address. It looks like `https://coastal-kiteboarding-sync.<your-name>.workers.dev`. Open it in a browser; it should answer `{"ok":true,...}`.

If the page ever moves to a custom domain, add that origin under **Settings → Variables** as `ALLOWED_ORIGINS` (comma-separated); the default allows `https://mikestoneapps.github.io` and localhost.

## 2. Turn it on in the app
1. Open the app on the device whose settings you want to keep (the phone). Tap **Rider** → scroll to **Sync across devices**.
2. Paste the Worker address, tap **Turn on sync**. The status line reads "Synced" and this device's settings are now the server copy.
3. Tap **Link another device** → **Copy link** or **Share…** and open that link on the laptop. It links, pulls the settings, and drops the key from the address bar.

From then on every change saves locally first and copies up about a second later; other devices pull when opened or brought to the foreground. If two devices change things while offline, the newer change wins.

**Unlink this device** forgets the key on that device only; settings stay as they are. To revoke a leaked link, unlink everywhere, turn sync on again on the phone (a new key) and relink.

**If you pasted the Worker code into the dashboard before 2026-10-16, paste the current `sync/worker.js` again** (Edit code → select all → paste → Deploy). Each phase has added routes: push alerts in Phase 3, and the photo routes below. An old Worker answers the new calls with 404; the page then simply keeps the photos on the device that took them.

## Your own spot photos
Open any spot, curated or added, and tap **Use my photo**: the phone offers the camera or the photo library, the picture is shrunk on the phone to the tile's size (480×320 JPEG, about 40 KB) and kept in the app's own storage (IndexedDB, keyed by spot id), so it never reloads from the network. With sync on it is also uploaded to the Worker (`PUT /v1/photo/<spot id>`, same sync key, 100 KB limit per photo, stored in the `SETTINGS` KV namespace under the rider's hashed key) and listed in the settings document; every other linked device fetches the photos it lacks in the background the next time it syncs. **Remove photo** deletes it from the Worker and from every device and puts the built-in or Wikimedia Commons photo back. Nothing else is needed in the dashboard: the photo routes use the existing `SETTINGS` binding. Free-tier KV allows 1 GB, which is tens of thousands of photos at this size.

## Optional: deploy from GitHub instead of pasting
`.github/workflows/sync-worker.yml` deploys `sync/worker.js` on every push to `main` that touches `sync/`, but only if the repo has two secrets: `CLOUDFLARE_API_TOKEN` (dashboard → profile → API Tokens → "Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID`. Put the KV namespace id in `sync/wrangler.toml`. Without the secrets the job skips itself.

## Push alerts (after sync works)
The hourly job on GitHub scores every spot for every rider who has turned notifications on and sends one digest per rider (SPEC §8; the rules live in `alerts/`). It needs three secrets and one Worker setting. All of this is a one-time setup; the rider only ever taps **Alerts → Enable notifications**.

1. **Make a VAPID key pair** (identifies this app to Apple's and Google's push services). On any computer with Node installed run `npx web-push generate-vapid-keys`. It prints a public key and a private key; keep both somewhere safe. (This is the one step that needs a terminal.)
2. **Worker variable:** Cloudflare dashboard → your Worker → **Settings → Variables and Secrets** → add `VAPID_PUBLIC_KEY` = the public key (type Text). Deploy.
3. **Worker secret:** same place, add `ADMIN_TOKEN` = a long random string you make up (type Secret). This lets the hourly job read riders and write back the "already alerted" list; without it the job's routes answer 404.
4. **GitHub secrets:** repo → **Settings → Secrets and variables → Actions** → add `SYNC_URL` (the Worker address from step 1.6), `SYNC_ADMIN_TOKEN` (same value as `ADMIN_TOKEN`) and `VAPID_PRIVATE_KEY` (the private key from step 1). Until these exist the alerts job skips itself with a note in the log.
5. If you pasted the Worker code into the dashboard, paste the current `sync/worker.js` again; the push routes were added in Phase 3.
6. On the phone: open the installed app (home-screen icon; iOS 16.4 or newer), tap **Alerts → Enable notifications**, allow. The sheet shows "On". Each linked device turns it on separately; the alert rules and the "already told you" list are shared through the sync key.

Test it without waiting for wind: temporarily drag **Only if a spot scores at least** down on the Alerts sheet, then **Actions → Station observations → Run workflow** on GitHub. The `alerts` job's log shows the digest it sent (or why it held: quiet hours, delivery hour, daily cap). Put the threshold back afterwards.

The job never sends more than the daily cap, holds tomorrow-and-beyond digests until the delivery hour, sends a same-day alert only in the morning, and stays silent in quiet hours. A spot-day it has told you about is not repeated unless its score moves by 2 or more or it drops below the threshold ("Saturday fell apart"). It also prunes devices whose subscription has expired.

## Baking the address into the page
Once the Worker exists, set `const SYNC_URL="..."` in `index.html` so a device opened fresh only needs the link (the link also carries the address, so this is a convenience, not a requirement).
