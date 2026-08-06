import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { BrowserWindow, Notification, app, dialog, screen } from "electron";
import { resolveEntry } from "./entry";
import { buildMenu } from "./menu";
import { type QuitChoice, quitChoiceFor, quitPromptSpec } from "./quit-prompt";
import { addRecent, labelRecents, pruneRecents, removeRecent } from "./recents";
import { type FinishedRun, type RunWatch, startRunWatch } from "./run-watch";
import { type ServerHandle, startServer } from "./server-child";
import { resolveShellPath } from "./shell-path";
import { performQuit } from "./shutdown";
import { type DesktopState, createStateStore } from "./store";
import { createWindow, installWebContentsGuards, showErrorPage } from "./window";
import { restoreWindowState } from "./window-state";

/**
 * steamtrain desktop — main process.
 *
 * Boot order matters: the PATH has to be corrected before the engine is forked
 * (otherwise the doctor finds no agent CLIs), and the engine has to report a
 * bound port before a window can be pointed at it.
 */

let server: ServerHandle | undefined;
let mainWindow: BrowserWindow | undefined;
let projectDir: string | undefined;
let watch: RunWatch | undefined;
/** Set on the way out so an expected child exit isn't reported as a crash. */
let quitting = false;

const store = createStateStore(app.getPath("userData"));
let state: DesktopState = { recents: [] };

/** Absolute path to the built CLI entry the engine runs from. */
function cliEntry(): string {
  return resolveEntry({ mainDir: __dirname, appPath: app.getAppPath() });
}

function persist(patch: Partial<DesktopState>): void {
  state = { ...state, ...patch };
  store.write(state);
}

/** Rebuild the menu — the recents submenu is a function of current state. */
function refreshMenu(): void {
  buildMenu({
    recents: labelRecents(state.recents),
    ...(projectDir ? { currentProject: projectDir } : {}),
    onOpenProject: () => {
      void (async () => {
        const dir = await promptForProject();
        if (dir) await switchProject(dir);
      })();
    },
    onOpenRecent: (dir) => void switchProject(dir),
    onClearRecents: () => {
      persist({ recents: [] });
      refreshMenu();
    },
  });
}

/** Ask for a project directory. Returns undefined if the user cancels. */
async function promptForProject(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({
    title: "Open a project",
    message: "Choose the repository steamtrain should run workflows against.",
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Open",
  });
  return result.canceled ? undefined : result.filePaths[0];
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Open a project, reporting any failure rather than throwing into the void.
 *
 * A recents entry can name a folder that has since been moved or deleted, so
 * the list is repaired here instead of offering the same broken entry forever.
 */
async function switchProject(dir: string): Promise<void> {
  if (dir === projectDir) return;
  if (!isDirectory(dir)) {
    persist({ recents: removeRecent(state.recents, dir) });
    refreshMenu();
    dialog.showErrorBox(
      "That project is gone",
      `${dir} is no longer a directory. It has been removed from the recent projects list.`,
    );
    return;
  }
  try {
    await openProject(dir);
  } catch (err) {
    reportFatal(err);
  }
}

/** The dock/taskbar indicator for work in flight. */
function showActivity(count: number): void {
  if (process.platform === "darwin") {
    // A badge, not a progress bar: macOS progress bars want a fraction, and
    // "how many runs" is the number this app actually knows.
    app.dock?.setBadge(count > 0 ? String(count) : "");
    return;
  }
  // Elsewhere an indeterminate bar is the available idiom. Harmless where the
  // desktop environment ignores it.
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(count > 0 ? 2 : -1);
}

/** Announce finished runs, and offer to jump straight to one. */
function announce(finished: readonly FinishedRun[]): void {
  if (!Notification.isSupported()) return;
  for (const run of finished) {
    const notification = new Notification({
      title: run.ok ? `${run.workflow} finished` : `${run.workflow} failed`,
      body: run.ok ? "The run completed successfully." : "The run ended with an error.",
    });
    notification.on("click", () => {
      if (!mainWindow || mainWindow.isDestroyed() || !server) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      // Same deep-link shape the engine's own notifications use.
      void mainWindow.loadURL(`${new URL(server.ready.url).origin}/#run-${run.id}`);
    });
    notification.show();
  }
}

/** Fork the engine for `cwd` and show its UI, replacing anything already open. */
async function openProject(cwd: string): Promise<void> {
  const previous = server;
  server = undefined;
  watch?.stop();
  watch = undefined;
  showActivity(0);
  await previous?.stop();

  const handle = await startServer({
    entry: cliEntry(),
    cwd,
    // Already carries the recovered PATH, applied in `main()` before any fork.
    env: process.env,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  server = handle;
  projectDir = cwd;
  persist({ recents: addRecent(state.recents, cwd) });

  const origin = new URL(handle.ready.url).origin;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(`steamtrain — ${basename(cwd)}`);
    void mainWindow.loadURL(origin);
  } else {
    mainWindow = createWindow({
      url: origin,
      projectName: basename(cwd),
      state: restoreWindowState(
        state.window,
        screen.getAllDisplays().map((display) => display.workArea),
      ),
      onStateChange: (window) => persist({ window }),
    });
    mainWindow.on("closed", () => {
      mainWindow = undefined;
    });
  }
  refreshMenu();

  watch = startRunWatch({
    origin,
    onActiveCount: showActivity,
    onFinished: announce,
  });

  handle.onExit(() => {
    // A detached background run outliving the app is by design; the *engine*
    // stopping while a window is open is not.
    if (quitting || server !== handle) return;
    watch?.stop();
    watch = undefined;
    showActivity(0);
    if (mainWindow && !mainWindow.isDestroyed()) {
      showErrorPage(mainWindow, "The steamtrain engine stopped", handle.stderrTail());
    }
  });
}

/** Report a boot failure in a dialog — there may be no window to render into. */
function reportFatal(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  dialog.showErrorBox("steamtrain could not start", detail);
}

/**
 * Ask what should happen to runs still in flight.
 *
 * Returns the user's choice, or `leave-running` when there is nothing in flight
 * — quitting an idle app must never show a dialog.
 */
async function askAboutRuns(): Promise<QuitChoice> {
  if (!watch || !mainWindow || mainWindow.isDestroyed()) return "leave-running";
  const active = await watch.refresh();
  if (active === 0) return "leave-running";
  const spec = quitPromptSpec(active);
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    message: spec.message,
    detail: spec.detail,
    buttons: spec.buttons,
    defaultId: spec.defaultId,
    cancelId: spec.cancelId,
    noLink: true,
  });
  return quitChoiceFor(spec, response);
}

async function main(): Promise<void> {
  // Two instances would race for the same `.steamtrain/` run store.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  await app.whenReady();

  const saved = store.read();
  // Pruned at startup rather than on every menu build: one stat per entry, and
  // a project deleted mid-session is caught by `switchProject` anyway.
  state = { ...saved, recents: pruneRecents(saved.recents, existsSync) };

  // A GUI launch inherits a minimal PATH; recover the user's real one before
  // anything tries to resolve `claude`, `codex` or `git`.
  const resolved = await resolveShellPath();
  // Recorded because it is the first thing to check when the doctor reports
  // agents that the user knows are installed.
  console.log(`[steamtrain] PATH resolved from ${resolved.source}`);
  // Applied to this process so main's own dialogs and helpers agree with the
  // engine; the forked child inherits all three from here.
  process.env.PATH = resolved.path;
  // Forwarded so the setup panel can explain an "absent" runner rather than
  // leaving the user to guess whether the PATH recovery worked.
  process.env.STEAMTRAIN_PATH_SOURCE = resolved.source;
  process.env.STEAMTRAIN_PATH_DETAIL = resolved.detail;

  installWebContentsGuards((url) => {
    if (!server) return false;
    try {
      return new URL(url).origin === new URL(server.ready.url).origin;
    } catch {
      return false;
    }
  });

  refreshMenu();

  // Reopening the last project is what makes the app feel like it belongs to a
  // project rather than asking the same question every launch. A folder that
  // has gone away falls through to the picker.
  const last = state.recents[0];
  const dir = last && isDirectory(last) ? last : await promptForProject();
  if (!dir) {
    app.quit();
    return;
  }
  await openProject(dir);
}

app.on("activate", () => {
  // macOS: clicking the dock icon with no window open should bring the app
  // back rather than leave a running process with nothing to show.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    return;
  }
  if (projectDir) void switchProjectFromDock(projectDir);
});

/** `activate` needs to re-open the *current* project, which `switchProject` refuses. */
async function switchProjectFromDock(dir: string): Promise<void> {
  projectDir = undefined;
  await switchProject(dir);
}

app.on("window-all-closed", () => {
  // Closing the window means quitting everywhere except macOS, where the app
  // stays in the dock and `activate` brings it back.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  quitting = true;
});

// Stopping the engine is asynchronous, so hold the quit for one pass and let it
// finish. Detached background runs are in their own process group and survive
// deliberately — only the server this app owns is torn down.
let shutdown: Promise<void> | undefined;
app.on("will-quit", (event) => {
  if (!server || shutdown) return;
  event.preventDefault();
  // The quit is already prevented, so this must reach `app.quit()` on every
  // path — otherwise a failed teardown leaves the app unquittable.
  shutdown = performQuit({
    askAboutRuns,
    cancelActive: async () => {
      await watch?.cancelActive();
    },
    stopWatch: () => {
      watch?.stop();
      watch = undefined;
    },
    stopServer: async () => {
      await server?.stop();
      server = undefined;
    },
    quit: () => app.quit(),
    onError: (err) => console.error("[steamtrain] shutdown step failed:", err),
  }).then((outcome) => {
    // Cancelled: back out of the quit entirely so a later one asks again.
    if (outcome === "cancelled") {
      quitting = false;
      shutdown = undefined;
    }
  });
});

main().catch((err) => {
  reportFatal(err);
  app.quit();
});
