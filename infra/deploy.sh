#!/usr/bin/env bash
# Deploy from local machine to VPS.
# Builds Docker images locally, pushes them to the VPS via SSH,
# and applies k8s manifests.
#
# Usage:
#   ./infra/deploy.sh              # build + deploy everything
#   ./infra/deploy.sh --push-only  # skip build, just push + apply
#   ./infra/deploy.sh home recipes # build + deploy specific apps
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

VPS="${HOMELAB_VPS:-scott@5.78.200.161}"
REGISTRY="${REGISTRY:-homelab}"

# Parse flags
PUSH_ONLY=false
APPS=()
for arg in "$@"; do
    case "$arg" in
        --push-only) PUSH_ONLY=true ;;
        *) APPS+=("$arg") ;;
    esac
done

# App builds: name -> APP_DIR:DIST_DIR
declare -A APP_BUILDS=(
    [home]="apps/home/app:dist"
    [recipes]="apps/recipes/app:build"
    [groceries]="apps/groceries/app:dist"
    [upkeep]="apps/upkeep/app:dist"
    [travel]="apps/travel/app:dist"
    [money]="apps/money:dist"
)

# Build phase
if [ "$PUSH_ONLY" = false ]; then
    if [ ${#APPS[@]} -eq 0 ]; then
        BUILD_LIST=("${!APP_BUILDS[@]}")
    else
        BUILD_LIST=("${APPS[@]}")
    fi

    echo "=== Building images ==="
    for app in "${BUILD_LIST[@]}"; do
        if [ "$app" = "homepage" ]; then
            echo "--- Building homepage (static) ---"
            docker build -f infra/docker/homepage.Dockerfile -t "${REGISTRY}/homepage:latest" .
        elif [ "$app" = "pocketbase" ]; then
            echo "--- Building pocketbase ---"
            docker build -f infra/docker/pocketbase.Dockerfile -t "${REGISTRY}/pocketbase:latest" .
        elif [ "$app" = "ingest" ]; then
            echo "--- Building ingest ---"
            docker build -f infra/docker/ingest.Dockerfile -t "${REGISTRY}/ingest:latest" .
        elif [ -n "${APP_BUILDS[$app]+x}" ]; then
            IFS=: read -r app_dir dist_dir <<< "${APP_BUILDS[$app]}"
            echo "--- Building ${app} (${app_dir}) ---"
            docker build -f infra/docker/app.Dockerfile \
                --build-arg APP="${app}" \
                --build-arg APP_DIR="${app_dir}" \
                --build-arg DIST_DIR="${dist_dir}" \
                -t "${REGISTRY}/${app}:latest" .
        else
            echo "Unknown app: ${app}" >&2
            exit 1
        fi
    done
fi

# Determine images to push
if [ ${#APPS[@]} -eq 0 ]; then
    IMAGES=($(docker images --filter "reference=${REGISTRY}/*" --format "{{.Repository}}:{{.Tag}}"))
    docker pull caddy:2-alpine 2>/dev/null || true
    IMAGES+=("caddy:2-alpine")
else
    IMAGES=()
    for app in "${APPS[@]}"; do
        IMAGES+=("${REGISTRY}/${app}:latest")
    done
fi

echo ""
echo "=== Pushing ${#IMAGES[@]} images to VPS ==="
for img in "${IMAGES[@]}"; do
    echo "  ${img}..."
    docker save "${img}" | ssh "${VPS}" "sudo k3s ctr images import -" 2>/dev/null || echo "  WARNING: failed ${img}"
done

echo ""
echo "=== Applying manifests ==="
ssh "${VPS}" "mkdir -p ~/homelab-manifests"
tar -cf - -C infra/k8s . | ssh "${VPS}" "tar -xf - -C ~/homelab-manifests/"
ssh "${VPS}" "export KUBECONFIG=~/.kube/config && kubectl apply -k ~/homelab-manifests/"

echo ""
echo "=== Restarting deployments ==="
ssh "${VPS}" "export KUBECONFIG=~/.kube/config && kubectl rollout restart -n homelab deployments,statefulsets 2>/dev/null || true"

echo ""
echo "=== Pod status ==="
ssh "${VPS}" "export KUBECONFIG=~/.kube/config && kubectl get pods -n homelab"
