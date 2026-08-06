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

## M2 — "it's pleasant" ✅

The distance between *works* and *would actually replace the terminal*. Nothing
here was architectural; it is the layer of finish that makes a tool feel like an
app rather than a browser pointed at localhost.

| Item | Why it was in M2 | Shipped as |
|------|------------------|------------|
| **Project switcher and recents** | The folder dialog was the entire project-selection story, and cancelling it at launch quit the app. | Last project reopens on launch; File → Open Recent for the last eight; macOS `activate` reopens rather than stranding a running process. |
| **Window state persistence** | Size, position and maximized state across launches. Cheap, and its absence is noticed immediately. | `window-state.ts`, which only restores a position that still lands on an attached display. |
| **Graceful "detach and quit"** | Quitting mid-run left the detached runner going. That is correct — detached runs are meant to outlive the UI — but it happened silently. | A three-way prompt: leave running (default), stop runs, or don't quit. |
| **Self-hosted fonts** | The page pulled IBM Plex from Google Fonts. A packaged offline app fell back silently *and* every launch made a third-party request. The only user-visible defect on the list, and fixing it fixed the web UI too. | Latin subsets under `/static/fonts/`; every CSP directive is now `'self'`. |
| **OS notifications and dock progress** | Run completion should reach the user when the window is behind something else. | Native notification that deep-links to the run, plus a dock badge counting active runs. |
| **Doctor `effectivePath` diagnostics** | Without it, a `shell-path.ts` failure was opaque — the user saw "agent missing" for an agent they knew was installed. | `/api/doctor` reports the searched directories and their source; Settings → Runners shows them. |
| **`will-quit` lifecycle coverage** | The shutdown path was the one piece of main-process logic with no test, and it had already shipped a bug that left the app unquittable. | `shutdown.ts` — the sequence extracted from the event wiring, with the "must always reach `quit()`" invariant tested against each failing step. |

The pattern that made M2 testable is worth keeping: every decision lives in a
pure module (`recents`, `window-state`, `run-watch`, `shutdown`, `quit-prompt`)
and `index.ts` only wires Electron events to them. What remains untested is the
wiring itself, which is what M3's smoke test is for.

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
  turned out to be, and the only gap M2's testing pattern cannot close.

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
