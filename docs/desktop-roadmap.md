# Desktop app roadmap

Where the [Electron shell](desktop-app.md) is going, and why each piece is where
it is. Three milestones plus a deferred pile; each milestone is a shippable
state, not a checklist of chores.

The organizing constraint is that the desktop app is a **thin shell**. The web
UI is the product; the shell's job is to remove the terminal from the path to
it. Anything that would fork the front end, or that only makes sense in a
desktop build, needs a strong reason — otherwise it belongs in the web UI where
both front ends get it.

## M1 — "it runs" ✅

Shipped in [#198](https://github.com/nilsonsfj/steamtrain/pull/198), with the
entry-resolution fix in [#199](https://github.com/nilsonsfj/steamtrain/pull/199).

A double-clickable app that asks for a project folder and shows the same web UI:
one window, one project chosen at launch, the engine forked as a child process,
a recovered GUI `PATH`, and a hardened window. No packaging.

Four supporting changes landed in `src/` — a `--port 0` deep-link fix that
affected the CLI too, the `--desktop-ready-json` handshake, containment of
`ELECTRON_RUN_AS_NODE`, and a runner seam in `spawnDetachedRunner`.

## M2 — "it's pleasant"

The distance between *works* and *would actually replace the terminal*. Nothing
here is architectural; it is the layer of finish that makes a tool feel like an
app rather than a browser pointed at localhost.

| Item | Why it's in M2 |
|------|----------------|
| **Project switcher and recents** | The folder dialog is currently the entire project-selection story, and cancelling it at launch quits the app. Needs a picker surface, a persisted recents list, and macOS dock-relaunch (`activate`) behavior. |
| **Window state persistence** | Size, position and maximized state across launches. Cheap, and its absence is noticed immediately. |
| **Graceful "detach and quit"** | Quitting mid-run leaves the detached runner going. That is correct — detached runs are meant to outlive the UI — but it happens silently. The user should be told and given the choice. |
| **Self-hosted fonts** | The page pulls IBM Plex from Google Fonts. A packaged offline app falls back silently *and* every launch makes a third-party request. The only item here that is a user-visible defect rather than a missing nicety, and it fixes the web UI too. |
| **OS notifications and dock progress** | Run completion should reach the user when the window is behind something else. |
| **Doctor `effectivePath` diagnostics** | The setup panel should show the `PATH` the engine actually resolved and where it came from. Without it, a `shell-path.ts` failure is completely opaque — the user sees "agent missing" for an agent they know is installed. |
| **`will-quit` lifecycle coverage** | The shutdown path is the one piece of main-process logic with no test, and it has already shipped one bug (a failed teardown left the app unquittable). |

## M3 — "it ships"

Turning a checkout you run with `npm run dev:electron` into something you can
hand to someone.

- **`electron-builder` packaging** — unsigned, macOS + Linux. `dmg` and
  `AppImage`/`deb`. The engine bundle (`dist/`) has to be packed alongside the
  shell, and `entry.ts` already resolves it from a layout that survives packing.
- **Real icons.** Only the 32px `FAVICON_SVG` exists today; an app icon needs
  the full macOS `icns` ladder drawn from something larger.
- **A macOS CI leg**, plus Playwright `_electron` smoke coverage — enough to
  catch "the app doesn't launch at all", which is exactly the class of bug #199
  turned out to be.

## Deferred

Not scheduled, and each for its own reason:

- **Signing and notarization** — the largest single item, and mostly not about
  the shell: the hardened runtime needs `allow-jit`,
  `allow-unsigned-executable-memory` and `disable-library-validation` for the
  agent CLIs the engine spawns, plus TCC usage strings for the folders it
  touches. Wants a paid developer account and a real CI secret story.
- **Auto-update** — depends on signing, and on having somewhere to publish.
- **`steamtrain://` deep links** — nice with notifications, but the notification
  itself can just focus the window; the URL scheme only earns its keep once
  links are being shared outside the app.
- **Tray / menu-bar presence** — only meaningful once detached runs are common
  enough that a background indicator beats opening the window.
- **Windows** — effectively a separate project. No login-shell `PATH` trick, a
  different agent-discovery story, and detached runs do not survive job-object
  teardown the way they do on POSIX. Doing it badly is worse than not doing it.

## Not planned

Forking the front end for desktop-specific UI, embedding the engine in the main
process (see [`desktop-app.md`](desktop-app.md) for why it is a child), and
bundling a Node runtime separate from Electron's.
