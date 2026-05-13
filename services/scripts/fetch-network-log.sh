#!/usr/bin/env bash
# Pull a captured network log from the ingest service into the local
# debug sandbox so it can be inspected with gron / jq / genson.
#
# Usage:
#   fetch-network-log.sh                       # latest chase log
#   fetch-network-log.sh chase                 # latest chase log
#   fetch-network-log.sh chase list            # list available logs
#   fetch-network-log.sh chase get <filename>  # specific log
#
# Override the host with INGEST_HOST=...
set -euo pipefail

INSTITUTION="${1:-chase}"
ACTION="${2:-latest}"
HOST="${INGEST_HOST:-https://ingest.tail56ca88.ts.net}"
SANDBOX="${MONEY_DEBUG_DIR:-$HOME/.config/money/debug}"

mkdir -p "$SANDBOX"

case "$ACTION" in
  list)
    curl -fsSL "$HOST/api/debug/network-log/list?institution=$INSTITUTION"
    ;;
  latest)
    out="$SANDBOX/${INSTITUTION}_latest.json"
    # The endpoint returns the file body; X-Log-Filename header carries the real name.
    headers=$(mktemp)
    curl -fsSL -D "$headers" -o "$out" \
      "$HOST/api/debug/network-log/latest?institution=$INSTITUTION"
    real_name=$(awk -F': ' 'tolower($1)=="x-log-filename"{gsub(/\r/,""); print $2}' "$headers" | tr -d '[:space:]')
    rm -f "$headers"
    if [[ -n "$real_name" ]]; then
      cp "$out" "$SANDBOX/$real_name"
      echo "$SANDBOX/$real_name"
    else
      echo "$out"
    fi
    ;;
  get)
    name="${3:-}"
    if [[ -z "$name" ]]; then
      echo "usage: fetch-network-log.sh $INSTITUTION get <filename>" >&2
      exit 1
    fi
    out="$SANDBOX/$name"
    curl -fsSL -o "$out" \
      "$HOST/api/debug/network-log/get?institution=$INSTITUTION&name=$name"
    echo "$out"
    ;;
  *)
    echo "unknown action: $ACTION (expected list, latest, or get)" >&2
    exit 1
    ;;
esac
