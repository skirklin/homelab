#!/bin/sh
# Seed a default config.json into the PVC data dir if none exists.
CONFIG="/app/.data/config.json"
if [ ! -f "$CONFIG" ]; then
    echo '{"institutions": {}, "logins": {}, "people": {}}' > "$CONFIG"
    echo "Seeded empty config at $CONFIG — edit in-place (e.g. via kubectl exec)."
fi

exec uv run money serve
