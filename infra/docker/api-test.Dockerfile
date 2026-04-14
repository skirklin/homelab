# Lightweight API service for testing — no Playwright/Chromium
FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /workspace

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY services/api/package.json services/api/package.json
RUN pnpm install --frozen-lockfile || pnpm install

COPY services/api/ services/api/

WORKDIR /workspace/services/api
EXPOSE 3000
CMD ["pnpm", "start"]
