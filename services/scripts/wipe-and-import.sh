#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export $(grep -v '^#' ../../.env | xargs)
echo "=== Wiping PocketBase ===" && npx tsx wipe-pb.ts
echo ""
echo "=== Importing from snapshot ===" && npx tsx import-to-pb.ts --snapshot-dir "${1:?Usage: $0 <snapshot-dir>}"
