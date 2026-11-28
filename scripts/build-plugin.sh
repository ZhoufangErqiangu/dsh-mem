#!/usr/bin/env bash
# Install locked dependencies and bundle the plugin into lib/.
#
# Building is deliberately separate from testing and packaging: this step only
# produces lib/, and `scripts/test-plugin.sh` consumes that output. The build is
# what the .deb ships, so CI always starts from `npm ci`. Set SKIP_INSTALL=1 to
# package an existing checkout without touching node_modules.
#
# lib/ is generated, git-ignored build output: CI and the .deb pipeline run this
# step, and no compiled tree is committed.

set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

NODE="$(node_bin)"
[ -n "$NODE" ] || die "Node.js not found. Install Node >= $NODE_MIN or set DSH_NODE."
check_node_version
require_cmd npm "npm is required to install dependencies"
init_version

cd "$ROOT"

if [ "${SKIP_INSTALL:-0}" = "1" ]; then
  log "skipping npm ci (SKIP_INSTALL=1)"
  [ -d "$ROOT/node_modules" ] || die "node_modules is missing; run npm ci first"
else
  log "installing locked dependencies (npm ci)"
  npm ci --no-audit --no-fund
fi

log "bundling into lib/"
npm run build

[ -f "$ROOT/lib/index.js" ] || die "the build did not produce lib/index.js"
[ -f "$ROOT/lib/index.d.ts" ] || die "the build did not produce lib/index.d.ts"
[ -f "$ROOT/lib/client.js" ] || die "the build did not produce lib/client.js"

# Every DSH package is a type-only build dependency and is provided by the Host
# at runtime. The compiled bundle must not import one, otherwise the package
# would depend on how the Host resolves its own node_modules.
log "checking that the compiled entry has no Host runtime imports"
if grep -rE "from ['\"]@deepseek-ai|require\(['\"]@deepseek-ai" "$ROOT/lib" --include='*.js'; then
  die "compiled output imports a @deepseek-ai package at runtime"
fi

log "${C_GREEN}build complete${C_RESET}: plugin $PLUGIN_VERSION, Node $("$NODE" -p 'process.versions.node')"
