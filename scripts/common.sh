#!/usr/bin/env bash
# Shared shell helpers for the dsh-memory Debian build.
#
# Every script can run standalone (it locates the repository root from its own
# path) or under the Makefile, which exports ROOT/BUILD/DIST.

set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BUILD="${BUILD:-$ROOT/build}"
DIST="${DIST:-$ROOT/dist}"
export ROOT BUILD DIST

# shellcheck source=../release.conf
. "$ROOT/release.conf"

if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then
  C_RESET='' C_BOLD='' C_DIM='' C_GREEN='' C_YELLOW='' C_RED=''
else
  C_RESET=$'\033[0m' C_BOLD=$'\033[1m' C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_RED=$'\033[31m'
fi

log()  { printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$*" >&2; }
step() { printf '%s  -%s %s\n' "$C_DIM" "$C_RESET" "$*" >&2; }
warn() { printf '%s[warn]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s[error]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# require_cmd CMD MESSAGE
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "${2:-required command not found: $1}"
}

# node_bin prints the Node executable used for builds and verification.
# DSH_NODE overrides discovery, matching the Harness launcher.
node_bin() {
  if [ -n "${DSH_NODE:-}" ]; then
    printf '%s\n' "$DSH_NODE"
    return 0
  fi
  command -v node 2>/dev/null || true
}

# check_node_version enforces the build-time Node floor in release.conf.
check_node_version() {
  local node
  node="$(node_bin)"
  [ -n "$node" ] || die "Node.js not found. Install Node >= $NODE_MIN or set DSH_NODE."
  NODE_MIN="$NODE_MIN" "$node" -e '
    const [a, b, c] = process.versions.node.split(".").map(Number)
    const [x, y, z] = process.env.NODE_MIN.split(".").map(Number)
    if (a < x || (a === x && (b < y || (b === y && c < z)))) {
      console.error(`Node ${process.versions.node} is older than required ${process.env.NODE_MIN}`)
      process.exit(1)
    }
  ' || die "Node >= $NODE_MIN is required (found "$("$node" -v)")."
}

# deb_upstream_version maps a semver version to a Debian upstream version.
# Every prerelease hyphen becomes `~`, which sorts before the release:
# 0.4.0-rc.1 becomes 0.4.0~rc.1, so apt upgrades to 0.4.0 correctly.
deb_upstream_version() {
  printf '%s\n' "$1" | sed 's/-/~/g'
}

# init_version resolves the package version, its Debian form, the reproducible
# timestamp, and the source commit, and exports them for the child scripts.
init_version() {
  local node
  node="$(node_bin)"
  [ -n "$node" ] || die "Node.js is required to read the plugin version"

  PLUGIN_VERSION="${PLUGIN_VERSION:-$("$node" -p "require(process.argv[1]).version" "$ROOT/package.json")}"
  DEB_UPSTREAM_VERSION="${DEB_UPSTREAM_VERSION:-$(deb_upstream_version "$PLUGIN_VERSION")}"
  DEB_FULL_VERSION="${DEB_UPSTREAM_VERSION}-${DEB_REVISION}"
  printf '%s' "$DEB_FULL_VERSION" | grep -Eq '^[0-9][0-9A-Za-z.+~]*-[0-9A-Za-z.+~]+$' \
    || die "cannot derive a Debian version from package.json version '$PLUGIN_VERSION'"

  if [ -z "${SOURCE_DATE_EPOCH:-}" ]; then
    if SOURCE_DATE_EPOCH="$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null)" && [ -n "$SOURCE_DATE_EPOCH" ]; then
      :
    else
      SOURCE_DATE_EPOCH="$(date +%s)"
    fi
  fi
  PLUGIN_COMMIT="${PLUGIN_COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')}"

  export PLUGIN_VERSION DEB_UPSTREAM_VERSION DEB_FULL_VERSION SOURCE_DATE_EPOCH PLUGIN_COMMIT
}

# deb_file prints the absolute path of the built package.
deb_file() {
  local name
  name="$(cat "$DIST/latest.txt" 2>/dev/null || true)"
  [ -n "$name" ] || die "no built package recorded in $DIST/latest.txt; run scripts/package.sh first"
  printf '%s/%s\n' "$DIST" "$name"
}

# render_template substitutes the @NAME@ placeholders shared by packaging/*.in.
# Call it after init_version, from the build root.
render_template() {
  sed \
    -e "s|@PACKAGE@|$DEB_PACKAGE|g" \
    -e "s|@VERSION@|$DEB_FULL_VERSION|g" \
    -e "s|@ARCH@|$DEB_ARCH|g" \
    -e "s|@MAINTAINER@|$DEB_MAINTAINER|g" \
    -e "s|@INSTALLED_SIZE@|${INSTALLED_SIZE:-0}|g" \
    -e "s|@DSH_PACKAGE@|$DSH_PACKAGE|g" \
    -e "s|@DSH_MIN_VERSION@|$DSH_MIN_VERSION|g" \
    -e "s|@PLUGIN_NAME@|$PLUGIN_NAME|g" \
    -e "s|@PLUGIN_VERSION@|$PLUGIN_VERSION|g" \
    -e "s|@PLUGIN_COMMIT@|$PLUGIN_COMMIT|g" \
    -e "s|@PLUGIN_INSTALL_DIR@|$PLUGIN_INSTALL_DIR|g" \
    -e "s|@PLUGIN_REPO_URL@|$PLUGIN_REPO_URL|g" \
    -e "s|@PROFILE@|$PROFILE|g"
}

