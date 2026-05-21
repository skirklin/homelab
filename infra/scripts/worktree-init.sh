#!/usr/bin/env bash
# worktree-init.sh — prepare a `.claude/worktrees/agent-<id>/` checkout so
# typecheck / tests / `pnpm exec` work without a fresh install.
#
# This monorepo uses pnpm workspaces with hoisted deps and per-package
# `node_modules/` + `packages/*/dist/` artifacts. A fresh worktree is a bare
# checkout — none of those exist, so `pnpm exec tsc` fails with
# "Cannot find module" errors until they're materialized.
#
# Why we don't just symlink `node_modules` from the parent repo: pnpm fills
# each `node_modules/` with *relative* symlinks like
# `node_modules/@homelab/backend -> ../../../packages/backend`. When we
# symlink the whole `node_modules` dir back to the parent checkout, those
# relative links still resolve relative to the link's TARGET (= parent),
# so `@homelab/backend` ends up pointing at the parent repo's source
# instead of the worktree's. That silently makes `tsc`/`vitest` read the
# parent's code, not the worktree's. Hence: install fresh in the worktree
# (pnpm's content-addressed store makes this ~near-instant).
#
# Why we fast-forward to `main`: parallel Claude sessions land commits on
# local `main` between the moment a worktree is created and the moment the
# agent inside it starts working. The worktree's branch (cut from the
# snapshot at creation time — often an `origin/main` snapshot that's
# already stale) silently misses those commits, so the agent makes
# architectural decisions against an outdated tree and produces avoidable
# merge conflicts. We detect "purely behind" and ff to local `main` before
# the install step so any new dependencies brought in by those commits are
# picked up by the same `pnpm install` that's about to run.
#
# Usage:
#   ./infra/scripts/worktree-init.sh           # populate node_modules + dist
#   ./infra/scripts/worktree-init.sh --verbose # log each step
#   ./infra/scripts/worktree-init.sh --clean   # remove node_modules + dist

set -euo pipefail

VERBOSE=0
CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=1 ;;
    --clean)      CLEAN=1 ;;
    -h|--help)
      sed -n '2,33p' "$0"
      exit 0
      ;;
    *)
      echo "worktree-init.sh: unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

log() { (( VERBOSE )) && echo "  $*"; return 0; }

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

# --- fast-forward to local main ----------------------------------------------
# Skip in --clean mode: `--clean` is purely "nuke build artifacts"; it must
# not touch git state.
if (( ! CLEAN )); then
  if git rev-parse --verify --quiet main >/dev/null; then
    # `|| echo 0` keeps `set -e` happy on first-commit / no-merge-base edge
    # cases where rev-list itself errors.
    behind=$(git rev-list --count HEAD..main 2>/dev/null || echo 0)
    ahead=$(git rev-list --count main..HEAD 2>/dev/null || echo 0)

    if (( behind == 0 )); then
      log "worktree up to date with main"
    elif (( ahead == 0 )); then
      # Pure behind — safe to fast-forward.
      if git merge --ff-only main >/dev/null 2>&1; then
        echo "ℹ️  Worktree was $behind commits behind main; fast-forwarded."
      else
        echo "⚠️  Worktree was $behind commits behind main but ff-only merge failed." >&2
        echo "    Continuing with stale base — resolve manually if needed." >&2
      fi
    else
      # Diverged — don't touch it, let the agent decide.
      echo "⚠️  Worktree diverged from main ($behind behind / $ahead ahead)."
      echo "    No auto-update — resolve manually if needed (\`git merge main\` to integrate)."
    fi
  else
    log "no local 'main' branch visible from this worktree — skipping fast-forward"
  fi
fi

# Packages that need a `dist/` (declaration files) for downstream typecheck.
# Both backend + ui have `types: "./dist/types/..."` in their package.json,
# so consumers' `tsc` will look here for type info; if it's missing or stale
# vs the worktree's src, you get phantom errors.
DIST_PACKAGES=(packages/backend packages/ui)

start_s=$SECONDS

# --- clean mode --------------------------------------------------------------
if (( CLEAN )); then
  removed=0
  # Old-script artifacts: symlinks pointing into the parent repo. Clear those
  # so a re-run of this script doesn't pick up stale absolute links.
  while IFS= read -r path; do
    if [[ -L "$path" ]]; then
      target="$(readlink "$path" || true)"
      # Absolute symlink into parent_repo, or matches the old script's pattern.
      if [[ "$target" == "$parent_repo/"* || "$target" == "$parent_repo" ]]; then
        rm -f "$path"
        removed=$((removed + 1))
        log "rm symlink $path"
      fi
    fi
  done < <(
    find . -name node_modules -prune -type l 2>/dev/null
    find . -path '*/packages/*/dist' -prune -type l 2>/dev/null
  )

  # Real (non-symlink) node_modules and dist dirs created by this script.
  while IFS= read -r path; do
    if [[ -d "$path" && ! -L "$path" ]]; then
      rm -rf "$path"
      removed=$((removed + 1))
      log "rm dir     $path"
    fi
  done < <(
    # Top-level + per-workspace node_modules
    find . -mindepth 1 -maxdepth 5 -name node_modules -type d -not -path '*/node_modules/*' 2>/dev/null
    # packages/*/dist
    for p in "${DIST_PACKAGES[@]}"; do
      [[ -d "$p/dist" ]] && echo "$p/dist"
    done
  )

  elapsed=$(( SECONDS - start_s ))
  echo "worktree-init: removed $removed path(s) in ${elapsed}s"
  exit 0
fi

# --- normal mode -------------------------------------------------------------
# Step 1: drop any stale symlinks left over by the previous version of this
# script that pointed into the parent repo. They cause @homelab/backend (and
# friends) to silently resolve to the parent's source.
stale_removed=0
while IFS= read -r path; do
  [[ -L "$path" ]] || continue
  target="$(readlink "$path" || true)"
  if [[ "$target" == "$parent_repo/"* || "$target" == "$parent_repo" ]]; then
    rm -f "$path"
    stale_removed=$((stale_removed + 1))
    log "drop stale symlink $path -> $target"
  fi
done < <(
  find . -name node_modules -prune -type l 2>/dev/null
  find . -path '*/packages/*/dist' -prune -type l 2>/dev/null
)
(( stale_removed > 0 )) && log "removed $stale_removed stale parent-repo symlink(s)"

# Step 2: pnpm install. With pnpm's content-addressed store warm this is ~7s
# from scratch and ~2s when already up to date.
install_status="up to date"
if [[ ! -d node_modules ]] || [[ ! -L node_modules/@homelab/backend && ! -d node_modules/@homelab/backend ]]; then
  install_status="installed"
fi

if (( VERBOSE )); then
  pnpm install --frozen-lockfile --prefer-offline
else
  # Quiet mode: only print if install actually does work.
  pnpm install --frozen-lockfile --prefer-offline 2>&1 \
    | grep -E '(added|Done in|ERR|error)' || true
fi

# Step 3: build dist artifacts that consumers' `tsc` will look up via the
# `types` export. `tsc -b` is incremental — second run is a near no-op via
# `.tsbuildinfo`.
built=0
skipped=0
for pkg in "${DIST_PACKAGES[@]}"; do
  if [[ ! -d "$worktree_root/$pkg" ]]; then
    log "skip $pkg (not present)"
    continue
  fi
  # If dist/types/ already exists and is newer than any src file, skip.
  # `tsc -b` will figure it out itself, but checking lets --verbose stay
  # informative.
  if [[ -d "$worktree_root/$pkg/dist/types" ]]; then
    log "build $pkg (incremental)"
  else
    log "build $pkg (fresh)"
  fi
  ( cd "$worktree_root/$pkg" && npx --offline tsc -b ) >/dev/null
  built=$((built + 1))
done

elapsed=$(( SECONDS - start_s ))
echo "worktree-init: pnpm $install_status, $built dist package(s) built in ${elapsed}s"
