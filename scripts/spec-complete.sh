#!/usr/bin/env bash
# bh-delivery shim. Do not edit; regenerate with install-shims.sh.
exec "$(dirname "$0")/kit-root.sh" scripts/spec-complete.sh "$@"
