# Project Context

You are the Architect on this project. Read ARCHITECT.md before doing anything else.

## What this is

Personal web apps monorepo, self-hosted on PocketBase + Caddy on a VPS (Hetzner, 5.78.200.161, user `scott`).

## Current state (2026-04-19)

Production is **`kirkl.in`**. Firebase → PocketBase migration is complete; PB on the VPS is authoritative for all app data. Caddy still serves `beta.kirkl.in` as an alias during the transition window.

### Architecture

k3s single-node cluster. Caddy pod handles TLS (Let's Encrypt) and reverse proxies to app services. Each frontend app is an nginx container serving Vite build output. PocketBase is a StatefulSet with a PVC. API service (Hono/TypeScript) handles recipe scraping, AI, sharing, push notifications, and data endpoints.

**URL config**: single `DOMAIN` env var (default `kirkl.in`) drives everything via `services/api/src/config.ts`. Frontend gets `VITE_DOMAIN` baked in at build time via `deploy.sh`. DNS: Squarespace `@` and `*` both A → 5.78.200.161.

| Subdomain | k8s Service |
|---|---|
| `kirkl.in` | home |
| `recipes.kirkl.in` | recipes |
| `shopping.kirkl.in` | shopping |
| `upkeep.kirkl.in` | upkeep (Kanban view) |
| `travel.kirkl.in` | travel |
| `me.kirkl.in` | homepage |
| `api.kirkl.in` | pocketbase (direct) + functions (under `/fn/`) |
| `registry.kirkl.in` | private Docker registry (auth required) |

Home app also serves `/tasks/*` (unified task outliner) and `/life/*` (life module).
Money app is tailnet-only via Tailscale Serve (`https://homelab-0.tail56ca88.ts.net`).

## MCP Server

**This project has an MCP server connected.** Use it to read and write all app data.

The homelab MCP tools are available as `mcp__homelab__*`. Use them whenever the user asks about their recipes, shopping lists, travel plans, tasks, or life data.

### Available tools (64 total):

**Recipes (read):**
- `list_boxes` — list all recipe boxes
- `search_recipes` — search by name across all boxes
- `get_recipe` — full recipe details by ID
- `list_cooking_log` — cooking log entries for a recipe (newest first)

**Recipes (write):**
- `scrape_recipe` — scrape a recipe from a URL
- `generate_recipe` — AI recipe generation from a text prompt
- `create_recipe_box` — create a new box
- `update_recipe_box` — rename, change description, or set visibility
- `delete_recipe_box` — delete a box (cascades to recipes + cooking log)
- `subscribe_to_box` / `unsubscribe_from_box` — manage the authenticated user's box subscriptions
- `add_recipe_to_box` — add a recipe with structured data
- `update_recipe` — replace a recipe's data (use after `get_recipe` to fetch + modify)
- `delete_recipe` — delete a recipe
- `set_recipe_visibility` — set per-recipe visibility
- `add_cooking_log_entry` — log a cooking session (optional notes/timestamp)
- `update_cooking_log_entry` — edit cooking log notes
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
- `list_tasks` — list tasks (filter by parent_id, tag, task_type)

**Tasks (write):**
- `add_task` — create a task (supports nesting via parent_id, recurring vs one_shot, notify_users)
- `update_task` — update fields (typed schema; pass only the fields to change)
- `delete_task` — delete task and all descendants
- `complete_task` — toggle completion (recurring sets last_completed; one_shot toggles completed)
- `snooze_task` / `unsnooze_task` — snooze until a date or clear snooze

Travel checklists are just tasks tagged `travel:<tripId>`, auto-nested under a `Trips/<name>/` container in the outliner.

**Travel (read):**
- `list_travel_trips` — all trips across logs
- `get_travel_trip` — single trip with activities + itineraries
- `get_travel_activity` — full activity details (geocoding, flight info, verdict/notes)
- `search_travel` — search trips/activities by destination/name

**Travel (write):**
- `add_travel_trip` — create a trip
- `update_travel_trip` — update trip fields
- `add_travel_activity` — create an activity
- `update_travel_activity` — update activity fields (including verdict, personal_notes, experienced_at for post-trip reflection)
- `add_travel_itinerary` — create an itinerary
- `update_travel_itinerary` — update itinerary fields or replace days array
- `delete_travel_trip` — delete a trip
- `delete_travel_activity` — delete an activity
- `delete_travel_itinerary` — delete an itinerary

**Life (read):**
- `list_life_entries` — recent entries (optional days filter)

**Life (write):**
- `add_life_entry` — log a widget event (data shape varies per widget type)
- `update_life_entry` — change timestamp, merge data, or set notes
- `delete_life_entry` — delete an entry

**Sharing:**
- `create_invite` — generate a sharing invite link (optional expiry)
- `list_invites` — list invites the user created (newest first)
- `update_invite` — change expiry on an existing invite
- `delete_invite` — revoke an invite

### Activity field guide

When creating or updating travel activities, fill in ALL relevant fields — don't put structured data in the description:

| Field | Purpose | Examples |
|---|---|---|
| `name` | Short name. No "Overnight in" prefix for lodging. | `Desert Botanical Garden`, `SpringHill Suites Phoenix` |
| `category` | Type of activity | `Transportation`, `Accommodation`, `Hiking`, `Adventure`, `Food & Dining`, `Sightseeing`, `Shopping`, `Nightlife`, `Culture`, `Relaxation`, `Other` |
| `location` | City or area | `Phoenix, AZ`, `Taos, NM` |
| `description` | Brief qualifying note only — what makes this specific. NOT costs, durations, or logistics. | `Ancient Puebloan great houses, 650+ rooms. Unpaved road in.` |
| `duration_estimate` | How long the activity takes (not including travel to/from) | `2h`, `half day`, `1.5h` |
| `walk_miles` | Distance on foot — for hikes, the trail length | `3.2`, `5.5` |
| `elevation_gain_feet` | Elevation gain (Hiking only) | `1400`, `3200` |
| `difficulty` | Hike difficulty (Hiking only) | `easy`, `moderate`, `hard`, `strenuous` |
| `cost_notes` | Price info | `$25/person`, `Free`, `$15 parking` |
| `setting` | Indoor/outdoor/both | `outdoor`, `indoor`, `both` |
| `trip_id` | Which trip this belongs to | (record ID) |

**Do not** put durations in the description. **Do not** prefix lodging names with "Overnight in". Use the actual hotel/property name.

### MCP auth
Uses `HOMELAB_API_TOKEN` env var (an `hlk_`-prefixed API token). Tokens are created in the Settings page of the home app (kirkl.in → Settings → API Tokens). The token is stored hashed in PocketBase `api_tokens` collection.

### MCP config
`.mcp.json` at project root (gitignored) configures the MCP server for Claude Code. Uses the project's local `tsx` binary to run `services/api/src/mcp.ts` over stdio.

### Remote MCP (tailnet)
Same tools also exposed over Streamable HTTP at `https://mcp.tail56ca88.ts.net/mcp` for the Claude mobile app and other remote clients. Mounted on the Hono API service ([services/api/src/index.ts](services/api/src/index.ts)) behind `authMiddleware`, gated by `MCP_ALLOWED_HOSTS` to refuse requests on any other Host header. Each connection's caller-supplied `hlk_` token becomes the MCP server's identity for that session, so multi-user works without code changes — every user just needs their own token from Settings → API Tokens.

## Repo layout

- `apps/{home,recipes,shopping,life,upkeep,travel,money,homepage}` — frontend apps
- `home` is the shell app that embeds shopping, recipes, life, upkeep, travel as modules
- Most apps have their code under `app/` subdirectory; money and homepage are at root level
- `packages/backend` is `@homelab/backend` — backend abstraction interfaces + PocketBase implementations
- `packages/ui` is `@kirkl/shared` — shared React components, auth, backend provider
- `services/api` — Hono API service (recipe scraping, AI, sharing, push, data endpoints, MCP server)
- `services/ingest` — Python backend for money/financial data, managed with uv
- `services/scripts` — migration and utility scripts (export-firebase, import-to-pb, wipe-pb)
- `extension/` — Chrome extension for financial data capture
- `infra/` — Dockerfiles, k8s manifests, build/deploy scripts
- `infra/pocketbase/pb_migrations/` — PocketBase schema migrations
- `infra/pocketbase/pb_hooks/` — PocketBase JS hooks (invite redemption)

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
- Private Docker registry at `registry.kirkl.in` — deploys take ~30-60s
- API tokens: `hlk_` prefix, SHA-256 hashed in PocketBase, created via Settings UI
- `.env` at project root has secrets (gitignored): `PB_ADMIN_PASSWORD`, `HOMELAB_API_TOKEN`, `VITE_GOOGLE_MAPS_API_KEY`

## Adding a new app

Whenever you add a new public-facing app or internal service, touch every file in this checklist — partial wiring is the most common source of "why isn't this routing / monitored / deployed":

1. `apps/<name>/` (or service equivalent) — code
2. `infra/deploy.sh` — add to the `APP_BUILDS` map (or as a special case if it has its own Dockerfile, like `homepage`/`pocketbase`/`ingest`/`functions`)
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

### Possible future work

Deferred but worth picking up if a need surfaces:

- **App error reporting** — `error_events` PB collection + `/fn/data/errors` endpoint, plus a global error handler in `@kirkl/shared` that POSTs uncaught frontend errors and a wrapped `handler()` in the api service that does the same for backend ones. Surface in the monitor frontend as a "Recent errors" pane. (Original Phase 2 of the monitoring buildout, deferred because the data sink alone gives no value until something writes to it.)
- **Push notifications on Gatus failures** — wire Gatus's webhook alerts into the existing VAPID push setup (`api-secrets` already has the keys). Converts uptime monitoring from "you check the dashboard" to "your phone buzzes when something dies."
- **Native Beszel charts in the monitor frontend** — query Beszel's PocketBase API directly and render CPU/memory/disk/network charts natively, instead of linking out to the Beszel UI. Needs a read-only auth path into Beszel's PB (separate user with read-only API token, stored in a k8s Secret, injected at the monitor's nginx layer like `HOMELAB_API_TOKEN` is). Couple hours of work.
- **Gatus tailnet-end checks** — current Gatus checks hit cluster-internal Service IPs, which prove the pod is healthy but don't catch a broken Tailscale operator proxy. To check the tailnet-edge URL end-to-end, Gatus would need to be tailnet-attached itself (e.g., a tailscale sidecar in its pod). Low priority since the operator's stable.

## Three Man Team
Available agents: Alice (Architect), Bob (Builder), Robert (Reviewer)
