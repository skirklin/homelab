# Recipe Clipper

A standalone Chrome extension (MV3, vanilla JS, no build step) that clips the
recipe from the page you're viewing and saves it to your homelab recipe boxes.

## Why a browser extension?

The server-side recipe scraper runs from a datacenter IP, and many recipe sites
(Serious Eats, Allrecipes, NYT Cooking, …) sit behind WAFs that return 402/403
to those IPs. This extension runs **in your own browser** — a residential IP
with your real session — so DOM extraction of the page's JSON-LD always works.

It reads the same `<script type="application/ld+json">` blocks the server
scraper does (porting its `extractRecipes`/`isRecipe` logic), unwraps any
`@graph`, keeps every `@type: "Recipe"` object, and POSTs the chosen one
verbatim to the recipes API — which stores recipes in the schema.org JSON-LD
shape as-is.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select this `extension-recipes/` directory.
4. The Recipe Clipper icon appears in the toolbar.

## Configure your API token

1. Sign in at [kirkl.in](https://kirkl.in) → **Settings** → **API Tokens** and
   mint a token. It starts with `hlk_`.
2. Right-click the extension icon → **Options** (or open the popup and click the
   "Open Options" prompt).
3. Paste the token, leave the API base URL as `https://api.kirkl.in`, and click
   **Save**. Use **Test connection** to confirm it reaches your recipe boxes.

The token is stored only in `chrome.storage.sync` and is never logged.

## Use

1. Navigate to a recipe page.
2. Click the Recipe Clipper icon.
   - If no recipe is found: "No recipe detected on this page."
   - If one or more are found: pick the recipe (when there's more than one) and
     the box to save it to, then click **Import recipe**.
3. A success message shows the saved recipe's name. A 401 means your token is
   wrong or expired — fix it in Options.

## Files

- `manifest.json` — MV3 manifest. `activeTab` + `scripting` (inject the
  extractor only on click — no persistent content script, no broad host perms)
  + `storage`. `host_permissions` for `https://api.kirkl.in/*` (and
  `http://localhost:3000/*` for dev parity).
- `extract.js` — injected into the active tab on click; reads/parses all
  `ld+json` blocks and returns the raw Recipe objects.
- `popup.html` / `popup.js` — the clip UI (extract → box picker → import).
- `options.html` / `options.js` — token + base-URL settings with a connection test.

## Server endpoints used (no server changes needed)

- `GET  https://api.kirkl.in/fn/data/boxes` → list of `{ id, name, … }`.
- `POST https://api.kirkl.in/fn/data/recipes` with `{ boxId, data }` where
  `data` is the raw JSON-LD Recipe object → creates the recipe.

Both authenticate via `Authorization: Bearer hlk_…`.
