# Project Context

You are the Architect on this project. Read ARCHITECT.md before doing anything else.

## What this is

Personal web apps monorepo, migrating from Firebase (Firestore, Auth, Cloud Functions) to self-hosted PocketBase + Caddy on a VPS (Hetzner, 5.78.200.161, user `scott`).

## Current state (2026-04-07)

Infra deployed and serving. PocketBase backend migration complete for all apps. E2E tests in place.

### Done
- Monorepo structure finalized with pnpm workspaces + Turborepo
- k3s + Docker on VPS, Caddy with auto Let's Encrypt
- All frontend apps built and deployed as nginx containers
- PocketBase deployed with schema migration (16 collections, API rules)
- DNS: `beta.kirkl.in` + `*.beta.kirkl.in` → VPS, HTTPS working
- PocketBase admin: scott.kirklin@gmail.com at https://api.beta.kirkl.in/_/
- Typed PocketBase client package at packages/pb-client
- All app backends migrated from Firebase to PocketBase (shopping, life, recipes, upkeep, travel)
- Vitest integration tests for all app backends (shopping, life, recipes, upkeep, travel, home)
- Playwright browser tests for shopping app (9 tests) and home app (28 tests covering all modules)
- Fixed PocketBase auto-cancellation bug across all modules (init requests need `$autoCancel: false`)
- Renamed all "groceries" references to "shopping"

### Not done yet
- Cloud Functions need replacing with PocketBase hooks or custom endpoints
- money app should eventually move to tailnet-only (Tailscale not set up)
- Data migration from Firestore (if needed)
- Google OAuth setup in PocketBase admin (required for real users)
- Some Playwright tests still flaky (recipes spinner, some list creation races)

## Architecture

k3s single-node cluster. Caddy pod handles TLS (Let's Encrypt) and reverse proxies to app services by cluster DNS name. Each frontend app is an nginx container serving Vite build output. PocketBase is a StatefulSet with a PVC.

| Subdomain | k8s Service |
|---|---|
| `beta.kirkl.in` | home |
| `recipes.beta.kirkl.in` | recipes |
| `shopping.beta.kirkl.in` | shopping |
| `upkeep.beta.kirkl.in` | upkeep |
| `travel.beta.kirkl.in` | travel |
| `me.beta.kirkl.in` | homepage |
| `money.beta.kirkl.in` | money |
| `api.beta.kirkl.in` | pocketbase |

Note: life is a module embedded in the home app, not a standalone deployment.

## Repo layout

- `apps/{home,recipes,shopping,life,upkeep,travel,money,homepage}` — frontend apps
- `home` is the shell app that embeds shopping, recipes, life, upkeep, travel as modules
- Most apps have their code under `app/` subdirectory; money and homepage are at root level
- `recipes` builds to `build/` not `dist/`
- `packages/ui` is `@kirkl/shared` — consumed as raw TS source, no build step
- `packages/pb-client` is `@homelab/pb-client` — typed PocketBase SDK wrapper
- `services/functions` — Firebase Cloud Functions (to be replaced)
- `services/scripts` — migration scripts (TypeScript, run via tsx)
- `services/ingest` — Python backend, `src/money/` layout, managed with uv
- `extension/` — Chrome extension for financial data capture
- `infra/` — Dockerfiles, k8s manifests, build/deploy scripts
- `infra/pocketbase/pb_migrations/` — PocketBase schema (baked into Docker image)

## Conventions

- Workspace deps use `workspace:*` protocol in package.json
- Prefer userspace installs (fnm, uv) over system-level (apt, sudo npm -g)
- PocketBase collections use snake_case (shopping_lists, shopping_items, etc.)
- Python module is still named `money` internally (renaming is a separate task)
- Deploy: `./infra/deploy.sh` builds locally, pushes images via SSH, applies k8s manifests
- VPS has KUBECONFIG set in /etc/environment — no need for explicit export in SSH commands

## Three Man Team
Available agents: Alice (Architect), Bob (Builder), Robert (Reviewer)
