#!/usr/bin/env bash
# Assemble build/rootfs: the plugin package root under /usr/lib/dsh/plugins,
# its documentation, and the DEBIAN control area. No step needs root;
# dpkg-deb --root-owner-group fixes ownership at package time.

set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

init_version
NODE="$(node_bin)"
[ -n "$NODE" ] || die "Node.js is required to stage the package"
[ -f "$ROOT/lib/index.js" ] || die "lib/ is not built; run scripts/build-plugin.sh first"

rootfs="$BUILD/rootfs"
pkg="$rootfs$PLUGIN_INSTALL_DIR"
doc="$rootfs/usr/share/doc/$DEB_PACKAGE"

rm -rf "$rootfs"
install -d "$pkg/lib" "$pkg/locale" "$pkg/docs" "$doc" "$doc/docs" "$rootfs/DEBIAN"

log "staging the plugin package root under $PLUGIN_INSTALL_DIR"
install -m 0644 \
  "$ROOT/package.json" \
  "$ROOT/cordis.patch.yml" \
  "$ROOT/README.md" \
  "$ROOT/LICENSE" \
  "$ROOT/icon.svg" \
  "$pkg/"
install -m 0644 "$ROOT"/locale/*.json "$pkg/locale/"
install -m 0644 "$ROOT"/docs/*.md "$pkg/docs/"

# Ship exactly the runtime the package exposes: the Host bundle and its
# declarations, plus the browser bundle and its source map. TypeScript sources,
# tests, and build tooling stay in the repository.
cp -a "$ROOT/lib/." "$pkg/lib/"

log "staging documentation"
install -m 0644 "$ROOT/packaging/copyright" "$doc/copyright"
install -m 0644 "$ROOT/LICENSE" "$doc/LICENSE"
install -m 0644 "$ROOT"/docs/*.md "$doc/docs/"
render_template < "$ROOT/packaging/README.Debian" > "$doc/README.Debian"
gzip -9n "$doc/README.Debian"

{
  printf '%s (%s) unstable; urgency=medium\n\n' "$DEB_PACKAGE" "$DEB_FULL_VERSION"
  printf '  * Package the memory plugin for DeepSeek Harness %s.\n' "$PLUGIN_VERSION"
  printf '  * Install the package root under %s; the profile is not modified.\n\n' "$PLUGIN_INSTALL_DIR"
  printf ' -- %s  %s\n' "$DEB_MAINTAINER" "$(LC_ALL=C date -R -u -d "@$SOURCE_DATE_EPOCH")"
} > "$doc/changelog.Debian"
gzip -9n "$doc/changelog.Debian"

export PLUGIN_VERSION DEB_FULL_VERSION PLUGIN_NAME PLUGIN_INSTALL_DIR
export DEB_PACKAGE DEB_ARCH PLUGIN_REPO_URL PLUGIN_COMMIT SOURCE_DATE_EPOCH PROFILE DSH_MIN_VERSION
"$NODE" - "$BUILD/BUILD-INFO.json" <<'EOF'
const { writeFileSync } = require('node:fs')
const out = process.argv[2]
const info = {
  package: process.env.DEB_PACKAGE,
  version: process.env.DEB_FULL_VERSION,
  architecture: process.env.DEB_ARCH,
  plugin: {
    name: process.env.PLUGIN_NAME,
    version: process.env.PLUGIN_VERSION,
    installPath: process.env.PLUGIN_INSTALL_DIR,
    entry: 'lib/index.js',
    bundlePatch: 'cordis.patch.yml',
  },
  source: {
    repository: process.env.PLUGIN_REPO_URL,
    commit: process.env.PLUGIN_COMMIT,
  },
  build: {
    sourceDateEpoch: Number(process.env.SOURCE_DATE_EPOCH),
    builtAt: new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  },
  requires: {
    dsh: `>=${process.env.DSH_MIN_VERSION}`,
  },
  enable: `dsh plugin --profile ${process.env.PROFILE} add ${process.env.PLUGIN_INSTALL_DIR}`,
}
writeFileSync(out, JSON.stringify(info, null, 2) + '\n')
EOF
install -m 0644 "$BUILD/BUILD-INFO.json" "$doc/BUILD-INFO.json"

log "writing the control area"
INSTALLED_SIZE="$(du -sk --exclude=DEBIAN "$rootfs" | cut -f1)"
export INSTALLED_SIZE
render_template < "$ROOT/packaging/control.in" > "$rootfs/DEBIAN/control"
render_template < "$ROOT/packaging/postinst.in" > "$rootfs/DEBIAN/postinst"
chmod 0755 "$rootfs/DEBIAN/postinst"

# dpkg-deb records only the payload; generate the md5sums database that
# `dpkg --verify` and package tooling expect.
(
  cd "$rootfs"
  find usr -type f -print0 | LC_ALL=C sort -z | xargs -0 md5sum > DEBIAN/md5sums
)

# Normalize modes and timestamps so two builds of the same commit produce the
# same archive. dpkg packages use 0755 directories and 0644/0755 files.
find "$rootfs" -type d -exec chmod 0755 {} +
find "$rootfs" -type f -perm -u+x -exec chmod 0755 {} +
find "$rootfs" -type f ! -perm -u+x -exec chmod 0644 {} +
find "$rootfs" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

log "${C_GREEN}rootfs ready${C_RESET}: $rootfs ($(du -sh "$rootfs" | cut -f1))"
