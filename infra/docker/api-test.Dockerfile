# Lightweight API service for testing — no Playwright/Chromium.
#
# pnpm workspace deps (`@homelab/backend`) need every linked workspace
# package's package.json present BEFORE `pnpm install`, otherwise
# `workspace:*` silently resolves to nothing and `tsx src/index.ts` fails
# at runtime with "Cannot find package '@homelab/backend'".
# After install we copy the package's source (and only its source) so it's
# available at runtime. The api runs via `tsx` (no compile step), so we
# need the .ts sources, not a built dist.
FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /workspace

# Workspace manifests for dependency resolution. Add another COPY line here
# if services/api ever picks up a new `workspace:*` dep.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY services/api/package.json services/api/package.json
COPY packages/backend/package.json packages/backend/package.json
RUN pnpm install --frozen-lockfile || pnpm install

# Source. Backend is a `"main": "src/index.ts"` package — tsx runs the .ts
# directly, so we need the whole tree (not just dist/).
COPY packages/backend/ packages/backend/
# services/api/src/lib/authz.ts imports `PB_RULES`/`PB_RULES_VERSION` from
# `../../../../infra/pocketbase/pb_migrations/lib/authz-rules.js` to keep
# server-side authz in sync with the PB schema. The lib/ dir is the only
# bit of infra/ that the api needs at runtime; copy just that.
COPY infra/pocketbase/pb_migrations/lib/ infra/pocketbase/pb_migrations/lib/
COPY services/api/ services/api/

WORKDIR /workspace/services/api
EXPOSE 3000
CMD ["pnpm", "start"]
