#!/usr/bin/env bash
# Reap completed agent worktrees under .claude/worktrees/.
#
# Safe by construction — a worktree is only removed when ALL of:
#   1. Working tree is clean (no uncommitted changes / untracked files)
#   2. Its branch is already an ancestor of `main` (i.e., merged)
#   3. Any harness `git worktree lock` points at a dead PID
#      (the agent that locked it has exited; the lock is stale)
#
# Anything that fails a check is skipped with a printed reason — the
# script never bypasses safety to "make progress".
#
# Why this matters: each agent worktree adds tens of thousands of files
# under .claude/worktrees/, and VS Code's WSL file watcher tracks every
# one of them. Letting them accumulate ballooned this host's watcher to
# 3.2 GB resident and pushed the system into swap thrash, which surfaced
# as test flakiness. Run this script after merging any agent worktree's
# branch, or periodically as a cleanup pass.
#
# Usage:
#   ./infra/scripts/worktree-reap.sh                # do it
#   ./infra/scripts/worktree-reap.sh --dry-run      # show what would be reaped
#   ./infra/scripts/worktree-reap.sh -n             # same

set -uo pipefail

DRY=0
case "${1:-}" in
  --dry-run|-n) DRY=1 ;;
  --help|-h)
    sed -n '2,/^$/p' "$0" | sed 's/^# \?//'
    exit 0
    ;;
  "") ;;
  *)
    echo "Unknown arg: $1 (use --dry-run or --help)" >&2
    exit 2
    ;;
esac

cd "$(git rev-parse --show-toplevel)"

REAPED=0
SKIPPED_DIRTY=0
SKIPPED_UNMERGED=0
SKIPPED_LIVE=0
SKIPPED_NOBRANCH=0
SKIPPED_LOCKED_UNKNOWN=0
FAILED=0

reap_one() {
  local wt="$1"
  [ -d "$wt" ] || return

  local branch dirty
  branch=$(git -C "$wt" branch --show-current 2>/dev/null)
  dirty=$(git -C "$wt" status --porcelain 2>/dev/null | head -1)

  if [ -n "$dirty" ]; then
    echo "  SKIP  $wt [$branch] — dirty working tree"
    SKIPPED_DIRTY=$((SKIPPED_DIRTY+1))
    return
  fi
  if [ -z "$branch" ]; then
    echo "  SKIP  $wt — no branch (detached HEAD?)"
    SKIPPED_NOBRANCH=$((SKIPPED_NOBRANCH+1))
    return
  fi
  if ! git merge-base --is-ancestor "$branch" main 2>/dev/null; then
    echo "  SKIP  $wt [$branch] — branch not merged into main"
    SKIPPED_UNMERGED=$((SKIPPED_UNMERGED+1))
    return
  fi

  local name lock_file
  name=$(basename "$wt")
  lock_file=".git/worktrees/$name/locked"
  if [ -f "$lock_file" ]; then
    local pid
    pid=$(grep -oE 'pid [0-9]+' "$lock_file" | awk '{print $2}' | head -1)
    if [ -z "$pid" ]; then
      echo "  SKIP  $wt [$branch] — locked with no PID in reason; manual review"
      SKIPPED_LOCKED_UNKNOWN=$((SKIPPED_LOCKED_UNKNOWN+1))
      return
    fi
    if kill -0 "$pid" 2>/dev/null; then
      echo "  SKIP  $wt [$branch] — agent pid $pid still alive"
      SKIPPED_LIVE=$((SKIPPED_LIVE+1))
      return
    fi
    # Stale lock (PID dead) — safe to unlock.
    if [ "$DRY" = "0" ]; then
      git worktree unlock "$wt" 2>/dev/null
    fi
  fi

  if [ "$DRY" = "1" ]; then
    echo "  WOULD-REAP $wt [$branch]"
    REAPED=$((REAPED+1))
    return
  fi

  if git worktree remove "$wt" 2>/dev/null; then
    # `branch -d` refuses if the branch isn't merged — and we already
    # confirmed it is, so this should always succeed. If it doesn't, the
    # worktree is gone but the branch ref lingers (cheap; user can clean).
    git branch -d "$branch" >/dev/null 2>&1
    echo "  reaped $wt [$branch]"
    REAPED=$((REAPED+1))
  else
    echo "  FAIL  $wt [$branch] — git worktree remove refused"
    FAILED=$((FAILED+1))
  fi
}

shopt -s nullglob
for wt in .claude/worktrees/agent-*; do
  reap_one "$wt"
done

[ "$DRY" = "0" ] && git worktree prune

echo
if [ "$DRY" = "1" ]; then
  echo "DRY-RUN summary (no changes made):"
  printf "  would reap:            %d\n" "$REAPED"
else
  echo "Summary:"
  printf "  reaped:                %d\n" "$REAPED"
fi
printf "  skipped (dirty):       %d\n" "$SKIPPED_DIRTY"
printf "  skipped (unmerged):    %d\n" "$SKIPPED_UNMERGED"
printf "  skipped (agent live):  %d\n" "$SKIPPED_LIVE"
[ "$SKIPPED_NOBRANCH" -gt 0 ]       && printf "  skipped (no branch):   %d\n" "$SKIPPED_NOBRANCH"
[ "$SKIPPED_LOCKED_UNKNOWN" -gt 0 ] && printf "  skipped (locked, no pid): %d (needs manual review)\n" "$SKIPPED_LOCKED_UNKNOWN"
[ "$FAILED" -gt 0 ]                 && printf "  failed:                %d\n" "$FAILED"

remaining=$(ls -d .claude/worktrees/agent-* 2>/dev/null | wc -l)
printf "  worktrees remaining:   %d\n" "$remaining"
