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

# Fail fast on SSH/1Password breakage so we don't waste a 5-minute build
# cycle just to die at the manifest-apply step. The common failure mode
# is "sign_and_send_pubkey: signing failed ... communication with agent
# failed" when 1Password's SSH agent has gone idle. Re-running an
# interactive `ssh $VPS true` re-establishes it.
if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "$VPS" 'true' >/dev/null 2>&1; then
    echo "[deploy.sh] SSH to $VPS failed before build (10s timeout)." >&2
    echo "[deploy.sh] Likely the 1Password SSH agent is locked or stalled." >&2
    echo "[deploy.sh] Fix: run \`ssh $VPS true\` once in your terminal to trigger" >&2
    echo "[deploy.sh] the 1P unlock prompt, then re-run this script." >&2
    exit 1
fi

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

    # Retry the POST: the api/functions pod is often mid-rolling-restart
    # when this trap fires (a deploy that touched it just rotated its pod),
    # so a single attempt regularly hits a transient connection failure.
    # 3 attempts × 10s covers a typical pod-restart window. If it still
    # fails, surface to stderr instead of silently dropping the record.
    local attempt
    for attempt in 1 2 3; do
        if curl -fsS --max-time 10 -X POST "${api_url}/data/deployments" \
                -H "Authorization: Bearer ${HOMELAB_API_TOKEN}" \
                -H "Content-Type: application/json" \
                -d "$payload" > /dev/null 2>&1; then
            return $exit_code
        fi
        [ $attempt -lt 3 ] && sleep 10
    done
    echo "[deploy.sh] failed to record deployment after 3 attempts (status=${DEPLOY_STATUS})" >&2

    return $exit_code
}
trap record_deployment EXIT

# ─── Build registry ──────────────────────────────────────────────────────────
# Two flavors of buildable thing:
#
#   APP_BUILDS  — Vite frontends that share infra/docker/app.Dockerfile and are
#                 parameterized by build args (APP, APP_DIR, DIST_DIR, optional
#                 NGINX_CONF/NGINX_CONF_DEST). Value shape:
#                     APP_DIR:DIST_DIR[:NGINX_CONF[:NGINX_CONF_DEST]]
#
#   SERVICE_BUILDS — Services with their own Dockerfile and no app-level args.
#                    Value is the Dockerfile path relative to repo root.
#
# Adding a new app/service is now exactly one entry in one of these maps —
# no new elif branch in the build loop.
declare -A APP_BUILDS=(
    [home]="apps/home/app:dist"
    [recipes]="apps/recipes/app:build"
    [shopping]="apps/shopping/app:dist"
    [upkeep]="apps/upkeep/app:dist"
    [travel]="apps/travel/app:dist"
    [money]="apps/money:dist:infra/docker/nginx-money.conf"
    [monitor]="apps/monitor/app:dist:apps/monitor/nginx.conf.template:/etc/nginx/templates/default.conf.template"
)

declare -A SERVICE_BUILDS=(
    [homepage]="infra/docker/homepage.Dockerfile"
    [pocketbase]="infra/docker/pocketbase.Dockerfile"
    [ingest]="infra/docker/ingest.Dockerfile"
    [functions]="infra/docker/api.Dockerfile"
    [event-watcher]="infra/docker/event-watcher.Dockerfile"
)

elapsed() {
    local secs=$1
    if [ "$secs" -ge 60 ]; then
        printf "%dm%02ds" $((secs / 60)) $((secs % 60))
    else
        printf "%ds" "$secs"
    fi
}

# Run `docker build` with the given args and report success/failure.
# Usage: run_docker_build <app> <progress_prefix> <docker_build_args...>
run_docker_build() {
    local app="$1"
    local prefix="$2"
    shift 2
    local push_tag="${PUSH_REGISTRY}/homelab/${app}:latest"
    local k8s_tag="${K8S_REGISTRY}/${app}:latest"
    local app_start=$SECONDS
    echo "${prefix} Building ${app}..."
    if docker build -q "$@" -t "${push_tag}" -t "${k8s_tag}" . > /dev/null 2>&1; then
        echo "${prefix} ✓ ${app} ($(elapsed $((SECONDS - app_start))))"
        return 0
    else
        echo "${prefix} ✗ ${app} FAILED"
        return 1
    fi
}

# Build phase
if [ "$PUSH_ONLY" = false ]; then
    if [ ${#APPS[@]} -eq 0 ]; then
        BUILD_LIST=("${!APP_BUILDS[@]}" "${!SERVICE_BUILDS[@]}")
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
        PROGRESS="[${BUILT}/${TOTAL}]"

        if [ -n "${APP_BUILDS[$app]+x}" ]; then
            # Vite frontend → shared app.Dockerfile with build args
            IFS=: read -r app_dir dist_dir nginx_conf nginx_conf_dest <<< "${APP_BUILDS[$app]}"
            BUILD_ARGS=(
                -f infra/docker/app.Dockerfile
                --build-arg "APP=${app}"
                --build-arg "APP_DIR=${app_dir}"
                --build-arg "DIST_DIR=${dist_dir}"
                --build-arg "VITE_GOOGLE_MAPS_API_KEY=${VITE_GOOGLE_MAPS_API_KEY:-}"
                --build-arg "VITE_DOMAIN=${DOMAIN:-kirkl.in}"
            )
            [ -n "$nginx_conf" ] && BUILD_ARGS+=(--build-arg "NGINX_CONF=${nginx_conf}")
            [ -n "$nginx_conf_dest" ] && BUILD_ARGS+=(--build-arg "NGINX_CONF_DEST=${nginx_conf_dest}")
            if ! run_docker_build "$app" "$PROGRESS" "${BUILD_ARGS[@]}"; then
                FAILED=$((FAILED + 1))
                FAILED_APPS+=("$app")
            fi
        elif [ -n "${SERVICE_BUILDS[$app]+x}" ]; then
            # Service with its own Dockerfile, no app-level build args
            if ! run_docker_build "$app" "$PROGRESS" -f "${SERVICE_BUILDS[$app]}"; then
                FAILED=$((FAILED + 1))
                FAILED_APPS+=("$app")
            fi
        else
            echo "Unknown app: ${app}" >&2
            echo "  Known APP_BUILDS: ${!APP_BUILDS[*]}" >&2
            echo "  Known SERVICE_BUILDS: ${!SERVICE_BUILDS[*]}" >&2
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
