#!/usr/bin/env bash
# scripts/bootstrap-sandbox.sh
#
# One-shot setup for the Cowork/Claude sandbox session.
# Run once at the start of any overnight or automated session.
#
# Usage:
#   source scripts/bootstrap-sandbox.sh        # recommended — exports env vars into current shell
#   bash   scripts/bootstrap-sandbox.sh        # also works, but env vars won't persist to caller
#
# Secrets file (gitignored via *.local):
#   .cowork-secrets.local — create this once in the workspace root:
#
#     GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
#
#   Generate at: https://github.com/settings/tokens
#   Required scopes: repo, read:org
#
# What this script does:
#   1. Creates a pnpm shim from node_modules/.bin (no network required)
#   2. Authenticates gh CLI if the GitHub API is reachable; warns otherwise
#   3. Copies .git → /tmp/workspace-git so git lock files live on a
#      POSIX-compliant filesystem (fixes the "unlink not permitted" issue
#      on Docker bind-mounted volumes)
#   4. Exports GIT_DIR / GIT_WORK_TREE so all subsequent git/gh calls work
#   5. Skips pnpm install if node_modules is already populated
#
# Network note:
#   The Cowork sandbox proxy only allows api.anthropic.com by default.
#   npm registry, github.com, and deno.land are blocked. This script is
#   designed to work fully offline as long as node_modules is pre-installed.
#   Git push / PR creation will be attempted and failures reported gracefully.

set -euo pipefail

WORKSPACE="${WORKSPACE:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)}"
SECRETS_FILE="$WORKSPACE/.cowork-secrets.local"
GIT_CACHE="/tmp/workspace-git"
PNPM_SHIM="/tmp/sandbox-pnpm"

_log() { echo "[bootstrap] $*"; }
_ok()  { echo "[bootstrap] ✅ $*"; }
_warn() { echo "[bootstrap] ⚠️  $*" >&2; }
_err() { echo "[bootstrap] ❌ $*" >&2; }

# ── 0. Sanity check ────────────────────────────────────────────────────────────
if [ ! -d "$WORKSPACE" ]; then
  _err "Workspace not found at $WORKSPACE — update the WORKSPACE env var and retry."
  return 1 2>/dev/null || exit 1
fi

# ── 1. Load secrets ────────────────────────────────────────────────────────────
if [ ! -f "$SECRETS_FILE" ]; then
  _err "Secrets file missing: $SECRETS_FILE"
  _err "Create it with:"
  _err "  echo 'GITHUB_TOKEN=ghp_yourTokenHere' > $WORKSPACE/.cowork-secrets.local"
  return 1 2>/dev/null || exit 1
fi

# shellcheck source=/dev/null
source "$SECRETS_FILE"

if [ -z "${GITHUB_TOKEN:-}" ]; then
  _err "GITHUB_TOKEN is not set in $SECRETS_FILE"
  return 1 2>/dev/null || exit 1
fi

# ── 2. Create offline pnpm shim ────────────────────────────────────────────────
# The sandbox blocks npm registry, so we can't install pnpm via npm.
# All pnpm scripts resolve to node_modules/.bin/ binaries already installed
# on the host. We create a thin shim that delegates to them directly.
#
# Supported commands: install, run <script>, -r <script>, typecheck, format,
# format:check, lint, test, test:unit, build
_log "Creating offline pnpm shim..."
cat > "$PNPM_SHIM" << 'PNPM_SHIM_EOF'
#!/usr/bin/env bash
# Offline pnpm shim for Cowork sandbox — delegates to node_modules/.bin/
set -euo pipefail
WS="${GIT_WORK_TREE:-$(pwd)}"
BIN="$WS/node_modules/.bin"

_run_script() {
  local pkg_json="$1"
  local script_name="$2"
  shift 2
  local cmd
  cmd=$(node -e "const d=require('$pkg_json'); process.stdout.write(d.scripts?.['$script_name']||'')" 2>/dev/null)
  if [ -z "$cmd" ]; then
    echo "[pnpm-shim] No script '$script_name' in $pkg_json" >&2
    return 0
  fi
  local pkg_dir
  pkg_dir=$(dirname "$pkg_json")
  PATH="$pkg_dir/node_modules/.bin:$BIN:$PATH" bash -c "$cmd" "$@"
}

cmd="${1:-}"
shift || true   # consume $1 so "$@" = extra args only

case "$cmd" in
  install|i)
    count=$(ls "$WS/node_modules/.pnpm" 2>/dev/null | wc -l || echo 0)
    if [ "$count" -gt 10 ]; then
      echo "[pnpm-shim] node_modules already populated ($count packages) — skipping install"
    else
      echo "[pnpm-shim] ⚠️  Cannot install packages (npm registry blocked). node_modules may be incomplete." >&2
    fi
    ;;
  -r)
    script="${1:-}"; shift || true
    for pkg_json in "$WS"/apps/*/package.json "$WS"/packages/*/package.json; do
      [ -f "$pkg_json" ] || continue
      pkg_dir=$(dirname "$pkg_json")
      pkg_name=$(node -e "const d=require('$pkg_json'); process.stdout.write(d.name||'$pkg_dir')" 2>/dev/null)
      has_script=$(node -e "const d=require('$pkg_json'); process.stdout.write(d.scripts?.['$script']?'yes':'')" 2>/dev/null)
      [ -n "$has_script" ] || continue
      echo "[pnpm-shim] Running $script in $pkg_name..."
      (cd "$pkg_dir" && _run_script "$pkg_json" "$script" "$@")
    done
    ;;
  run)
    script="${1:-}"; shift || true
    _run_script "$WS/package.json" "$script" "$@"
    ;;
  typecheck)
    echo "[pnpm-shim] Running typecheck across workspace packages..."
    for pkg_json in "$WS"/apps/*/package.json "$WS"/packages/*/package.json; do
      [ -f "$pkg_json" ] || continue
      has_script=$(node -e "const d=require('$pkg_json'); process.stdout.write(d.scripts?.typecheck?'yes':'')" 2>/dev/null)
      [ -n "$has_script" ] || continue
      pkg_dir=$(dirname "$pkg_json")
      pkg_name=$(node -e "const d=require('$pkg_json'); process.stdout.write(d.name||'$pkg_dir')" 2>/dev/null)
      echo "[pnpm-shim] typecheck: $pkg_name"
      (cd "$pkg_dir" && PATH="$pkg_dir/node_modules/.bin:$BIN:$PATH" bash -c "tsc --noEmit")
    done
    echo "[pnpm-shim] ⚠️  Skipping typecheck:functions (deno not available in sandbox)"
    ;;
  typecheck:functions)
    echo "[pnpm-shim] ⚠️  Skipping typecheck:functions (deno not available in sandbox)" >&2
    ;;
  format)
    cd "$WS" && "$BIN/prettier" --write . "$@"
    ;;
  format:check)
    cd "$WS" && "$BIN/prettier" --check . "$@"
    ;;
  lint)
    cd "$WS" && "$BIN/eslint" apps packages "$@"
    ;;
  test|test:unit)
    cd "$WS" && "$BIN/vitest" run --config vitest.unit.config.ts "$@"
    ;;
  build)
    _run_script "$WS/package.json" build "$@"
    ;;
  --version|-v)
    echo "pnpm-shim/sandbox (wrapping node_modules/.bin)"
    ;;
  *)
    _run_script "$WS/package.json" "$cmd" "$@" || {
      echo "[pnpm-shim] Unknown command: $cmd $*" >&2
      exit 1
    }
    ;;
esac
PNPM_SHIM_EOF
chmod +x "$PNPM_SHIM"

# Add shim to PATH (takes priority over any broken system pnpm)
export PATH="/tmp:$WORKSPACE/scripts/bin:$PATH"
export PNPM_HOME="$HOME/.local/share/pnpm"

# Symlink so 'pnpm' resolves to our shim
ln -sf "$PNPM_SHIM" /tmp/pnpm

_ok "pnpm shim ready (offline mode)"

# ── 3. Deno — skip gracefully ──────────────────────────────────────────────────
# deno.land is blocked by the sandbox proxy. typecheck:functions is skipped.
export DENO_INSTALL="$HOME/.deno"
export PATH="$DENO_INSTALL/bin:$PATH"
if command -v deno &>/dev/null; then
  _ok "deno $(deno --version | head -1) available"
else
  _warn "deno not available (deno.land blocked by proxy) — typecheck:functions will be skipped"
fi

# ── 4. gh CLI ─────────────────────────────────────────────────────────────────
# gh binary is pre-bundled in scripts/bin. Auth requires api.github.com which
# may be blocked by the sandbox proxy. We attempt auth and warn if it fails —
# this is non-fatal; the session proceeds and git push failures are caught later.
export GH_TOKEN="$GITHUB_TOKEN"

if command -v gh &>/dev/null; then
  gh_version=$(gh --version 2>/dev/null | head -1 | awk '{print $3}' || echo "unknown")
  # Test if GitHub API is reachable
  if gh auth status &>/dev/null 2>&1 || echo "$GITHUB_TOKEN" | gh auth login --with-token &>/dev/null 2>&1; then
    _ok "gh $gh_version authenticated as $(gh api user -q .login 2>/dev/null || echo 'unknown')"
    export GITHUB_PUSH_OK=true
  else
    _warn "gh $gh_version present but GitHub API unreachable (proxy blocks api.github.com)"
    _warn "Git push and PR creation will be attempted but may fail — implementation work will proceed"
    export GITHUB_PUSH_OK=false
  fi
else
  _warn "gh CLI not found — git push and PR creation unavailable"
  export GITHUB_PUSH_OK=false
fi

# ── 5. Fix git lock issue ──────────────────────────────────────────────────────
# The workspace is a Docker bind-mount that allows file creation but not deletion.
# Git's atomic lock mechanism (create X.lock → rename → unlink X.lock) fails on
# deletion, leaving stale lock files that block subsequent commands.
#
# Fix: copy .git to /tmp (full POSIX support) and point GIT_DIR there.
# GIT_WORK_TREE keeps the actual source files on the mounted volume.
_log "Copying .git → $GIT_CACHE (POSIX-safe git directory)..."
rm -rf "$GIT_CACHE"
cp -r "$WORKSPACE/.git" "$GIT_CACHE"

export GIT_DIR="$GIT_CACHE"
export GIT_WORK_TREE="$WORKSPACE"

# Verify git works end-to-end
if git status --short &>/dev/null; then
  _ok "git OK (GIT_DIR=$GIT_DIR)"
else
  _err "git check failed — inspect $GIT_CACHE"
  return 1 2>/dev/null || exit 1
fi

# ── 6. Workspace dependencies ─────────────────────────────────────────────────
# Skip install if node_modules is already populated (npm registry is blocked).
nm_count=$(ls "$WORKSPACE/node_modules/.pnpm" 2>/dev/null | wc -l || echo 0)
if [ "$nm_count" -gt 10 ]; then
  _ok "node_modules already populated ($nm_count packages) — skipping install"
else
  _log "Installing pnpm workspace dependencies (offline)..."
  cd "$WORKSPACE"
  pnpm install --frozen-lockfile --prefer-offline --silent 2>/dev/null || \
    _warn "pnpm install failed (expected in sandbox) — proceeding with existing node_modules"
fi

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo "╔════════════════════════════════════════╗"
echo "║  Sandbox ready                         ║"
printf "║  %-38s ║\n" "pnpm:  shim (offline)"
printf "║  %-38s ║\n" "deno:  $(command -v deno &>/dev/null && deno --version 2>/dev/null | grep deno | awk '{print $2}' || echo 'unavailable')"
printf "║  %-38s ║\n" "gh:    $(command -v gh &>/dev/null && gh --version 2>/dev/null | head -1 | awk '{print $3}' || echo 'unavailable')"
printf "║  %-38s ║\n" "git → /tmp/workspace-git"
printf "║  %-38s ║\n" "GitHub push: ${GITHUB_PUSH_OK:-false}"
echo "╚════════════════════════════════════════╝"
echo ""
echo "NOTE: GIT_DIR and GIT_WORK_TREE are exported."
if [ "${GITHUB_PUSH_OK:-false}" = "true" ]; then
  echo "      Push changes with: git push origin <branch>"
else
  echo "  ⚠️  GitHub API is unreachable — push/PR steps will be skipped."
  echo "      To fix: ensure the Cowork egress allowlist includes api.github.com"
  echo "      Workaround: manually push from your terminal after the session."
fi
echo ""
echo "To seed local DB with dev test accounts (run after 'supabase start'):"
echo "  pnpm db:bootstrap"
