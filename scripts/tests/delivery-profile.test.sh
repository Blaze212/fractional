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

# The missing-pin failure path, exercised against THIS repo's committed kit-root.sh.
# The kit's own suite covers its generator, but what actually runs here is the copy in
# this tree, and a drifted or hand-edited copy is invisible to the kit's tests. Every
# other check here hands the resolver a VALID profile, so none would notice a regression
# back to the `set -e` swallow (kit 1.0.2), where a profile with no kit_version exited 1
# silently instead of 3 with the diagnostic.
probe="$(mktemp -d)"
trap 'rm -rf "$probe"' EXIT
printf 'repo:\n  github: Blaze212/fractional\n' > "$probe/no-pin.yaml"
set +e
probe_out="$(BH_DELIVERY_PROFILE="$probe/no-pin.yaml" scripts/kit-root.sh 2>&1)"
probe_rc=$?
set -e
if [ "$probe_rc" -ne 3 ]; then
  echo "✗ missing-pin path: expected exit 3, got $probe_rc — '$probe_out'"
  exit 1
fi
if ! printf '%s' "$probe_out" | grep -q 'no kit_version in' \
   || ! printf '%s' "$probe_out" | grep -q 'plugin install bh-delivery'; then
  echo "✗ missing-pin path: expected the diagnostic + fix-it, got '$probe_out'"
  exit 1
fi
echo "✓ a profile with no kit_version exits 3 with the diagnostic and the fix"

# verify.full must be commands this repo actually defines, or the pipeline's test step
# fails on a green PR for no reason.
for s in typecheck test:unit:coverage lint format:check; do
  node -e '
    const s = JSON.parse(require("fs").readFileSync("package.json","utf8")).scripts || {};
    if (!s[process.argv[1]]) { console.error("✗ package.json has no script " + process.argv[1]); process.exit(1); }
  ' "$s"
done
echo "✓ every verify.full command is a package.json script"
