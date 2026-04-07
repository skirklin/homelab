#!/usr/bin/env bash
# Deploy from local machine to VPS.
# Pushes Docker images and k8s manifests, then applies them.
#
# Usage: ./infra/deploy.sh [app1 app2 ...]
#   No args = deploy everything. Pass app names to deploy selectively.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

VPS="${HOMELAB_VPS:-scott@5.78.200.161}"
REGISTRY="${REGISTRY:-homelab}"

# Determine which images to push
if [ $# -gt 0 ]; then
    IMAGES=("$@")
else
    IMAGES=($(docker images --filter "reference=${REGISTRY}/*" --format "{{.Repository}}:{{.Tag}}"))
    docker pull caddy:2-alpine 2>/dev/null || true
    IMAGES+=("caddy:2-alpine")
fi

echo "=== Pushing images to ${VPS} ==="
for img in "${IMAGES[@]}"; do
    if [[ "$img" != */* && "$img" != *:* ]]; then
        img="${REGISTRY}/${img}:latest"
    fi
    echo "Pushing ${img}..."
    docker save "${img}" | ssh "${VPS}" "sudo k3s ctr images import -" || echo "  WARNING: failed to push ${img}"
done

echo ""
echo "=== Syncing manifests ==="
ssh "${VPS}" "mkdir -p ~/homelab-manifests"
scp -r infra/k8s/* "${VPS}:~/homelab-manifests/"

echo ""
echo "=== Applying manifests ==="
ssh "${VPS}" "kubectl apply -k ~/homelab-manifests/"

echo ""
echo "=== Restarting deployments ==="
ssh "${VPS}" "kubectl rollout restart -n homelab deployments,statefulsets 2>/dev/null || true"

echo ""
echo "=== Pod status ==="
ssh "${VPS}" "kubectl get pods -n homelab"
