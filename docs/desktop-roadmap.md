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
and `index.ts` only wires Electron events to them. What that pattern could not
reach was the wiring itself — M3's smoke test is what closed it.

## M3 — "it ships" ✅

Turning a checkout you run with `npm run dev:electron` into something you can
hand to someone.

| Item | Why it was in M3 | Shipped as |
|------|------------------|------------|
| **Launch smoke coverage** | The one gap M2's testing pattern cannot close. Every decision is in a covered pure module, but nothing proved the app *starts* — which is exactly what #199 was. | `e2e/desktop.spec.ts`: the real app, launched, asserted to reach the engine's origin with the UI rendered, and to leave no engine behind when it quits. |
| **`electron-builder` packaging** | Unsigned macOS `dmg` and Linux `AppImage`/`deb`, with the engine bundle packed alongside the shell. | [`electron-builder.yml`](../electron-builder.yml), `npm run package:desktop`. Output goes to `release/`, because the default is `dist/` — where the CLI bundle already lives. |
| **Real icons** | Only the 32px `FAVICON_SVG` existed, and it is drawn for a size where a silhouette is all that survives. | `build/icon.svg` at 1024 — the same locomotive with the details a large rendering asks for — plus `scripts/build-icon.ts` so the committed PNG is reproducible from it. |
| **A macOS CI leg** | Two platforms, and the one that matters most for a desktop app was the one CI never ran. | A `desktop` job on Linux *and* macOS: build, smoke test, package, smoke test the package. Real installers come from the on-demand `desktop-packages` workflow. |

Ordering the smoke test first paid for itself immediately: the first packaged
build launched the CLI instead of the shell, because Electron boots a package
through `package.json`'s `main` and ours points at the CLI, as it must. Nothing
in the source layout can reproduce that — the dev launch passes an explicit
script path — which is why the suite now runs against the package as well.

## Deferred

Not scheduled, and each for its own reason:

- **Signing and notarization** — the largest single item, and mostly not about
  the shell: the hardened runtime needs `allow-jit`,
  `allow-unsigned-executable-memory` and `disable-library-validation` for the
  agent CLIs the engine spawns, plus TCC usage strings for the folders it
  touches. Wants a paid developer account and a real CI secret story.

  There is no free version of this. Notarization needs a Developer ID
  certificate, which needs the $99/yr Developer Program; the fee waiver is for
  nonprofits, accredited schools and government entities, not open source. The
  $99 is also the small half of the cost — the entitlements and the secret
  story are the work.

  What defers it is that the dmg is a convenience rather than the product. The
  CLI is the supported install (`npm i -g steamtrain`), it carries the same web
  UI, and npm packages never meet Gatekeeper. Linux is unaffected. A locally
  built dmg is unquarantined and works permanently, so contributors pay nothing
  either. Only *downloaded* macOS builds pay, and only on first launch.

  The trigger to reconsider is the desktop app becoming how most people run
  steamtrain rather than a nicety over the CLI. One route narrowed already:
  Homebrew is removing `--no-quarantine` and will drop casks that fail
  Gatekeeper on **2026-09-01**
  ([Homebrew/brew#20755](https://github.com/Homebrew/brew/issues/20755)), so a
  cask is not a way around this. If a free-ish middle path is ever wanted, it is
  building the app on the user's machine — a local build is unquarantined by
  construction — at the price of an Electron download and a build per install.
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
