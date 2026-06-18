# Thin nginx image for all React/Vite frontend apps.
#
# The vite build now runs on the HOST (turbo-cached) before `docker build` —
# see infra/deploy.sh. This Dockerfile just copies the pre-built dist into
# nginx, so there's no in-Docker pnpm install / vite build anymore.
#
# Build with --build-arg APP_DIR=apps/recipes/app (and DIST_DIR if not "dist").
# The host-built output must be present at ${APP_DIR}/${DIST_DIR} in the build
# context — the repo .dockerignore re-includes apps/*/dist, apps/*/app/dist, and
# apps/recipes/app/build for exactly this reason.

FROM nginx:alpine
ARG APP
ARG APP_DIR
ARG DIST_DIR=dist

ARG NGINX_CONF=infra/docker/nginx-spa.conf
# Where the conf lands in the image. Default is conf.d/ for static SPA configs;
# override to /etc/nginx/templates/default.conf.template for env-var substitution
# at container startup (nginx:alpine processes templates/* via envsubst).
ARG NGINX_CONF_DEST=/etc/nginx/conf.d/default.conf

COPY ${APP_DIR}/${DIST_DIR} /usr/share/nginx/html
COPY ${NGINX_CONF} ${NGINX_CONF_DEST}

EXPOSE 80
