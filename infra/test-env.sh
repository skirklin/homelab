#!/usr/bin/env bash
# Start, stop, or check the test environment (PocketBase + API containers)
# used by vitest e2e tests and Playwright tests.
#
# Usage:
#   infra/test-env.sh up                    # start containers, wait for health
#   infra/test-env.sh down                  # stop containers
#   infra/test-env.sh status                # print status
#   infra/test-env.sh check                 # exit 0 if healthy, 1 otherwise
#   infra/test-env.sh url [--api|--pb]      # print PB/API URL for this shell
#   infra/test-env.sh port [--api|--pb]     # print PB/API port for this shell
#
# Port allocation (so parallel worktrees don't collide on a shared PB):
#   - If $TEST_PB_PORT is set, use it (manual override).
#   - Else if cwd is inside `.claude/worktrees/agent-*/`, derive a stable port
#     from the worktree's `agent-XXXX` basename: 8091 + (cksum(basename) % 1000).
#     The API port follows the same offset on top of 3001.
#   - Else (main checkout) → 8091 / 3001 (legacy default).
# Once `up` succeeds the chosen URLs are written to `.test-env-port` at the
# repo root so downstream callers can read them without recomputing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.test.yml"

# ─── Port derivation ─────────────────────────────────────────────────────────
# Pick a deterministic per-worktree port so concurrent agent sessions don't
# trample each other's PB. `cksum` is POSIX and gives a stable 32-bit hash;
# mod 1000 keeps us inside 8091..9090 / 3001..4000.
derive_port_offset() {
    if [ -n "${TEST_PB_PORT:-}" ]; then
        # Manual override — preserve the exact PB port the caller picked,
        # but still derive an API offset from the worktree basename so
        # parallel worktrees with the same TEST_PB_PORT (unlikely) still
        # don't collide on :3001. Hash whatever basename we have.
        echo "manual"
        return
    fi
    local cwd_basename
    cwd_basename=$(basename "$ROOT")
    if [[ "$cwd_basename" == agent-* ]]; then
        # cksum prints "<hash> <bytes> <filename?>" — first field is the
        # checksum. printf+cksum keeps it pure-stdin so no temp file.
        local hash
        hash=$(printf '%s' "$cwd_basename" | cksum | awk '{print $1}')
        echo $((hash % 1000))
    else
        echo "0"
    fi
}

OFFSET=$(derive_port_offset)
if [ "$OFFSET" = "manual" ]; then
    PB_PORT="${TEST_PB_PORT}"
    # When PB port is overridden, derive an independent API offset so the
    # two ports don't both end up at their defaults and collide.
    API_OFFSET=$(printf '%s' "$(basename "$ROOT")" | cksum | awk '{print $1 % 1000}')
    API_PORT=$((3001 + API_OFFSET))
else
    PB_PORT=$((8091 + OFFSET))
    API_PORT=$((3001 + OFFSET))
fi

PB_URL="http://127.0.0.1:${PB_PORT}"
API_URL="http://127.0.0.1:${API_PORT}"

# Compose project name — defaults to cwd basename, which is already
# per-worktree. Make it explicit and prefixed so `docker ps` is readable
# and `docker compose down` from any worktree only kills its own stack.
PROJECT_NAME="homelab-test-$(basename "$ROOT")"

# Export so child processes (compose, vitest, etc.) see them.
export TEST_PB_PORT="$PB_PORT"
export TEST_API_PORT="$API_PORT"
export PB_TEST_URL="$PB_URL"
export TEST_API_URL="$API_URL"

PORT_FILE="$ROOT/.test-env-port"

# Find docker. On WSL2 with Docker Desktop, `docker` is usually a shim
# that fails; `docker.exe` actually works.
if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then
    DOCKER=docker
elif command -v docker.exe >/dev/null 2>&1; then
    DOCKER=docker.exe
else
    echo "Error: docker not found. Install Docker Desktop (Windows) or docker (Linux)." >&2
    exit 1
fi

compose() {
    "$DOCKER" compose \
        --project-name "$PROJECT_NAME" \
        --project-directory "$ROOT" \
        -f "$COMPOSE_FILE" "$@"
}

check() {
    local pb_ok api_ok
    pb_ok=$(curl -fs "$PB_URL/api/health" >/dev/null 2>&1 && echo yes || echo no)
    api_ok=$(curl -fs "$API_URL/health" >/dev/null 2>&1 && echo yes || echo no)
    echo "PocketBase ($PB_URL): $pb_ok"
    echo "API        ($API_URL): $api_ok"
    [[ "$pb_ok" == "yes" && "$api_ok" == "yes" ]]
}

write_port_file() {
    cat > "$PORT_FILE" <<EOF
# Auto-written by infra/test-env.sh — current worktree's test environment.
# Gitignored. Source this file to pick up TEST_PB_PORT/PB_TEST_URL/etc.
TEST_PB_PORT=$PB_PORT
TEST_API_PORT=$API_PORT
PB_TEST_URL=$PB_URL
TEST_API_URL=$API_URL
COMPOSE_PROJECT=$PROJECT_NAME
EOF
}

case "${1:-}" in
    up)
        echo "Test env for worktree '$(basename "$ROOT")':"
        echo "  PocketBase → $PB_URL"
        echo "  API        → $API_URL"
        echo "  compose project: $PROJECT_NAME"
        compose up -d
        echo "Waiting for services to be healthy..."
        pb_written=false
        for _ in $(seq 1 30); do
            # Write the port file as soon as PB is up — most callers (vitest
            # PB-only suites, deploy.sh gate) don't need the API. Don't gate
            # the whole script on api-test being healthy.
            if ! $pb_written && curl -fs "$PB_URL/api/health" >/dev/null 2>&1; then
                write_port_file
                pb_written=true
            fi
            if check >/dev/null 2>&1; then
                echo "Ready."
                check
                exit 0
            fi
            sleep 1
        done
        echo "Services did not become healthy in 30s." >&2
        compose ps
        # If PB came up but the api didn't, exit 0 with a warning — `pnpm test`
        # only needs PB. Playwright is the only thing that requires api, and
        # it'll re-probe and explicitly fail with a more useful message.
        if $pb_written; then
            echo "PocketBase is healthy at $PB_URL — continuing (api not up, but most suites don't need it)." >&2
            exit 0
        fi
        exit 1
        ;;
    down)
        compose down
        rm -f "$PORT_FILE"
        ;;
    status)
        compose ps
        echo
        check || true
        ;;
    check)
        check >/dev/null 2>&1
        ;;
    url)
        case "${2:-}" in
            --api) echo "$API_URL" ;;
            ""|--pb) echo "$PB_URL" ;;
            *) echo "Usage: $0 url [--api|--pb]" >&2; exit 1 ;;
        esac
        ;;
    port)
        case "${2:-}" in
            --api) echo "$API_PORT" ;;
            ""|--pb) echo "$PB_PORT" ;;
            *) echo "Usage: $0 port [--api|--pb]" >&2; exit 1 ;;
        esac
        ;;
    *)
        echo "Usage: $0 {up|down|status|check|url|port}" >&2
        exit 1
        ;;
esac
