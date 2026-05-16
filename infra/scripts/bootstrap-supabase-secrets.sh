#!/usr/bin/env bash
# Bootstrap the `supabase-secrets` k8s Secret for the homelab Supabase stack.
#
# This script generates fresh secrets every invocation. By design it does NOT
# commit any secret values to the repo. Run once per cluster; refuses to
# overwrite an existing Secret unless --force is passed.
#
# Usage:
#   ./infra/scripts/bootstrap-supabase-secrets.sh           # safe (refuses to overwrite)
#   ./infra/scripts/bootstrap-supabase-secrets.sh --force   # overwrite existing
#
# Connects to the VPS over SSH and applies via `kubectl apply -f -` so secrets
# never touch the command line or shell history.
#
# Side effects:
#   - k8s: creates Secret `supabase-secrets` in namespace `homelab`
#   - laptop: writes the Postgres password to ~/.config/supabase/postgres.password
#     (mode 600) so `psql` against db.tail56ca88.ts.net works without a prompt
#   - stdout: prints ANON_KEY and SERVICE_ROLE_KEY so the user can save them
#     to .env if/when frontend code starts consuming them (Phase 3)

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

HOST="${HOMELAB_VPS:-scott@5.78.200.161}"
NAMESPACE="${SUPABASE_NAMESPACE:-homelab}"
SECRET_NAME="${SUPABASE_SECRET_NAME:-supabase-secrets}"

FORCE=false
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=true ;;
        -h|--help)
            sed -n '2,20p' "$0"
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

# ---- Refuse to overwrite ----
if ssh "$HOST" "kubectl get secret -n $NAMESPACE $SECRET_NAME" >/dev/null 2>&1; then
    if [ "$FORCE" != "true" ]; then
        echo "ERROR: Secret $NAMESPACE/$SECRET_NAME already exists." >&2
        echo "       Re-run with --force to rotate (this will require restarting" >&2
        echo "       all supabase-* pods so they pick up new credentials)." >&2
        exit 1
    fi
    echo "WARNING: overwriting existing $NAMESPACE/$SECRET_NAME" >&2
fi

# ---- Generate randoms ----
gen_hex() { openssl rand -hex "$1"; }

POSTGRES_PASSWORD="$(gen_hex 20)"            # 40 hex chars
JWT_SECRET="$(gen_hex 32)"                   # 64 hex chars, HS256-safe (>= 32 byte entropy)
REALTIME_SECRET_KEY_BASE="$(gen_hex 32)"     # 64 chars; Phoenix endpoint secret
REALTIME_ENC_KEY="$(gen_hex 8)"              # exactly 16 hex chars (DB_ENC_KEY requires 16)
DASHBOARD_USERNAME="${DASHBOARD_USERNAME:-admin}"
DASHBOARD_PASSWORD="$(gen_hex 16)"

# ---- Sign the two JWTs (anon + service_role) ----
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
    echo "ERROR: node not found on PATH (required to sign JWTs)" >&2
    exit 1
fi
jwt_out="$(JWT_SECRET="$JWT_SECRET" "$NODE_BIN" infra/scripts/_sign-supabase-jwts.mjs)"
ANON_KEY="$(echo "$jwt_out" | grep '^ANON_KEY=' | cut -d= -f2-)"
SERVICE_ROLE_KEY="$(echo "$jwt_out" | grep '^SERVICE_ROLE_KEY=' | cut -d= -f2-)"
if [ -z "$ANON_KEY" ] || [ -z "$SERVICE_ROLE_KEY" ]; then
    echo "ERROR: JWT signer did not return both keys" >&2
    exit 1
fi

# ---- Compose Postgres connection URLs for downstream services ----
# supabase/postgres init creates these roles; all share POSTGRES_PASSWORD.
GOTRUE_DB_URL="postgres://supabase_auth_admin:${POSTGRES_PASSWORD}@supabase-db:5432/postgres?search_path=auth"
PGRST_DB_URI="postgres://authenticator:${POSTGRES_PASSWORD}@supabase-db:5432/postgres"

# ---- Apply via kubectl ----
# stringData (vs data) lets us send plaintext and lets the apiserver handle
# base64 encoding. apply -f - means nothing lands in argv or history.
manifest=$(cat <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET_NAME}
  namespace: ${NAMESPACE}
type: Opaque
stringData:
  POSTGRES_PASSWORD: "${POSTGRES_PASSWORD}"
  JWT_SECRET: "${JWT_SECRET}"
  ANON_KEY: "${ANON_KEY}"
  SERVICE_ROLE_KEY: "${SERVICE_ROLE_KEY}"
  REALTIME_SECRET_KEY_BASE: "${REALTIME_SECRET_KEY_BASE}"
  REALTIME_ENC_KEY: "${REALTIME_ENC_KEY}"
  DASHBOARD_USERNAME: "${DASHBOARD_USERNAME}"
  DASHBOARD_PASSWORD: "${DASHBOARD_PASSWORD}"
  GOTRUE_DB_URL: "${GOTRUE_DB_URL}"
  PGRST_DB_URI: "${PGRST_DB_URI}"
EOF
)

echo "$manifest" | ssh "$HOST" "kubectl apply -n ${NAMESPACE} -f -"

# ---- Save Postgres password locally for psql convenience ----
local_dir="${HOME}/.config/supabase"
install -d -m 700 "$local_dir"
umask 077

# No trailing newline — some clients read the whole file as the password.
printf '%s' "$POSTGRES_PASSWORD" > "${local_dir}/postgres.password"

# `.pgpass` file format requires a trailing newline per line, picked up by psql.
pgpass="${local_dir}/.pgpass"
{
    echo "supabase-db.tail56ca88.ts.net:5432:postgres:postgres:${POSTGRES_PASSWORD}"
    echo "supabase-db:5432:postgres:postgres:${POSTGRES_PASSWORD}"
} > "$pgpass"
chmod 600 "$pgpass"

cat <<EOF

== Bootstrap complete ==

Created Secret: ${NAMESPACE}/${SECRET_NAME}

Local files (gitignored, mode 600):
  ${local_dir}/postgres.password
  ${local_dir}/.pgpass        (use: PGPASSFILE=${local_dir}/.pgpass psql ...)

JWTs (save these to .env if/when Phase 3 frontend code needs them — they're
also stored in the k8s Secret and Studio reads them at startup):

  SUPABASE_ANON_KEY=${ANON_KEY}
  SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}

Next:
  ./infra/deploy.sh --push-only     # applies the new manifests (no images to build)
  ssh ${HOST} kubectl get pods -n homelab -l app.kubernetes.io/part-of=supabase
EOF
