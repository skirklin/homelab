# homelab

Personal web apps monorepo, migrating from Firebase to a self-hosted stack (PocketBase + Caddy on a VPS).

## Structure

```
apps/
  recipes/        # Recipe management app (React + Vite)
  groceries/      # Grocery list app (React + Vite)
  critic/         # Literary analysis tool (Python)
  homepage/       # Personal homepage (static)
  money/          # Personal finance dashboard (React + Vite)
services/
  ingest/         # Financial data ingest server (Python, managed with uv)
extension/        # Chrome extension for financial data capture
packages/
  pb-client/      # Typed PocketBase client (placeholder)
  ui/             # Shared React components (placeholder)
```

## Migration status

This repo consolidates two previous repos:

- **firebase-apps** — `recipes`, `groceries`, `critic`, `homepage` (plus `home`, `life`, `shared`, `upkeep`, and Cloud Functions which were not carried forward — they remain in git history)
- **money** — `money` frontend, `ingest` backend, Chrome `extension`

The apps currently depend on Firebase (Firestore, Auth, Cloud Functions). The plan is to migrate each app to PocketBase for data/auth, with Caddy as the reverse proxy, all self-hosted on a VPS.

## Tooling

- **pnpm workspaces** + **Turborepo** for JS/TS packages
- **uv** for Python projects (`services/ingest/`, `apps/critic/`)
- Each React app uses **Vite**

## Development

```bash
pnpm install
pnpm dev       # starts all apps via Turborepo
pnpm build     # builds all apps
```

## License

MIT
