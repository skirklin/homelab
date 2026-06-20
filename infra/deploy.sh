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
#   ./infra/deploy.sh --skip-tests # bypass pre-deploy typecheck+test gate
#                                  # (hotfix escape hatch; SKIP_TESTS=1 also works)
set -euo pipefail

# ─── Resource enforcement ────────────────────────────────────────────────────
# WSL2 doesn't bound process memory by default — a runaway tsc / vite / docker
# build can eat all the VM's RAM and freeze the host. Re-exec ourselves inside
# a transient systemd-run scope with a hard memory cap so the kernel OOM-kills
# inside the scope instead of taking down the whole VM.
#
# Conditional on systemd being available (PID 1 systemd OR systemctl --user
# running) — if not, we run as before with a single-line warning. To opt out
# of the wrap (e.g. CI environments that already do their own enforcement),
# set HOMELAB_DEPLOY_UNBOUNDED=1. Override the cap with HOMELAB_DEPLOY_MEMORY=NG.
if [ -z "${HOMELAB_DEPLOY_SCOPE:-}" ] && [ -z "${HOMELAB_DEPLOY_UNBOUNDED:-}" ]; then
    # Probe the actual capability we need (transient scope creation) instead
    # of checking is-system-running, which returns non-zero on the common
    # "degraded" state (e.g. pulseaudio failed — irrelevant to us).
    if command -v systemd-run >/dev/null 2>&1 \
       && systemd-run --user --scope --quiet --no-block -- true 2>/dev/null; then
        DEPLOY_MEM_CAP="${HOMELAB_DEPLOY_MEMORY:-8G}"
        echo "→ entering memory-bounded scope (MemoryMax=${DEPLOY_MEM_CAP}, swap=0)" >&2
        export HOMELAB_DEPLOY_SCOPE=1
        exec systemd-run --user --scope --quiet \
            --unit="homelab-deploy-$$" \
            -p MemoryMax="${DEPLOY_MEM_CAP}" \
            -p MemorySwapMax=0 \
            -- "$0" "$@"
    else
        echo "⚠  systemd --user scope creation unavailable — running without memory cap" >&2
        echo "   (enable systemd in /etc/wsl.conf + restart WSL to bound this deploy)" >&2
    fi
fi

# Cap V8 heap per Node process (tsc, vite, esbuild, vitest, etc.). The default
# is ~4 GB; compounding across the workspace this can blow past any reasonable
# scope cap. 2 GB is plenty for our packages; override per-invocation if a
# bigger bundle needs it.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"

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

# Helper used by both the pre-deploy test gate and the build/push phases.
elapsed() {
    local secs=$1
    if [ "$secs" -ge 60 ]; then
        printf "%dm%02ds" $((secs / 60)) $((secs % 60))
    else
        printf "%ds" "$secs"
    fi
}

# Parse flags
PUSH_ONLY=false
BETA=false
SKIP_TESTS="${SKIP_TESTS:-0}"
APPS=()
for arg in "$@"; do
    case "$arg" in
        --push-only) PUSH_ONLY=true ;;
        --beta) BETA=true ;;
        --skip-tests) SKIP_TESTS=1 ;;
        --help|-h)
            sed -n '2,13p' "$0"
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

# ─── Pre-deploy test gate ────────────────────────────────────────────────────
# Lightweight CI: typecheck + unit tests must pass before we build images.
# Runs at the deploy chokepoint the user already feels, so broken code can't
# silently ship. Skipped on --push-only (no new code is being built) and on
# --skip-tests / SKIP_TESTS=1 (hotfix escape hatch — prints a loud warning).
RED=""
YELLOW=""
NC=""
if [ -t 2 ]; then
    # Only colorize when stderr is a TTY; CI/log capture stays clean.
    RED=$'\033[31m'
    YELLOW=$'\033[33m'
    NC=$'\033[0m'
fi

if [ "$PUSH_ONLY" = false ] && [ "$SKIP_TESTS" = 1 ]; then
    {
        echo ""
        echo "${RED}⚠  WARNING: SKIPPING PRE-DEPLOY TEST GATE${NC}"
        echo "${RED}⚠  This deploy may ship broken code.${NC}"
        echo "${RED}⚠  Override should only be used for hotfixes when tests are environmentally blocked.${NC}"
        echo ""
        echo "${YELLOW}   Continuing in 3s (Ctrl-C to abort)...${NC}"
        echo ""
    } >&2
    sleep 3
elif [ "$PUSH_ONLY" = false ]; then
    GATE_START=$SECONDS
    echo "=== Pre-deploy test gate ==="

    if ! command -v pnpm >/dev/null 2>&1; then
        echo "[deploy.sh] pnpm not found on PATH — install pnpm or run \`fnm use\`. Aborting." >&2
        exit 1
    fi

    # Cycle this worktree's test env via `test-env.sh fresh` (NOT `up`) so each
    # gate run starts against a freshly-rebuilt PB. `up` is idempotent and
    # would reuse a long-lived PB whose auth/realtime/index state has drifted
    # across runs — the root cause of the 2026-05 shopping deterministic-failure
    # (state outside the per-collection `wipeCollections` scope). `fresh` does
    # `down + up` under a per-worktree flock, so concurrent gates in the same
    # worktree serialize cleanly. Image stays cached, so the cycle is ~10-20s.
    #
    # NOT a raw curl probe — a bare health check trusts whatever answers the
    # port, so a FOREIGN container squatting our port would sail through and
    # the whole gate would run against the wrong PB/API (the 2026-05
    # spurious-failure bug). The `up` invoked inside `fresh` fails loud on a
    # squatter with a reap/triage hint.
    #
    # Note: `fresh` may exit 0 with PB-only ready if the API genuinely failed
    # to start (most suites don't need it); we re-verify the API through
    # `test-env.sh check` just before Playwright below.
    TEST_PB_URL=$(infra/test-env.sh url --pb)
    TEST_API_URL=$(infra/test-env.sh url --api)
    # Export the URLs so child processes inherit them: apps/* tests key off
    # PB_TEST_URL, services/api/* off PB_URL, and the Playwright-spawned Vite
    # dev server resolves its `/fn` proxy target from TEST_API_URL.
    export PB_TEST_URL="$TEST_PB_URL"
    export PB_URL="$TEST_PB_URL"
    export TEST_API_URL
    echo "→ Cycling test env (PocketBase ${TEST_PB_URL} + API ${TEST_API_URL}) — fresh PB for this gate..."
    if ! infra/test-env.sh fresh; then
        {
            echo ""
            echo "${RED}[deploy.sh] Test environment failed to rebuild (or a foreign container is${NC}"
            echo "${RED}            squatting this worktree's port — see the message above). Common causes:${NC}"
            echo "${RED}  • Docker daemon not running (start Docker Desktop)${NC}"
            echo "${RED}  • Port held by a sibling/dead worktree's container${NC}"
            echo "${RED}    (triage: \`docker ps\`; reap dead ones: \`infra/test-env.sh reap\`)${NC}"
            echo "${RED}  • First-run image build failure — run \`infra/test-env.sh fresh\` manually to see logs${NC}"
            echo ""
            echo "${RED}  Hotfix override: re-run with --skip-tests${NC}"
            echo ""
        } >&2
        exit 1
    fi

    echo "→ Running \`pnpm typecheck\`..."
    if ! pnpm typecheck; then
        {
            echo ""
            echo "${RED}[deploy.sh] Pre-deploy gate failed: \`pnpm typecheck\`.${NC}"
            echo "${RED}  Fix the type errors above before deploying.${NC}"
            echo "${RED}  Hotfix override: re-run with --skip-tests${NC}"
            echo ""
        } >&2
        exit 1
    fi

    # Cap each package's vitest worker pool to 2 forks for the gate run (the
    # `-- --max-workers=2` passthrough reaches every `vitest run`). turbo is
    # already at `--concurrency=1` so packages run one-at-a-time; this bounds
    # the *within-package* file parallelism too. The point is peak memory:
    # several parallel Claude sessions each run their own gate against their own
    # PB container on a box with no swap, and an uncapped vitest pool spawns
    # one fork per CPU — the host-contention races that flake unrelated e2e
    # specs (shopping sharing, upkeep assertions) trace to that RSS spike, not
    # real regressions. Invoke turbo directly (not `pnpm test`) because pnpm
    # eats the first `--`, so the passthrough never reaches turbo otherwise.
    echo "→ Running \`turbo run test\` (gate; --max-workers=2)..."
    if ! pnpm exec turbo run test --concurrency=1 -- --max-workers=2; then
        {
            echo ""
            echo "${RED}[deploy.sh] Pre-deploy gate failed: \`pnpm test\`.${NC}"
            echo "${RED}  Fix the failing tests above before deploying.${NC}"
            echo "${RED}  Hotfix override: re-run with --skip-tests${NC}"
            echo ""
        } >&2
        exit 1
    fi

    # Playwright suites need the test API container too (not just PB). The
    # upfront `up` already ensured it, but `up` exits 0 with PB-only ready when
    # the API genuinely failed (most suites don't need it). Verify the FULL env
    # via `test-env.sh check` — which now requires that OUR container owns both
    # host ports, not just that something answers — and run `up` once more to
    # recover a transient API miss before failing loud.
    echo "→ Verifying test API at ${TEST_API_URL} is up + owned (for Playwright)..."
    if ! infra/test-env.sh check; then
        infra/test-env.sh up || true
        if ! infra/test-env.sh check; then
            {
                echo ""
                echo "${RED}[deploy.sh] Test API not healthy/owned at ${TEST_API_URL} after \`up\`.${NC}"
                echo "${RED}  Playwright suite can't run against a container we don't own.${NC}"
                echo "${RED}  Status: \`infra/test-env.sh status\`${NC}"
                echo "${RED}  Logs:   \`docker compose -f docker-compose.test.yml logs api\`${NC}"
                echo "${RED}  Hotfix override: re-run with --skip-tests${NC}"
                echo ""
            } >&2
            exit 1
        fi
    fi

    echo "→ Running \`pnpm test:playwright\`..."
    if ! pnpm test:playwright; then
        {
            echo ""
            echo "${RED}[deploy.sh] Pre-deploy gate failed: \`pnpm test:playwright\`.${NC}"
            echo "${RED}  Fix the failing Playwright specs above before deploying.${NC}"
            echo "${RED}  HTML report: apps/<app>/app/playwright-report/index.html${NC}"
            echo "${RED}  Hotfix override: re-run with --skip-tests${NC}"
            echo ""
        } >&2
        exit 1
    fi

    echo "✓ Pre-deploy gate passed ($(elapsed $((SECONDS - GATE_START))))"
    echo ""
fi

# The gate exported test-env URLs (PB_TEST_URL/PB_URL/TEST_API_URL) so the test
# suites talked to the dockerized test PB. They must NOT leak past the gate:
# pre_deploy_backup reads ${PB_URL:-<prod>} and would otherwise back up the
# *test* PB instead of prod (failing soft → silently no pre-deploy backup).
# Nothing downstream of the gate legitimately needs them. Unset now.
unset PB_URL PB_TEST_URL TEST_API_URL TEST_PB_PORT TEST_API_PORT

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

# Pre-deploy lint — block the deploy if PB migrations / hooks carry the
# 2026-05-22 goja JSON byte-array bug pattern. Cheap (sub-second) so we
# always run it; hard exit so a known-bad pattern can never ship. Allowlist
# for frozen historical migrations lives inside the script.
if [ -x "infra/scripts/lint-pb-migrations.sh" ]; then
    if ! infra/scripts/lint-pb-migrations.sh; then
        echo "[deploy.sh] PB migration/hook lint failed — fix findings above or annotate with \`// lint-skip: <reason>\`. Aborting deploy." >&2
        exit 1
    fi
fi

# Pre-deploy PB backup — belt-and-suspenders on top of the nightly
# pb-backup-daily CronJob. A migration shipped on a Wednesday and the
# nightly only ran Tuesday is exactly the gap that bit us on 2026-05-22.
# Tags the backup key with the git SHA so it's recoverable by deploy.
#
# PB's POST /api/backups returns 204 on *enqueue* — a 2xx does NOT mean a
# usable zip exists. So after the POST we GET /api/backups and assert the
# just-created key is present with non-zero size; only then is the restore
# point real. (GET returns [{key, size, modified}, ...].)
#
# Failure handling depends on the deploy mode. For a normal deploy the whole
# point of this hook is a restore point before a potentially-destructive
# migration, so a failed/unverifiable backup ABORTS (return 1 → set -e exits,
# exit trap records failure). The escape hatches that already say "I accept
# risk" — --skip-tests / SKIP_TESTS=1 (hotfix) and --push-only (no new code) —
# downgrade to a loud warning so a 5xx on the backup endpoint can't wedge a
# hotfix.
pre_deploy_backup() {
    local api_url="${HOMELAB_API_URL:-https://api.${DOMAIN:-kirkl.in}}"
    local pb_url="${PB_URL:-${api_url}}"
    # Solo-user: email is well-known, hardcoded as the default everywhere else
    # too (services/scripts/*.ts). Only PB_ADMIN_PASSWORD must come from .env.
    local email="${PB_ADMIN_EMAIL:-scott.kirklin@gmail.com}"
    local password="${PB_ADMIN_PASSWORD:-}"

    # Whether an unverifiable backup is fatal. Hotfix (--skip-tests) and
    # --push-only deploys accept the risk; a normal deploy must not proceed
    # without a real restore point.
    local fatal=true
    if [ "$PUSH_ONLY" = true ] || [ "$SKIP_TESTS" = 1 ]; then
        fatal=false
    fi
    # Centralized failure path: abort (fatal) or warn-and-continue.
    fail_backup() {
        if [ "$fatal" = true ]; then
            echo "${RED}[deploy.sh] pre-deploy backup failed: $1${NC}" >&2
            echo "${RED}  Refusing to deploy without a verified restore point.${NC}" >&2
            echo "${RED}  Override (accepts risk): --skip-tests or --push-only.${NC}" >&2
            return 1
        fi
        echo "[deploy.sh] WARNING: pre-deploy backup failed: $1 (continuing — risk accepted)" >&2
        return 0
    }

    if [ -z "$password" ]; then
        fail_backup "PB_ADMIN_PASSWORD not in .env" || return 1
        return 0
    fi
    command -v jq >/dev/null 2>&1 || {
        fail_backup "jq not installed locally" || return 1
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
        fail_backup "auth request to ${pb_url} failed" || return 1
        return 0
    }
    token=$(printf '%s' "$auth_resp" | jq -er .token 2>/dev/null) || {
        fail_backup "auth response had no token" || return 1
        return 0
    }

    # PB session token: no `Bearer ` prefix. 204 here means "enqueued", not
    # "done" — we verify with a GET below before trusting it.
    if ! curl -fsS --max-time 120 -X POST "${pb_url}/api/backups" \
            -H "Authorization: ${token}" \
            -H "Content-Type: application/json" \
            -d "$(jq -nc --arg name "$key" '{name:$name}')" > /dev/null 2>&1; then
        fail_backup "POST /api/backups failed" || return 1
        return 0
    fi

    # Verify the zip actually landed: GET the list and assert our key is
    # present with non-zero size. PB writes the backup synchronously before
    # returning the enqueue 204 in current versions, but a single GET can race
    # a slow flush, so retry a few times before giving up.
    local listing entry size attempt
    for attempt in 1 2 3 4 5; do
        listing=$(curl -fsS --max-time 30 "${pb_url}/api/backups" \
            -H "Authorization: ${token}" 2>/dev/null) || listing=""
        if [ -n "$listing" ]; then
            entry=$(printf '%s' "$listing" | jq -c --arg k "$key" '.[] | select(.key == $k)' 2>/dev/null || echo "")
            if [ -n "$entry" ]; then
                size=$(printf '%s' "$entry" | jq -r '.size // 0' 2>/dev/null || echo 0)
                if [ "${size:-0}" -gt 0 ] 2>/dev/null; then
                    echo "[deploy.sh] pre-deploy backup verified: ${key} (${size} bytes)"
                    return 0
                fi
            fi
        fi
        [ "$attempt" -lt 5 ] && sleep 2
    done

    fail_backup "backup ${key} not found with non-zero size after POST (enqueue may have failed)" || return 1
    return 0
}
# NOTE: pre_deploy_backup is INVOKED below, after the EXIT trap is installed,
# so a backup-abort (normal deploy, unverifiable backup) is still recorded as a
# failed deployment instead of dying before the recorder exists.

# Deployment recording — POSTs a row to the monitor's deployments collection
# via api.kirkl.in. Tracks success/failure via DEPLOY_STATUS, set just before
# the final "Deploy complete" echo. Trap on EXIT so failures get recorded too.
DEPLOY_START=$SECONDS
DEPLOY_STATUS="failure"
FAILED_APPS=()
# Set by the build phase to its scratch dir; cleaned up by on_exit. Declared
# here (before the trap is installed) so the trap can reference it even if we
# exit before the build phase runs.
BUILD_TMP=""

record_deployment() {
    local exit_code="$1"
    # No token → skip recording silently. The deploy still succeeds, but the
    # `deployments` collection gets no row, so the monitor shows a gap in
    # deploy history with no warning anywhere. (Same for a missing `jq` below.)
    [ -z "${HOMELAB_API_TOKEN:-}" ] && return "$exit_code"
    command -v jq >/dev/null 2>&1 || return "$exit_code"

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
            return "$exit_code"
        fi
        [ "$attempt" -lt 3 ] && sleep 10
    done
    echo "[deploy.sh] failed to record deployment after 3 attempts (status=${DEPLOY_STATUS})" >&2

    return "$exit_code"
}

# Single EXIT trap: capture the real exit code FIRST (before any cleanup
# command can clobber $?), tear down the build scratch dir, then record the
# deployment with the preserved code. Folding temp-cleanup in here (rather than
# re-installing the trap inside the build block) keeps record_deployment seeing
# the script's actual exit status, not `rm`'s.
on_exit() {
    local code=$?
    [ -n "$BUILD_TMP" ] && rm -rf "$BUILD_TMP"
    record_deployment "$code"
}
trap on_exit EXIT

# Now that the recorder + trap are live, take the pre-deploy backup. On a
# normal deploy an unverifiable backup aborts here (set -e), and on_exit
# records the failed deployment.
pre_deploy_backup

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
    [coach]="infra/docker/coach.Dockerfile"
)

# Run `docker build` with the given args and report success/failure.
# Usage: run_docker_build <app> <progress_prefix> <docker_build_args...>
# Honors $IMAGE_TAG (default "latest"; --beta sets it to "beta") so a beta
# build doesn't overwrite the prod :latest tag in the registry.
#
# Overridable for testing: set DEPLOY_BUILD_CMD to a function/command name and
# it's called instead of `docker build` (used by the test harness to simulate
# a per-app failure and prove cross-subshell exit-code collection).
run_docker_build() {
    local app="$1"
    local prefix="$2"
    shift 2
    local push_tag="${PUSH_REGISTRY}/homelab/${app}:${IMAGE_TAG}"
    local k8s_tag="${K8S_REGISTRY}/${app}:${IMAGE_TAG}"
    local app_start=$SECONDS
    echo "${prefix} Building ${app}..."
    # Docker enforces per-build memory via cgroups under the hood. Cap each
    # BuildKit worker at 3 GB so a pathological build can't run away even if
    # the outer scope is generous. Override with HOMELAB_BUILD_MEMORY=NG.
    local build_mem="${HOMELAB_BUILD_MEMORY:-3g}"
    if "${DEPLOY_BUILD_CMD:-docker}" build -q \
            --memory="${build_mem}" --memory-swap="${build_mem}" \
            "$@" -t "${push_tag}" -t "${k8s_tag}" . > /dev/null 2>&1; then
        echo "${prefix} ✓ ${app} ($(elapsed $((SECONDS - app_start))))"
        return 0
    else
        echo "${prefix} ✗ ${app} FAILED"
        return 1
    fi
}

# Build the docker-build argument vector for a single app. Echoes the args
# (newline-separated, since none contain newlines) and returns non-zero for an
# unknown app. Shared by the serial and parallel build paths so there's exactly
# one place that knows APP_BUILDS vs SERVICE_BUILDS.
build_args_for() {
    local app="$1"
    if [ -n "${APP_BUILDS[$app]+x}" ]; then
        # Vite frontend → shared app.Dockerfile with build args
        local app_dir dist_dir nginx_conf nginx_conf_dest
        IFS=: read -r app_dir dist_dir nginx_conf nginx_conf_dest <<< "${APP_BUILDS[$app]}"
        # No VITE_* build-args: the bundle is built on the host now (turbo),
        # so the image is a thin COPY of the pre-built dist into nginx.
        printf '%s\n' \
            -f infra/docker/app.Dockerfile \
            --build-arg "APP=${app}" \
            --build-arg "APP_DIR=${app_dir}" \
            --build-arg "DIST_DIR=${dist_dir}"
        [ -n "$nginx_conf" ] && printf '%s\n' --build-arg "NGINX_CONF=${nginx_conf}"
        [ -n "$nginx_conf_dest" ] && printf '%s\n' --build-arg "NGINX_CONF_DEST=${nginx_conf_dest}"
        return 0
    elif [ -n "${SERVICE_BUILDS[$app]+x}" ]; then
        # Service with its own Dockerfile, no app-level build args
        printf '%s\n' -f "${SERVICE_BUILDS[$app]}"
        return 0
    fi
    return 1
}

# Build phase
if [ "$PUSH_ONLY" = false ]; then
    if [ ${#APPS[@]} -eq 0 ]; then
        BUILD_LIST=("${!APP_BUILDS[@]}" "${!SERVICE_BUILDS[@]}")
    else
        BUILD_LIST=("${APPS[@]}")
    fi

    # Validate the whole list up front so an unknown app fails before we kick
    # off any (possibly-backgrounded) builds.
    for app in "${BUILD_LIST[@]}"; do
        if [ -z "${APP_BUILDS[$app]+x}" ] && [ -z "${SERVICE_BUILDS[$app]+x}" ]; then
            echo "Unknown app: ${app}" >&2
            echo "  Known APP_BUILDS: ${!APP_BUILDS[*]}" >&2
            echo "  Known SERVICE_BUILDS: ${!SERVICE_BUILDS[*]}" >&2
            exit 1
        fi
    done

    # ─── Host-side vite build (turbo-cached) ─────────────────────────────────
    # Frontend apps (APP_BUILDS) are built on the HOST, not inside Docker — the
    # app.Dockerfile is now a thin `COPY dist → nginx`. Turbo caches by input
    # hash, so unchanged apps are instant on a re-deploy (the main win). We must
    # bake the SAME Vite env the old Docker build baked in: VITE_DOMAIN comes
    # from ${DOMAIN:-kirkl.in} (unchanged by --beta — beta only forks the image
    # TAG, not the domain) and VITE_GOOGLE_MAPS_API_KEY from .env. These are
    # declared in turbo.json's build `env`, so a domain change invalidates the
    # cache instead of returning a stale bundle.
    #
    # Filter turbo by the app's source DIRECTORY (./apps/.../) rather than its
    # package name — money's package is "frontend" and monitor's is "monitor",
    # so a name map would be one more thing to keep in sync; the dir is already
    # in APP_BUILDS. `^build` pulls in the workspace deps (@kirkl/shared etc.).
    HOST_BUILD_FILTERS=()
    for app in "${BUILD_LIST[@]}"; do
        if [ -n "${APP_BUILDS[$app]+x}" ]; then
            app_dir="${APP_BUILDS[$app]%%:*}"
            HOST_BUILD_FILTERS+=("--filter=./${app_dir}")
        fi
    done
    if [ ${#HOST_BUILD_FILTERS[@]} -gt 0 ]; then
        echo "=== Building ${#HOST_BUILD_FILTERS[@]} frontend app(s) on host (turbo-cached) ==="
        HOST_BUILD_START=$SECONDS
        if ! VITE_DOMAIN="${DOMAIN:-kirkl.in}" \
             VITE_GOOGLE_MAPS_API_KEY="${VITE_GOOGLE_MAPS_API_KEY:-}" \
             pnpm exec turbo run build "${HOST_BUILD_FILTERS[@]}"; then
            echo "[deploy.sh] Host vite build failed — aborting before image build." >&2
            exit 1
        fi
        echo "✓ Host build ($(elapsed $((SECONDS - HOST_BUILD_START))))"
        echo ""
    fi

    TOTAL=${#BUILD_LIST[@]}
    BUILD_START=$SECONDS

    # Lean by default. Frontend images are now thin (host-built dist → nginx
    # COPY), but SERVICE_BUILDS still compile inside Docker (~2-3 GB peak each:
    # pnpm install + tsc/esbuild). Default to SERIAL; the outer systemd scope
    # caps total memory, but serial keeps the peak predictable. Override with
    # DEPLOY_BUILD_JOBS=N for "I have RAM, go fast" (CI is the canonical case).
    #
    # The footgun: you CANNOT collect exit codes by appending to a bash array
    # from `&`-backgrounded subshells — the appends happen in the subshell and
    # vanish when it exits. Each background job instead writes its result to a
    # per-app status file ("$tmpdir/<app>.status": "ok" or "fail"); after
    # `wait` we read those files back in the parent to build FAILED_APPS.
    MAX_JOBS="${DEPLOY_BUILD_JOBS:-1}"
    # A single-app build (the common selective-deploy case) has nothing to
    # parallelize; force serial so output isn't muddied and there's no temp dir.
    [ "$TOTAL" -le 1 ] && MAX_JOBS=1

    echo "=== Building ${TOTAL} images (up to ${MAX_JOBS} in parallel) ==="
    echo ""

    # Scratch dir for per-app status files. The EXIT trap (on_exit) cleans it
    # up; we just point it at our dir here rather than re-installing the trap.
    BUILD_TMP=$(mktemp -d "${TMPDIR:-/tmp}/homelab-build.XXXXXX")

    build_one() {
        # Runs (often) in a backgrounded subshell. MUST NOT mutate parent
        # state — it communicates success/failure only via its status file.
        local app="$1" idx="$2"
        local prefix="[${idx}/${TOTAL}]"
        local args=()
        # build_args_for can't fail here — the list was validated above.
        mapfile -t args < <(build_args_for "$app")
        if run_docker_build "$app" "$prefix" "${args[@]}"; then
            echo ok > "${BUILD_TMP}/${app}.status"
        else
            echo fail > "${BUILD_TMP}/${app}.status"
        fi
    }

    BUILT=0
    for app in "${BUILD_LIST[@]}"; do
        BUILT=$((BUILT + 1))
        if [ "$MAX_JOBS" -le 1 ]; then
            build_one "$app" "$BUILT"
        else
            # Throttle: block until a slot frees up before launching the next.
            while [ "$(jobs -rp | wc -l)" -ge "$MAX_JOBS" ]; do
                wait -n 2>/dev/null || true
            done
            build_one "$app" "$BUILT" &
        fi
    done
    wait

    # Collect results from the per-app status files (parent process, post-wait,
    # so the writes are all visible). A missing/non-"ok" file counts as failure.
    FAILED=0
    for app in "${BUILD_LIST[@]}"; do
        if [ "$(cat "${BUILD_TMP}/${app}.status" 2>/dev/null)" != "ok" ]; then
            FAILED=$((FAILED + 1))
            FAILED_APPS+=("$app")
        fi
    done

    echo ""
    if [ "$FAILED" -gt 0 ]; then
        echo "Build: ${FAILED}/${TOTAL} failed (${FAILED_APPS[*]}) ($(elapsed $((SECONDS - BUILD_START))))"
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
PUSH_FAILED=0
PUSH_FAILED_IMAGES=()
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
        PUSH_FAILED=$((PUSH_FAILED + 1))
        PUSH_FAILED_IMAGES+=("$short")
    fi
done
echo ""
# A failed push means k8s would pull a stale tag (or hit ImagePullBackOff) —
# never proceed to `kubectl apply`. Abort exactly like the build loop does.
if [ "$PUSH_FAILED" -gt 0 ]; then
    echo "Push: ${PUSH_FAILED}/${PUSH_TOTAL} failed (${PUSH_FAILED_IMAGES[*]}) ($(elapsed $((SECONDS - PUSH_START))))" >&2
    echo "[deploy.sh] Aborting before manifest apply — refusing to deploy stale images." >&2
    exit 1
fi
echo "Push: ${PUSH_TOTAL} images ($(elapsed $((SECONDS - PUSH_START))))"

echo ""
echo "=== Applying manifests ==="
# Clear the remote manifest dir before re-syncing. The previous additive
# tar-only flow left orphans whenever a manifest was deleted from the repo —
# historically a removed deploy's resources would resurrect themselves for
# months (a manifest deleted in `0860dd6` kept reappearing because the stale
# copy lingered on the VPS), so this prevents that class of stale-resource
# regression. Scoped to top-level .yaml/.yml only — preserves any other files
# dropped in the dir, doesn't recurse, and won't go anywhere weird if the path
# expands unexpectedly (no `rm -rf` of a variable).
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
    # Full deploy: restart everything. Do NOT swallow failures — a failed
    # rollout restart here means images were pushed but pods never restarted,
    # so prod silently keeps running old code while DEPLOY_STATUS flips to
    # "success". Let the failure surface (set -e exits, the exit trap records
    # the failed deploy).
    ssh "${VPS}" "kubectl rollout restart -n homelab deployments,statefulsets"
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
