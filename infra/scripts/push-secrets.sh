#!/usr/bin/env bash
#
# push-secrets.sh — push the `api-secrets` Secret to the cluster from the local .env.
#
# .env at the repo root IS the definition of the `api-secrets` Secret: every
# KEY=VALUE line in it becomes a key in the Secret. To add/rotate a secret, edit
# .env and run this script — that's the whole workflow.
#
# ⚠️  Anything that must live in api-secrets MUST live in .env. The cluster Secret
#     is rebuilt wholesale from .env on every run (kubectl create --dry-run | apply),
#     so a key that exists only in the cluster is DELETED the next time this runs.
#     This is exactly how the VAPID push keys were lost once: they lived only in
#     the cluster, not in .env, and a push from .env dropped them. Don't repeat it.
#
# kubectl is not installed locally — it runs on the VPS over ssh. Override the
# host with HOMELAB_SSH_HOST (default scott@5.78.200.161).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
SSH_HOST="${HOMELAB_SSH_HOST:-scott@5.78.200.161}"
NS=homelab
SECRET=api-secrets

[ -f "$ENV_FILE" ] || { echo "error: no .env at $ENV_FILE" >&2; exit 1; }

echo "Keys to push into $SECRET (values hidden):"
grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE" | cut -d= -f1 | sed 's/^/  - /'
echo

# Build the Secret from .env (streamed over ssh stdin) and apply it.
echo "Applying $SECRET to namespace $NS on $SSH_HOST ..."
ssh "$SSH_HOST" "kubectl create secret generic $SECRET -n $NS \
    --from-env-file=/dev/stdin --dry-run=client -o yaml | kubectl apply -f -" < "$ENV_FILE"

# Restart every Deployment that actually consumes the Secret so new values take
# effect (envFrom.secretRef or a per-var valueFrom.secretKeyRef). Discovered from
# the live cluster so this never goes stale as consumers are added/removed.
# jq runs locally (the VPS has no jq), so we pull the Deployment JSON over ssh.
echo
echo "Finding Deployments that consume $SECRET ..."
consumers=$(ssh "$SSH_HOST" "kubectl get deploy -n $NS -o json" | jq -r \
  ".items[] | select([.spec.template.spec.containers[]?.envFrom[]?.secretRef.name] + \
   [.spec.template.spec.containers[]?.env[]?.valueFrom.secretKeyRef.name] \
   | index(\"$SECRET\")) | .metadata.name")

if [ -z "$consumers" ]; then
  echo "No Deployments reference $SECRET — nothing to restart."
else
  echo "Restarting: $(echo "$consumers" | tr '\n' ' ')"
  for d in $consumers; do
    ssh "$SSH_HOST" "kubectl rollout restart -n $NS deploy/$d"
  done
fi

echo
echo "Done. Secret pushed and consumers restarted."
