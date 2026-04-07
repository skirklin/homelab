# Project Context

## What this is

Personal web apps monorepo, migrating from Firebase (Firestore, Auth, Cloud Functions) to self-hosted PocketBase + Caddy on a VPS (Hetzner, 5.78.200.161, user `scott`).

## Current state (2026-04-06)

Monorepo consolidation is complete. Infra manifests are written. Next step is building Docker images and deploying to k3s.

### Done
- Imported firebase-apps and money repos with git history preserved (subtree merge)
- Monorepo structure finalized with pnpm workspaces + Turborepo
- k3s installed on VPS (Traefik disabled, using Caddy instead)
- Docker installed on VPS
- pnpm install done, lockfile generated
- DNS: `beta.kirkl.in` + `*.beta.kirkl.in` → VPS
- Dockerfiles written (infra/docker/)
- k8s manifests written (infra/k8s/) with Kustomize
- build.sh and deploy.sh scripts ready

### Not done yet
- No images have been built — expect build errors from Firebase SDK references, missing env vars
- PocketBase not set up — no schemas, no data migration
- Apps still use Firebase for everything — actual backend migration hasn't started
- money app should eventually move to tailnet-only (Tailscale not set up on VPS yet)
- TLS certs (*.pem) are gitignored

### Immediate next steps
1. Run `./infra/build.sh` — fix build errors as they surface
2. Run `./infra/deploy.sh` to get pods running
3. Set up PocketBase schemas
4. Start migrating app backends from Firebase to PocketBase

## Architecture

k3s single-node cluster. Caddy pod handles TLS (Let's Encrypt) and reverse proxies to app services by cluster DNS name. Each frontend app is an nginx container serving Vite build output. PocketBase is a StatefulSet with a PVC.

| Subdomain | k8s Service |
|---|---|
| `beta.kirkl.in` | home |
| `recipes.beta.kirkl.in` | recipes |
| `groceries.beta.kirkl.in` | groceries |
| `life.beta.kirkl.in` | life |
| `upkeep.beta.kirkl.in` | upkeep |
| `travel.beta.kirkl.in` | travel |
| `me.beta.kirkl.in` | homepage |
| `money.beta.kirkl.in` | money |
| `api.beta.kirkl.in` | pocketbase |

## Repo layout

- `apps/{home,recipes,groceries,life,upkeep,travel,money,homepage}` — frontend apps
- `home` is the shell app that embeds groceries, recipes, life, upkeep, travel as modules
- Most apps have their code under `app/` subdirectory; money and homepage are at root level
- `recipes` builds to `build/` not `dist/`
- `packages/ui` is `@kirkl/shared` — consumed as raw TS source, no build step
- `services/functions` — Firebase Cloud Functions (to be replaced by PocketBase)
- `services/scripts` — migration scripts (TypeScript, run via tsx)
- `services/ingest` — Python backend, `src/money/` layout, managed with uv
- `extension/` — Chrome extension for financial data capture
- `infra/` — Dockerfiles, k8s manifests, build/deploy scripts

## Conventions

- Workspace deps use `workspace:*` protocol in package.json
- Prefer userspace installs (fnm, uv) over system-level (apt, sudo npm -g)
- Don't touch app internals during structural work — one thing at a time
- Python module is still named `money` internally (renaming is a separate task)
