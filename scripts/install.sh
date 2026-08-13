#!/usr/bin/env bash
#
# steamtrain — install this checkout as a system binary (alpha / dev install).
#
# Thin wrapper over the repo's top-level `install.sh`, pinned to this checkout:
# it builds here and links the `steamtrain` command into a directory on your
# PATH, instead of cloning a fresh copy the way the curl one-liner does.
#
# Usage:
#   scripts/install.sh                 # build + link into ~/.local/bin
#   STEAMTRAIN_BIN_DIR=/usr/local/bin scripts/install.sh   # custom target
#   scripts/install.sh --no-build      # link only (assumes dist/ is built)
#
# Every option the top-level installer takes works here too; see
# `./install.sh --help`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

exec sh "${REPO_ROOT}/install.sh" --from-checkout "${REPO_ROOT}" "$@"
