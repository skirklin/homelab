#!/usr/bin/env bash
# Wrapper: regenerate apple-touch-icon.png for every PWA from its favicon.svg.
# Installs `sharp` into a temp dir on-demand so no long-lived dep is required.
set -euo pipefail

cd "$(dirname "$0")/../.."

REPO_ROOT="$(pwd)"
TMPDIR=$(mktemp -d -t apple-touch-icon-XXXXXX)
trap 'rm -rf "$TMPDIR"' EXIT

(cd "$TMPDIR" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund sharp@0.33 >/dev/null)

# Copy the script next to node_modules so ESM resolution can find `sharp`.
cp infra/scripts/gen-apple-touch-icons.mjs "$TMPDIR/run.mjs"
HOMELAB_REPO_ROOT="$REPO_ROOT" node "$TMPDIR/run.mjs"
