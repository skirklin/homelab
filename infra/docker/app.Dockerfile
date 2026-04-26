# Shared multi-stage Dockerfile for all React/Vite frontend apps.
# Build with --build-arg APP=recipes (or groceries, life, upkeep, travel, money)
#
# The home app requires all workspace apps to be available, so this Dockerfile
# copies the full workspace and lets pnpm resolve everything.

FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /workspace

# Install deps first (cache layer). Every workspace package needs its
# package.json present here so pnpm can resolve workspace:* deps before
# we copy the rest of the source.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/ui/package.json packages/ui/package.json
COPY packages/backend/package.json packages/backend/package.json
COPY packages/vite-preset/package.json packages/vite-preset/package.json
COPY apps/home/app/package.json apps/home/app/package.json
COPY apps/recipes/app/package.json apps/recipes/app/package.json
COPY apps/recipes/package.json apps/recipes/package.json
COPY apps/shopping/app/package.json apps/shopping/app/package.json
COPY apps/life/app/package.json apps/life/app/package.json
COPY apps/upkeep/app/package.json apps/upkeep/app/package.json
COPY apps/travel/app/package.json apps/travel/app/package.json
COPY apps/money/package.json apps/money/package.json
RUN pnpm install --frozen-lockfile || pnpm install

# Copy full source (needed for workspace deps like @kirkl/shared)
COPY packages/ packages/
COPY apps/ apps/

ARG APP
ARG APP_DIR

# Vite env vars (baked into the JS bundle at build time)
ARG VITE_GOOGLE_MAPS_API_KEY=""
ARG VITE_DOMAIN=""

# Build the target app
# APP_DIR is the directory containing the vite project (e.g. apps/recipes/app or apps/money)
RUN cd ${APP_DIR} && \
    VITE_GOOGLE_MAPS_API_KEY=${VITE_GOOGLE_MAPS_API_KEY} \
    VITE_DOMAIN=${VITE_DOMAIN} \
    pnpm run build

# Serve with nginx
FROM nginx:alpine
ARG APP
ARG APP_DIR
ARG DIST_DIR=dist

ARG NGINX_CONF=infra/docker/nginx-spa.conf

COPY --from=build /workspace/${APP_DIR}/${DIST_DIR} /usr/share/nginx/html
COPY ${NGINX_CONF} /etc/nginx/conf.d/default.conf

EXPOSE 80
