#!/usr/bin/env bash
# Run every scripts/tests/*.test.sh. Non-zero if any fails.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
fails=0
for t in ./*.test.sh; do
  echo "── $t"
  if ! bash "$t"; then echo "✗ $t FAILED"; fails=$((fails + 1)); fi
  echo
done
[ "$fails" -eq 0 ] || { echo "scripts/tests: $fails test file(s) failed"; exit 1; }
echo "scripts/tests: all green"
