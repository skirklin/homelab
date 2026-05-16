#!/usr/bin/env bash
# Sync the Phase 2 schema SQL to the cluster:
#   1. Update the `supabase-schema-sql` ConfigMap from infra/supabase/schema.sql
#   2. Delete the previous `supabase-schema-migrate` Job (if any) so the
#      manifest re-apply creates a fresh pod that mounts the new SQL
#   3. Re-apply manifests (kustomize) — recreates the Job
#   4. Tail logs from the new Job
#
# Same pattern as infra/scripts/bootstrap-supabase-secrets.sh: the ConfigMap
# is bootstrapped out-of-band so the SQL file doesn't have to live inside
# infra/k8s/ (where the tar+ssh deploy path expects only manifests).
#
# Idempotent. The SQL is itself idempotent (IF NOT EXISTS, DROP+CREATE
# policies), so re-running this script is safe at any time.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

HOST="${HOMELAB_VPS:-scott@5.78.200.161}"
NAMESPACE="${SUPABASE_NAMESPACE:-homelab}"
SCHEMA_SQL="infra/supabase/schema.sql"
CM_NAME="supabase-schema-sql"
JOB_NAME="supabase-schema-migrate"

if [ ! -f "$SCHEMA_SQL" ]; then
    echo "ERROR: $SCHEMA_SQL not found" >&2
    exit 1
fi

echo "==> Updating ConfigMap $CM_NAME from $SCHEMA_SQL"
# Generate the ConfigMap YAML locally, ship it through ssh+kubectl apply.
kubectl create configmap "$CM_NAME" \
    --namespace "$NAMESPACE" \
    --from-file=schema.sql="$SCHEMA_SQL" \
    --dry-run=client -o yaml \
    | ssh "$HOST" "kubectl apply -f -"

echo "==> Deleting previous Job (if any) so the next apply re-creates it fresh"
ssh "$HOST" "kubectl delete job/$JOB_NAME -n $NAMESPACE --ignore-not-found=true --wait=true"

echo "==> Re-syncing manifests and applying"
ssh "$HOST" "mkdir -p ~/homelab-manifests"
tar -cf - -C infra/k8s . | ssh "$HOST" "tar -xf - -C ~/homelab-manifests/"
ssh "$HOST" "kubectl apply -k ~/homelab-manifests/ 2>&1 | grep -E 'supabase|configured|created' || true"

echo "==> Waiting for the Job to complete"
ssh "$HOST" "kubectl wait --for=condition=complete job/$JOB_NAME -n $NAMESPACE --timeout=180s" || {
    echo "WARN: Job did not complete in time. Tailing logs:" >&2
    ssh "$HOST" "kubectl logs -n $NAMESPACE job/$JOB_NAME --tail=80"
    exit 1
}

echo "==> Job complete. Tailing logs:"
ssh "$HOST" "kubectl logs -n $NAMESPACE job/$JOB_NAME --tail=40"
