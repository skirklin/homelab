#!/usr/bin/env bash
# Build the Chrome extension into a zip for distribution via the ingest server.
# Usage: ./infra/build-extension.sh
#
# The zip and version file are placed in services/ingest/.data/extension/
# so the ingest server can serve them at /extension/download.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$REPO_ROOT/extension"
OUT_DIR="$REPO_ROOT/services/ingest/.data/extension"

mkdir -p "$OUT_DIR"

# Read version from manifest.json
VERSION=$(python3 -c "import json; print(json.load(open('$EXT_DIR/manifest.json'))['version'])")

echo "Building extension v${VERSION}..."

# Create zip (exclude hidden files and any node_modules)
cd "$EXT_DIR"
zip -r "$OUT_DIR/money-collector.zip" . \
  -x '.*' -x '__MACOSX/*' -x 'node_modules/*'

# Write version file for the server endpoint
echo "$VERSION" > "$OUT_DIR/version.txt"

echo "Built: $OUT_DIR/money-collector.zip (v${VERSION})"
