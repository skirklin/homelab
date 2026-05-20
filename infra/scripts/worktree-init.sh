#!/usr/bin/env bash
# worktree-init.sh — symlink node_modules + built packages from the parent
# repo into a `.claude/worktrees/agent-<id>/` checkout so typecheck / tests /
# `pnpm exec` work without re-running `pnpm install`.
#
# This monorepo uses pnpm workspaces with hoisted deps and per-package
# `node_modules/` + `packages/*/dist/` artifacts. A fresh worktree is a bare
# checkout — none of those exist, so `pnpm exec tsc` fails with
# "Cannot find module" errors until they're materialized.
#
# Usage:
#   ./infra/scripts/worktree-init.sh           # create / refresh symlinks
#   ./infra/scripts/worktree-init.sh --verbose # log each link
#   ./infra/scripts/worktree-init.sh --clean   # remove links we'd create

set -euo pipefail

VERBOSE=0
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=1 ;;
    --clean)      CLEAN=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *)
      echo "worktree-init.sh: unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

# --- locate worktree + parent repo -------------------------------------------
git_dir="$(git rev-parse --git-dir 2>/dev/null || true)"
git_common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -z "$git_dir" || -z "$git_common_dir" ]]; then
  echo "worktree-init.sh: not inside a git repo" >&2
  exit 1
fi

# Resolve to absolute paths for comparison.
abs_git_dir="$(cd "$git_dir" && pwd)"
abs_common_dir="$(cd "$git_common_dir" && pwd)"
if [[ "$abs_git_dir" == "$abs_common_dir" ]]; then
  echo "worktree-init.sh: this is the main checkout, not a worktree — refusing to run." >&2
  echo "  Run this from inside a .claude/worktrees/agent-<id>/ checkout instead." >&2
  exit 1
fi

worktree_root="$(git rev-parse --show-toplevel)"
parent_repo="$(dirname "$abs_common_dir")"
cd "$worktree_root"

if [[ "$worktree_root" == "$parent_repo" ]]; then
  echo "worktree-init.sh: worktree root resolves to parent repo — refusing." >&2
  exit 1
fi

# --- gather target paths from the parent repo --------------------------------
# All paths emitted are RELATIVE to the repo root, so they apply 1:1 to both
# sides.
gather_targets() {
  local rel
  # Root hoisted store.
  if [[ -d "$parent_repo/node_modules" ]]; then echo "node_modules"; fi
  # apps/*/node_modules + apps/*/app/node_modules (some apps live one level deeper)
  while IFS= read -r rel; do echo "$rel"; done < <(
    find "$parent_repo/apps" -mindepth 1 -maxdepth 4 -name node_modules -type d 2>/dev/null \
      | sed "s|^$parent_repo/||"
  )
  # services/*/node_modules
  while IFS= read -r rel; do echo "$rel"; done < <(
    find "$parent_repo/services" -mindepth 1 -maxdepth 3 -name node_modules -type d 2>/dev/null \
      | sed "s|^$parent_repo/||"
  )
  # packages/*/node_modules and packages/*/dist
  while IFS= read -r rel; do echo "$rel"; done < <(
    find "$parent_repo/packages" -mindepth 1 -maxdepth 3 \( -name node_modules -o -name dist \) -type d 2>/dev/null \
      | sed "s|^$parent_repo/||"
  )
}

created=0
refreshed=0
skipped=0
removed=0
missing=0

start_s=$SECONDS

while IFS= read -r rel; do
  [[ -z "$rel" ]] && continue
  src="$parent_repo/$rel"
  dst="$worktree_root/$rel"

  if [[ ! -e "$src" ]]; then
    missing=$((missing + 1))
    continue
  fi

  if (( CLEAN )); then
    if [[ -L "$dst" ]]; then
      rm -f "$dst"
      removed=$((removed + 1))
      (( VERBOSE )) && echo "  rm   $rel"
    fi
    continue
  fi

  # Idempotency: if a symlink already points at the right target, skip.
  if [[ -L "$dst" ]]; then
    cur="$(readlink "$dst" || true)"
    if [[ "$cur" == "$src" ]]; then
      skipped=$((skipped + 1))
      (( VERBOSE )) && echo "  skip $rel"
      continue
    fi
    # Wrong target — replace it.
    refreshed=$((refreshed + 1))
    (( VERBOSE )) && echo "  fix  $rel"
  elif [[ -e "$dst" ]]; then
    # Real directory or file already lives here (not a symlink). Don't clobber.
    skipped=$((skipped + 1))
    (( VERBOSE )) && echo "  keep $rel (not a symlink, leaving alone)"
    continue
  else
    created=$((created + 1))
    (( VERBOSE )) && echo "  link $rel"
  fi

  mkdir -p "$(dirname "$dst")"
  ln -sfn "$src" "$dst"
done < <(gather_targets)

elapsed=$(( SECONDS - start_s ))

if (( CLEAN )); then
  echo "worktree-init: removed $removed link(s) in ${elapsed}s"
else
  echo "worktree-init: $created created, $refreshed refreshed, $skipped skipped, $missing missing-in-parent (${elapsed}s)"
fi
