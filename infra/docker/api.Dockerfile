# API service — TypeScript/Hono backend for recipe scraping, AI, sharing
# Uses Playwright's base image for Chromium support (recipe scraping)
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /workspace

# Install deps (cache layer)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY services/api/package.json services/api/package.json
RUN pnpm install --frozen-lockfile || pnpm install

# Install Playwright Chromium + system deps
RUN npx --yes playwright install --with-deps chromium

# Copy source
COPY services/api/ services/api/

# Runtime — same base for Chromium compat
FROM node:22-bookworm-slim
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /workspace

# Copy Playwright browsers and system deps
COPY --from=build /root/.cache/ms-playwright /root/.cache/ms-playwright
COPY --from=build /workspace/node_modules ./node_modules
COPY --from=build /workspace/services/api ./services/api
COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml

# Install Chromium runtime deps (needed in the runtime stage)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libdbus-1-3 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libwayland-client0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/services/api
EXPOSE 3000
CMD ["pnpm", "start"]
