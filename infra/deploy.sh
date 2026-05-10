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
PUSH_REGISTRY="${REGISTRY_HOST:-registry.${DOMAIN:-kirkl.in}}"
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

# Deployment recording — POSTs a row to the monitor's deployments collection
# via api.kirkl.in. Tracks success/failure via DEPLOY_STATUS, set just before
# the final "Deploy complete" echo. Trap on EXIT so failures get recorded too.
DEPLOY_START=$SECONDS
DEPLOY_STATUS="failure"
FAILED_APPS=()

record_deployment() {
    local exit_code=$?
    [ -z "${HOMELAB_API_TOKEN:-}" ] && return 0
    command -v jq >/dev/null 2>&1 || return 0

    local api_url="${HOMELAB_API_URL:-https://api.${DOMAIN:-kirkl.in}/fn}"
    local git_sha git_branch git_subject deployer host duration apps_json failed_json
    git_sha=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
    git_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    git_subject=$(git log -1 --pretty=%s 2>/dev/null || echo "")
    # Surface uncommitted changes so the same SHA across deploys is distinguishable.
    dirty_count=$(git status --porcelain 2>/dev/null | wc -l)
    if [ "$dirty_count" -gt 0 ]; then
        git_subject="${git_subject} (dirty: ${dirty_count})"
    fi
    deployer=$(git config user.email 2>/dev/null || whoami)
    host=$(hostname 2>/dev/null || echo "")
    duration=$((SECONDS - DEPLOY_START))

    if [ ${#APPS[@]} -gt 0 ]; then
        apps_json=$(printf '%s\n' "${APPS[@]}" | jq -R . | jq -s .)
    else
        apps_json='["all"]'
    fi
    if [ ${#FAILED_APPS[@]} -gt 0 ]; then
        failed_json=$(printf '%s\n' "${FAILED_APPS[@]}" | jq -R . | jq -s .)
    else
        failed_json='[]'
    fi

    local payload
    payload=$(jq -n \
        --arg git_sha "$git_sha" \
        --arg git_branch "$git_branch" \
        --arg git_subject "$git_subject" \
        --arg status "$DEPLOY_STATUS" \
        --arg deployer "$deployer" \
        --arg host "$host" \
        --argjson apps "$apps_json" \
        --argjson failed_apps "$failed_json" \
        --argjson duration_seconds "$duration" \
        '{git_sha:$git_sha, git_branch:$git_branch, git_subject:$git_subject, status:$status, deployer:$deployer, host:$host, apps:$apps, failed_apps:$failed_apps, duration_seconds:$duration_seconds}')

    curl -fsS --max-time 10 -X POST "${api_url}/data/deployments" \
        -H "Authorization: Bearer ${HOMELAB_API_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "$payload" > /dev/null 2>&1 || true

    return $exit_code
}
trap record_deployment EXIT

# App builds: name -> APP_DIR:DIST_DIR[:NGINX_CONF[:NGINX_CONF_DEST]]
declare -A APP_BUILDS=(
    [home]="apps/home/app:dist"
    [recipes]="apps/recipes/app:build"
    [shopping]="apps/shopping/app:dist"
    [upkeep]="apps/upkeep/app:dist"
    [travel]="apps/travel/app:dist"
    [money]="apps/money:dist:infra/docker/nginx-money.conf"
    [monitor]="apps/monitor/app:dist:apps/monitor/nginx.conf.template:/etc/nginx/templates/default.conf.template"
)

elapsed() {
    local secs=$1
    if [ "$secs" -ge 60 ]; then
        printf "%dm%02ds" $((secs / 60)) $((secs % 60))
    else
        printf "%ds" "$secs"
    fi
}

# Build phase
if [ "$PUSH_ONLY" = false ]; then
    if [ ${#APPS[@]} -eq 0 ]; then
        BUILD_LIST=("${!APP_BUILDS[@]}" homepage pocketbase ingest functions event-watcher)
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
                FAILED_APPS+=("$app")
            fi
        elif [ "$app" = "pocketbase" ]; then
            echo "[${BUILT}/${TOTAL}] Building pocketbase..."
            if docker build -q -f infra/docker/pocketbase.Dockerfile -t "${PUSH_TAG}" -t "${K8S_TAG}" . > /dev/null 2>&1; then
                echo "[${BUILT}/${TOTAL}] ✓ pocketbase ($(elapsed $((SECONDS - APP_START))))"
            else
                echo "[${BUILT}/${TOTAL}] ✗ pocketbase FAILED"
                FAILED=$((FAILED + 1))
                FAILED_APPS+=("$app")
            fi
        elif [ "$app" = "ingest" ]; then
            echo "[${BUILT}/${TOTAL}] Building ingest..."
            if docker build -q -f infra/docker/ingest.Dockerfile -t "${PUSH_TAG}" -t "${K8S_TAG}" . > /dev/null 2>&1; then
                echo "[${BUILT}/${TOTAL}] ✓ ingest ($(elapsed $((SECONDS - APP_START))))"
            else
                echo "[${BUILT}/${TOTAL}] ✗ ingest FAILED"
                FAILED=$((FAILED + 1))
                FAILED_APPS+=("$app")
            fi
        elif [ "$app" = "functions" ]; then
            echo "[${BUILT}/${TOTAL}] Building functions (API service)..."
            if docker build -q -f infra/docker/api.Dockerfile -t "${PUSH_TAG}" -t "${K8S_TAG}" . > /dev/null 2>&1; then
                echo "[${BUILT}/${TOTAL}] ✓ functions ($(elapsed $((SECONDS - APP_START))))"
            else
                echo "[${BUILT}/${TOTAL}] ✗ functions FAILED"
                FAILED=$((FAILED + 1))
                FAILED_APPS+=("$app")
            fi
        elif [ "$app" = "event-watcher" ]; then
            echo "[${BUILT}/${TOTAL}] Building event-watcher..."
            if docker build -q -f infra/docker/event-watcher.Dockerfile -t "${PUSH_TAG}" -t "${K8S_TAG}" . > /dev/null 2>&1; then
                echo "[${BUILT}/${TOTAL}] ✓ event-watcher ($(elapsed $((SECONDS - APP_START))))"
            else
                echo "[${BUILT}/${TOTAL}] ✗ event-watcher FAILED"
                FAILED=$((FAILED + 1))
                FAILED_APPS+=("$app")
            fi
        elif [ -n "${APP_BUILDS[$app]+x}" ]; then
            IFS=: read -r app_dir dist_dir nginx_conf nginx_conf_dest <<< "${APP_BUILDS[$app]}"
            echo "[${BUILT}/${TOTAL}] Building ${app}..."
            EXTRA_ARGS=""
            if [ -n "$nginx_conf" ]; then
                EXTRA_ARGS="--build-arg NGINX_CONF=${nginx_conf}"
            fi
            if [ -n "$nginx_conf_dest" ]; then
                EXTRA_ARGS="${EXTRA_ARGS} --build-arg NGINX_CONF_DEST=${nginx_conf_dest}"
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
                FAILED_APPS+=("$app")
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

DEPLOY_STATUS="success"

echo ""
echo "=== Deploy complete ($(elapsed $((SECONDS - DEPLOY_START)))) ==="
