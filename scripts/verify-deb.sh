#!/usr/bin/env bash
# Verify the built .deb without installing it system-wide:
#   * control metadata and dependency fields
#   * payload layout, ownership, and modes
#   * package.json / bundle-patch consistency
#   * the compiled entry loads and exports the bundle contract
#   * the plugin composes into a real DeepSeek Harness profile, when dsh is on PATH

set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

init_version
NODE="$(node_bin)"
[ -n "$NODE" ] || die "Node.js is required to verify the package"
deb="$(deb_file)"
[ -f "$deb" ] || die "package missing: $deb"

check=0
pass() { check=$((check + 1)); printf '  %s[ok]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
fail() { printf '  %s[FAIL]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
field() { dpkg-deb --field "$deb" "$1"; }

log "verifying $(basename "$deb")"

[ "$(field Package)" = "$DEB_PACKAGE" ] || fail "Package is not $DEB_PACKAGE"
[ "$(field Version)" = "$DEB_FULL_VERSION" ] || fail "Version is not $DEB_FULL_VERSION"
[ "$(field Architecture)" = "$DEB_ARCH" ] || fail "Architecture is not $DEB_ARCH"
[ "$(field Section)" = "devel" ] || fail "Section is not devel"
field Depends | grep -Fq "$DSH_PACKAGE (>= $DSH_MIN_VERSION)" \
  || fail "missing dependency on $DSH_PACKAGE (>= $DSH_MIN_VERSION)"
[ "$(field X-DSH-Plugin-Name)" = "$PLUGIN_NAME" ] || fail "X-DSH-Plugin-Name is not $PLUGIN_NAME"
[ "$(field X-DSH-Plugin-Version)" = "$PLUGIN_VERSION" ] || fail "X-DSH-Plugin-Version is not $PLUGIN_VERSION"
[ "$(field X-DSH-Plugin-Commit)" = "$PLUGIN_COMMIT" ] || fail "X-DSH-Plugin-Commit is not $PLUGIN_COMMIT"
pass "control metadata (version, arch, Harness dependency, plugin provenance)"

rm -rf "$BUILD/verify"
mkdir -p "$BUILD/verify/root"
dpkg-deb --extract "$deb" "$BUILD/verify/root"
root="$BUILD/verify/root"
pkg="$root$PLUGIN_INSTALL_DIR"
doc="$root/usr/share/doc/$DEB_PACKAGE"

for file in \
  package.json cordis.patch.yml README.md LICENSE icon.svg \
  locale/en.json locale/zh.json \
  docs/DETAIL.md docs/GLOBAL.md docs/CURATION.md docs/ROADMAP.md \
  lib/index.js lib/index.d.ts lib/client.js lib/client.js.map; do
  [ -f "$pkg/$file" ] || fail "payload is missing $PLUGIN_INSTALL_DIR/$file"
done
[ ! -e "$pkg/dist" ] || fail "build output must live in lib/, not dist/"
[ ! -e "$pkg/src" ] || fail "TypeScript sources must not be packaged"
[ ! -e "$pkg/lib/tests" ] || fail "compiled tests must not be packaged"
[ ! -e "$pkg/package-lock.json" ] || fail "package-lock.json must not be packaged"
[ ! -e "$pkg/node_modules" ] || fail "the plugin has no runtime node_modules"
[ -f "$doc/copyright" ] || fail "copyright is missing"
[ -f "$doc/LICENSE" ] || fail "LICENSE is missing"
[ -f "$doc/README.Debian.gz" ] || fail "README.Debian.gz is missing"
[ -f "$doc/changelog.Debian.gz" ] || fail "changelog.Debian.gz is missing"
[ -f "$doc/BUILD-INFO.json" ] || fail "BUILD-INFO.json is missing"
for file in DETAIL.md GLOBAL.md CURATION.md ROADMAP.md; do
  [ -f "$doc/docs/$file" ] || fail "documentation is missing: docs/$file"
done
grep -q "^License: MIT$" "$doc/copyright" || fail "copyright does not declare the MIT license"
pass "payload layout, license, and documentation"

listing="$(dpkg-deb -c "$deb")"
bad_owner="$(printf '%s\n' "$listing" | grep -v ' root/root ' || true)"
if [ -n "$bad_owner" ]; then
  printf '%s\n' "$bad_owner" >&2
  fail "payload contains entries not owned by root/root"
fi
bad_setuid="$(printf '%s\n' "$listing" | awk '$1 ~ /[sS]/ { print }')"
if [ -n "$bad_setuid" ]; then
  printf '%s\n' "$bad_setuid" >&2
  fail "payload contains setuid or setgid entries"
fi
bad_mode="$(printf '%s\n' "$listing" | awk '
  $1 ~ /^d/ && $1 != "drwxr-xr-x" { print }
  $1 ~ /^-/ && $1 != "-rw-r--r--" && $1 != "-rwxr-xr-x" { print }
')"
if [ -n "$bad_mode" ]; then
  printf '%s\n' "$bad_mode" >&2
  fail "payload contains an unexpected file mode"
fi
pass "ownership (root/root) and modes (0755 directories, 0644 files, 0755 postinst)"

PLUGIN_NAME="$PLUGIN_NAME" PLUGIN_VERSION="$PLUGIN_VERSION" "$NODE" - "$pkg" <<'EOF' || fail "package.json does not describe a loadable bundle"
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[2]
const fail = message => { console.error(`package.json: ${message}`); process.exit(1) }
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
if (pkg.name !== process.env.PLUGIN_NAME) fail(`name is ${pkg.name}, expected ${process.env.PLUGIN_NAME}`)
if (pkg.version !== process.env.PLUGIN_VERSION) fail(`version is ${pkg.version}, expected ${process.env.PLUGIN_VERSION}`)
if (pkg.main !== 'lib/index.js') fail(`main is ${pkg.main}`)
if (pkg.exports?.['.']?.default !== './lib/index.js') fail('exports["."].default does not point at lib/index.js')
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch does not point at cordis.patch.yml')
if (pkg.exports?.['./client'] !== './lib/client.js') fail('exports["./client"] does not point at lib/client.js')
if (pkg.dsh?.client?.platform !== 'web') fail('dsh.client.platform is not web')
if (!Array.isArray(pkg.dsh?.client?.inject)) fail('dsh.client.inject is not a list')
if (pkg.dependencies !== undefined && Object.keys(pkg.dependencies).length > 0) fail('runtime dependencies are not expected')
if (pkg.license !== 'MIT') fail(`license is ${pkg.license}, expected MIT`)
for (const file of ['lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'cordis.patch.yml', 'LICENSE', 'locale/en.json', 'locale/zh.json', 'icon.svg']) {
  if (!fs.existsSync(path.join(dir, file))) fail(`missing ${file}`)
}
EOF
pass "package.json identity, entry points, client manifest, and bundle patch"

"$NODE" - "$pkg" <<'EOF' || fail "a locale meta.detail path is missing from the package root"
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[2]
for (const name of ['en.json', 'zh.json']) {
  const locale = JSON.parse(fs.readFileSync(path.join(dir, 'locale', name), 'utf8'))
  const detail = locale.meta?.detail
  if (typeof detail !== 'string' || detail.length === 0) {
    console.error(`locale/${name}: meta.detail is missing`)
    process.exit(1)
  }
  if (!fs.existsSync(path.join(dir, detail))) {
    console.error(`locale/${name}: meta.detail does not exist: ${detail}`)
    process.exit(1)
  }
}
EOF
pass "locale meta.detail files exist in the package root"

grep -Eq "id:[[:space:]]*memory" "$pkg/cordis.patch.yml" \
  || fail "cordis.patch.yml does not insert the memory row"
grep -Eq "name:[[:space:]]*'?$PLUGIN_NAME'?" "$pkg/cordis.patch.yml" \
  || fail "cordis.patch.yml does not name $PLUGIN_NAME"
pass "bundle patch inserts the memory row for $PLUGIN_NAME"

if grep -rE "from ['\"]@deepseek-ai|require\(['\"]@deepseek-ai" "$pkg/lib" --include='*.js' >/dev/null; then
  fail "compiled output imports a @deepseek-ai package at runtime"
fi
if grep -rIl -F "$ROOT" "$pkg" >/dev/null 2>&1; then
  fail "payload embeds the build directory path ($ROOT)"
fi
pass "no Host runtime imports and no build-path leakage"

"$NODE" --input-type=module -e '
  import { pathToFileURL } from "node:url"
  const entry = process.argv[1]
  const mod = await import(pathToFileURL(entry).href)
  if (mod.name !== "memory") throw new Error(`name is ${String(mod.name)}`)
  if (typeof mod.apply !== "function") throw new Error("apply is not exported")
  if (!Array.isArray(mod.inject) || !mod.inject.includes("tools") || !mod.inject.includes("workingDirectory")) {
    throw new Error(`unexpected inject: ${JSON.stringify(mod.inject)}`)
  }
' "$pkg/lib/index.js" || fail "the compiled entry does not load"
pass "compiled entry loads and exports name/apply/inject"

grep -q "window.__ModuleLoader__.load" "$pkg/lib/client.js" \
  || fail "lib/client.js does not register a module-loader factory"
grep -q "@local/dsh-memory" "$pkg/lib/client.js" \
  || fail "lib/client.js does not register the package module"
grep -q "data-memory-row" "$pkg/lib/client.js" \
  || fail "lib/client.js does not register the memory Chat row"
pass "client bundle registers the package module and the memory row"

dpkg-deb --control "$deb" "$BUILD/verify/control"
sh -n "$BUILD/verify/control/postinst" || fail "postinst has a syntax error"
pass "maintainer-script syntax"

# Compose a throwaway profile that links the extracted package root exactly the
# way `dsh plugin add <path>` would, and let the Harness resolve the bundle.
if command -v dsh >/dev/null 2>&1 && dsh --version >/dev/null 2>&1; then
  home="$BUILD/verify/dsh-home"
  profile="$home/profiles/verify"
  install -d "$profile/node_modules/@local"
  ln -sfn "$pkg" "$profile/node_modules/@local/dsh-memory"
  cat > "$profile/package.json" <<EOF
{
  "name": "dsh-profile-verify",
  "private": true,
  "dependencies": {
    "$PLUGIN_NAME": "link:$pkg"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "$PLUGIN_NAME"]
    }
  }
}
EOF
  if ! DSH_HOME="$home" dsh --profile verify --dump-config \
      > "$BUILD/verify/dump-config.yml" 2> "$BUILD/verify/dump-config.err"; then
    cat "$BUILD/verify/dump-config.err" >&2
    fail "dsh could not compose a profile with the packaged plugin"
  fi
  if grep -q "skipping profile bundle" "$BUILD/verify/dump-config.err"; then
    cat "$BUILD/verify/dump-config.err" >&2
    fail "dsh skipped the packaged plugin"
  fi
  grep -q "id: memory" "$BUILD/verify/dump-config.yml" \
    || fail "the composed profile does not contain the memory row"
  grep -Fq "name: '$PLUGIN_NAME'" "$BUILD/verify/dump-config.yml" \
    || fail "the composed profile does not name $PLUGIN_NAME"
  pass "dsh composes the packaged plugin into a web profile"
else
  step "skipping the dsh composition check (dsh is not on PATH)"
fi

log "${C_GREEN}all checks passed${C_RESET} ($check structural checks)"
