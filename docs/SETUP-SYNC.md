# Settings sync — one-time setup (no terminal needed)

Sync keeps the rider profile, comfort limits, per-spot overrides, checklist edits, alert settings and kept spots the same on every device. It runs on a free Cloudflare Worker with a small KV store; the page works exactly as before until you turn it on, and keeps working offline afterwards (the phone's copy is the cache).

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

## Optional: deploy from GitHub instead of pasting
`.github/workflows/sync-worker.yml` deploys `sync/worker.js` on every push to `main` that touches `sync/`, but only if the repo has two secrets: `CLOUDFLARE_API_TOKEN` (dashboard → profile → API Tokens → "Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID`. Put the KV namespace id in `sync/wrangler.toml`. Without the secrets the job skips itself.

## Baking the address into the page
Once the Worker exists, set `const SYNC_URL="..."` in `index.html` so a device opened fresh only needs the link (the link also carries the address, so this is a convenience, not a requirement).
