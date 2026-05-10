# event-watcher — small TypeScript service that streams k8s Events into
# the api's /data/pod_events endpoint. No native deps, single-stage build.

FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /workspace

# Install workspace deps (just event-watcher's needs)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY services/event-watcher/package.json services/event-watcher/package.json
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source
COPY services/event-watcher/ services/event-watcher/

WORKDIR /workspace/services/event-watcher
CMD ["pnpm", "start"]
