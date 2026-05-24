#!/usr/bin/env bash
# Deploy from local machine to VPS.
# Builds Docker images locally, pushes to VPS registry (with layer dedup),
# and applies k8s manifests.
#
# Usage:
#   ./infra/deploy.sh              # build + deploy everything
#   ./infra/deploy.sh --push-only  # skip build, just push + apply
#   ./infra/deploy.sh home recipes # build + deploy specific apps
#   ./infra/deploy.sh --beta       # build home as :beta, deploy to home-beta
#                                  # (powers beta.kirkl.in; does NOT touch prod home)
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
BETA=false
APPS=()
for arg in "$@"; do
    case "$arg" in
        --push-only) PUSH_ONLY=true ;;
        --beta) BETA=true ;;
        --help|-h)
            sed -n '2,11p' "$0"
            exit 0
            ;;
        *) APPS+=("$arg") ;;
    esac
done

# --beta channel: only home is beta-routed (kirkl.in/<module> serves the home
# bundled version of each app, so just the home shell needs a beta variant).
# This flag overrides any positional APPS and pins the image tag to :beta so
# prod home (:latest) is untouched. The home-beta Deployment in apps.yaml
# references the :beta tag and is the only thing we roll out here.
IMAGE_TAG="latest"
DEPLOY_VARIANT="prod"
if [ "$BETA" = true ]; then
    if [ ${#APPS[@]} -gt 0 ] && [ "${APPS[*]}" != "home" ]; then
        echo "[deploy.sh] --beta only builds 'home'; ignoring extra apps: ${APPS[*]}" >&2
    fi
    APPS=("home")
    IMAGE_TAG="beta"
    DEPLOY_VARIANT="beta"
fi

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

# Pre-deploy PB backup — belt-and-suspenders on top of the nightly
# pb-backup-daily CronJob. A migration shipped on a Wednesday and the
# nightly only ran Tuesday is exactly the gap that bit us on 2026-05-22.
# Tags the backup key with the git SHA so it's recoverable by deploy.
# Failure does NOT abort the deploy — backups are insurance, not the
# critical path, and a 5xx on the PB backup endpoint shouldn't block
# pushing a hotfix. Warning goes to stderr so it's visible in the deploy
# log if it ever silently degrades.
pre_deploy_backup() {
    local api_url="${HOMELAB_API_URL:-https://api.${DOMAIN:-kirkl.in}}"
    local pb_url="${PB_URL:-${api_url}}"
    # Solo-user: email is well-known, hardcoded as the default everywhere else
    # too (services/scripts/*.ts). Only PB_ADMIN_PASSWORD must come from .env.
    local email="${PB_ADMIN_EMAIL:-scott.kirklin@gmail.com}"
    local password="${PB_ADMIN_PASSWORD:-}"
    if [ -z "$password" ]; then
        echo "[deploy.sh] (pre-deploy-backup) skipped: PB_ADMIN_PASSWORD not in .env" >&2
        return 0
    fi
    command -v jq >/dev/null 2>&1 || {
        echo "[deploy.sh] (pre-deploy-backup) skipped: jq not installed locally" >&2
        return 0
    }

    local sha ts key auth_resp token
    sha=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
    # PB rejects uppercase chars in backup names (regex `^[a-z0-9_-]+\.zip$`).
    # Use lowercase `t`/`z` separators; git short SHA is hex (lowercase).
    ts=$(date -u +%Y%m%dt%H%M%Sz)
    key="pre-deploy-${sha}-${ts}.zip"

    auth_resp=$(curl -fsS --max-time 15 -X POST "${pb_url}/api/collections/_superusers/auth-with-password" \
        -H "Content-Type: application/json" \
        -d "$(jq -nc --arg id "$email" --arg pw "$password" '{identity:$id, password:$pw}')" 2>/dev/null) || {
        echo "[deploy.sh] WARNING: pre-deploy backup auth failed (continuing deploy)" >&2
        return 0
    }
    token=$(printf '%s' "$auth_resp" | jq -er .token 2>/dev/null) || {
        echo "[deploy.sh] WARNING: pre-deploy backup auth response had no token (continuing)" >&2
        return 0
    }

    # PB session token: no `Bearer ` prefix.
    if curl -fsS --max-time 60 -X POST "${pb_url}/api/backups" \
            -H "Authorization: ${token}" \
            -H "Content-Type: application/json" \
            -d "$(jq -nc --arg name "$key" '{name:$name}')" > /dev/null 2>&1; then
        echo "[deploy.sh] pre-deploy backup created: ${key}"
    else
        echo "[deploy.sh] WARNING: pre-deploy backup POST failed (continuing deploy)" >&2
    fi
}
pre_deploy_backup

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
        --arg variant "${DEPLOY_VARIANT:-prod}" \
        --argjson apps "$apps_json" \
        --argjson failed_apps "$failed_json" \
        --argjson duration_seconds "$duration" \
        '{git_sha:$git_sha, git_branch:$git_branch, git_subject:$git_subject, status:$status, deployer:$deployer, host:$host, variant:$variant, apps:$apps, failed_apps:$failed_apps, duration_seconds:$duration_seconds}')

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
    [life]="apps/life/app:dist"
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
# Honors $IMAGE_TAG (default "latest"; --beta sets it to "beta") so a beta
# build doesn't overwrite the prod :latest tag in the registry.
run_docker_build() {
    local app="$1"
    local prefix="$2"
    shift 2
    local push_tag="${PUSH_REGISTRY}/homelab/${app}:${IMAGE_TAG}"
    local k8s_tag="${K8S_REGISTRY}/${app}:${IMAGE_TAG}"
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
    # Whole-cluster deploy only operates on :latest — don't accidentally
    # push :beta (or any other side-tag) if a prior --beta run left some
    # tagged images in the local docker cache.
    IMAGES=($(docker images --filter "reference=${PUSH_REGISTRY}/homelab/*:latest" --format "{{.Repository}}:{{.Tag}}"))
else
    IMAGES=()
    for app in "${APPS[@]}"; do
        IMAGES+=("${PUSH_REGISTRY}/homelab/${app}:${IMAGE_TAG}")
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
# Clear the remote manifest dir before re-syncing. The previous additive
# tar-only flow left orphans whenever a manifest was deleted from the repo
# (caused supabase to keep coming back for months after `0860dd6` removed it).
# Scoped to top-level .yaml/.yml only — preserves any other files dropped in
# the dir, doesn't recurse, and won't go anywhere weird if the path expands
# unexpectedly (no `rm -rf` of a variable).
ssh "${VPS}" 'set -e
  mkdir -p ~/homelab-manifests
  find ~/homelab-manifests -maxdepth 1 -type f \( -name "*.yaml" -o -name "*.yml" \) -delete'
tar -cf - -C infra/k8s . | ssh "${VPS}" "tar -xf - -C ~/homelab-manifests/"
ssh "${VPS}" "kubectl apply -k ~/homelab-manifests/"

echo ""
echo "=== Restarting deployments ==="
if [ "$BETA" = true ]; then
    # Beta channel: roll out only home-beta. Production `home` Deployment
    # is left completely untouched (and still pulling :latest).
    echo "Restarting home-beta..."
    ssh "${VPS}" "kubectl rollout restart -n homelab deployment/home-beta"
elif [ ${#APPS[@]} -eq 0 ]; then
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
