# Build the dsh-memory Debian package from this repository.
#
#   make            build -> test -> stage -> package -> verify
#   make deb        same as the default target
#   make build      npm ci and bundle into lib/ (SKIP_INSTALL=1 reuses node_modules)
#   make test       typecheck and run the unit tests after the build
#   make stage      assemble build/rootfs from the compiled package
#   make package    write dist/dsh-memory_<version>-<rev>_all.deb
#   make verify     structural checks and the module/composition smoke test
#   make clean      remove build/ and the built .deb (keeps the generated lib/)
#
# Overrides for a one-off build:
#   make DEB_REVISION=alex1 deb
#   make DEB_ARCH=amd64 deb      # force a per-architecture build
#
# Everything runs as the invoking user. dpkg-deb --root-owner-group records
# root:root ownership, so fakeroot or sudo is not needed.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

ROOT := $(CURDIR)

# release.conf holds shell defaults. Read them through the shell (rather than
# `include`) so `:=` lets an environment value or a command-line override win.
DEB_PACKAGE ?= $(shell . ./release.conf; printf '%s' "$$DEB_PACKAGE")
DEB_REVISION ?= $(shell . ./release.conf; printf '%s' "$$DEB_REVISION")
DEB_ARCH ?= $(shell . ./release.conf; printf '%s' "$$DEB_ARCH")
DEB_MAINTAINER ?= $(shell . ./release.conf; printf '%s' "$$DEB_MAINTAINER")
DSH_PACKAGE ?= $(shell . ./release.conf; printf '%s' "$$DSH_PACKAGE")
DSH_MIN_VERSION ?= $(shell . ./release.conf; printf '%s' "$$DSH_MIN_VERSION")
PLUGIN_NAME ?= $(shell . ./release.conf; printf '%s' "$$PLUGIN_NAME")
PLUGIN_INSTALL_DIR ?= $(shell . ./release.conf; printf '%s' "$$PLUGIN_INSTALL_DIR")
NODE_MIN ?= $(shell . ./release.conf; printf '%s' "$$NODE_MIN")

export ROOT DEB_PACKAGE DEB_REVISION DEB_ARCH DEB_MAINTAINER
export DSH_PACKAGE DSH_MIN_VERSION PLUGIN_NAME PLUGIN_INSTALL_DIR NODE_MIN

.DEFAULT_GOAL := deb

.PHONY: all deb build test stage package verify check clean print-config

all: deb

build:
	scripts/build-plugin.sh

test: build
	scripts/test-plugin.sh

stage: build
	scripts/stage-rootfs.sh

package: stage
	scripts/package.sh

verify check: package
	scripts/verify-deb.sh

deb: test verify
	@printf '\nDebian package: %s\n' "$$(cat $(ROOT)/dist/latest.txt)"

print-config:
	@printf 'package:   %s %s-%s (%s)\n' "$(DEB_PACKAGE)" "$$(node -p "require('$(ROOT)/package.json').version")" "$(DEB_REVISION)" "$(DEB_ARCH)"
	@printf 'installs:  %s\n' "$(PLUGIN_INSTALL_DIR)"
	@printf 'depends:   %s (>= %s)\n' "$(DSH_PACKAGE)" "$(DSH_MIN_VERSION)"
	@printf 'node:      >= %s (build/tests)\n' "$(NODE_MIN)"

clean:
	rm -rf "$(ROOT)/build"
	rm -f "$(ROOT)"/dist/*.deb "$(ROOT)"/dist/*.sha256 "$(ROOT)/dist/latest.txt"
