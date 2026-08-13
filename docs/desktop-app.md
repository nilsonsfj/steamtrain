# The steamtrain desktop app

An Electron shell around the [web UI](web-ui.md). Same engine, same cockpit — it
just removes the terminal from the path to it: open the app, pick a project
folder, watch the pipeline.

This is **M3: it ships**. One window at a time, but it remembers your projects
and your window, tells you when a run finishes, asks before walking away from
work in progress — and builds into an installer you can hand to someone.

```bash
npm run dev:electron        # builds the CLI + shell, then launches Electron
npm run package:desktop     # builds a real installer into release/
```

`dev:electron` runs `npm run build` first because the app runs the *built* CLI
(`dist/index.js`), not the TypeScript sources.

One thing a dev launch cannot fix: on macOS the **menu bar title still reads
"Electron"**. That name comes from the bundle being run, and a dev launch borrows
Electron's own. Everything the app can name for itself — the dock, its
notifications, the directory it keeps state in — is set from `app.setName`, and a
packaged build gets the menu bar too.

## Installing a build

`npm run package:desktop` produces, in `release/`:

| Platform | Artifact |
|----------|----------|
| macOS | `steamtrain-<version>.dmg` (arm64 and x64) |
| Linux | `steamtrain-<version>.AppImage` and `steamtrain_<version>_amd64.deb` |

**The builds are unsigned.** What that costs depends entirely on how the app
reached the machine, and the difference trips people up:

- **You built it yourself** — nothing happens. `com.apple.quarantine` is set by
  the application that *downloads* a file, not by the build, so a local
  `package:desktop` produces a dmg that opens on a double-click and keeps
  working. Gatekeeper is never consulted.
- **You downloaded it** — the first open reports a damaged or unidentified app.

On macOS 15 and later the escape hatch is **System Settings → Privacy &
Security**, where a blocked app leaves an **Open Anyway** button; that prompts
for an admin password, and only the first launch needs it. The Control-click →
Open trick that used to do this was removed in Sequoia, so any instruction
telling you to right-click is describing an older macOS.

Clearing the flag directly still works, and is the honest option for a machine
you control:

```bash
xattr -dr com.apple.quarantine /Applications/steamtrain.app
```

It is deliberately not the headline instruction. Teaching people to strip
quarantine reflexively is the practice the ecosystem is actively moving away
from — Homebrew is removing `--no-quarantine` and drops casks that fail
Gatekeeper on 2026-09-01, which closes `brew install --cask` as a route for
unsigned software.

Two things blunt this in practice. The CLI is unaffected — `npm i -g steamtrain`
then `steamtrain --web-ui` serves the same cockpit, and an npm package is not a
bundle, so it never meets Gatekeeper at all. And the Linux targets have no
equivalent: the AppImage and deb install without ceremony.

Signing and notarization are deliberately deferred — see the
[roadmap](desktop-roadmap.md) for what they actually cost here, which is mostly
entitlements for the agent CLIs the engine spawns rather than anything about
the shell.

Configuration lives in [`electron-builder.yml`](../electron-builder.yml). Two
parts of it are load-bearing:

- **`directories.output: release`.** electron-builder's default output is
  `dist/`, which is where the CLI bundle already lives — the default would
  package the app over the thing it is packaging.
- **`extraMetadata.main`.** Electron boots a packaged app through
  `package.json`'s `main`, which here points at the CLI, as it must for
  `import "steamtrain"`. Without the override, a packaged launch starts the CLI,
  prints its usage text and exits. That was the first packaged build's actual
  behaviour, and it is why the smoke suite runs against the package too.

## How it works

```
Electron main ──fork──> node dist/index.js --web-ui --port 0 --project-dir <cwd>
     │                                    │
     └──── BrowserWindow ──HTTP/SSE──────>┘  http://127.0.0.1:<ephemeral>
```

The app does not embed the web server; it forks the real CLI entry and points a
window at the port that process reports.

**How the port gets reported.** The engine binds `--port 0`, so the OS picks a
free port and the app can never collide with a `steamtrain --web-ui` you already
have running. It learns the result from `--desktop-ready-json`, which prints one
machine-readable line once the server is listening:

```json
{"steamtrain":"ready","url":"http://127.0.0.1:38249","port":38249,"pid":8692}
```

That is the only stdout line that parses as JSON, so the app scans for it rather
than matching the human banner. If a launch hangs, this handshake is the first
thing to check — the app waits 30s for it and then reports the engine's stderr.
Everything else the engine prints is forwarded to the app's log prefixed
`[engine]`.

Three more consequences worth knowing:

- **The engine is a normal Node process.** `process.argv[1]` is the entry script
  and `import.meta.url` resolves to `dist/public/`, so detached runs, static
  asset loading, and agent spawning behave exactly as they do from a terminal.
  `ELECTRON_RUN_AS_NODE=1` is what makes the Electron binary serve as that Node
  runtime; it is stripped from agent CLIs and `command` steps so it can't
  confuse a developer tool that is itself an Electron app.
- **An engine crash doesn't take the window.** The app shows the captured stderr
  instead of a blank frame.
- **Detached background runs survive quitting**, by design — they live in their
  own process group, and the CLI or a later launch can re-attach.

## Projects, window, and runs

**The last project reopens on launch.** An explicit project path, including
`--project-dir <path>`, takes precedence. Without one, the folder picker only
appears when there is no usable project to return to — a first launch, or one
whose folder has since moved. **File → Open Recent** switches between the last
eight, each labelled by folder name and disambiguated by its parent only when
two would otherwise read the same. Switching stops the current engine and forks
a new one; the window stays put. The shell opens one project at a time, so only
the first path after a `--` end-of-options marker is used.

**The first breadcrumb segment is the project switcher** (`⌘P`, or click it).
It lists the same projects by name and real path, each with what is running or
broken in it right now — read from that project's own `.steamtrain/runs`
registry, not its history, so the answer is about this moment and costs one
directory walk per project. "Open a folder…" at the bottom reaches the same
dialog as **File → Open Project**. The renderer only *asks* to switch: main
refuses any path that is not already in the recents list, because the page
asking is a web page. In a browser tab there is nothing to switch to, and the
segment stays the plain path it has always been.

**The window remembers its size, position and maximized state**, but only
restores a position that still lands on an attached display. A window saved on
an external monitor and reopened without it comes back centred rather than
somewhere you cannot reach.

**The topbar is the title bar** on macOS: the window's own is hidden so the UI
reaches the top edge, which leaves the close/minimise/zoom controls sitting
inside the app's first row. The page reserves room for them, and the bar's empty
stretch becomes the handle for moving the window. Both halves of that agreement
are named in `electron/shared/title-bar.ts` — the preload publishes the inset,
`shell.css` spends it, keyed off a class that only exists inside the app.

**Closing the window quits**, on macOS too. The convention there is to stay in
the dock and wait for the icon to be clicked, which suits an app that idles
cheaply; this one holds a forked engine serving a project, and leaving that
running behind a closed window is invisible rather than convenient. Runs in
flight are still asked about, and detached runs still survive either way.

**Runs in flight are visible and survive quitting.** While anything is running
the macOS dock icon carries a count badge (elsewhere, an indeterminate taskbar
bar), and a finishing run raises a native notification whose click focuses the
window on that run. Quitting with work in flight asks first:

- **Leave Running** — the default, and what M1 did silently. The runs are
  detached, in their own process group; a later launch or the CLI re-attaches.
- **Stop Runs** — cancel everything, then quit.
- **Cancel** — don't quit after all.

Quitting with nothing running never asks.

The app learns about runs by polling `GET /api/runs` every few seconds rather
than consuming the SSE stream. The stream is per-run and carries every step
event; a dock badge and a notification about work that takes minutes need
neither, and polling has no reconnect story to get wrong. Those requests are
unauthenticated because the engine binds loopback with no token — if that ever
changes, `run-watch.ts` is what breaks.

The UI is loaded over `http://127.0.0.1:<port>` rather than `file://` or a
custom scheme. That is required, not incidental: the server enforces same-origin
on every state-changing request and authenticates with a `SameSite=Strict`
cookie, and neither survives a `file://` document's `Origin: null`.

## Layout

The shell lives in `electron/` and builds separately from the CLI:

| File | Purpose |
|------|---------|
| `tsup.electron.config.ts` | Builds `electron/` to `dist-electron/`. **CJS**, because a preload under `sandbox: true` must be CJS and a CJS main avoids Electron's ESM loader edge cases. `tsup.config.ts` is untouched, so the CLI bundle is unaffected. |
| `tsconfig.electron.json` | Type-checks `electron/` only. Adds `DOM` to `lib` — required by Electron's own type definitions and by the preload, which runs in a renderer. It is deliberately *not* in the root tsconfig, so `src/` stays DOM-free and cannot silently accept browser globals. |
| `electron-builder.yml` | Packaging. Unsigned macOS and Linux targets. |
| `electron/shared/title-bar.ts` | The one place that decides the window controls are drawn over the page, and how much room that costs. Imported by both main (which hides the title bar) and the preload (which tells the page), because the two have to agree and live in different bundles. |
| `build/icon.svg` | The app icon at 1024. `npm run build:icon` rasterises it to the committed `build/icon.png`, which electron-builder converts into `.icns`, `.ico` and the Linux size ladder. The locomotive is not redrawn here — it is `FAVICON_SVG`'s 32-unit geometry placed by a transform, so the dock icon and the browser tab cannot drift apart. Only the plate under it (gradient, glow, rim) is tuned for this size. |
| `e2e/desktop.spec.ts` | The launch smoke test (below), run by `npm run test:e2e`. |
| `tsconfig.e2e.json` | Type-checks `e2e/` and the Playwright config. Adds `DOM` for the same reason and with the same boundary as the Electron config: the specs evaluate code inside the page. |

`npm run typecheck` runs all three configs — the root, `electron/`, and `e2e/`.

## Testing the shell

Every decision the main process makes lives in a pure module with unit tests:
`recents.ts`, `window-state.ts`, `run-watch.ts`, `quit-prompt.ts`, `shutdown.ts`,
`store.ts`, `project-list.ts`. `index.ts` only wires Electron's events to them, which is what keeps
the wiring small enough to read.

What no unit test can see is whether that wiring works. So there is one small
end-to-end suite that launches the real app:

```bash
npm run build && npm run build:electron
npm run test:e2e                          # Linux: prefix with `xvfb-run -a`
```

It asserts the things a user notices first — the window comes up on the engine's
origin with the UI actually rendered, closing it quits the app rather than
leaving an engine behind, and the topbar keeps clear of the window controls —
plus that the window geometry was persisted on the way out.

Point `STEAMTRAIN_E2E_APP` at a packaged executable to run the same assertions
against a real package rather than the source layout:

```bash
npm run package:desktop:dir
STEAMTRAIN_E2E_APP=release/linux-unpacked/steamtrain npm run test:e2e
```

Those are genuinely different apps. A package boots through `package.json`'s
`main` instead of a script argument, runs the engine out of an asar archive, and
uses its own binary as the Node runtime. CI runs both, on Linux and macOS.

## PATH: why the app can find your agents

A macOS app launched from Finder (or a Linux app from a desktop launcher)
inherits a minimal `PATH` — no Homebrew, no `~/.local/bin`, no nvm. Since
steamtrain resolves every agent CLI by scanning `PATH` and spawns bare `git`,
that would report every agent as missing on a machine where the CLI works fine.

So before forking the engine, the app asks your login shell what its `PATH` is
(`$SHELL -ilc 'command -p env'`, with a 5-second timeout and a fallback scan of
the usual toolchain directories). Launching from a terminal skips this — the
inherited `PATH` is already yours.

**Checking what it found.** Settings → Runners has a collapsed **PATH** row
showing every directory the engine searched, where the list came from
(`login-shell`, `fallback`, or `inherited`), and which entries are not on disk.
When a runner reads "absent" and you know the tool is installed, that list is
the answer — it is served by `/api/doctor`, so it is also visible from the
plain web UI.

If an agent still shows as missing, the reliable escape hatch is a per-agent
absolute `binary` path in [agent configuration](agent-configuration.md).

## Fonts

The page self-hosts the Latin subsets of IBM Plex Sans and Mono from
`/static/fonts/` (~60 KB, [OFL](../src/web/public/fonts/LICENSE.txt)), so it
renders identically offline and reaches no third-party origin. The `@font-face`
rules are generated by `renderIndex` rather than written in a stylesheet,
because the `src:` URLs carry the same content hashes as every other asset.

The CSP is correspondingly narrower: every directive is now `'self'`.

## What isn't here yet

Code signing and notarization, auto-update, `steamtrain://` deep links, a tray
presence, and Windows — which needs its own PATH story and its own answer for
detached runs, and is closer to a separate project than a port.

[`desktop-roadmap.md`](desktop-roadmap.md) has the reasoning behind that
ordering, and what is deliberately never happening.
