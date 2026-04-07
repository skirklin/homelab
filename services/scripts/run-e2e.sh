#!/usr/bin/env bash
# Run e2e tests against a local PocketBase instance.
#
# Usage:
#   ./services/scripts/run-e2e.sh              # run all e2e tests
#   ./services/scripts/run-e2e.sh shopping     # run shopping tests only
#   ./services/scripts/run-e2e.sh home         # run home app tests only
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

APP="${1:-all}"
PB_TEST_URL="${PB_TEST_URL:-http://127.0.0.1:8091}"
export PB_TEST_URL

# Start PocketBase if not already running
if ! curl -sf "${PB_TEST_URL}/api/health" > /dev/null 2>&1; then
  echo "=== Starting PocketBase test instance ==="
  docker compose -f docker-compose.test.yml up -d --build --wait
  echo "PocketBase ready at ${PB_TEST_URL}"
else
  echo "PocketBase already running at ${PB_TEST_URL}"
fi

echo ""
echo "=== Running e2e tests ==="

run_tests() {
  local app_dir="$1"
  echo "--- ${app_dir} ---"
  pnpm --filter "./${app_dir}" exec vitest run --config vitest.e2e.config.ts 2>&1
}

case "$APP" in
  all)
    run_tests "apps/shopping/app"
    run_tests "apps/home/app"
    run_tests "apps/upkeep/app"
    run_tests "apps/recipes/app"
    ;;
  shopping)
    run_tests "apps/shopping/app"
    ;;
  home)
    run_tests "apps/home/app"
    ;;
  upkeep)
    run_tests "apps/upkeep/app"
    ;;
  recipes)
    run_tests "apps/recipes/app"
    ;;
  *)
    echo "Unknown app: ${APP}" >&2
    exit 1
    ;;
esac

echo ""
echo "=== Done ==="
