# coach — long-running Claude Agent SDK service backing the realtime
# Coach feature. D2 wires the SDK loop + PB realtime subscription on top
# of D1's scaffolding. See apps/life/OBSERVER_BUILD_PLAN.md §"Phase D".
#
# Pure TS — no native deps — so a single-stage alpine image works (same
# shape as services/event-watcher). Runs via `tsx` at startup so we don't
# need a separate compile step.

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /workspace

# Install workspace deps (just coach's needs). pnpm needs the lockfile +
# workspace manifest to resolve workspace:* properly, plus this service's
# own package.json so it knows which deps to materialize into the cache layer.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY services/coach/package.json services/coach/package.json
COPY packages/backend/package.json packages/backend/package.json
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source
COPY services/coach/ services/coach/

# bundle.ts (copied below) imports @homelab/backend (normalizeSessionRuns +
# types) since the life-b3.2 per-item session cutover. It's consumed as TS
# source directly — package.json main → src/index.ts, tsx loads TS at runtime,
# no build step — same as api.Dockerfile. Without this, tsx crashes at boot
# with ERR_MODULE_NOT_FOUND.
COPY packages/backend/ packages/backend/

# Reuse the cross-source bundle assembler from the api service (warm-context
# on session boot — see services/coach/src/agent.ts). Imported via relative
# path; only the two files the bundle actually needs come in to keep the
# image lean. Bumps the rebuild cost when those files change but that's
# fine — they change roughly never.
#
# api/package.json comes along too so tsx walks-up-for-nearest-package finds
# the api package's `"type": "module"` declaration. Without it, tsx walks to
# /workspace/package.json (no `type` field → CommonJS default), loads
# bundle.ts as CJS, and warm-context.ts's ESM named-import of `assembleBundle`
# fails with "does not provide an export named ...". Copied AFTER `pnpm
# install` so it doesn't trip workspace resolution — coach's node_modules
# already has the transitive deps bundle needs at runtime (date-fns-tz etc).
COPY services/api/package.json services/api/package.json
COPY services/api/src/lib/observer/bundle.ts services/api/src/lib/observer/bundle.ts
COPY services/api/src/lib/notifications/tz.ts services/api/src/lib/notifications/tz.ts

# bundle.ts imports `date-fns-tz` from the api path — Node's resolver walks
# up looking for node_modules. services/api/ has none in this image (we
# only copied two files), so without this symlink Node walks to
# /workspace/node_modules and 404s (pnpm hoists per-package, not to root).
# Link the api dir's node_modules to coach's so bundle's `date-fns-tz`,
# `pocketbase`, etc. all resolve. The proper fix is promoting bundle.ts to
# packages/observer-bundle/ — flagged in OBSERVER_BUILD_PLAN.md v2 work.
RUN ln -s /workspace/services/coach/node_modules /workspace/services/api/node_modules

WORKDIR /workspace/services/coach
EXPOSE 3030
# Run tsx directly so stdout isn't buffered behind pnpm's process wrapper.
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
