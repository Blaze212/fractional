#!/usr/bin/env bash
# Every scripts/*.sh the kit owns is a shim that resolves and executes through the kit.
#
# This is the test that would have caught a broken resolver before the pipeline needed it:
# it does not mock kit-root.sh, it runs the real shims against the real resolved kit.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

fails=0
ok()   { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; fails=$((fails + 1)); }

SHIMMED=(
  gated-run.sh gated-watchdog.sh validate-gated-yaml.sh pr-open.sh pr-merge.sh
  pr-size-gate.sh new-worktree.sh git-fetch-main.sh linear.sh profile-classify.sh
)

kit="$(scripts/kit-root.sh)"
ok "kit-root.sh resolves to $kit"

# 1 — each shim exists, is executable, is a shim (not a copy), and names a real kit script.
for name in "${SHIMMED[@]}"; do
  f="scripts/$name"
  if [ ! -x "$f" ]; then fail "$name missing or not executable"; continue; fi
  if [ "$(wc -l < "$f")" -gt 5 ]; then
    fail "$name is $(wc -l < "$f") lines — a copy, not a shim. Regenerate with install-shims.sh"
    continue
  fi
  if ! grep -q "kit-root.sh\" scripts/$name" "$f"; then
    fail "$name does not exec through kit-root.sh"
    continue
  fi
  if [ ! -x "$kit/scripts/$name" ]; then fail "$name shims a script the kit does not have"; continue; fi
  ok "$name is a shim onto the kit"
done

# 2 — shims that have a side-effect-free mode actually run end to end through the kit.
if scripts/gated-run.sh --help >/dev/null 2>&1; then ok "gated-run.sh --help exits 0"
else fail "gated-run.sh --help did not exit 0"; fi

if scripts/git-fetch-main.sh --check >/dev/null 2>&1; then ok "git-fetch-main.sh --check exits 0"
else fail "git-fetch-main.sh --check did not exit 0"; fi

# 3 — profile-classify.sh is the single tiering oracle; both the compiler and pr-merge.sh
# call it, so a profile whose rules stopped matching is a silent tier-down. Assert both
# directions against this repo's own rules.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf 'apps/portal/src/App.tsx\n' > "$tmp/green.txt"
out="$(scripts/profile-classify.sh --profile .claude/delivery-profile.yaml --files "$tmp/green.txt")"
if [ "$(printf '%s' "$out" | grep -c '^tier:')" -eq 1 ] && printf '%s' "$out" | grep -q '^tier: none$'; then
  ok "profile-classify: an ordinary portal file is tier none"
else
  fail "profile-classify on a portal file printed: $out"
fi

printf 'apps/adjuster/.clasp.json\n' > "$tmp/red.txt"
out="$(scripts/profile-classify.sh --profile .claude/delivery-profile.yaml --files "$tmp/red.txt")"
if printf '%s' "$out" | grep -q '^tier: red$' && printf '%s' "$out" | grep -q '^rule: apps-script-deploy$'; then
  ok "profile-classify: a clasp config change is tier red (apps-script-deploy)"
else
  fail "profile-classify on .clasp.json printed: $out"
fi

cat > "$tmp/retell.diff" <<'DIFF'
diff --git a/apps/adjuster/retell.ts b/apps/adjuster/retell.ts
--- a/apps/adjuster/retell.ts
+++ b/apps/adjuster/retell.ts
@@ -1 +1,2 @@
 const x = 1;
+// bind number to the published agent version
DIFF
out="$(scripts/profile-classify.sh --profile .claude/delivery-profile.yaml --diff "$tmp/retell.diff")"
if printf '%s' "$out" | grep -q '^tier: red$' && printf '%s' "$out" | grep -q '^rule: retell-publish$'; then
  ok "profile-classify: a diff binding a number is tier red (retell-publish)"
else
  fail "profile-classify on a retell diff printed: $out"
fi

# 4 — the size gate stops an oversize branch. Build one rather than trusting the limit,
# and assert the VERDICT LINE, not just a non-zero exit: kit-root.sh's own failure code is
# also 3, so an exit-code-only check goes green when the gate never ran at all. The fixture
# repo has no profile of its own, hence BH_DELIVERY_PROFILE.
prof="$repo_root/.claude/delivery-profile.yaml"
git -C "$tmp" init -q fixture
(
  cd "$tmp/fixture"
  git config user.email t@t; git config user.name t
  : > big.txt; git add big.txt; git commit -qm base
  git branch -q -M main
  git checkout -qb oversize
  seq 1 1200 > big.txt
  git add big.txt; git commit -qm oversize
  git checkout -q main
  git checkout -qb small
  seq 1 10 > big.txt
  git add big.txt; git commit -qm small
)

run_gate() { # run_gate <branch>
  ( cd "$tmp/fixture" \
      && BH_DELIVERY_PROFILE="$prof" BASE_REF=main "$repo_root/scripts/pr-size-gate.sh" "$1" green ) 2>&1
}

set +e
out="$(run_gate oversize)"; code=$?
set -e
if [ "$code" -ne 0 ] && printf '%s' "$out" | grep -q 'pr-oversize'; then
  ok "pr-size-gate.sh stops a 1200-line branch with a pr-oversize verdict (exit $code)"
else
  fail "pr-size-gate.sh on a 1200-line branch: exit $code, output: $out"
fi

set +e
out="$(run_gate small)"; code=$?
set -e
if [ "$code" -eq 0 ] && printf '%s' "$out" | grep -q '10 changed line'; then
  ok "pr-size-gate.sh passes a 10-line branch"
else
  fail "pr-size-gate.sh on a 10-line branch: exit $code, output: $out"
fi

echo
if [ "$fails" -gt 0 ]; then echo "kit-shims: $fails failure(s)"; exit 1; fi
echo "kit-shims: all checks passed"
