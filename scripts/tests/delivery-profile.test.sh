#!/usr/bin/env bash
# The profile is valid, and its kit_version pin matches the kit actually resolved.
#
# The pin check is the point: scripts/kit-root.sh already refuses a mismatch at exit 3, but
# it only runs when someone invokes a shim. This test puts the same check in CI, so a pin
# that drifts from the installed/checked-out kit fails a PR rather than the next run.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

profile=".claude/delivery-profile.yaml"
[ -f "$profile" ] || { echo "✗ no $profile"; exit 1; }

kit="$(scripts/kit-root.sh)"
node "$kit/scripts/profile.mjs" validate "$profile"

want="$(grep -E '^kit_version:' "$profile" | head -1 \
  | sed -E "s/^kit_version:[[:space:]]*//; s/[\"']//g; s/[[:space:]]*(#.*)?$//")"
have="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||""))' \
  "$kit/.claude-plugin/plugin.json")"

if [ "$want" != "$have" ]; then
  echo "✗ kit_version pin is $want but the resolved kit at $kit is $have"
  exit 1
fi
echo "✓ kit_version $want matches the resolved kit"

# Repo-specific keys the compiler and the runner read. A typo here is silent otherwise:
# the compiler would emit a test-* step that does not exist, or push to the wrong repo.
check_key() {
  local key="$1" expect="$2" got
  got="$(node "$kit/scripts/profile.mjs" read "$profile" "$key")"
  if [ "$got" != "$expect" ]; then
    echo "✗ $key is '$got', expected '$expect'"
    exit 1
  fi
  echo "✓ $key = $expect"
}
check_key repo.github Blaze212/fractional
check_key ci.required_check 'Typecheck, Lint & Test'
check_key verify.full 'pnpm typecheck && pnpm test:unit:coverage && pnpm lint && pnpm format:check'

# verify.full must be commands this repo actually defines, or the pipeline's test step
# fails on a green PR for no reason.
for s in typecheck test:unit:coverage lint format:check; do
  node -e '
    const s = JSON.parse(require("fs").readFileSync("package.json","utf8")).scripts || {};
    if (!s[process.argv[1]]) { console.error("✗ package.json has no script " + process.argv[1]); process.exit(1); }
  ' "$s"
done
echo "✓ every verify.full command is a package.json script"
