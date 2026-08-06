# The steamtrain desktop app

An Electron shell around the [web UI](web-ui.md). Same engine, same cockpit — it
just removes the terminal from the path to it: open the app, pick a project
folder, watch the pipeline.

This is **M2: usable**. One window at a time, no packaged installer yet, but it
remembers your projects and your window, tells you when a run finishes, and asks
before walking away from work in progress. Run it from a checkout:

```bash
npm run dev:electron        # builds the CLI + shell, then launches Electron
```

`dev:electron` runs `npm run build` first because the app runs the *built* CLI
(`dist/index.js`), not the TypeScript sources.

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

**The last project reopens on launch.** The folder picker only appears when
there is no usable project to return to — a first launch, or one whose folder
has since moved. **File → Open Recent** switches between the last eight, each
labelled by folder name and disambiguated by its parent only when two would
otherwise read the same. Switching stops the current engine and forks a new one;
the window stays put.

**The window remembers its size, position and maximized state**, but only
restores a position that still lands on an attached display. A window saved on
an external monitor and reopened without it comes back centred rather than
somewhere you cannot reach.

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

`npm run typecheck` runs both configs.

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

- **M3** — `electron-builder` packaging, real icons, a macOS CI leg, and
  Playwright `_electron` smoke coverage. The main-process wiring is the part
  with no automated test: the decisions inside it are extracted into pure
  modules (`shutdown.ts`, `window-state.ts`, `recents.ts`, `run-watch.ts`) and
  covered, but nothing yet proves the app launches.
- **Deferred** — code signing and notarization, auto-update, `steamtrain://`
  deep links, tray, and Windows (which needs its own PATH and process-lifetime
  work).

[`desktop-roadmap.md`](desktop-roadmap.md) has the reasoning behind that
ordering, and what is deliberately never happening.
