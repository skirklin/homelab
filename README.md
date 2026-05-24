# homelab

Personal web apps monorepo for a single user, self-hosted as a k3s single-node cluster on a Hetzner VPS. PocketBase is the system of record; Caddy fronts everything with Let's Encrypt TLS; each frontend is a Vite build served by nginx; a Hono API service handles scraping, AI, sharing, push, and an MCP server. Production lives at **`kirkl.in`**.

## Apps

| Subdomain | App | Notes |
|---|---|---|
| `kirkl.in` | home | Shell app; also serves `/tasks/*` (unified task outliner) |
| `beta.kirkl.in` | home-beta | Parallel `home` build sharing prod PB / API / data |
| `recipes.kirkl.in` | recipes | Standalone deploy + module under home |
| `shopping.kirkl.in` | shopping | Standalone deploy + module under home |
| `upkeep.kirkl.in` | upkeep | Kanban task view |
| `travel.kirkl.in` | travel | Trip planner |
| `life.kirkl.in` | life | Standalone (no longer bundled into home) |
| `me.kirkl.in` | homepage | Static personal page |
| `api.kirkl.in` | pocketbase + Hono `/fn/*` | Same hostname, split by path |
| `registry.kirkl.in` | private Docker registry | Auth required |

Tailnet-only: `money` (financial dashboard), `ingest` (Python money backend), `monitor` (deploys + uptime UI), `beszel` (metrics), `gatus` (uptime). Exposed via the Tailscale Kubernetes operator.

## Repo layout

- `apps/` — frontend apps: `home`, `recipes`, `shopping`, `upkeep`, `travel`, `life`, `money`, `homepage`, `monitor`. Most apps live under an `app/` subdirectory; `money`, `homepage`, and `monitor` are flatter.
- `packages/` — shared workspace packages:
  - `backend` (`@homelab/backend`) — backend interfaces + PocketBase implementations
  - `ui` (`@kirkl/shared`) — shared React components, auth, backend provider
  - `vite-preset` — shared Vite config
- `services/` — backend services:
  - `api` — Hono API (recipe scraping, AI, sharing, push, data endpoints, MCP server)
  - `ingest` — Python money/financial backend (managed with `uv`)
  - `event-watcher` — k8s event sink → PocketBase
  - `scripts` — migration + utility scripts; one-shot recovery scripts live under `services/scripts/historical/`
- `infra/` — Dockerfiles, k8s manifests (Kustomize), `deploy.sh`, PB migrations + hooks
- `extension/` — Chrome extension for financial data capture
- `tools/`, `docs/`, `billing-cap/` — supporting bits

For the full structure, conventions, MCP tool reference, and the new-app wiring checklist, see [`CLAUDE.md`](CLAUDE.md).

## Stack

- **Frontend**: Vite + React + TypeScript (pnpm workspaces + Turborepo)
- **Backend**: PocketBase (StatefulSet on k3s with a PVC), Hono API in `services/api`, Python ingest service in `services/ingest`
- **Auth**: PocketBase users; `hlk_` API tokens for tooling (Settings → API Tokens); OAuth 2.1 + PKCE for Claude mobile MCP (`mcpat_` tokens)
- **Hosting**: k3s on a Hetzner VPS, Caddy for TLS + reverse proxy, private Docker registry at `registry.kirkl.in`
- **Monitoring**: Beszel (system metrics) + Gatus (uptime) + a custom `monitor` frontend, all tailnet-only

## Local dev

```bash
pnpm install
pnpm -F home dev          # or recipes, shopping, life, travel, …
```

Most apps need PB credentials and other secrets in the project-root `.env` (gitignored — see `CLAUDE.md` for the expected keys: `PB_ADMIN_PASSWORD`, `HOMELAB_API_TOKEN`, `VITE_GOOGLE_MAPS_API_KEY`, …). Without them you can sign in but most data calls will 401.

Useful root scripts:

```bash
pnpm typecheck            # turbo typecheck across the workspace
pnpm lint:pb              # lint PB migrations for goja byte-array footguns
pnpm test:pb-hooks        # vitest against PB hook stubs
pnpm test:ingest          # Python ingest test suite (handles VIRTUAL_ENV poisoning)
pnpm test:env:up          # bring up test PB (:8091) + API (:3001) in Docker
pnpm test                 # turbo test
```

Beta and prod share the same PB instance, so dev should point at the test environment (`test:env:up`) — not prod — for anything that mutates state.

## Deploy

```bash
./infra/deploy.sh [app ...]      # build → push to registry.kirkl.in → kubectl apply -k
./infra/deploy.sh --beta         # builds only home and rolls out home-beta
./infra/deploy.sh --push-only    # re-apply manifests without rebuilding images
```

`deploy.sh`:
- Runs `pnpm lint:pb` before anything else; a broken migration can't reach prod.
- Snapshots PB to a `pre-deploy-<sha>-*.zip` backup (best-effort; failure does not abort).
- Writes a row to the `deployments` PB collection on exit so the monitor frontend can show history.

For wiring a brand-new app/service end-to-end (build map, k8s manifest, Caddy block, Gatus check), see the "Adding a new app" checklist in [`CLAUDE.md`](CLAUDE.md).

## Where to look next

- [`CLAUDE.md`](CLAUDE.md) — full project context, conventions, MCP tool reference, monitoring + backup details
- [`apps/recipes/README.md`](apps/recipes/README.md), [`apps/money/README.md`](apps/money/README.md) — app-specific notes
- [`apps/life/ROADMAP.md`](apps/life/ROADMAP.md) — life-app phasing plan
- [`MONEY_IMPROVEMENTS.md`](MONEY_IMPROVEMENTS.md) — money ingest punch list
- [`services/ingest/MIGRATION.md`](services/ingest/MIGRATION.md) — plan for moving money onto PocketBase
- Forward-looking sync/storage explorations (not yet executed): [`SUPABASE-MIGRATION.md`](SUPABASE-MIGRATION.md), [`ELECTRIC-SQL-MIGRATION.md`](ELECTRIC-SQL-MIGRATION.md), [`SYNC-ENGINE-DESIGN.md`](SYNC-ENGINE-DESIGN.md)

## License

MIT
