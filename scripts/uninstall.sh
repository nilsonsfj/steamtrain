#!/usr/bin/env bash
#
# steamtrain — remove the linked system binary installed by scripts/install.sh.
#
# Usage:
#   scripts/uninstall.sh
#   STEAMTRAIN_BIN_DIR=/usr/local/bin scripts/uninstall.sh
#
# Removes the `steamtrain` launcher only; it does not touch this checkout,
# your config in ~/.steamtrain, or any project data.
set -euo pipefail

BIN_NAME="steamtrain"

if [ -n "${STEAMTRAIN_BIN_DIR:-}" ]; then
  BIN_DIR="$STEAMTRAIN_BIN_DIR"
else
  BIN_DIR="${HOME}/.local/bin"
fi

LINK="${BIN_DIR}/${BIN_NAME}"

if [ -e "$LINK" ] || [ -L "$LINK" ]; then
  rm -f "$LINK"
  printf '\033[1;32m✓\033[0m Removed %s\n' "$LINK"
else
  # Fall back to whatever is on PATH so we can tell the user where it lives.
  found="$(command -v "$BIN_NAME" 2>/dev/null || true)"
  if [ -n "$found" ]; then
    printf '\033[1;33m!\033[0m No link at %s, but a %s exists at %s\n' "$LINK" "$BIN_NAME" "$found" >&2
    printf '  Set STEAMTRAIN_BIN_DIR to its directory and re-run, or remove it manually.\n' >&2
    exit 1
  fi
  printf '\033[1;33m!\033[0m Nothing to remove: no %s found at %s\n' "$BIN_NAME" "$LINK"
fi
