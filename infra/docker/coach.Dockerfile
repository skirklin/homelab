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
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source
COPY services/coach/ services/coach/

# Reuse the cross-source bundle assembler from the api service (warm-context
# on session boot — see services/coach/src/agent.ts). Imported via relative
# path; only the two files the bundle actually needs come in to keep the
# image lean. Bumps the rebuild cost when those files change but that's
# fine — they change roughly never.
COPY services/api/src/lib/observer/bundle.ts services/api/src/lib/observer/bundle.ts
COPY services/api/src/lib/notifications/tz.ts services/api/src/lib/notifications/tz.ts

WORKDIR /workspace/services/coach
EXPOSE 3030
# Run tsx directly so stdout isn't buffered behind pnpm's process wrapper.
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
