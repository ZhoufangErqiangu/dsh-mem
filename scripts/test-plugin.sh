#!/usr/bin/env bash
# Typecheck and run the unit tests after a build.
#
# Building is a separate step (`npm run build`, or `make build`). This gate
# consumes lib/ and never produces it, so a test run cannot hide a stale or
# missing bundle.

set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

cd "$ROOT"

[ -f "$ROOT/lib/index.js" ] || die "lib/index.js is missing; run 'npm run build' first"
[ -f "$ROOT/lib/client.js" ] || die "lib/client.js is missing; run 'npm run build' first"

log "typechecking"
npm run typecheck

log "running the unit tests"
npm test
