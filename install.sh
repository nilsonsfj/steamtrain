#!/bin/sh
#
# steamtrain — one-line installer.
#
#   curl -fsSL https://steamtrain.app/install.sh | sh                   # the CLI
#   curl -fsSL https://steamtrain.app/install.sh | sh -s -- --desktop   # the macOS app
#
# Clones (or updates) steamtrain into a per-user directory, builds it, and links
# a `steamtrain` command into a bin directory on your PATH. No sudo, and nothing
# outside your home directory is touched.
#
# This is an ALPHA install: steamtrain runs from the checkout this script links
# back to, so that checkout is kept around. Re-run the same line to update.
#
# --desktop is a different install entirely: it downloads the packaged macOS app
# from the latest GitHub release into /Applications. Nothing is cloned, nothing
# is built, and no toolchain is needed. The app is unsigned — that route exists
# because a file fetched by curl carries no quarantine attribute, so it opens
# normally, while the same app downloaded in a browser does not.
#
# Options (pass them through the pipe with `| sh -s -- <options>`):
#   --desktop                download the packaged macOS app (no build)
#   --desktop-url <url>      install that .zip instead of the latest release
#   --app-dir <dir>          where to put the app               (default /Applications)
#                            (the last two imply --desktop)
#   --ref <ref>              git ref to install                 (default main)
#   --src-dir <dir>          where to keep the checkout         (default ~/.steamtrain/src)
#   --bin-dir <dir>          where to link the command          (default ~/.local/bin)
#   --repo <url>             git remote to clone                (default the GitHub repo)
#   --from-checkout [dir]    install from an existing checkout instead of cloning
#   --no-build               skip dependency install + build    (link only)
#   --force                  replace a non-steamtrain file sitting at the link path
#   -h, --help               print this help
#
# Every option also has an environment variable: STEAMTRAIN_REF,
# STEAMTRAIN_SRC_DIR, STEAMTRAIN_BIN_DIR, STEAMTRAIN_REPO, STEAMTRAIN_FORCE,
# STEAMTRAIN_APP_DIR, STEAMTRAIN_DESKTOP_URL.
#
# Uninstall: remove the link and the checkout. Your config in ~/.steamtrain
# (minus src/) and any .steamtrain/ run state in your projects stay put.
# The app is just a bundle — drag /Applications/steamtrain.app to the trash.
#
set -eu

REPO="${STEAMTRAIN_REPO:-https://github.com/nilsonsfj/steamtrain.git}"
REF="${STEAMTRAIN_REF:-main}"
# Both defaults live under HOME, but --src-dir/--bin-dir can replace them —
# so these stay empty until the options have been parsed, and a missing HOME is
# only fatal for a default this run actually needs.
HOME_DIR="${HOME:-}"
SRC_DIR="${STEAMTRAIN_SRC_DIR:-}"
BIN_DIR="${STEAMTRAIN_BIN_DIR:-}"
FORCE="${STEAMTRAIN_FORCE:-0}"
BIN_NAME="steamtrain"
DO_BUILD=1
FROM_CHECKOUT=""
DO_DESKTOP=0
APP_DIR="${STEAMTRAIN_APP_DIR:-}"
DESKTOP_URL="${STEAMTRAIN_DESKTOP_URL:-}"
# The releases page is the source of the packaged app. Kept separate from $REPO
# because that one is a git remote and this one is an API path.
RELEASE_SLUG="${STEAMTRAIN_RELEASE_SLUG:-nilsonsfj/steamtrain}"

# --- output -------------------------------------------------------------------
# Colors only when stdout is a terminal: piped installs land in logs just as
# often as they land in a shell.
if [ -t 1 ]; then
  C_INFO='\033[1;36m'; C_WARN='\033[1;33m'; C_ERR='\033[1;31m'; C_OK='\033[1;32m'; C_OFF='\033[0m'
else
  C_INFO=''; C_WARN=''; C_ERR=''; C_OK=''; C_OFF=''
fi

info() { printf "${C_INFO}›${C_OFF} %s\n" "$1"; }
ok()   { printf "${C_OK}✓${C_OFF} %s\n" "$1"; }
warn() { printf "${C_WARN}!${C_OFF} %s\n" "$1" >&2; }
die()  { printf "${C_ERR}✗${C_OFF} %s\n" "$1" >&2; exit 1; }
hint() { printf '  %s\n' "$1" >&2; }

usage() {
  # The comment block at the top of this file is the help text — except when
  # this script is piped from curl and $0 is not a readable file.
  if [ -n "${0:-}" ] && [ -f "${0:-}" ]; then
    sed -n '3,41p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'
  else
    printf '%s\n' "steamtrain installer — https://steamtrain.app/install.sh"
    printf '%s\n' "options: --desktop --desktop-url --app-dir --ref --repo --src-dir --bin-dir"
    printf '%s\n' "         --from-checkout --no-build --force"
  fi
}

# --- arguments ----------------------------------------------------------------
need_value() {
  [ -n "${2:-}" ] || die "option ${1} needs a value."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref)   need_value "$1" "${2:-}"; REF="$2"; shift 2 ;;
    --repo)  need_value "$1" "${2:-}"; REPO="$2"; shift 2 ;;
    --src-dir) need_value "$1" "${2:-}"; SRC_DIR="$2"; shift 2 ;;
    --bin-dir) need_value "$1" "${2:-}"; BIN_DIR="$2"; shift 2 ;;
    --from-checkout)
      # The directory is optional: bare --from-checkout means "the checkout this
      # script lives in".
      case "${2:-}" in
        ''|-*) FROM_CHECKOUT="auto"; shift ;;
        *)     FROM_CHECKOUT="$2"; shift 2 ;;
      esac
      ;;
    --desktop)  DO_DESKTOP=1; shift ;;
    # Both of these imply --desktop. They mean nothing to the CLI install, so
    # the alternative is accepting them and silently ignoring them — which is
    # how `--app-dir /opt` would quietly link a command instead.
    --desktop-url) need_value "$1" "${2:-}"; DESKTOP_URL="$2"; DO_DESKTOP=1; shift 2 ;;
    --app-dir)  need_value "$1" "${2:-}"; APP_DIR="$2"; DO_DESKTOP=1; shift 2 ;;
    --no-build) DO_BUILD=0; shift ;;
    --force)    FORCE=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) die "unknown option: $1  (try --help)" ;;
  esac
done

# --- environment --------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

case "$(uname -s 2>/dev/null || echo unknown)" in
  Darwin|Linux) ;;
  MINGW*|MSYS*|CYGWIN*)
    die "Windows shells are not supported. Install steamtrain from inside WSL." ;;
  *)
    warn "untested platform: $(uname -s). Continuing anyway." ;;
esac

# --- the desktop app ----------------------------------------------------------
# A wholly separate install from everything below: download a packaged bundle,
# put it in /Applications, done. It shares only this file's option parsing and
# output helpers, and it returns by exiting.
RELEASES_PAGE="https://github.com/${RELEASE_SLUG}/releases"

# The newest release asset whose name ends in `-<arch>.zip`.
#
# Deliberately the releases *list* and not `releases/latest`: alpha tags publish
# as prereleases, and the `latest` endpoint skips those. The list comes back
# newest-first, so the first match is the current one. Unauthenticated calls are
# rate limited to 60/hour per IP; --desktop-url is the way past that.
latest_desktop_url() {
  arch="$1"
  curl -fsSL -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/${RELEASE_SLUG}/releases?per_page=10" 2>/dev/null \
    | tr ',' '\n' \
    | sed -n 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | grep -- "-${arch}\.zip$" \
    | head -n 1
}

install_desktop() {
  if [ "$(uname -s)" != "Darwin" ]; then
    printf "${C_ERR}✗${C_OFF} %s\n" "--desktop installs the macOS app; this is $(uname -s)." >&2
    hint "Linux builds ship as .AppImage and .deb:  ${RELEASES_PAGE}"
    exit 1
  fi

  have curl || die "curl is required to download the app."
  # Part of macOS since forever, but it is what preserves the bundle's symlinks
  # and permission bits, and unzip(1) does not — so it is a hard requirement
  # rather than something to silently fall back from.
  have ditto || die "'ditto' is required to unpack the app bundle."

  case "$(uname -m)" in
    arm64)  arch="arm64" ;;
    x86_64) arch="x64" ;;
    *)      die "unsupported architecture: $(uname -m)  (pass --desktop-url <url>)" ;;
  esac

  if [ -z "$APP_DIR" ]; then
    APP_DIR="/Applications"
    # An unwritable /Applications is a managed or multi-user Mac, not a broken
    # one. ~/Applications is a real macOS location and needs no sudo, so prefer
    # it over asking for a password.
    if [ ! -w "$APP_DIR" ]; then
      [ -n "$HOME_DIR" ] || die "/Applications is not writable and HOME is not set — pass --app-dir <dir>."
      APP_DIR="${HOME_DIR}/Applications"
      warn "/Applications is not writable — installing to ${APP_DIR} instead."
    fi
  fi
  mkdir -p "$APP_DIR" || die "could not create ${APP_DIR}"
  [ -w "$APP_DIR" ] || die "not writable: ${APP_DIR}  (pass --app-dir <dir>)"

  if [ -z "$DESKTOP_URL" ]; then
    info "Looking up the latest ${arch} build…"
    DESKTOP_URL="$(latest_desktop_url "$arch")" || true
    if [ -z "$DESKTOP_URL" ]; then
      printf "${C_ERR}✗${C_OFF} %s\n" "no ${arch} app build found in the latest releases." >&2
      hint "check ${RELEASES_PAGE}, or pass --desktop-url <url>."
      exit 1
    fi
  fi

  tmp="$(mktemp -d 2>/dev/null)" || die "could not create a temporary directory."
  trap 'rm -rf "$tmp"' EXIT INT TERM

  info "Downloading $(basename "$DESKTOP_URL")…"
  curl -fL --progress-bar -o "${tmp}/app.zip" "$DESKTOP_URL" \
    || die "download failed: ${DESKTOP_URL}"

  mkdir "${tmp}/x"
  ditto -x -k "${tmp}/app.zip" "${tmp}/x" || die "could not unpack the download."

  app="$(find "${tmp}/x" -maxdepth 2 -name '*.app' -print 2>/dev/null | head -n 1)"
  [ -n "$app" ] || die "no .app bundle inside ${DESKTOP_URL}"
  app_name="$(basename "$app")"
  dest="${APP_DIR}/${app_name}"

  # Replacing an app bundle means deleting a directory, so be sure it is one:
  # anything at that path that is not itself a bundle is somebody else's file.
  if [ -e "$dest" ]; then
    if [ -f "${dest}/Contents/Info.plist" ]; then
      info "Replacing the existing ${dest}…"
      rm -rf "$dest" || die "could not remove the existing ${dest}"
    elif [ "$FORCE" = "1" ]; then
      warn "${dest} is not an app bundle — removing it anyway (--force)."
      rm -rf "$dest" || die "could not remove ${dest}"
    else
      printf "${C_ERR}✗${C_OFF} %s\n" "${dest} exists and is not an app bundle." >&2
      hint "move it aside, re-run with --force, or pass --app-dir <dir>."
      exit 1
    fi
  fi

  ditto "$app" "$dest" || die "could not install into ${dest}"

  # Apple Silicon refuses to execute a binary with no signature at all, even one
  # that arrived without a quarantine flag — so the builds are ad-hoc signed
  # (see the `identity` note in electron-builder.yml). A release that fails this
  # is a broken release, and saying so here beats letting someone double-click a
  # bundle that dies with no explanation.
  if [ "$arch" = "arm64" ] && have codesign; then
    codesign --verify "$dest" >/dev/null 2>&1 \
      || warn "the installed app's signature is not valid — it may not launch. Please report this."
  fi

  version=""
  if have defaults; then
    version="$(defaults read "${dest}/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || true)"
  fi
  if [ -n "$version" ]; then
    ok "Installed ${app_name} ${version} to ${APP_DIR}"
  else
    ok "Installed ${app_name} to ${APP_DIR}"
  fi

  printf '\n'
  printf '  %s\n' "Open it:    open \"${dest}\""
  printf '  %s\n' "Update:     curl -fsSL https://steamtrain.app/install.sh | sh -s -- --desktop"
  printf '  %s\n' "Uninstall:  rm -rf \"${dest}\""
  printf '\n'
  # Said plainly rather than buried, because it is the one thing that surprises
  # people later: this build is unsigned, and it opens only because curl does
  # not set com.apple.quarantine. Re-downloading the dmg by hand behaves
  # differently, and that is not a bug in the app.
  printf '  %s\n' "Note: this alpha is not notarized by Apple. It opens because the installer"
  printf '  %s\n' "fetched it with curl. The same app downloaded through a browser is"
  printf '  %s\n' "quarantined, and needs System Settings → Privacy & Security → Open Anyway."

  exit 0
}

if [ "$DO_DESKTOP" -eq 1 ]; then
  install_desktop
fi

# --- defaults that depend on HOME ---------------------------------------------
if [ -z "$BIN_DIR" ]; then
  [ -n "$HOME_DIR" ] || die "HOME is not set — pass --bin-dir <dir>."
  BIN_DIR="${HOME_DIR}/.local/bin"
fi
if [ -z "$SRC_DIR" ] && [ -z "$FROM_CHECKOUT" ]; then
  [ -n "$HOME_DIR" ] || die "HOME is not set — pass --src-dir <dir>."
  SRC_DIR="${HOME_DIR}/.steamtrain/src"
fi

# First run of digits in a version string: "git version 2.39.5" -> 2
major_of() {
  printf '%s' "$1" | head -n1 | sed -e 's/^[^0-9]*//' -e 's/[^0-9].*$//'
}

require_major() {
  exe="$1"; minimum="$2"; purpose="$3"; install_hint="${4:-}"

  if ! have "$exe"; then
    printf "${C_ERR}✗${C_OFF} %s\n" "'${exe}' (>=${minimum}) is required ${purpose} but was not found." >&2
    if [ -n "$install_hint" ]; then hint "$install_hint"; fi
    exit 1
  fi

  raw="$("$exe" --version 2>/dev/null)" || die "could not determine the '${exe}' version."
  got="$(major_of "$raw")"
  case "$got" in
    ''|*[!0-9]*) die "could not parse a version for '${exe}' out of: ${raw}" ;;
  esac

  if [ "$got" -lt "$minimum" ]; then
    printf "${C_ERR}✗${C_OFF} %s\n" "'${exe}' >=${minimum} is required ${purpose}; found ${raw}." >&2
    if [ -n "$install_hint" ]; then hint "$install_hint"; fi
    exit 1
  fi
}

require_major node 20 "to run steamtrain" "install Node.js 20+:  https://nodejs.org"
if [ "$DO_BUILD" -eq 1 ]; then
  require_major bun 1 "to build steamtrain" "install bun:  curl -fsSL https://bun.sh/install | bash"
fi

# --- resolve the source checkout ----------------------------------------------
# Either an existing checkout (the `npm run install:local` path) or a clone we
# manage under SRC_DIR (the curl | sh path).
if [ "$FROM_CHECKOUT" = "auto" ]; then
  script_dir=""
  case "${0:-}" in
    ''|sh|-sh|bash|-bash|/dev/*) ;;
    *) [ -f "$0" ] && script_dir="$(cd "$(dirname "$0")" && pwd)" ;;
  esac
  [ -n "$script_dir" ] || die "--from-checkout could not locate this script; pass the directory explicitly."
  FROM_CHECKOUT="$script_dir"
fi

if [ -n "$FROM_CHECKOUT" ]; then
  [ -d "$FROM_CHECKOUT" ] || die "not a directory: ${FROM_CHECKOUT}"
  SRC_DIR="$(cd "$FROM_CHECKOUT" && pwd)"
  [ -f "${SRC_DIR}/package.json" ] || die "${SRC_DIR} does not look like a steamtrain checkout (no package.json)."
  info "Installing from the checkout at ${SRC_DIR}"
else
  require_major git 2 "to fetch steamtrain" "install git:  https://git-scm.com/downloads"

  if [ -d "${SRC_DIR}/.git" ]; then
    # `-uno`: the previous run's own build output (dist/, node_modules/) is
    # untracked here, and a stray file is no reason to refuse an update. Only
    # edits to tracked files would be lost by the checkout below.
    if [ -n "$(git -C "$SRC_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
      printf "${C_ERR}✗${C_OFF} %s\n" "the checkout at ${SRC_DIR} has local changes." >&2
      hint "commit or discard them, or install elsewhere with --src-dir <dir>."
      exit 1
    fi
    info "Updating the checkout in ${SRC_DIR} (${REF})…"
    git -C "$SRC_DIR" fetch --quiet --depth 1 origin "$REF" \
      || die "could not fetch '${REF}' from origin in ${SRC_DIR}."
    git -C "$SRC_DIR" checkout --quiet --detach FETCH_HEAD
  else
    [ ! -e "$SRC_DIR" ] \
      || die "${SRC_DIR} exists but is not a git checkout — move it aside, or pass --src-dir <dir>."
    info "Cloning ${REPO} (${REF}) into ${SRC_DIR}…"
    mkdir -p "$(dirname "$SRC_DIR")"
    # A failed clone leaves a half-populated directory behind, and the next run
    # would then refuse it as "not a git checkout". Clean it up here instead.
    if ! git clone --quiet --depth 1 --branch "$REF" "$REPO" "$SRC_DIR"; then
      rm -rf "$SRC_DIR"
      die "could not clone ${REPO} at ref '${REF}'."
    fi
  fi
fi

# --- build --------------------------------------------------------------------
if [ "$DO_BUILD" -eq 1 ]; then
  info "Installing dependencies with bun…"
  # The build needs devDependencies (tsup, esbuild, typescript), which drags in
  # electron — and electron's postinstall downloads a ~100 MB platform binary
  # this CLI install has no use for. Skip that download unless the caller wants
  # it (building the desktop shell does).
  (
    cd "$SRC_DIR"
    ELECTRON_SKIP_BINARY_DOWNLOAD="${ELECTRON_SKIP_BINARY_DOWNLOAD:-1}"
    export ELECTRON_SKIP_BINARY_DOWNLOAD
    bun install
  ) || die "'bun install' failed in ${SRC_DIR}."

  info "Building steamtrain…"
  (cd "$SRC_DIR" && bun run build) || die "'bun run build' failed in ${SRC_DIR}."
fi

TARGET="${SRC_DIR}/dist/index.js"
if [ ! -f "$TARGET" ]; then
  printf "${C_ERR}✗${C_OFF} %s\n" "build output not found at ${TARGET}." >&2
  hint "run again without --no-build, or run 'bun run build' in ${SRC_DIR} first."
  exit 1
fi
chmod +x "$TARGET"

# --- link ---------------------------------------------------------------------
mkdir -p "$BIN_DIR" || die "could not create the install directory: ${BIN_DIR}"
[ -w "$BIN_DIR" ] || die "install directory is not writable: ${BIN_DIR}  (pass --bin-dir <dir>)"

LINK="${BIN_DIR}/${BIN_NAME}"
if [ -e "$LINK" ] && [ ! -L "$LINK" ] && [ "$FORCE" != "1" ]; then
  printf "${C_ERR}✗${C_OFF} %s\n" "${LINK} already exists and is not a symlink this installer made." >&2
  hint "remove it yourself, re-run with --force, or pass --bin-dir <dir>."
  exit 1
fi
rm -f "$LINK"
# Node resolves modules from a symlink's real path, so the checkout's own
# node_modules is used even though the command lives in a bin dir.
ln -s "$TARGET" "$LINK"
ok "Linked ${LINK} → ${TARGET}"

VERSION="$(node "$TARGET" --version 2>/dev/null)" || die "the built binary at ${TARGET} did not run."
ok "Installed ${VERSION}"

# --- PATH guidance ------------------------------------------------------------
case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    ok "Run it:  ${BIN_NAME}"
    ;;
  *)
    warn "${BIN_DIR} is not on your PATH yet."
    # SHELL is unset in plenty of places this installer legitimately runs —
    # CI, cron, a bare Docker layer — and `set -u` would abort on the bare
    # expansion, after the install has already succeeded.
    shell_path="${SHELL:-}"
    shell_name="${shell_path##*/}"
    case "$shell_name" in
      zsh)  rc="~/.zshrc" ;;
      bash) rc="~/.bashrc" ;;
      fish) rc="~/.config/fish/config.fish" ;;
      *)    rc="your shell profile" ;;
    esac
    printf '  %s\n' "Add it, then restart your shell:"
    if [ "$shell_name" = "fish" ]; then
      printf '    %s\n' "fish_add_path ${BIN_DIR}"
    else
      printf '    %s\n' "echo 'export PATH=\"${BIN_DIR}:\$PATH\"' >> ${rc}"
    fi
    printf '  %s\n' "Or run it directly:  ${LINK}"
    ;;
esac

if [ -z "$FROM_CHECKOUT" ]; then
  printf '\n'
  printf '  %s\n' "Update:     curl -fsSL https://steamtrain.app/install.sh | sh"
  printf '  %s\n' "Uninstall:  rm -f ${LINK} && rm -rf ${SRC_DIR}"
fi
