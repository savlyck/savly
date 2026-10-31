# SAVLY core journey (work branch)

Status: **development branch, not production verified**. Based on main commit `e764538ec570ec651d4e592710c9f478a4157ed4` (2026-10-02).

## What changed
- Existing Python backend and original web UI retained.
- SQLite-backed sessions: opaque bearer tokens stored as SHA-256 hashes; 30-day sliding expiration. Restart-safe **only if SAVLY_DB is on durable storage**.
- Session cookie uses HttpOnly, SameSite=Lax, Secure on HTTPS and matching Max-Age.
- Optional "Planlegg enkelt" journey in `public/core.js`, loaded by the existing HTML response. First-time preferences (household size, optional avoidance notes) stay local.
- Meal entry and starter recipes, day planning, copy/move, portion adjustments, last week's plan reuse.
- Deterministic meal emoji based on meal title, independent of ingredients.
- Grocery generation with compatible kg/g and l/dl/ml summing, simple provenance, checkbox and "Har hjemme". Repeated imports do not add duplicates for generated items. Legacy list items are preserved.

## Local startup

Python 3.10+ recommended.
```bash
python -m pip install -r requirements-google.txt
export GOOGLE_CLIENT_ID="YOUR_GOOGLE_WEB_CLIENT_ID" # optional
export KASSALAPP_API_KEY="YOUR_SECRET" # optional: prices disabled without this
export SAVLY_DB="./savly.sqlite3"
export PORT=8787
python server.py
```
Open http://localhost:8787 and use **Planlegg enkelt**.

Google Credential tokens must be configured for the same deployed origin. Never store Kassalapp keys in the browser.

## Render storage safety
**Do not deploy with the default DB path on ephemeral Render storage.**
Configure a persistent Render disk (a plan that supports it), mount e.g. at `/var/data` and set:
```
SAVLY_DB=/var/data/savly.sqlite3
SAVLY_PUBLIC_ORIGIN=https://YOUR-HOST
```
Back up the existing `savly.sqlite3` before changing paths or restarting production. An empty DB at a new path will look like account data loss. SQLite is suitable only with one durable shared writer; do not scale to multiple independent disks.

## Known gaps and caveats
- This change is **additive, not a completed navigation rewrite**. The legacy menu, onboarding, demo user mode and Pro prompts remain reachable. The focused journey is opened using "Planlegg enkelt".
- Starter recipes are first-party illustrative ingredient lists, not scraped content.
- Allergy/avoidance notes are locally stored; **there is no allergen validation**.
- Guest-to-Google account merge, automatic background reconciliation when a meal changes, favorites, full quantity editing, delete undo and robust offline/multi-device migration are still unfinished.
- Lists synchronize only through existing mechanisms, with current household conflict handling; do not assume every multi-device scenario is safe.
- Browser reload and logged-in persistence still need end-to-end verification. Google Safari cookie retention and OAuth behavior have **not been device-tested**.
- Prices still use the existing Kassalapp gateway; provider abstraction, membership terms, full pricing coverage and licensing for upstream images are not resolved.
- The original app's `account.js` route exists in server routing but that file is not present in the inspected repository tree; diagnose any broken script references before launch.
- No verified payment integration; never claim Pro is active or purchased.
- The code has not been tested in iOS Safari or Android Chrome. Web app is not an App Store/Play Store release.

## Manual acceptance checklist
1. Start backend. Open as guest. Use Planlegg enkelt; set number of people, skip allergies. Add Taco.
2. Generate the handleliste. Import twice; confirm no second generated row.
3. Add Pasta med kjøttdeig. Same-unit kjøttdeig should total 800 g for two people with default portions.
4. Add manual 'Toalettpapir'; regenerate and ensure it remains.
5. Mark a generated item "Har hjemme"; regenerate and ensure the flag remains.
6. Change portion input, regenerate, confirm recomputed quantity while manual items remain.
7. Change day, copy meal, regenerate, confirm sources and totals. Delete meal; regenerate.
8. Copy previous week and repeat operation; verify duplicates are avoided per day/title.
9. Reload page, repeat checks. Test a Google login, then restart Python, and ensure /api/session returns the same user using saved cookie.
10. Test house membership constraints, two device conflicts, and price API outage separately.

## Deployment status
Only committed on `feature/core-journey-2026-10-31`; **not merged to main and not published to Render**. No complete automated/browser test suite has run in this environment. Production deploy requires separate review and approval.
