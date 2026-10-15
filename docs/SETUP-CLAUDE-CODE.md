# Moving the project into Claude Code (no terminal needed)

You'll run Claude Code **in the cloud** from the Code tab of the Claude desktop app, or from https://claude.ai/code in a browser. It clones the GitHub repo, makes changes on a branch, and opens a pull request you approve on GitHub. Nothing is installed on your Mac.

## 1. Connect GitHub to Claude (one time, ~3 minutes)
1. Go to https://claude.ai/code (or open the **Code** tab in the Claude desktop app and choose **Cloud**).
2. The first time, it asks to connect GitHub. Click through to **install the Claude GitHub App**. Sign in to GitHub as `mikestoneapps` if asked.
3. On the install screen choose **Only select repositories** → pick `coastal-kiteboarding` → **Install**.
4. Back in Claude, the repo appears in the repository picker. If it doesn't, reload the page once.

## 2. Get the handoff files into the repo
Either:
- **Ask Mike's prototype session to push them** (fastest: tell Claude in the chat where this file came from "GitHub is connected, push the handoff"), or
- **Upload them yourself**: unzip the handoff zip, then in the repo click **Add file → Upload files**, drag everything in (including the `docs` folder), and **Commit changes**. Overwriting `index.html` and the images is expected.

Check: the repo should show `CLAUDE.md`, `README.md`, `SPEC.md`, `scoring.js`, `spots.json`, `stations.json`, `docs/`, and the site files. Open the live link once to confirm it still loads.

## 3. Start the first session
1. At claude.ai/code click **New session** (or in the desktop Code tab, Environment **Cloud**).
2. Repository: `mikestoneapps/coastal-kiteboarding`. Branch: `main`.
3. Permission mode: **Default** (asks before risky actions) is fine for the first session.
4. Paste this as the first message:

> Read CLAUDE.md and SPEC.md. Implement Phase 1 of docs/BUILD-PLAN.md: an hourly GitHub Actions workflow that runs obs_standalone.py and commits obs.json, and make index.html read obs.json alongside its direct NWS fetches. Run the script once locally to generate a first obs.json and commit it. Test the page in a headless browser before opening the PR.

5. Claude works for a while and usually opens the pull request itself; its final message links it as "#N". If it only shows a diff (`+120 −8`) and no PR link, click the diff to review and then click **Create PR**.

## 4. Approve and ship (this happens on GitHub, not in Claude)
1. Open the pull request link on GitHub (or the repo's **Pull requests** tab). Scroll through the "Files changed" tab if you like.
2. Click **Merge pull request** → **Confirm merge**.
3. GitHub Pages redeploys `main` automatically in about a minute. Reload the live link on your phone.
4. The hourly job appears under the repo's **Actions** tab; the first run happens at the next scheduled time, or click the workflow → **Run workflow** to trigger it now.

## 5. Keep going
One phase per session, in a **new** session each time. Start each with "Read CLAUDE.md and docs/BUILD-PLAN.md, then do Phase N. Show me your plan before making changes." Phases that add an outside service (Phase 2: Cloudflare for sync; Phase 3: push/email) end with a setup doc in `docs/` telling you what to create and where to paste the result; do that after merging. If Claude asks a question you can't answer (his quiver, his favorite spots), say "use the default and note it under Open questions."

## If something goes wrong
- **Live page broken after a merge**: on GitHub, open the merged PR → **Revert** → merge the revert. Pages redeploys the previous version.
- **Claude can't see the repo**: GitHub → Settings → Applications → Claude → Configure → make sure `coastal-kiteboarding` is selected.
- **Actions job fails**: open the Actions tab, click the failed run, copy the red error into a Claude Code session and ask it to fix it.
