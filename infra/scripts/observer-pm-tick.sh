#!/usr/bin/env bash
# Observer PM cron tick — runs the daily PM check-in for the life-app observer build.
#
# Invoked by crontab (daily 6am PT). Each firing is a fresh, autonomous Claude
# session whose protocol lives in apps/life/OBSERVER_BUILD_PLAN.md and whose
# prompt lives at infra/scripts/observer-pm-prompt.md. Continuity across days
# is provided by the plan doc (daily log + state), not by session memory.
#
# Logs to ~/.local/share/observer-pm/tick-<UTC-iso>.log. Older logs auto-pruned
# after 30 days.

set -euo pipefail

REPO_DIR="/home/skirklin/projects/homelab"
LOG_DIR="${HOME}/.local/share/observer-pm"
PROMPT_FILE="${REPO_DIR}/infra/scripts/observer-pm-prompt.md"

mkdir -p "$LOG_DIR"
TIMESTAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
LOG_FILE="${LOG_DIR}/tick-${TIMESTAMP}.log"

# Cron's PATH is minimal — explicitly include claude (~/.local/bin), fnm-managed
# node (used by some MCP servers), pnpm, and the standard system bins.
export PATH="${HOME}/.local/bin:${HOME}/.local/share/fnm/aliases/default/bin:${HOME}/.local/share/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# .mcp.json + project context only resolve from the repo root.
cd "$REPO_DIR"

# Auto-prune old tick logs so the directory doesn't grow forever.
find "$LOG_DIR" -maxdepth 1 -name "tick-*.log" -mtime +30 -delete 2>/dev/null || true

{
  echo "=== observer-pm tick start: $(date -Iseconds) (UTC $(date -u -Iseconds)) ==="
  echo "PWD: $(pwd)"
  echo "Claude: $(claude --version 2>&1 | head -1)"
  echo "Git HEAD: $(git rev-parse --short HEAD) on $(git branch --show-current)"
  echo "---"

  # --print: headless mode (required for cron).
  # --max-budget-usd: hard stop on runaway loops.
  # --dangerously-skip-permissions: autonomous tool use — required for headless.
  #   The prompt itself + constraints in OBSERVER_BUILD_PLAN.md keep behavior bounded.
  # --no-session-persistence: each tick is independent; don't pollute the resume list.
  claude --print \
    --max-budget-usd 5 \
    --dangerously-skip-permissions \
    --no-session-persistence \
    "$(cat "$PROMPT_FILE")"

  echo "---"
  echo "=== observer-pm tick end: $(date -Iseconds) ==="
} 2>&1 | tee "$LOG_FILE"
