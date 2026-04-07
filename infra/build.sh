#!/usr/bin/env bash
# Build all Docker images for the homelab.
# Run from the repo root: ./infra/build.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

REGISTRY="${REGISTRY:-homelab}"

# App builds: name -> APP_DIR:DIST_DIR
declare -A APPS=(
    [home]="apps/home/app:dist"
    [recipes]="apps/recipes/app:build"
    [shopping]="apps/shopping/app:dist"
    # life has no index.html — it's a module consumed by home, not standalone
    [upkeep]="apps/upkeep/app:dist"
    [travel]="apps/travel/app:dist"
    [money]="apps/money:dist"
)

echo "=== Building frontend apps ==="
for app in "${!APPS[@]}"; do
    IFS=: read -r app_dir dist_dir <<< "${APPS[$app]}"
    echo "--- Building ${app} (${app_dir}) ---"
    docker build \
        -f infra/docker/app.Dockerfile \
        --build-arg APP="${app}" \
        --build-arg APP_DIR="${app_dir}" \
        --build-arg DIST_DIR="${dist_dir}" \
        -t "${REGISTRY}/${app}:latest" \
        .
done

echo ""
echo "=== Building homepage (static) ==="
docker build -f infra/docker/homepage.Dockerfile -t "${REGISTRY}/homepage:latest" .

echo ""
echo "=== Building PocketBase ==="
docker build -f infra/docker/pocketbase.Dockerfile -t "${REGISTRY}/pocketbase:latest" .

echo ""
echo "=== Building ingest ==="
docker build -f infra/docker/ingest.Dockerfile -t "${REGISTRY}/ingest:latest" .

echo ""
echo "All images built:"
docker images --filter "reference=${REGISTRY}/*" --format "table {{.Repository}}:{{.Tag}}\t{{.Size}}"
