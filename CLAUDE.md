# Project Context

You are the Architect on this project. Read ARCHITECT.md before doing anything else.

## ⚠️ Parallel sessions — edit in worktrees

Multiple Claude Code sessions run against this repo at the same time. Editing files directly in the main checkout causes merge conflicts and clobbered work between sessions. **Do not edit working-tree files directly when making non-trivial changes.** Instead:

- Dispatch an **Agent with `isolation: "worktree"`** for any substantive edit. The agent works in its own git worktree, and the user merges the result deliberately.
- **First command to run inside your worktree: `./infra/scripts/worktree-init.sh`.** It symlinks `node_modules/` + `packages/*/dist/` from the parent repo so `pnpm exec tsc`, tests, and other workspace commands work without a fresh install. Re-running is a no-op; pass `--clean` before final review to drop the symlinks.
- **Once an agent's branch is merged into `main`, reap its worktree.** Run `./infra/scripts/worktree-reap.sh` (use `--dry-run` first to preview). It only removes a worktree when ALL three are true: the working tree is clean, the branch is already an ancestor of `main`, and any harness lock points at a dead PID — never destructive, no override flag exists. **Letting worktrees accumulate is not free**: each one adds tens of thousands of files under `.claude/worktrees/`, and VS Code's WSL file watcher monitors every one of them. This repo once accumulated 93 stale worktrees → 3.2 GB file-watcher RSS + heavy slab pressure + swap thrash that surfaced as flaky tests. Reap eagerly.
- The main Claude session may do read-only exploration, ask clarifying questions, plan, run tests, and produce non-file outputs without a worktree.
- One-line / typo / trivially safe edits the user has explicitly approved in the current turn are fine inline.
- Never `git stash`, `git reset --hard`, `git checkout --`, or unscoped `git worktree remove` without explicit per-action approval — sibling sessions probably have uncommitted work that would disappear. The reap script above is the safe path for `git worktree remove`: it checks every safety condition before acting.

If you are unsure whether a change is "substantive," default to dispatching a worktree agent. The cost of an extra agent run is low; the cost of trampling a sibling session's WIP is high.

## Continuous improvement — leave it better than you found it

Whenever a feature lands or any code is touched, follow up by looking at the surrounding code with fresh eyes. Ask:

- Is this still the right shape, or was it a choice that made sense then and is stale now?
- Is there dead code, an unused abstraction, or a simpler structure waiting to come out?
- Did this change just make a nearby pattern redundant, smelly, or worth promoting/inlining?
- Is there a follow-up cleanup worth flagging even if it's out of scope for this turn?

A great codebase is the result of constantly questioning previous choices, not just stacking new code on top. Aim to leave a better world for our future selves — small, scoped cleanups beat big rewrites. Out-of-scope improvements you spot should be raised explicitly so the user can decide whether to chase them now, defer them, or skip.

## What this is

Personal web apps monorepo, self-hosted on PocketBase + Caddy on a VPS (Hetzner, 5.78.200.161, user `scott`).

## Current state (2026-05-24)

Production is **`kirkl.in`**. Firebase → PocketBase migration is complete; PB on the VPS is authoritative for all app data. Caddy still serves `beta.kirkl.in` as an alias during the transition window.

The **life app is now unhosted** from the home shell — `life.kirkl.in` serves a standalone deploy (its own nginx pod) and is no longer bundled as a module under `kirkl.in`. The morning/evening session wizards (`/morning`, `/evening`) live in that standalone app. The widget manifest is hardcoded in [`apps/life/app/src/manifest.ts`](apps/life/app/src/manifest.ts) — the in-DB manifest editor was deleted.

### Architecture

k3s single-node cluster. Caddy pod handles TLS (Let's Encrypt) and reverse proxies to app services. Each frontend app is an nginx container serving Vite build output. PocketBase is a StatefulSet with a PVC. API service (Hono/TypeScript) handles recipe scraping, AI, sharing, push notifications, and data endpoints.

**URL config**: single `DOMAIN` env var (default `kirkl.in`) drives everything via `services/api/src/config.ts`. Frontend gets `VITE_DOMAIN` baked in at build time via `deploy.sh`. DNS: Squarespace `@` and `*` both A → 5.78.200.161.

| Subdomain | k8s Service |
|---|---|
| `kirkl.in` | home |
| `beta.kirkl.in` | home-beta (parallel home variant) |
| `recipes.kirkl.in` | recipes |
| `shopping.kirkl.in` | shopping |
| `upkeep.kirkl.in` | upkeep (Kanban view) |
| `travel.kirkl.in` | travel |
| `life.kirkl.in` | life |
| `me.kirkl.in` | homepage |
| `api.kirkl.in` | pocketbase (direct) + functions (under `/fn/`) |
| `registry.kirkl.in` | private Docker registry (auth required) |
| `mcp.kirkl.in` | MCP server (Streamable HTTP + OAuth, public) |

Home app also serves `/tasks/*` (unified task outliner).
Money app is tailnet-only via Tailscale Serve (`https://homelab-0.tail56ca88.ts.net`).

**Beta channel (`beta.kirkl.in`)**: a separately-deployed `home` build that shares the same PB, API, auth, and data as production — only the home bundle differs. The `home-beta` Deployment pulls `home:beta` while prod `home` stays on `:latest`. Push to it with `./infra/deploy.sh --beta` (from any branch). The flag pins `IMAGE_TAG=beta`, builds only `home`, rolls out only the `home-beta` Deployment, and marks the deployment record with `variant: "beta"` so the monitor can partition history. Production is never touched. The `*.beta.kirkl.in` subdomain aliases on the standalone apps (recipes/shopping/…) still point at their prod Services — beta only forks `home`.

## MCP Server

**This project has an MCP server connected.** Use it to read and write all app data.

The homelab MCP tools are available as `mcp__homelab__*`. Use them whenever the user asks about their recipes, shopping lists, travel plans, tasks, or life data.

### Available tools:

**Recipes (read):**
- `list_boxes` — list all recipe boxes
- `search_recipes` — search by name across all boxes
- `get_recipe` — full recipe details by ID
- `list_cooking_log` — cooking log entries for a recipe (newest first)

**Recipes (write):**
- `scrape_recipe` — scrape a recipe from a URL
- `create_recipe_box` — create a new box
- `update_recipe_box` — rename, change description, or set visibility
- `delete_recipe_box` — delete a box (cascades to recipes + cooking log)
- `subscribe_to_box` / `unsubscribe_from_box` — manage the authenticated user's box subscriptions
- `add_recipe_to_box` — add a recipe with structured data
- `update_recipe` — replace a recipe's data (whole-replace; for small edits prefer the surgical ops below)
- `patch_recipe` — merge top-level fields into recipe.data (name, recipeYield, recipeCuisine, …); null clears
- `add_recipe_ingredient` / `update_recipe_ingredient` / `remove_recipe_ingredient` / `reorder_recipe_ingredients` — index-addressable ingredient ops
- `add_recipe_step` / `update_recipe_step` / `remove_recipe_step` / `reorder_recipe_steps` — same for instruction steps
- `delete_recipe` — delete a recipe
- `set_recipe_visibility` — set per-recipe visibility
- `add_cooking_log_entry` — log a cooking session (optional notes/timestamp)
- `update_cooking_log_entry` — edit cooking log notes and/or timestamp
- `delete_cooking_log_entry` — delete a cooking log entry

**Shopping (read):**
- `list_shopping_lists` — list all lists
- `list_shopping_items` — items in a list

**Shopping (write):**
- `create_shopping_list` / `update_shopping_list` / `delete_shopping_list` — manage lists
- `add_shopping_item` — add item to a list
- `update_shopping_item` — edit ingredient/note/category/checked
- `check_shopping_item` — toggle checked status
- `remove_shopping_item` — delete an item
- `clear_checked_items` — done shopping, clear checked

**Tasks (read):**
- `list_task_lists` — list the user's task lists (call first to discover list IDs)
- `list_tasks` — list tasks (filter by parent_id, tag, task_type)

**Tasks (write):**
- `add_task` — create a task (supports nesting via parent_id, recurring vs one_shot, assignees)
- `add_trip_task` — add a trip-prep task; auto-nests under `Trips/<destination>/` and tags `travel:<tripId>`. Pass `activity_id` to also tag `activity:<id>` so the Prep tab groups it under that activity. (Use this for trip prep instead of raw `add_task`.)
- `update_task` — update fields (typed schema; pass only the fields to change). To reparent or move between lists use `move_task` instead.
- `move_task` — reparent and/or move between lists; recomputes descendant `path` atomically
- `tag_task` — add and/or remove tags atomically (avoids the get-then-set race of `update_task(tags=...)`)
- `delete_task` — delete task and all descendants
- `complete_task` — toggle completion (recurring sets last_completed; one_shot toggles completed)
- `snooze_task` / `unsnooze_task` — snooze until a date or clear snooze

Travel checklists are just tasks tagged `travel:<tripId>`, auto-nested under a `Trips/<name>/` container in the outliner. The easy path is `add_trip_task` — it resolves the destination, finds-or-creates the containers, and tags the leaf. Using raw `add_task` is the hard path: you have to find the "Trips" root + per-trip container yourself, or the task ends up at the top level. Tasks may also carry an optional `activity:<activityId>` tag; when present, the Prep tab groups them under that activity (e.g. "Book Frida Kahlo tickets" under the Frida Kahlo Museum activity). `add_trip_task` accepts an `activity_id` param for this — stale `activity:<id>` tags whose activity has been deleted degrade gracefully to General prep, no cleanup needed.

**Travel (read):**
- `list_travel_trips` — all trips across logs
- `get_travel_trip` — single trip with activities + itineraries
- `get_travel_activity` — full activity details (geocoding, flight info, verdict/notes)
- `search_travel` — search trips/activities by destination/name
- `get_trip_issues` — per-day validation (overlap, out-of-order, drive-gap); same data the travel UI surfaces as "N issues"
- `list_travel_notes` — per-user feedback notes for a subject (activity/day/trip), newest first. `subject_id`: activity→activity ID, trip→trip ID, day→`<tripId>:<date>`

**Travel (write):**
- `add_travel_trip` — create a trip
- `update_travel_trip` — update trip fields
- `add_travel_activity` — create an activity
- `update_travel_activity` — update activity fields (including verdict, personal_notes, experienced_at for post-trip reflection)
- `add_travel_itinerary` — create an itinerary
- `update_travel_itinerary` — update itinerary fields or replace days array (whole-replace; for small edits prefer the surgical ops below)
- `add_itinerary_slot` / `remove_itinerary_slot` / `update_itinerary_slot` / `move_itinerary_slot` — surgical slot ops by `(itinerary_id, day_index, slot_index)` so callers don't round-trip the whole days array
- `add_itinerary_flight` / `remove_itinerary_flight` / `update_itinerary_flight` / `move_itinerary_flight` — same shape, but for the `flights[]` array on a day
- `add_itinerary_day` / `remove_itinerary_day` / `move_itinerary_day` — manage the day list itself
- `update_itinerary_day` — patch a day's `label` / `date` / `lodging_activity_id`
- `delete_travel_trip` — delete a trip
- `delete_travel_activity` — delete an activity
- `delete_travel_itinerary` — delete an itinerary
- `add_travel_note` — add a per-user feedback note to an activity/day/trip; author (`created_by`) is stamped server-side from your identity, never client-settable. Caller must own the log
- `update_travel_note` — replace a note's `entries` wholesale (can't change author or subject)
- `delete_travel_note` — delete a note by ID

**Life (read):**
- `list_life_entries` — recent entries (optional days filter)
- `list_life_trackables` — the caller's per-user trackable manifest (id, label, group, hidden, fields, pinned)

**Life (write):**
- `add_life_entry` — log a widget event (data shape varies per widget type)
- `update_life_entry` — change timestamp, merge data, or set notes
- `delete_life_entry` — delete an entry
- `add_life_trackable` — create a trackable (immutable slug `id`, `label`, optional `group`/`hidden`, typed `fields[]`; category fields need `options`)
- `update_life_trackable` — patch label/group/hidden/fields/pinned. `id` and existing `field.key`/type are IMMUTABLE (history join keys); you may append new fields but never rename/remove/retype one
- `remove_life_trackable` — drop a trackable from the manifest. Manifest-only — NEVER deletes `life_events`; events re-link if the same id is re-added
- `reorder_life_trackables` — set trackable order (dashboard renders in manifest order)
- `add_life_pin` / `remove_life_pin` — manage a trackable's pinned quick-actions; a pin's `entries[].name`/`labels` keys must match the trackable's field keys so it replays as a history-compatible event

All trackable tools operate on the authenticated caller's own life log — there is no log-id parameter, so cross-user edits are impossible.

**Sharing:**
- `create_invite` — generate a sharing invite link (optional expiry)
- `list_invites` — list invites the user created (newest first)
- `update_invite` — change expiry on an existing invite
- `delete_invite` — revoke an invite

**Money (read-only, proxied to the ingest service):**
- `list_money_accounts` — all financial accounts with current balances
- `list_money_balances` — balance snapshots (optionally by account)
- `list_money_transactions` — transaction history with filters (account, category, date range)
- `get_money_net_worth_summary` — current net worth, broken down by category/institution
- `get_money_net_worth_history` — net-worth time series
- `get_money_performance` — invested/earned + returns for investment accounts
- `get_money_spending_summary` — spending aggregated by category/period
- `list_money_holdings` — investment positions
- `get_money_allocation` — asset allocation breakdown
- `list_money_recurring` — detected recurring transactions / subscriptions
- `list_money_institutions` / `list_money_people` — lookup tables

Writes are deliberately not exposed — money mutations are infrequent and risky to delegate. To migrate money fully to PocketBase, see [`services/ingest/MIGRATION.md`](services/ingest/MIGRATION.md).

### Activity field guide

When creating or updating travel activities, fill in ALL relevant fields — don't put structured data in the description:

| Field | Purpose | Examples |
|---|---|---|
| `name` | Short name. No "Overnight in" prefix for lodging. | `Desert Botanical Garden`, `SpringHill Suites Phoenix` |
| `category` | Type of activity | `Transportation`, `Accommodation`, `Hiking`, `Adventure`, `Food & Dining`, `Sightseeing`, `Shopping`, `Nightlife`, `Culture`, `Relaxation`, `Other` |
| `location` | City or area | `Phoenix, AZ`, `Taos, NM` |
| `description` | Brief qualifying note only — what makes this specific. NOT costs, durations, logistics, or booking instructions. | `Ancient Puebloan great houses, 650+ rooms. Unpaved road in.` |
| `duration_estimate` | How long the activity takes (not including travel to/from) | `2h`, `half day`, `1.5h` |
| `walk_miles` | Distance on foot — for hikes, the trail length | `3.2`, `5.5` |
| `elevation_gain_feet` | Elevation gain (Hiking only) | `1400`, `3200` |
| `difficulty` | Hike difficulty (Hiking only) | `easy`, `moderate`, `hard`, `strenuous` |
| `cost_notes` | Price info | `$25/person`, `Free`, `$15 parking` |
| `setting` | Indoor/outdoor/both | `outdoor`, `indoor`, `both` |
| `trip_id` | Which trip this belongs to | (record ID) |
| `confirmation_code` | Set once a booking is complete — the readiness dashboard treats it as the "confirmed" signal. | `ABC123` |

**Do not** put durations or booking instructions in the description. **Do not** prefix lodging names with "Overnight in". Use the actual hotel/property name.

For advance-booking todos (reserve tickets, get permits, book restaurants, etc.), create a task tagged `travel:<tripId>` via the `add_trip_task` MCP tool — the Prep tab reads from there, and tasks are the single source of truth for trip prep.

### MCP auth
Uses `HOMELAB_API_TOKEN` env var (an `hlk_`-prefixed API token). Tokens are created in the Settings page of the home app (kirkl.in → Settings → API Tokens). The token is stored hashed in PocketBase `api_tokens` collection.

### MCP config
`.mcp.json` at project root (gitignored) configures the MCP server for Claude Code. Uses the project's local `tsx` binary to run `services/api/src/mcp.ts` over stdio.

### Remote MCP (public + tailnet)
Same tools also exposed over Streamable HTTP at `https://mcp.kirkl.in/mcp` (public) and `https://mcp.tail56ca88.ts.net/mcp` (tailnet) for the Claude mobile app and other remote clients. Mounted on the Hono API service ([services/api/src/index.ts](services/api/src/index.ts)) behind `authMiddleware`, gated by `MCP_ALLOWED_HOSTS` to refuse requests on any other Host header. Each connection's caller-supplied token becomes the MCP server's identity for that session, so multi-user works without code changes.

Two ways to authenticate:
- **Static `hlk_` API tokens** — used by Claude Code's `.mcp.json` (`type: "http"`, `headers.Authorization: "Bearer hlk_..."`). Tokens are minted in Settings → API Tokens.
- **OAuth 2.1 + PKCE** — used by Claude mobile/desktop, which reject static Bearer headers in their connector UI. The MCP server is its own OAuth authorization server: discovery at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp`, dynamic client registration at `/oauth/register`, and the standard `/oauth/authorize` (login + consent) → `/oauth/token` flow. Issued tokens are `mcpat_`-prefixed, stored hashed in PB collections (`oauth_clients`/`oauth_codes`/`oauth_access_tokens`/`oauth_refresh_tokens`, migration 0022). Auth middleware accepts both `hlk_` and `mcpat_` Bearer tokens transparently.

## Repo layout

- `apps/{home,recipes,shopping,life,upkeep,travel,money,homepage}` — frontend apps
- `home` is the shell app that embeds shopping, recipes, upkeep, travel as modules
- Most apps have their code under `app/` subdirectory; money and homepage are at root level
- `packages/backend` is `@homelab/backend` — backend abstraction interfaces + PocketBase implementations
- `packages/ui` is `@kirkl/shared` — shared React components, auth, backend provider
- `services/api` — Hono API service (recipe scraping, AI, sharing, push, data endpoints, MCP server)
- `services/ingest` — Python backend for money/financial data, managed with uv
- `services/scripts` — migration and utility scripts (export-firebase, import-to-pb, wipe-pb). One-shot recovery scripts live under `services/scripts/historical/` (e.g. `recover-life-events.ts`, `recover-recipe-events.ts`, `recover-cooking-log.py`) — kept around for forensic value but not part of the steady-state deploy path.
- `extension/` — Chrome extension for financial data capture
- `infra/` — Dockerfiles, k8s manifests, build/deploy scripts
- `infra/pocketbase/pb_migrations/` — PocketBase schema migrations. Use [`_TEMPLATE.js.example`](infra/pocketbase/pb_migrations/_TEMPLATE.js.example) as the starting point for new migrations; it imports `unwrapPbJson` from [`lib/pb-json.js`](infra/pocketbase/pb_migrations/lib/pb-json.js), which handles all three goja shapes (string, parsed object, byte-array) for PB JSON columns.
- `infra/pocketbase/pb_hooks/` — PocketBase JS hooks: `sharing.pb.js` (invite redemption), `shopping-list-cleanup.pb.js`, `task-list-cleanup.pb.js`, `recipe-box-cleanup.pb.js`, `api_tokens.pb.js`. Module-scope helpers are unreachable inside `routerAdd` callbacks under goja, so JSON-column unwrap is inlined in each hook that needs it (mirrors `lib/pb-json.js`).

## Backend abstraction (`@homelab/backend`)

All apps use interfaces from `packages/backend/` instead of calling PocketBase directly. Each app has adapters that convert between backend types and app-local types.

Interfaces: `AuthBackend`, `UserBackend`, `ShoppingBackend`, `RecipesBackend`, `UpkeepBackend`, `TravelBackend`, `LifeBackend`

Implementations live in `packages/backend/src/pocketbase/`. Apps get backends via `BackendProvider` from `@kirkl/shared`.

## Conventions

- Workspace deps use `workspace:*` protocol in package.json
- Prefer userspace installs (fnm, uv) over system-level (apt, sudo npm -g)
- PocketBase collections use snake_case; TypeScript types use camelCase; PB mappers translate between them
- Backend types are camelCase only — no snake_case aliases
- Deploy: `./infra/deploy.sh [apps...]` builds locally, pushes to registry, applies k8s manifests
- **Pre-deploy gate**: `./infra/deploy.sh` runs `pnpm typecheck` + `pnpm test` + `pnpm test:playwright` before any image build. The gate calls `infra/test-env.sh url --pb` and `--api` to discover the worktree-specific PB / API URLs, then invokes `infra/test-env.sh fresh` to cycle (down+up) the test env so each gate run starts against a freshly-rebuilt PB — auth/realtime/index state can't drift across gates. The image stays cached so the cycle is ~10-20s. `pnpm test:playwright` is `turbo run test:playwright --concurrency=1` — workspaces opt in by defining the script in their own `package.json` (currently only `apps/shopping/app`; turbo skips packages without it). Bypass with `--skip-tests` (or `SKIP_TESTS=1`) only for hotfixes — fires a loud red warning + 3s pause before continuing.
- **Per-worktree test env**: Each `.claude/worktrees/agent-*/` checkout gets a deterministic, unique pair of test ports (`8091 + cksum(basename) % 1000` for PB, same offset on `3001` for the API container) so parallel agent sessions never collide on a shared PB. Main checkout keeps the legacy `8091/3001`. Discover the URL for the current shell with `infra/test-env.sh url [--pb|--api]` or read `.test-env-port` at the worktree root. `TEST_PB_PORT` env var manually overrides the derivation. All test setups (`apps/*/vitest.e2e.config.ts`, `services/api/src/e2e/*.test.ts`, `packages/ui/src/test-utils.ts`) honor `PB_TEST_URL` / `PB_URL` env vars and fall back to the legacy default. The same offset applies to vite dev-server ports via `resolveDevVitePort(base)` in `@kirkl/vite-preset` (used by every app's `vite.config.ts` and the Playwright configs in `apps/{home,recipes,shopping}/app/playwright.config.ts`) so parallel `pnpm dev` / `pnpm test:playwright` runs each get their own dev server instead of silently sharing one via `webServer.reuseExistingServer`.
- **Test env is self-healing + fail-loud** (`infra/test-env.sh`): `up` now (1) **auto-reaps orphans first** — test containers whose worktree dir under `.claude/worktrees/` no longer exists are stopped + removed (containers *and* their compose network) before any port is bound, so a stale container from a dead worktree can never silently steal a live checkout's port; (2) **verifies host-port ownership** — the readiness probe confirms *our* compose container is the one publishing the host port, not merely that *something* answers there, which is what let a squatter's PB masquerade as healthy and produce the three-way-mismatch 401s; (3) **fails loud** — if a foreign live container (or main) holds the port, or our container comes up with no host mapping, `up` exits non-zero naming the exact squatting container and the port, instead of printing "Ready." on a half-up state. Reap orphans on demand with `infra/test-env.sh reap` (`--dry-run` to preview). Reaping handles both the current `homelab-test-<basename>-{pocketbase,api}-1` naming and the legacy `agent-<hash>-{pocketbase,api}-1` scheme; the main checkout (`homelab`) and any container that resolves to a live worktree are never touched.
  - `infra/test-env.sh fresh` does `down + up` under a per-worktree `flock` on `<worktree>/.test-env.lock` — used by the pre-deploy gate to guarantee a hermetic PB per invocation (auth/realtime/index state can't accumulate across runs). Concurrent gates in the same worktree serialize on the lock; parallel worktrees are unaffected (different lock files, different ports).
- **Cleaning up worktree-scoped processes**: never use `pkill -f vite` (or `pkill -f vitest` / `pkill -f playwright`) from inside a worktree — the pattern matches every matching process on the host, so cleanup in one worktree will silently kill a sibling worktree's running dev server / test runner. Use `./infra/scripts/worktree-kill.sh [filter ...]` instead — it walks `/proc/<pid>/cwd` and only signals processes whose cwd is inside the *current* worktree. Argless = kill all worktree-scoped processes; pass cmdline substrings to narrow (`worktree-kill.sh vite vitest`). The script refuses to run from the main checkout (too broad), excludes itself and its parent shell, and SIGTERMs first with a 3s grace before SIGKILL. Pass `-n`/`--dry-run` to preview.
- Private Docker registry at `registry.kirkl.in` — deploys take ~30-60s
- API tokens: `hlk_` prefix, SHA-256 hashed in PocketBase, created via Settings UI
- `.env` at project root has secrets (gitignored): `PB_ADMIN_PASSWORD`, `HOMELAB_API_TOKEN`, `VITE_GOOGLE_MAPS_API_KEY`
- `pnpm lint:pb` — runs `infra/scripts/lint-pb-migrations.sh`, which fails on the goja byte-array footguns (`JSON.parse(JSON.stringify(r.get(...)))` and unwrapped JSON-column field access). Wired into `deploy.sh` so a broken migration can't reach prod.
- `pnpm test:pb-hooks` — vitest against `unwrapPbJson` + PB hook execution stubs in `packages/backend/src/pocketbase-hooks/`.
- New PB migrations: copy [`_TEMPLATE.js.example`](infra/pocketbase/pb_migrations/_TEMPLATE.js.example) and rename to `YYYYMMDD_HHMMSS_<slug>.js`. Always read JSON columns through `unwrapPbJson` from [`lib/pb-json.js`](infra/pocketbase/pb_migrations/lib/pb-json.js) — never `r.get("jsonField")` directly (see 2026-05-22 incident).

## Adding a new app

Whenever you add a new public-facing app or internal service, touch every file in this checklist — partial wiring is the most common source of "why isn't this routing / monitored / deployed":

1. `apps/<name>/` (or service equivalent) — code
2. `infra/deploy.sh` — add to `APP_BUILDS` (Vite frontend served by the shared `app.Dockerfile`) or `SERVICE_BUILDS` (service with its own Dockerfile, like `homepage`/`pocketbase`/`ingest`/`functions`/`event-watcher`). One line in one of the two maps; the build loop is unified. If you created a new manifest file in step 3 below, also add it to `infra/k8s/kustomization.yaml`'s `resources:` — `kubectl apply -k` won't pick it up otherwise.
3. `infra/k8s/apps.yaml` — `Deployment` + `Service` (skip if it's not a frontend; backend services get their own manifest)
4. `infra/k8s/caddy.yaml` — public Caddy site block, OR for tailnet-only: `kubectl port-forward` systemd unit + `tailscale serve` rule on the VPS (matches `money`/`ingest`/`beszel`/`gatus` pattern)
5. `infra/k8s/gatus.yaml` — add a check entry to the `gatus-config` ConfigMap so uptime is monitored from day one

Health endpoints to expose so Gatus has something to hit:
- Frontend nginx pods: `GET /` returning 200 is enough
- Backend services: a `/health` (or `/api/health` for PB-style services) returning 200 + a known body shape

## Monitoring stack

- **Beszel** (system metrics) — hub at `https://beszel.tail56ca88.ts.net/`. Agent connects via WebSocket using `TOKEN`+`KEY` from the `beszel-agent-token` k8s Secret (gitignored, created out-of-band).
- **Gatus** (uptime checks) — UI at `https://gatus.tail56ca88.ts.net/`. Edit checks in `infra/k8s/gatus.yaml`'s `gatus-config` ConfigMap, then `./infra/deploy.sh --push-only` (or `kubectl rollout restart -n homelab deploy/gatus`) to pick up changes.
- **Monitor frontend** — `https://monitor.tail56ca88.ts.net/` (tailnet-only, surfaces deployments + uptime).
- **Deployment history** — `deployments` PB collection. Written automatically by `infra/deploy.sh`'s exit trap. Read via `GET /fn/data/deployments`.
- **Tailscale operator** — All tailnet apps use the Tailscale Kubernetes operator (Ingress with `ingressClassName: tailscale`), which auto-provisions per-app tailnet devices and HTTPS certs. Operator config in `infra/k8s/tailscale-operator.yaml` (vendored upstream + env overrides for `OPERATOR_INITIAL_TAGS`/`PROXY_TAGS=tag:k8s`). OAuth client + ACL `tagOwners` use a single `tag:k8s` — Tailscale enforces *exact-match* between OAuth `authTags` and the tags requested at mint time, so single-tag is simpler. To expose a new app: add an `Ingress` with `ingressClassName: tailscale` and `tls.hosts: [<name>]`.

### Backups & data retention

All CronJobs live in [`infra/k8s/cronjobs.yaml`](infra/k8s/cronjobs.yaml).

| CronJob | Schedule (UTC) | Local (PT) | Purpose |
|---|---|---|---|
| `pb-backup-daily` | `0 9 * * *` | 2:00 AM | Creates `daily-YYYY-MM-DDtHH-MM-SSz.zip` under `/pb/pb_data/backups/` via PB's `/api/backups` |
| `pb-backup-prune` | `5 9 * * *` | 2:05 AM | Applies tiered retention (see below) |
| `pod-events-prune` | `30 9 * * *` | 2:30 AM | Deletes `pod_events` rows with `type="Normal"` older than 10 days; `type="Warning"` kept forever (low volume, high forensic value) |

Backup retention tiers (enforced by `pb-backup-prune`):
- **`daily-*`** — keep 90 days, EXCEPT the chronologically-first daily of each calendar month (monthly tier, kept forever). At ~30 MB/snapshot that's ~3 GB/yr.
- **`pre-deploy-*`** — keep only the newest 10 (by `.modified`), delete the rest regardless of age. Count-bounded rather than time-bounded because at ~12 deploys/day during active work a 14-day window let these accrue to 75+ (~2 GB). Written by the pre-deploy hook in `infra/deploy.sh` (tagged with the git SHA, e.g. `pre-deploy-abc1234-20260524t090000z.zip`); belt-and-suspenders on top of the nightly so a same-day rollback always has a fresh baseline. Backup failure does NOT abort the deploy — it's insurance, not critical-path.
- **`pre-migration-*`** — keep forever.
- **Anything else** (`emergency-*`, `pre-restore-*`, manual) — keep forever.

Backup freshness monitor:
- `GET /fn/health/backups` (public, no auth) returns `{ age_hours, latest_key, size }` for the newest `daily-*`. See [`services/api/src/index.ts`](services/api/src/index.ts).
- Gatus check `pb-backups-fresh` polls every 5m and fails if `age_hours > 25` (the +1h gives the daily CronJob some slack if it lags).

### Possible future work

Deferred but worth picking up if a need surfaces:

- **App error reporting** — `error_events` PB collection + `/fn/data/errors` endpoint, plus a global error handler in `@kirkl/shared` that POSTs uncaught frontend errors and a wrapped `handler()` in the api service that does the same for backend ones. Surface in the monitor frontend as a "Recent errors" pane. (Original Phase 2 of the monitoring buildout, deferred because the data sink alone gives no value until something writes to it.)
- **Push notifications on Gatus failures** — wire Gatus's webhook alerts into the existing VAPID push setup (`api-secrets` already has the keys). Converts uptime monitoring from "you check the dashboard" to "your phone buzzes when something dies."
- **Native Beszel charts in the monitor frontend** — query Beszel's PocketBase API directly and render CPU/memory/disk/network charts natively, instead of linking out to the Beszel UI. Needs a read-only auth path into Beszel's PB (separate user with read-only API token, stored in a k8s Secret, injected at the monitor's nginx layer like `HOMELAB_API_TOKEN` is). Couple hours of work.
- **Gatus tailnet-end checks** — current Gatus checks hit cluster-internal Service IPs, which prove the pod is healthy but don't catch a broken Tailscale operator proxy. To check the tailnet-edge URL end-to-end, Gatus would need to be tailnet-attached itself (e.g., a tailscale sidecar in its pod). Low priority since the operator's stable.
- **Money → PocketBase migration** — retire ingest's sqlite as system of record; money joins the `@homelab/backend` pattern. Plan in [`services/ingest/MIGRATION.md`](services/ingest/MIGRATION.md). ~2–3 weeks focused work. MCP access already covered by the TS proxy in `services/api/src/routes/money.ts`.
- **VPS state outside the repo** — sysctl tweaks (e.g. `fs.inotify.max_user_watches`), 1Password SSH agent config, k3s install script invocation, etc. are currently undocumented manual steps. If the box ever gets rebuilt, recovering takes archaeology. Worth either a bootstrap script under `infra/scripts/` or a small Ansible playbook.
- **Off-volume backup target** — daily backups currently live on the same PVC as the PB data they're protecting; a disk-level failure or accidental PVC delete loses both. Wire `pb-backup-daily` (or a sidecar) to push each new `daily-*.zip` to B2/S3 for true disaster recovery. ~1 day of work, plus a credentials secret.
- **Broader migration-test harness** — `pnpm lint:pb` catches the specific goja byte-array footgun, but schema/data-correctness more broadly (e.g. a migration that drops a field still referenced by app code) is still uncovered. A CI job that spins up a fresh PB, applies all migrations, and runs a smoke pass would close that gap.
- **Mirror's `set` Mutation kind → `create` rename** — the legacy "set" name dates from before the meaning settled. Renaming clarifies intent, but persisted IDB entries in users' browsers still carry `{kind: "set", ...}`. Needs a `DB_VERSION` bump in `packages/backend/src/wrapped-pb/idb.ts` that maps old "set" → new "create" on load so in-flight writes survive the deploy.
- **Render bootstrap errors in SyncDot** — mirror bootstrap failures (non-404 errors during initial getList) now flow into `wpb.debug` ring buffer as `bootstrap-error` events; queryable today via `window.__wpbDebug.events()`. The follow-up is wiring SyncDot to surface them visually so a silently-failing fetch isn't invisible to the user. Small UI change.
- **`unpersistMutation` → awaited** — currently fire-and-forget after a dispatch ack. The `composeView` fix (don't apply persisted `set` over a server snapshot) made the "tab closes mid-IDB-delete leaves stale entry" hole harmless. Awaiting it before resolving the dispatch chain would close the hole entirely at the cost of one IDB write per ack. Cascades to test timing (e.g. `dispatchMutation` callers that don't await would race the next call). Take it on once a related write-path change is being made.
- **Narrow `mirror.resync()`'s trigger from "every focus" to "SSE actually dropped"** — resync is necessary (PocketBase realtime does NOT replay events missed while an SSE connection is down — verified against the SDK; e.g. a backgrounded phone never sees the other device's edit until resume), but today `useRealtimeResync` ([`packages/ui/src/backend-provider.tsx`](packages/ui/src/backend-provider.tsx)) fires a full refetch of *every* active slice on every `focus`/`pageshow`/`visibilitychange` — a wasteful "focus storm" on routine tab-switches where the connection never dropped. There used to be a better two-signal design (a `realtimeDirty` flag set on `onDisconnect`, resync only on the next `PB_CONNECT`) that was deleted with the legacy `subscribe()` path in commit `161fab7`, leaving the blunt focus-only trigger. Restore it: resync on **PB_CONNECT** (precise — only after a real drop+reconnect) **plus** focus/visibility as the backstop for *silent* mobile suspends (where the OS freezes the network stack so the SDK never fires a clean disconnect/PB_CONNECT). Strictly less steady-state work, same recovery guarantees. Don't drop the focus arm — it's the only thing that catches the silent-suspend case. Pattern reference: the deleted `d3bf90e` wiring.

## Money debugging

When inspecting money captures, identity extraction, or any JSON from ingest, **use these tools — never `sed`/`grep`/`python -c` over ssh**:

- **JSON tools** (allow-listed in `.claude/settings.json`):
  - `jq` — field extraction, filtering
  - `gron` — every leaf as a path (`gron x.json | grep emails`); best for "what shape is this?"
  - `genson` — generate a schema from a sample
  - The pod doesn't have them; copy files locally first with `kubectl cp`.
- **`services/scripts/fetch-network-log.sh`** — pulls a captured network log via `/api/debug/network-log/{list,latest,get}` to `~/.config/money/debug/`. Usage: `fetch-network-log.sh chase latest`.
- **`services/ingest/scripts/scrub_fixture.py`** — redacts PII from a capture so it can be committed as a test fixture. Has `--check` mode for CI.
- **`pnpm test:ingest`** from the repo root runs the ingest test suite. Handles the `VIRTUAL_ENV`/conda poisoning issue. Args pass through (e.g. `pnpm test:ingest tests/test_identity.py -v`).
- **`infra/scripts/m <args>`** — wraps `kubectl exec -n homelab deploy/ingest -- money "$@"` over ssh. Run `m replay-capture latest` / `m capture list --unresolved` from the laptop instead of building ssh heredocs. Set `INGEST_SSH_HOST` to override the default `scott@5.78.200.161`.
- **Punch list** of further tools to build (replay-capture, capture inspect, config edit, etc.) lives in [`MONEY_IMPROVEMENTS.md`](MONEY_IMPROVEMENTS.md) Tier-1 items C1–C6. Next-touch heuristic: if you reach for the same inline-python pattern twice, the third time add it as a script/subcommand.

## Three Man Team
Available agents: Alice (Architect), Bob (Builder), Robert (Reviewer)
