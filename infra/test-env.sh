#!/usr/bin/env bash
# Start, stop, or check the test environment (PocketBase + API containers)
# used by vitest e2e tests and Playwright tests.
#
# Usage:
#   infra/test-env.sh up                    # reap orphans, start containers, wait for health
#   infra/test-env.sh down                  # stop containers
#   infra/test-env.sh status                # print status
#   infra/test-env.sh check                 # exit 0 if healthy, 1 otherwise
#   infra/test-env.sh reap [--dry-run]      # remove test containers from dead worktrees
#   infra/test-env.sh url [--api|--pb]      # print PB/API URL for this shell
#   infra/test-env.sh port [--api|--pb]     # print PB/API port for this shell
#
# Port allocation (so parallel worktrees don't collide on a shared PB):
#   - If $TEST_PB_PORT is set, use it (manual override).
#   - Else if cwd is inside `.claude/worktrees/agent-*/`, derive a stable port
#     from the worktree's `agent-XXXX` basename: 8091 + (cksum(basename) % 999 + 1).
#     The offset is in 1..999 — never 0 — so an agent worktree can never land on
#     8091/3001 and collide with the main checkout. The API port follows the
#     same offset on top of 3001.
#   - Else (main checkout) → 8091 / 3001 (legacy default; offset 0, reserved).
# Once `up` succeeds the chosen URLs are written to `.test-env-port` at the
# repo root so downstream callers can read them without recomputing.
#
# Self-healing & fail-loud (added 2026-05):
#   - `up` reaps orphan containers FIRST (containers from worktrees that no
#     longer exist), so a stale container can't silently squat on our port.
#   - The readiness check probes the actual *host* port AND verifies the
#     responding container is the one WE started — a squatter answering on the
#     same port no longer counts as "Ready."
#   - If the host port can't be bound or doesn't answer, `up` exits non-zero
#     with a message naming the port and the squatting container (if any).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.test.yml"

# The worktrees live under the *main* repo root, never inside a worktree
# checkout. Derive it from the shared git dir so reaping resolves worktree
# existence against the canonical location regardless of where we're invoked.
GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [ -n "$GIT_COMMON_DIR" ]; then
    MAIN_ROOT="$(cd "$GIT_COMMON_DIR/.." && pwd)"
else
    # Not in a git repo (unusual); fall back to ROOT so reaping is at worst a no-op.
    MAIN_ROOT="$ROOT"
fi
WORKTREES_DIR="$MAIN_ROOT/.claude/worktrees"

# ─── Port derivation ─────────────────────────────────────────────────────────
# Pick a deterministic per-worktree port so concurrent agent sessions don't
# trample each other's PB. `cksum` is POSIX and gives a stable 32-bit hash;
# `(hash % 999) + 1` maps to offset 1..999 — non-zero by construction — keeping
# us inside 8092..9090 / 3002..4000. Offset 0 (8091/3001) is reserved for the
# main checkout, so an agent worktree can never collide with main.
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
        # (hash % 999) + 1 → 1..999, never 0. Offset 0 (8091/3001) is reserved
        # for the main checkout; an agent worktree must never land there.
        echo $(((hash % 999) + 1))
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

# ─── Container / port introspection helpers ──────────────────────────────────

# Names of the two containers this worktree's compose project owns.
PB_CONTAINER="${PROJECT_NAME}-pocketbase-1"
API_CONTAINER="${PROJECT_NAME}-api-1"

# Which container (if any) currently publishes the given host port? Prints the
# container name, or nothing. Matches both ":<port>->" (IPv4) and the IPv6
# form docker also prints. Excludes the trailing port in "->8091/tcp".
container_publishing_port() {
    local port="$1"
    "$DOCKER" ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
        | awk -v p=":${port}->" 'index($0, p) { print $1; exit }'
}

# Does the named container exist (running or stopped)?
container_exists() {
    "$DOCKER" ps -a --format '{{.Names}}' 2>/dev/null | grep -qxF "$1"
}

# ─── Orphan reaping ──────────────────────────────────────────────────────────
# A "test container" is one of:
#   - homelab-test-<basename>-{pocketbase,api}-1   (current scheme)
#   - agent-<hash>-{pocketbase,api}-1              (legacy, pre-prefix)
# We resolve each to a worktree basename and check whether
# `.claude/worktrees/<basename>/` still exists. If gone → orphan → reap.
# The main checkout (basename "homelab") is never an orphan.

# Given a container name, echo the worktree basename it belongs to, or nothing
# if the name doesn't look like a test container.
container_to_basename() {
    local name="$1" base
    case "$name" in
        homelab-test-*-pocketbase-1) base="${name#homelab-test-}"; base="${base%-pocketbase-1}" ;;
        homelab-test-*-api-1)        base="${name#homelab-test-}"; base="${base%-api-1}" ;;
        *-pocketbase-1)              base="${name%-pocketbase-1}" ;;
        *-api-1)                     base="${name%-api-1}" ;;
        *) return 0 ;;
    esac
    echo "$base"
}

# Is a container's worktree still alive? "homelab" (main checkout) is always
# alive. A legacy `agent-<hash>` whose dir is gone is an orphan. Anything that
# doesn't resolve to an agent-* basename and isn't "homelab" is treated
# conservatively as alive (we don't reap names we don't understand).
basename_is_live_worktree() {
    local base="$1"
    [ "$base" = "homelab" ] && return 0
    if [[ "$base" == agent-* ]]; then
        [ -d "$WORKTREES_DIR/$base" ] && return 0 || return 1
    fi
    # Unknown shape (not homelab, not agent-*): be conservative, keep it.
    return 0
}

# Find compose *project names* that are orphaned. We key off project name so we
# can `docker compose down` the whole project (containers + network) in one go,
# which is cleaner than removing containers individually and leaving the
# network behind. Legacy `agent-<hash>` projects and current
# `homelab-test-<basename>` projects are both handled.
#
# Echoes one "<project>\t<basename>" line per orphaned project.
list_orphan_projects() {
    "$DOCKER" ps -a --format '{{.Names}}' 2>/dev/null | while read -r name; do
        local base project
        base="$(container_to_basename "$name")"
        [ -z "$base" ] && continue
        basename_is_live_worktree "$base" && continue
        # Reconstruct the compose project name from the container name by
        # stripping the trailing "-<service>-1".
        case "$name" in
            *-pocketbase-1) project="${name%-pocketbase-1}" ;;
            *-api-1)        project="${name%-api-1}" ;;
            *) continue ;;
        esac
        printf '%s\t%s\n' "$project" "$base"
    done | sort -u
}

# Reap orphaned test containers + their networks. $1=dry-run flag (0/1).
reap() {
    local dry="${1:-0}"
    local orphans
    orphans="$(list_orphan_projects)"
    if [ -z "$orphans" ]; then
        echo "reap: no orphan test containers found (all map to live worktrees)."
        return 0
    fi
    local count=0
    while IFS=$'\t' read -r project base; do
        [ -z "$project" ] && continue
        count=$((count + 1))
        if [ "$dry" = "1" ]; then
            echo "reap: [dry-run] would remove project '$project' (worktree '$base' is gone)"
        else
            echo "reap: removing project '$project' (worktree '$base' is gone)..."
            # `compose down` on the orphan project tears down its containers AND
            # network in one shot. Use the orphan's own project name; the
            # compose file is irrelevant for `down -v` of an existing project,
            # but pass it so compose is happy.
            "$DOCKER" compose --project-name "$project" -f "$COMPOSE_FILE" down --remove-orphans >/dev/null 2>&1 || true
            # Belt-and-suspenders: if any containers survive (e.g. legacy
            # projects compose can't fully resolve), force-remove by name.
            for svc in pocketbase api; do
                local cname="${project}-${svc}-1"
                if container_exists "$cname"; then
                    "$DOCKER" rm -f "$cname" >/dev/null 2>&1 || true
                fi
            done
            # Drop the dangling default network if it's still around.
            "$DOCKER" network rm "${project}_default" >/dev/null 2>&1 || true
        fi
    done <<< "$orphans"
    if [ "$dry" = "1" ]; then
        echo "reap: dry-run — $count orphan project(s) listed; nothing removed."
    else
        echo "reap: removed $count orphan project(s)."
    fi
}

# ─── Health checking ─────────────────────────────────────────────────────────

# True if *something* answers the health endpoint on the host port.
host_port_answers() {
    local url="$1" path="$2"
    curl -fs --max-time 3 "${url}${path}" >/dev/null 2>&1
}

# True if the named container is the one publishing the given host port. This
# is the load-bearing check: it distinguishes "our PB answered" from "a
# squatter on the same port answered" — the exact bug this rework fixes.
our_container_owns_port() {
    local container="$1" port="$2" owner
    owner="$(container_publishing_port "$port")"
    [ "$owner" = "$container" ]
}

# A service is "ok" only when its host port answers health AND the container
# publishing that port is OURS — a squatter answering on the same port must not
# count as healthy (that masquerade is the exact bug this rework kills). We
# report three states so `status`/`check` callers can tell "my env is up" from
# "something else is on my port":
#   ok        — our container owns the port and answers health
#   no        — nothing answers the port (our env is down)
#   squatter  — something answers, but it's not our container
classify_service() {
    local container="$1" url="$2" path="$3"
    if ! host_port_answers "$url" "$path"; then
        echo "no"
    elif our_container_owns_port "$container" "${url##*:}"; then
        echo "ok"
    else
        echo "squatter"
    fi
}

check() {
    local pb_state api_state
    pb_state=$(classify_service "$PB_CONTAINER" "$PB_URL" "/api/health")
    api_state=$(classify_service "$API_CONTAINER" "$API_URL" "/health")
    echo "PocketBase ($PB_URL): $pb_state"
    echo "API        ($API_URL): $api_state"
    [[ "$pb_state" == "ok" && "$api_state" == "ok" ]]
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

# Emit the fail-loud diagnostic for a host port that our container does not own,
# then return. $1 = "PocketBase"|"API", $2 = port, $3 = expected container.
explain_port_problem() {
    local label="$1" port="$2" expected="$3" squatter
    squatter="$(container_publishing_port "$port")"
    {
        echo ""
        echo "[test-env.sh] ${label} host port :${port} is NOT served by this worktree's container."
        echo "  Expected publisher: ${expected}"
        if [ -n "$squatter" ]; then
            echo "  Actual publisher:   ${squatter}  ← this container is squatting on :${port}"
            local sbase
            sbase="$(container_to_basename "$squatter")"
            if [ -n "$sbase" ] && ! basename_is_live_worktree "$sbase"; then
                echo "  '${squatter}' belongs to a dead worktree — run: infra/test-env.sh reap"
            else
                echo "  '${squatter}' belongs to a LIVE worktree/main — it is not safe to auto-remove."
                echo "  Stop it from its own checkout, or change this worktree's TEST_PB_PORT."
            fi
        else
            echo "  Nothing is publishing :${port}. The container likely failed to bind the port."
            echo "  Inspect: docker ps -a   and   $(basename "$0") status"
        fi
        echo "  Squatter triage: docker ps --format '{{.Names}}\\t{{.Ports}}' | grep ':${port}->'"
        echo ""
    } >&2
}

case "${1:-}" in
    up)
        echo "Test env for worktree '$(basename "$ROOT")':"
        echo "  PocketBase → $PB_URL"
        echo "  API        → $API_URL"
        echo "  compose project: $PROJECT_NAME"

        # 1. Self-heal: reap orphan containers BEFORE binding ports, so a stale
        #    container from a dead worktree can never silently steal our port.
        #    Fast (one `docker ps`) and safe (only touches provably-dead worktrees).
        reap 0

        # 2. Pre-flight squatter check: if a *foreign* live container already
        #    holds our port, fail loud now rather than letting compose come up
        #    with no host mapping and then "passing" against the squatter.
        for spec in "PocketBase|$PB_PORT|$PB_CONTAINER" "API|$API_PORT|$API_CONTAINER"; do
            IFS='|' read -r lbl prt ours <<< "$spec"
            squatter="$(container_publishing_port "$prt")"
            if [ -n "$squatter" ] && [ "$squatter" != "$ours" ]; then
                echo "[test-env.sh] Port :${prt} is held by '${squatter}', not by this worktree." >&2
                explain_port_problem "$lbl" "$prt" "$ours"
                exit 1
            fi
        done

        compose up -d
        echo "Waiting for services to be healthy..."
        pb_written=false
        for _ in $(seq 1 30); do
            # PB is "ready" only when the host port answers AND it's OUR
            # container publishing that port — not a squatter. Write the port
            # file as soon as our PB is genuinely up; most callers (vitest
            # PB-only suites, the deploy.sh gate) don't need the API.
            if ! $pb_written \
               && host_port_answers "$PB_URL" "/api/health" \
               && our_container_owns_port "$PB_CONTAINER" "$PB_PORT"; then
                write_port_file
                pb_written=true
            fi
            if host_port_answers "$PB_URL" "/api/health" \
               && our_container_owns_port "$PB_CONTAINER" "$PB_PORT" \
               && host_port_answers "$API_URL" "/health" \
               && our_container_owns_port "$API_CONTAINER" "$API_PORT"; then
                echo "Ready."
                check
                exit 0
            fi
            sleep 1
        done

        # ── Timed out. Diagnose precisely WHY, and fail loud. ────────────────
        echo "Services did not become healthy in 30s." >&2
        compose ps

        pb_owned=false
        if our_container_owns_port "$PB_CONTAINER" "$PB_PORT"; then
            pb_owned=true
        fi

        # If our PB doesn't own its port, that's the squatter/bind failure —
        # the exact silent failure mode this rework exists to kill.
        if ! $pb_owned; then
            explain_port_problem "PocketBase" "$PB_PORT" "$PB_CONTAINER"
            echo "[test-env.sh] Aborting — PocketBase is not correctly bound on :${PB_PORT}." >&2
            exit 1
        fi

        # PB owns its port but didn't answer health → genuine PB failure.
        if ! host_port_answers "$PB_URL" "/api/health"; then
            {
                echo ""
                echo "[test-env.sh] PocketBase container owns :${PB_PORT} but isn't answering /api/health."
                echo "  Inspect: docker compose -f docker-compose.test.yml --project-name $PROJECT_NAME logs pocketbase"
                echo ""
            } >&2
            exit 1
        fi

        # PB is genuinely healthy + correctly bound. The API is the only thing
        # that didn't come up. Most suites (`pnpm test`) only need PB, so write
        # the port file and exit 0 with a warning — Playwright re-probes the API
        # and fails loud on its own if it truly needs it (see deploy.sh).
        $pb_written || write_port_file
        api_squatter="$(container_publishing_port "$API_PORT")"
        if [ -n "$api_squatter" ] && [ "$api_squatter" != "$API_CONTAINER" ]; then
            explain_port_problem "API" "$API_PORT" "$API_CONTAINER"
            echo "[test-env.sh] Aborting — test API port :${API_PORT} is squatted." >&2
            exit 1
        fi
        echo "PocketBase is healthy and correctly bound at $PB_URL — continuing." >&2
        echo "(Test API on :${API_PORT} is not up; most suites don't need it. Playwright will re-probe.)" >&2
        exit 0
        ;;
    down)
        compose down
        rm -f "$PORT_FILE"
        ;;
    reap)
        case "${2:-}" in
            ""|--reap) reap 0 ;;
            -n|--dry-run) reap 1 ;;
            *) echo "Usage: $0 reap [--dry-run]" >&2; exit 1 ;;
        esac
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
        echo "Usage: $0 {up|down|status|check|reap|url|port}" >&2
        exit 1
        ;;
esac
