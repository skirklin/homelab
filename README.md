# homelab

Personal web apps monorepo, self-hosted on a VPS with k3s, Caddy, and PocketBase.

## Infrastructure

k3s (single-node Kubernetes) on a VPS. Caddy handles TLS (automatic Let's Encrypt) and reverse proxies to app services. PocketBase provides data storage and auth.

| Subdomain | App |
|---|---|
| `beta.kirkl.in` | home (shell) |
| `recipes.beta.kirkl.in` | recipes |
| `shopping.beta.kirkl.in` | shopping |
| `life.beta.kirkl.in` | life |
| `upkeep.beta.kirkl.in` | upkeep |
| `travel.beta.kirkl.in` | travel |
| `me.beta.kirkl.in` | homepage (static) |
| `money.beta.kirkl.in` | money (moving to tailnet-only) |
| `api.beta.kirkl.in` | PocketBase API |

## Structure

```
apps/
  recipes/        # Recipe management app (React + Vite)
  shopping/      # Grocery list app (React + Vite)
  homepage/       # Personal homepage (static)
  home/           # Shell app that hosts shopping, recipes, life, upkeep, travel
  life/           # Life tracker app (React + Vite)
  upkeep/         # Household task tracker (React + Vite)
  travel/         # Travel trip planner (React + Vite)
  money/          # Personal finance dashboard (React + Vite)
services/
  functions/      # Firebase Cloud Functions (to be migrated)
  scripts/        # Data migration scripts
  ingest/         # Financial data ingest server (Python, managed with uv)
extension/        # Chrome extension for financial data capture
packages/
  pb-client/      # Typed PocketBase client (placeholder)
  ui/             # Shared React components (@kirkl/shared)
infra/
  docker/         # Dockerfiles for all services
  k8s/            # Kubernetes manifests (Kustomize)
  build.sh        # Build all Docker images
  deploy.sh       # Deploy to k3s
  setup-k3s.sh    # One-time k3s installation
```

## Deployment

### First-time setup (on the VPS)

```bash
# Install k3s
./infra/setup-k3s.sh

# Build all images and deploy
./infra/build.sh
./infra/deploy.sh
```

### Updating

```bash
./infra/build.sh       # rebuild images
./infra/deploy.sh      # import + rollout restart
```

### Monitoring

```bash
kubectl get pods -n homelab
kubectl logs -n homelab deploy/caddy
kubectl logs -n homelab deploy/recipes
```

## Development

```bash
pnpm install
pnpm dev       # starts all apps via Turborepo
pnpm build     # builds all apps
```

## Tooling

- **k3s** — single-node Kubernetes
- **Caddy** — reverse proxy, automatic HTTPS
- **PocketBase** — database + auth
- **pnpm workspaces** + **Turborepo** — JS/TS monorepo
- **uv** — Python projects (`services/ingest/`)
- **Vite** — frontend builds

## Migration status

This repo consolidates two previous repos:

- **firebase-apps** — `recipes`, `shopping`, `homepage`, `home`, `life`, `upkeep`, `travel`, shared components, Cloud Functions, and migration scripts
- **money** — `money` frontend, `ingest` backend, Chrome `extension`

The apps currently depend on Firebase (Firestore, Auth, Cloud Functions). Migrating to PocketBase for data/auth.

## License

MIT
