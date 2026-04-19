#!/usr/bin/env bash
# Deploy from local machine to VPS.
# Builds Docker images locally, pushes to VPS registry (with layer dedup),
# and applies k8s manifests.
#
# Usage:
#   ./infra/deploy.sh              # build + deploy everything
#   ./infra/deploy.sh --push-only  # skip build, just push + apply
#   ./infra/deploy.sh home recipes # build + deploy specific apps
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Load env vars for build-time injection (e.g. VITE_GOOGLE_MAPS_API_KEY)
if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

VPS="${HOMELAB_VPS:-scott@5.78.200.161}"
# Push to public registry (Caddy with TLS + basic auth)
PUSH_REGISTRY="registry.beta.kirkl.in"
# k8s pulls from the NodePort on localhost
K8S_REGISTRY="localhost:30500/homelab"

# Parse flags
PUSH_ONLY=false
APPS=()
for arg in "$@"; do
    case "$arg" in
        --push-only) PUSH_ONLY=true ;;
        *) APPS+=("$arg") ;;
    esac
done

# App builds: name -> APP_DIR:DIST_DIR[:NGINX_CONF]
declare -A APP_BUILDS=(
    [home]="apps/home/app:dist"
    [recipes]="apps/recipes/app:build"
    [shopping]="apps/shopping/app:dist"
    [upkeep]="apps/upkeep/app:dist"
    [travel]="apps/travel/app:dist"
    [money]="apps/money:dist:infra/docker/nginx-money.conf"
)

elapsed() {
    local secs=$1
    if [ "$secs" -ge 60 ]; then
        printf "%dm%02ds" $((secs / 60)) $((secs % 60))
    else
        printf "%ds" "$secs"
    fi
}

DEPLOY_START=$SECONDS

# Build phase
if [ "$PUSH_ONLY" = false ]; then
    if [ ${#APPS[@]} -eq 0 ]; then
        BUILD_LIST=("${!APP_BUILDS[@]}" homepage pocketbase ingest functions)
    else
        BUILD_LIST=("${APPS[@]}")
    fi

    TOTAL=${#BUILD_LIST[@]}
    BUILT=0
    FAILED=0
    BUILD_START=$SECONDS

    echo "=== Building ${TOTAL} images ==="
    echo ""
    for app in "${BUILD_LIST[@]}"; do
        BUILT=$((BUILT + 1))
        APP_START=$SECONDS

        # Tag for both registries: push registry (for docker push) and k8s registry (for manifests)
        PUSH_TAG="${PUSH_REGISTRY}/homelab/${app}:latest"
        K8S_TAG="${K8S_REGISTRY}/${app}:latest"

        if [ "$app" = "homepage" ]; then
            echo "[${BUILT}/${TOTAL}] Building homepage (static)..."
            if docker build -q -f infra/docker/homepage.Dockerfile -t "${PUSH_TAG}" -t "${K8S_TAG}" . > /dev/null 2>&1; then
                echo "[${BUILT}/${TOTAL}] ✓ homepage ($(elapsed $((SECONDS - APP_START))))"
            else
                echo "[${BUILT}/${TOTAL}] ✗ homepage FAILED"
                FAILED=$((FAILED + 1))
            fi
        elif [ "$app" = "pocketbase" ]; then
            echo "[${BUILT}/${TOTAL}] Building pocketbase..."
            if docker build -q -f infra/docker/pocketbase.Dockerfile -t "${PUSH_TAG}" -t "${K8S_TAG}" . > /dev/null 2>&1; then
                echo "[${BUILT}/${TOTAL}] ✓ pocketbase ($(elapsed $((SECONDS - APP_START))))"
            else
                echo "[${BUILT}/${TOTAL}] ✗ pocketbase FAILED"
                FAILED=$((FAILED + 1))
            fi
        elif [ "$app" = "ingest" ]; then
            echo "[${BUILT}/${TOTAL}] Building ingest..."
            if docker build -q -f infra/docker/ingest.Dockerfile -t "${PUSH_TAG}" -t "${K8S_TAG}" . > /dev/null 2>&1; then
                echo "[${BUILT}/${TOTAL}] ✓ ingest ($(elapsed $((SECONDS - APP_START))))"
            else
                echo "[${BUILT}/${TOTAL}] ✗ ingest FAILED"
                FAILED=$((FAILED + 1))
            fi
        elif [ "$app" = "functions" ]; then
            echo "[${BUILT}/${TOTAL}] Building functions (API service)..."
            if docker build -q -f infra/docker/api.Dockerfile -t "${PUSH_TAG}" -t "${K8S_TAG}" . > /dev/null 2>&1; then
                echo "[${BUILT}/${TOTAL}] ✓ functions ($(elapsed $((SECONDS - APP_START))))"
            else
                echo "[${BUILT}/${TOTAL}] ✗ functions FAILED"
                FAILED=$((FAILED + 1))
            fi
        elif [ -n "${APP_BUILDS[$app]+x}" ]; then
            IFS=: read -r app_dir dist_dir nginx_conf <<< "${APP_BUILDS[$app]}"
            echo "[${BUILT}/${TOTAL}] Building ${app}..."
            EXTRA_ARGS=""
            if [ -n "$nginx_conf" ]; then
                EXTRA_ARGS="--build-arg NGINX_CONF=${nginx_conf}"
            fi
            if docker build -q -f infra/docker/app.Dockerfile \
                --build-arg APP="${app}" \
                --build-arg APP_DIR="${app_dir}" \
                --build-arg DIST_DIR="${dist_dir}" \
                --build-arg VITE_GOOGLE_MAPS_API_KEY="${VITE_GOOGLE_MAPS_API_KEY:-}" \
                --build-arg VITE_DOMAIN="${DOMAIN:-kirkl.in}" \
                ${EXTRA_ARGS} \
                -t "${PUSH_TAG}" -t "${K8S_TAG}" . > /dev/null 2>&1; then
                echo "[${BUILT}/${TOTAL}] ✓ ${app} ($(elapsed $((SECONDS - APP_START))))"
            else
                echo "[${BUILT}/${TOTAL}] ✗ ${app} FAILED"
                FAILED=$((FAILED + 1))
            fi
        else
            echo "Unknown app: ${app}" >&2
            exit 1
        fi
    done

    echo ""
    if [ "$FAILED" -gt 0 ]; then
        echo "Build: ${FAILED}/${TOTAL} failed ($(elapsed $((SECONDS - BUILD_START))))"
        exit 1
    else
        echo "Build: ${TOTAL}/${TOTAL} succeeded ($(elapsed $((SECONDS - BUILD_START))))"
    fi
fi

# Push phase: docker push to registry with layer dedup
# Determine images to push
if [ ${#APPS[@]} -eq 0 ]; then
    IMAGES=($(docker images --filter "reference=${PUSH_REGISTRY}/homelab/*" --format "{{.Repository}}:{{.Tag}}"))
else
    IMAGES=()
    for app in "${APPS[@]}"; do
        IMAGES+=("${PUSH_REGISTRY}/homelab/${app}:latest")
    done
fi

echo ""
PUSH_START=$SECONDS
PUSH_TOTAL=${#IMAGES[@]}
PUSHED=0
echo "=== Pushing ${PUSH_TOTAL} images to registry ==="
for img in "${IMAGES[@]}"; do
    PUSHED=$((PUSHED + 1))
    IMG_START=$SECONDS
    short="${img#${PUSH_REGISTRY}/}"
    printf "[%d/%d] %s..." "$PUSHED" "$PUSH_TOTAL" "$short"
    if docker push "${img}" > /dev/null 2>&1; then
        echo " ✓ ($(elapsed $((SECONDS - IMG_START))))"
    else
        echo " ✗ FAILED"
    fi
done
echo ""
echo "Push: ${PUSH_TOTAL} images ($(elapsed $((SECONDS - PUSH_START))))"

echo ""
echo "=== Applying manifests ==="
ssh "${VPS}" "mkdir -p ~/homelab-manifests"
tar -cf - -C infra/k8s . | ssh "${VPS}" "tar -xf - -C ~/homelab-manifests/"
ssh "${VPS}" "kubectl apply -k ~/homelab-manifests/"

echo ""
echo "=== Restarting deployments ==="
if [ ${#APPS[@]} -eq 0 ]; then
    # Full deploy: restart everything
    ssh "${VPS}" "kubectl rollout restart -n homelab deployments,statefulsets 2>/dev/null || true"
else
    # Selective deploy: only restart what was built
    for app in "${APPS[@]}"; do
        echo "Restarting ${app}..."
        # Try as deployment first, then statefulset (pocketbase is a statefulset)
        ssh "${VPS}" "kubectl rollout restart -n homelab deployment/${app} 2>/dev/null || kubectl rollout restart -n homelab statefulset/${app} 2>/dev/null || echo '  (no deployment/statefulset named ${app})'";
    done
fi

echo ""
echo "=== Pod status ==="
ssh "${VPS}" "kubectl get pods -n homelab"

echo ""
echo "=== Deploy complete ($(elapsed $((SECONDS - DEPLOY_START)))) ==="
