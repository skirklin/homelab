#!/usr/bin/env bash
# Create a PocketBase backup with a given prefix, e.g.:
#   ./infra/scripts/pb-backup.sh pre-migration-life-shape-vocab
# Names it <prefix>-YYYY-MM-DDtHH-MM-SSz.zip (PB enforces lowercase names).
# Retention is prefix-driven (see infra/k8s/cronjobs.yaml): pre-migration-*
# and emergency-* are kept forever; daily-* is thinned; pre-deploy-* keeps 10.
#
# Reads PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD from the repo-root .env unless
# already set. PB_URL overrides the default https://api.kirkl.in.
set -euo pipefail

PREFIX="${1:?usage: pb-backup.sh <prefix> (e.g. pre-migration-<slug>)}"
PB="${PB_URL:-https://api.kirkl.in}"

if [[ -z "${PB_ADMIN_EMAIL:-}" || -z "${PB_ADMIN_PASSWORD:-}" ]]; then
  ENV_FILE="$(cd "$(dirname "$0")/../.." && pwd)/.env"
  [[ -f "$ENV_FILE" ]] || { echo "error: PB_ADMIN_EMAIL/PASSWORD unset and $ENV_FILE missing" >&2; exit 1; }
  set -a; source "$ENV_FILE"; set +a
fi

# PB session tokens go in `Authorization: <token>` (no Bearer prefix).
TOKEN=$(curl -sf -X POST "$PB/api/collections/_superusers/auth-with-password" \
  -H "Content-Type: application/json" \
  -d "{\"identity\":\"$PB_ADMIN_EMAIL\",\"password\":\"$PB_ADMIN_PASSWORD\"}" | jq -er .token)

KEY="${PREFIX}-$(date -u +%Y-%m-%dt%H-%M-%Sz).zip"
curl -sf -X POST "$PB/api/backups" \
  -H "Authorization: $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$KEY\"}"
echo "created $KEY"
