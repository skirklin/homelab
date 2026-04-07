#!/usr/bin/env bash
# Deploy (or update) all services to k3s.
# Run from the repo root: ./infra/deploy.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# k3s uses containerd, so import images directly (no registry needed)
echo "=== Importing images into k3s ==="
for img in $(docker images --filter "reference=homelab/*" --format "{{.Repository}}:{{.Tag}}"); do
    echo "Importing ${img}..."
    docker save "${img}" | sudo k3s ctr images import -
done

# Also import the caddy image
echo "Importing caddy:2-alpine..."
docker pull caddy:2-alpine 2>/dev/null
docker save caddy:2-alpine | sudo k3s ctr images import -

echo ""
echo "=== Applying k8s manifests ==="
kubectl apply -k infra/k8s/

echo ""
echo "=== Restarting deployments to pick up new images ==="
for deploy in $(kubectl get deployments -n homelab -o name 2>/dev/null); do
    kubectl rollout restart "${deploy}" -n homelab
done
for sts in $(kubectl get statefulsets -n homelab -o name 2>/dev/null); do
    kubectl rollout restart "${sts}" -n homelab
done

echo ""
echo "=== Status ==="
kubectl get pods -n homelab
