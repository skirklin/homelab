# Project Context

You are the Architect on this project. Read ARCHITECT.md before doing anything else.

## What this is

Personal web apps monorepo, self-hosted on PocketBase + Caddy on a VPS (Hetzner, 5.78.200.161, user `scott`).

## Current state (2026-04-12)

All apps deployed and serving. Backend abstraction layer complete. MCP server connected.

### Architecture

k3s single-node cluster. Caddy pod handles TLS (Let's Encrypt) and reverse proxies to app services. Each frontend app is an nginx container serving Vite build output. PocketBase is a StatefulSet with a PVC. API service (Hono/TypeScript) handles recipe scraping, AI, sharing, push notifications, and data endpoints.

| Subdomain | k8s Service |
|---|---|
| `beta.kirkl.in` | home |
| `recipes.beta.kirkl.in` | recipes |
| `shopping.beta.kirkl.in` | shopping |
| `upkeep.beta.kirkl.in` | upkeep |
| `travel.beta.kirkl.in` | travel |
| `me.beta.kirkl.in` | homepage |
| `api.beta.kirkl.in` | pocketbase (direct) + functions (under `/fn/`) |
| `registry.beta.kirkl.in` | private Docker registry (auth required) |

Money app is tailnet-only via Tailscale Serve (`https://homelab-0.tail56ca88.ts.net`).
Life is a module embedded in the home app, not a standalone deployment.

## MCP Server

**This project has an MCP server connected.** Use it to read and write all app data.

The homelab MCP tools are available as `mcp__homelab__*`. Use them whenever the user asks about their recipes, shopping lists, travel plans, tasks, or life data.

### Available tools (31 total):

**Recipes (read):**
- `list_boxes` — list all recipe boxes
- `search_recipes` — search by name across all boxes
- `get_recipe` — full recipe details by ID

**Recipes (write):**
- `scrape_recipe` — scrape a recipe from a URL
- `generate_recipe` — AI recipe generation from a text prompt
- `create_recipe_box` — create a new box
- `add_recipe_to_box` — add a recipe with structured data

**Shopping (read):**
- `list_shopping_lists` — list all lists
- `list_shopping_items` — items in a list

**Shopping (write):**
- `add_shopping_item` — add item to a list
- `check_shopping_item` — toggle checked status
- `remove_shopping_item` — delete an item
- `clear_checked_items` — done shopping, clear checked

**Upkeep (read):**
- `list_tasks` — list tasks in a task list

**Upkeep (write):**
- `add_task` — create a task
- `complete_task` — mark done
- `snooze_task` — snooze until a date

**Travel (read):**
- `list_travel_trips` — all trips across logs
- `get_travel_trip` — single trip with activities + itineraries
- `search_travel` — search trips/activities by destination/name

**Travel (write):**
- `add_travel_trip` — create a trip
- `update_travel_trip` — update trip fields
- `add_travel_activity` — create an activity
- `update_travel_activity` — update activity fields (including trip_id reassignment)
- `add_travel_itinerary` — create an itinerary
- `update_travel_itinerary` — update itinerary fields or replace days array
- `delete_travel_trip` — delete a trip
- `delete_travel_activity` — delete an activity
- `delete_travel_itinerary` — delete an itinerary

**Life (read):**
- `list_life_entries` — recent entries (optional days filter)

**Sharing:**
- `create_invite` — generate a sharing invite link

### Activity field guide

When creating or updating travel activities, fill in ALL relevant fields — don't put structured data in the description:

| Field | Purpose | Examples |
|---|---|---|
| `name` | Short name. No "Overnight in" prefix for lodging. | `Desert Botanical Garden`, `SpringHill Suites Phoenix` |
| `category` | Type of activity | `Attraction`, `Lodging`, `Transport`, `Food`, `Adventure`, `Culture` |
| `location` | City or area | `Phoenix, AZ`, `Taos, NM` |
| `description` | Brief qualifying note only — what makes this specific. NOT costs, durations, or logistics. | `Ancient Puebloan great houses, 650+ rooms. Unpaved road in.` |
| `duration_estimate` | How long the activity takes (not including travel to/from) | `2h`, `half day`, `1.5h` |
| `cost_notes` | Price info | `$25/person`, `Free`, `$15 parking` |
| `setting` | Indoor/outdoor/both | `outdoor`, `indoor`, `both` |
| `trip_id` | Which trip this belongs to | (record ID) |

**Do not** put durations in the description. **Do not** prefix lodging names with "Overnight in". Use the actual hotel/property name.

### MCP auth
Uses `HOMELAB_API_TOKEN` env var (an `hlk_`-prefixed API token). Tokens are created in the Settings page of the home app (beta.kirkl.in → Settings → API Tokens). The token is stored hashed in PocketBase `api_tokens` collection.

### MCP config
`.mcp.json` at project root (gitignored) configures the MCP server for Claude Code. Uses the project's local `tsx` binary to run `services/api/src/mcp.ts`.

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
- Private Docker registry at `registry.beta.kirkl.in` — deploys take ~30-60s
- API tokens: `hlk_` prefix, SHA-256 hashed in PocketBase, created via Settings UI
- `.env` at project root has secrets (gitignored): `PB_ADMIN_PASSWORD`, `HOMELAB_API_TOKEN`, `VITE_GOOGLE_MAPS_API_KEY`

## Three Man Team
Available agents: Alice (Architect), Bob (Builder), Robert (Reviewer)
