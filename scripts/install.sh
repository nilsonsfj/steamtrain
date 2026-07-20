#!/usr/bin/env bash
#
# steamtrain — install as a system binary (alpha / dev install).
#
# Builds steamtrain from this checkout and links the `steamtrain` command into a
# directory on your PATH, so you can run it from anywhere. Works on macOS and
# Linux, no sudo required (installs into a per-user bin directory by default).
#
# Usage:
#   scripts/install.sh                 # build + link into ~/.local/bin
#   STEAMTRAIN_BIN_DIR=/usr/local/bin scripts/install.sh   # custom target
#   scripts/install.sh --no-build      # link only (assumes dist/ is built)
#
# This is an ALPHA developer install: it links back to `dist/index.js` in this
# checkout (runtime deps stay in this repo's node_modules), so keep the repo
# where it is. Re-run after `git pull` — a rebuild refreshes the linked binary.
set -euo pipefail

BIN_NAME="steamtrain"

# --- locate the repo root (this script lives in <repo>/scripts) ---------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

info()  { printf '\033[1;36m›\033[0m %s\n' "$1"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$1" >&2; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$1"; }

# --- verify the required toolchain -------------------------------------------
require_major() {
  local executable="$1"
  local minimum="$2"
  local purpose="$3"
  local install_hint="${4:-}"
  if ! command -v "$executable" >/dev/null 2>&1; then
    echo "error: '${executable}' (>=${minimum}) is required ${purpose} but was not found." >&2
    if [ -n "$install_hint" ]; then echo "  ${install_hint}" >&2; fi
    exit 1
  fi

  local raw_version
  if ! raw_version="$("$executable" --version 2>/dev/null)"; then
    echo "error: could not determine '${executable}' version." >&2
    exit 1
  fi
  local version="${raw_version#v}"
  local major="${version%%.*}"
  if [[ ! "$major" =~ ^[0-9]+$ ]] || (( major < minimum )); then
    echo "error: '${executable}' >=${minimum} is required ${purpose}; found ${raw_version}." >&2
    if [ -n "$install_hint" ]; then echo "  ${install_hint}" >&2; fi
    exit 1
  fi
}

require_major node 20 "to run steamtrain"
if [ "$DO_BUILD" -eq 1 ]; then
  require_major bun 1 "to build steamtrain" "install bun:  https://bun.sh"
fi

# --- build --------------------------------------------------------------------
if [ "$DO_BUILD" -eq 1 ]; then
  info "Installing dependencies with bun…"
  (cd "$REPO_ROOT" && bun install)

  info "Building steamtrain…"
  (cd "$REPO_ROOT" && bun run build)
fi

TARGET="${REPO_ROOT}/dist/index.js"
if [ ! -f "$TARGET" ]; then
  echo "error: build output not found at ${TARGET}." >&2
  echo "  run without --no-build, or run 'bun run build' first." >&2
  exit 1
fi
chmod +x "$TARGET"

# --- choose an install directory ----------------------------------------------
# Honor an explicit override; otherwise prefer a per-user bin dir (no sudo).
if [ -n "${STEAMTRAIN_BIN_DIR:-}" ]; then
  BIN_DIR="$STEAMTRAIN_BIN_DIR"
else
  BIN_DIR="${HOME}/.local/bin"
fi
mkdir -p "$BIN_DIR"

if [ ! -w "$BIN_DIR" ]; then
  echo "error: install directory is not writable: ${BIN_DIR}" >&2
  echo "  choose another with STEAMTRAIN_BIN_DIR=…, or fix permissions." >&2
  exit 1
fi

LINK="${BIN_DIR}/${BIN_NAME}"

# --- link (Node resolves modules from the symlink's real path, so the repo's
#     node_modules is used even though we link into a bin dir) -----------------
if [ -e "$LINK" ] || [ -L "$LINK" ]; then
  rm -f "$LINK"
fi
ln -s "$TARGET" "$LINK"
ok "Linked ${LINK} → ${TARGET}"

VERSION="$(node "$TARGET" --version 2>/dev/null || echo "steamtrain")"
ok "Installed ${VERSION}"

# --- PATH guidance ------------------------------------------------------------
case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    ok "Run it:  ${BIN_NAME}"
    ;;
  *)
    warn "${BIN_DIR} is not on your PATH yet."
    case "${SHELL##*/}" in
      zsh)  rc="~/.zshrc" ;;
      bash) rc="~/.bashrc" ;;
      fish) rc="~/.config/fish/config.fish" ;;
      *)    rc="your shell profile" ;;
    esac
    echo "  Add it, then restart your shell:"
    if [ "${SHELL##*/}" = "fish" ]; then
      echo "    fish_add_path ${BIN_DIR}"
    else
      echo "    echo 'export PATH=\"${BIN_DIR}:\$PATH\"' >> ${rc}"
    fi
    echo "  Or run it directly:  ${LINK}"
    ;;
esac
