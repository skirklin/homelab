#!/usr/bin/env bash
# Install k3s on the VPS (single-node, no Traefik — we use Caddy instead).
# Run this once on the server.
set -euo pipefail

echo "Installing k3s (without Traefik)..."
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable=traefik" sh -

echo "Waiting for k3s to be ready..."
until kubectl get nodes 2>/dev/null | grep -q ' Ready'; do
    sleep 2
done

echo "k3s is ready:"
kubectl get nodes

echo ""
echo "Kubeconfig is at /etc/rancher/k3s/k3s.yaml"
echo "To use kubectl from your local machine, copy it and set KUBECONFIG."
