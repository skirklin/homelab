#!/usr/bin/env bash
# Start, stop, or check the test environment (PocketBase + API containers)
# used by vitest e2e tests and Playwright tests.
#
# Usage:
#   infra/test-env.sh up        # start containers, wait for health
#   infra/test-env.sh down      # stop containers
#   infra/test-env.sh status    # print status
#   infra/test-env.sh check     # exit 0 if healthy, 1 otherwise
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.test.yml"
PB_URL="http://127.0.0.1:8091"
API_URL="http://127.0.0.1:3001"

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

compose() { "$DOCKER" compose -f "$COMPOSE_FILE" "$@"; }

check() {
  local pb_ok api_ok
  pb_ok=$(curl -fs "$PB_URL/api/health" >/dev/null 2>&1 && echo yes || echo no)
  api_ok=$(curl -fs "$API_URL/health" >/dev/null 2>&1 && echo yes || echo no)
  echo "PocketBase ($PB_URL): $pb_ok"
  echo "API        ($API_URL): $api_ok"
  [[ "$pb_ok" == "yes" && "$api_ok" == "yes" ]]
}

case "${1:-}" in
  up)
    compose up -d
    echo "Waiting for services to be healthy..."
    for _ in $(seq 1 30); do
      if check >/dev/null 2>&1; then
        echo "Ready."
        check
        exit 0
      fi
      sleep 1
    done
    echo "Services did not become healthy in 30s." >&2
    compose ps
    exit 1
    ;;
  down)
    compose down
    ;;
  status)
    compose ps
    echo
    check || true
    ;;
  check)
    check >/dev/null 2>&1
    ;;
  *)
    echo "Usage: $0 {up|down|status|check}" >&2
    exit 1
    ;;
esac
