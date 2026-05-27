#!/usr/bin/env bash
# worktree-kill.sh — kill only the processes belonging to the *current* git
# worktree, so cleanup in one worktree doesn't take out a sibling worktree's
# dev server / test runner.
#
# Why this exists
# ---------------
# Parallel Claude Code sessions each run in their own `.claude/worktrees/agent-*/`
# checkout. They each spin up their own `pnpm dev` / Playwright / vitest on
# their own derived ports (see resolveDevVitePort + infra/test-env.sh). But
# when an agent finishes its work and reaches for `pkill -f vite`, the kernel
# happily matches every `node .../vite/...` process system-wide — including
# the sibling worktree's vite, which the agent has no business touching.
#
# The fix is to scope kills to "processes whose cwd is inside this worktree".
# That's reliable, robust to renamed binaries (electron-vite, esbuild, etc.),
# and trivially correct because pnpm/vitest/playwright all inherit cwd from
# the shell that launched them.
#
# How it works
# ------------
# 1. Locate the worktree root via `git rev-parse --show-toplevel`. Refuse to
#    run from the main checkout — too risky to mass-kill there.
# 2. Walk `/proc/*/cwd`, resolve each symlink, keep PIDs whose cwd is inside
#    our worktree root (canonical path comparison).
# 3. Exclude self + every ancestor up to PID 1, so we don't kill the shell
#    that invoked us or the parent agent.
# 4. Apply optional name filter(s) (cmdline substring match, any-of).
# 5. SIGTERM, wait up to 3s, SIGKILL stragglers.
#
# Usage
# -----
#   worktree-kill.sh                  # kill all worktree-scoped procs (except self/ancestors)
#   worktree-kill.sh vite             # only procs whose cmdline matches "vite"
#   worktree-kill.sh vite vitest      # any-of: cmdline matches "vite" OR "vitest"
#   worktree-kill.sh -n vite          # dry run: list what would be killed
#
# Linux only — relies on /proc/<pid>/cwd. macOS would need lsof; punted (see
# the doc note in CLAUDE.md).

set -euo pipefail

DRY_RUN=0
FILTERS=()
for arg in "$@"; do
  case "$arg" in
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,38p' "$0"
      exit 0
      ;;
    -*)
      echo "worktree-kill: unknown flag: $arg" >&2
      exit 2
      ;;
    *)
      FILTERS+=("$arg")
      ;;
  esac
done

# --- platform check ----------------------------------------------------------
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "worktree-kill: requires Linux (uses /proc/<pid>/cwd). Detected $(uname -s)." >&2
  echo "  On macOS, equivalent would be: lsof -d cwd | awk '...' — not implemented." >&2
  exit 1
fi

# --- locate worktree ---------------------------------------------------------
git_dir="$(git rev-parse --git-dir 2>/dev/null || true)"
git_common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -z "$git_dir" || -z "$git_common_dir" ]]; then
  echo "worktree-kill: not inside a git repo. Refusing to run." >&2
  exit 1
fi

abs_git_dir="$(cd "$git_dir" && pwd)"
abs_common_dir="$(cd "$git_common_dir" && pwd)"
if [[ "$abs_git_dir" == "$abs_common_dir" ]]; then
  echo "worktree-kill: refusing to run from the main checkout." >&2
  echo "  This script only operates inside a git worktree (.claude/worktrees/agent-*/)." >&2
  echo "  Scoping kills from the main checkout would match every dev server on the host." >&2
  exit 1
fi

worktree_root="$(git rev-parse --show-toplevel)"
# Canonicalise so symlinked worktree dirs compare equal to the cwd-resolved
# /proc/<pid>/cwd targets (which are always real paths).
worktree_root="$(readlink -f "$worktree_root")"
if [[ -z "$worktree_root" || "$worktree_root" == "/" ]]; then
  echo "worktree-kill: refusing — worktree root resolved to '$worktree_root'." >&2
  exit 1
fi

# --- build exclusion set: self + ancestors -----------------------------------
# Walking up via /proc/<pid>/status's PPid field is more reliable than `ps -o`
# (no PATH/$BUSYBOX surprises) and stops cleanly at PID 1.
declare -A EXCLUDE_PIDS=()
pid=$$
while [[ -n "$pid" && "$pid" != "0" ]]; do
  EXCLUDE_PIDS[$pid]=1
  if [[ -r "/proc/$pid/status" ]]; then
    ppid="$(awk '/^PPid:/ {print $2}' "/proc/$pid/status" 2>/dev/null || true)"
  else
    ppid=""
  fi
  [[ -z "$ppid" || "$ppid" == "0" || "$ppid" == "$pid" ]] && break
  pid="$ppid"
done

# --- cmdline filter matcher --------------------------------------------------
# cmdline is NUL-separated argv on Linux. Translate to spaces for matching.
matches_filter() {
  local cmdline="$1"
  (( ${#FILTERS[@]} == 0 )) && return 0
  local f
  for f in "${FILTERS[@]}"; do
    if [[ "$cmdline" == *"$f"* ]]; then
      return 0
    fi
  done
  return 1
}

# --- scan /proc --------------------------------------------------------------
declare -a TARGETS=()
declare -A TARGET_CMD=()

shopt -s nullglob
for proc_dir in /proc/[0-9]*; do
  target_pid="${proc_dir#/proc/}"

  # Skip excluded (self + ancestors).
  [[ -n "${EXCLUDE_PIDS[$target_pid]:-}" ]] && continue

  # Resolve cwd. Owned-by-other-user procs return permission denied — skip silently.
  cwd_target="$(readlink "$proc_dir/cwd" 2>/dev/null || true)"
  [[ -z "$cwd_target" ]] && continue

  # Strictly inside worktree_root, or equal to it.
  if [[ "$cwd_target" != "$worktree_root" && "$cwd_target" != "$worktree_root"/* ]]; then
    continue
  fi

  # Read cmdline (NUL-separated). Empty for kernel threads — skip those.
  if [[ ! -r "$proc_dir/cmdline" ]]; then
    continue
  fi
  cmdline_raw="$(tr '\0' ' ' < "$proc_dir/cmdline" 2>/dev/null || true)"
  # Trim trailing space.
  cmdline_raw="${cmdline_raw% }"
  [[ -z "$cmdline_raw" ]] && continue

  matches_filter "$cmdline_raw" || continue

  TARGETS+=("$target_pid")
  TARGET_CMD[$target_pid]="$cmdline_raw"
done
shopt -u nullglob

# --- report + kill -----------------------------------------------------------
if (( ${#TARGETS[@]} == 0 )); then
  if (( ${#FILTERS[@]} == 0 )); then
    echo "worktree-kill: no worktree-scoped processes found in $worktree_root"
  else
    echo "worktree-kill: no worktree-scoped processes matching: ${FILTERS[*]}"
  fi
  exit 0
fi

if (( ${#FILTERS[@]} == 0 )); then
  echo "worktree-kill: ${#TARGETS[@]} process(es) scoped to $worktree_root"
else
  echo "worktree-kill: ${#TARGETS[@]} process(es) scoped to $worktree_root matching: ${FILTERS[*]}"
fi

for pid in "${TARGETS[@]}"; do
  cmd="${TARGET_CMD[$pid]}"
  # Truncate very long cmdlines for readability.
  if (( ${#cmd} > 140 )); then
    cmd="${cmd:0:137}..."
  fi
  printf '  pid %-7s %s\n' "$pid" "$cmd"
done

if (( DRY_RUN )); then
  echo "worktree-kill: dry-run — no signals sent."
  exit 0
fi

# SIGTERM first.
sent_term=0
for pid in "${TARGETS[@]}"; do
  if kill -TERM "$pid" 2>/dev/null; then
    sent_term=$((sent_term + 1))
  fi
done
echo "worktree-kill: sent SIGTERM to $sent_term process(es); waiting up to 3s..."

# Wait up to 3s for graceful exit.
deadline=$(( $(date +%s) + 3 ))
while (( $(date +%s) < deadline )); do
  any_alive=0
  for pid in "${TARGETS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      any_alive=1
      break
    fi
  done
  (( any_alive == 0 )) && break
  sleep 0.2
done

# SIGKILL stragglers.
stragglers=()
for pid in "${TARGETS[@]}"; do
  if kill -0 "$pid" 2>/dev/null; then
    stragglers+=("$pid")
  fi
done

if (( ${#stragglers[@]} > 0 )); then
  echo "worktree-kill: ${#stragglers[@]} process(es) still alive after grace period; sending SIGKILL"
  for pid in "${stragglers[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done
fi

echo "worktree-kill: done."
