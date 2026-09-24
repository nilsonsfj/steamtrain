import { existsSync, statSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { BrowserWindow, Notification, app, dialog, ipcMain, screen } from "electron";
import { resolveEntry } from "./entry";
import { launchProjectPath, selectLaunchProject } from "./launch-project";
import { buildMenu } from "./menu";
import { listProjects } from "./project-list";
import { type QuitChoice, quitChoiceFor, quitPromptSpec } from "./quit-prompt";
import { addRecent, labelRecents, pruneRecents, removeRecent } from "./recents";
import { type FinishedRun, type RunWatch, startRunWatch } from "./run-watch";
import { type ServerHandle, startServer } from "./server-child";
import { resolveShellPath } from "./shell-path";
import { performQuit } from "./shutdown";
import { type DesktopState, createStateStore, pruneLastWorkflow } from "./store";
import { handleUncaught } from "./uncaught";
import { createWindow, installWebContentsGuards, showErrorPage } from "./window";
import { restoreWindowState } from "./window-state";

/**
 * steamtrain desktop — main process.
 *
 * Boot order matters: the PATH has to be corrected before the engine is forked
 * (otherwise the doctor finds no agent CLIs), and the engine has to report a
 * bound port before a window can be pointed at it.
 */

// Before anything reads a path off `app`: `userData` is derived from the app
// name, and a development launch has no bundle to take a name from. Without
// this the app is "Electron" — in the dock, in its notifications, and in the
// directory it keeps its state in. A packaged build already knows better and
// this changes nothing there.
app.setName("steamtrain");

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
      persist({ recents: [], lastWorkflow: pruneLastWorkflow(state.lastWorkflow, []) });
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
    const recents = removeRecent(state.recents, dir);
    persist({ recents, lastWorkflow: pruneLastWorkflow(state.lastWorkflow, recents) });
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

/** Build the app window for an engine that is already running. */
function openWindow(origin: string, cwd: string): BrowserWindow {
  const win = createWindow({
    url: origin,
    projectName: basename(cwd),
    state: restoreWindowState(
      state.window,
      screen.getAllDisplays().map((display) => display.workArea),
    ),
    onStateChange: (window) => persist({ window }),
  });
  win.on("closed", () => {
    mainWindow = undefined;
  });
  return win;
}

/**
 * Put the UI back in front of the user.
 *
 * Closing the window quits the app, so a live app with no window is a narrow
 * state: the dock icon was clicked while hidden, or a quit was started and then
 * cancelled. Both want the window the engine is already serving — re-opening
 * the *project* would tear down a working engine and fork a new one.
 */
function restoreWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    return;
  }
  if (!server || !projectDir) return;
  mainWindow = openWindow(new URL(server.ready.url).origin, projectDir);
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
    mainWindow = openWindow(origin, cwd);
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
  if (!watch) return "leave-running";
  const active = await watch.refresh();
  if (active === 0) return "leave-running";
  const spec = quitPromptSpec(active);
  const options = {
    type: "question" as const,
    message: spec.message,
    detail: spec.detail,
    buttons: spec.buttons,
    defaultId: spec.defaultId,
    cancelId: spec.cancelId,
    noLink: true,
  };
  // Attached to the window when there is one, and asked app-modally when there
  // is not: closing the window is itself a way to quit, and that path has to
  // reach the same question rather than silently taking the default.
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const { response } = await (parent
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options));
  return quitChoiceFor(spec, response);
}

/**
 * Wear this app's own icon during development.
 *
 * A dev launch borrows Electron's bundle, so the dock otherwise shows the
 * Electron logo next to a window that calls itself steamtrain. A packaged build
 * carries the icon in its bundle and needs nothing here.
 */
function useOwnDockIcon(): void {
  if (app.isPackaged || process.platform !== "darwin") return;
  // Same layout the CLI entry is found through: `main.cjs` sits in
  // `<root>/dist-electron/`, so the build resources are one level up.
  const icon = join(__dirname, "..", "build", "icon.png");
  if (existsSync(icon)) app.dock?.setIcon(icon);
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
  useOwnDockIcon();

  const saved = store.read();
  // Pruned at startup rather than on every menu build: one stat per entry, and
  // a project deleted mid-session is caught by `switchProject` anyway.
  const recents = pruneRecents(saved.recents, existsSync);
  state = { ...saved, recents, lastWorkflow: pruneLastWorkflow(saved.lastWorkflow, recents) };

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

  // Same action as the "Open Project…" menu item, reachable from the project
  // switcher's "Open a folder…" row once the renderer knows it's in the app.
  ipcMain.handle("steamtrain:switch-project", async () => {
    const dir = await promptForProject();
    if (dir) await switchProject(dir);
  });

  // The web UI's own `localStorage` copy of the last-selected workflow can't
  // survive a restart: the embedded server's port (and so its origin)
  // changes every launch. This is the persistent fallback, keyed by project
  // since a remembered workflow from a different project is meaningless.
  ipcMain.handle("steamtrain:get-last-workflow", () => {
    if (!projectDir) return undefined;
    return state.lastWorkflow?.[projectDir];
  });
  ipcMain.handle("steamtrain:set-last-workflow", (_event, name: unknown) => {
    if (!projectDir || typeof name !== "string" || !name) return;
    persist({ lastWorkflow: { ...state.lastWorkflow, [projectDir]: name } });
  });

  // The rows of that switcher: every project the app knows about, with what is
  // running or broken in each. Recomputed per call rather than cached — the
  // menu is opened by hand, and a stale "2 running" is the one thing the row
  // exists to get right.
  ipcMain.handle("steamtrain:list-projects", () =>
    listProjects({
      recents: state.recents,
      ...(projectDir ? { current: projectDir } : {}),
      home: app.getPath("home"),
    }),
  );

  // Switch to a project the app already knows. The renderer is a web page, so
  // the path is checked against the recents list rather than trusted: an
  // arbitrary string arriving here must not become a directory the engine is
  // forked against.
  ipcMain.handle("steamtrain:open-project", async (_event, dir: unknown) => {
    if (typeof dir !== "string") return;
    if (dir !== projectDir && !state.recents.includes(dir)) return;
    await switchProject(dir);
  });

  installWebContentsGuards((url) => {
    if (!server) return false;
    try {
      return new URL(url).origin === new URL(server.ready.url).origin;
    } catch {
      return false;
    }
  });

  refreshMenu();

  const dir =
    selectLaunchProject({
      explicitPath: launchProjectPath({
        argv: process.argv,
        packaged: app.isPackaged,
      }),
      recents: state.recents,
      isDirectory,
    }) ?? (await promptForProject());
  if (!dir) {
    app.quit();
    return;
  }
  await openProject(dir);
}

app.on("activate", () => {
  // macOS: the dock icon was clicked. Since closing the window quits, this is
  // the app coming back from hidden, or a quit that was cancelled after the
  // window had already gone — in both cases the engine is still there to show.
  if (server || (mainWindow && !mainWindow.isDestroyed())) {
    restoreWindow();
    return;
  }
  // No engine to show — the last one failed or was stopped, so start over.
  if (projectDir) void switchProjectFromDock(projectDir);
});

/** `activate` needs to re-open the *current* project, which `switchProject` refuses. */
async function switchProjectFromDock(dir: string): Promise<void> {
  projectDir = undefined;
  await switchProject(dir);
}

/**
 * One line per quit step on stdout. Quitting holds the app open while it tears
 * the engine down, so a quit that stalls should say which step it stalled in.
 * Written synchronously: on macOS a write to a stdout pipe is otherwise
 * asynchronous, and the last steps would be lost when the app exits.
 */
function quitLog(step: string): void {
  try {
    writeSync(1, `[steamtrain] quit ${new Date().toISOString()}: ${step}\n`);
  } catch {
    // No stdout to write to (a packaged app launched from Finder): nothing to say.
  }
}

// Replaces Electron's default, a modal error box that blocks the main thread:
// mid-quit, with no window left, that box is invisible and the quit never ends.
process.on("uncaughtException", (err) => {
  handleUncaught(err, {
    quitting: () => quitting,
    hasWindow: () => Boolean(mainWindow && !mainWindow.isDestroyed()),
    log: (text) => {
      // Synchronous, like `quitLog`: this is often the last thing the app says.
      try {
        writeSync(2, `${text}\n`);
      } catch {
        // No stderr to write to: nothing more to do.
      }
    },
    showErrorBox: (title, content) => dialog.showErrorBox(title, content),
  });
});

app.on("window-all-closed", () => {
  quitLog("last window closed");
  // Closing the window quits, on macOS too. The usual macOS convention — stay
  // in the dock, wait for `activate` — assumes a lightweight app that can idle
  // cheaply. This one holds a forked engine serving a project, and leaving that
  // running behind a closed window is invisible rather than convenient: the
  // user has quit, as far as they can tell, and the process is still there.
  //
  // Background runs are unaffected. They are detached by design and outlive the
  // app either way; the quit prompt is what asks about them.
  app.quit();
});

app.on("before-quit", () => {
  quitLog("before-quit");
  quitting = true;
});

// Stopping the engine is asynchronous, so hold the quit for one pass and let it
// finish. Detached background runs are in their own process group and survive
// deliberately — only the server this app owns is torn down.
let shutdown: Promise<void> | undefined;
app.on("will-quit", (event) => {
  if (!server || shutdown) {
    // `shutdown` is set once a teardown started; a clean one also cleared `server`.
    quitLog(shutdown ? "will-quit, torn down" : "will-quit, no engine");
    return;
  }
  quitLog("will-quit, tearing down");
  event.preventDefault();
  // The quit is already prevented, so this must reach `app.quit()` on every
  // path — otherwise a failed teardown leaves the app unquittable.
  shutdown = performQuit({
    askAboutRuns: async () => {
      quitLog("asking about runs");
      const choice = await askAboutRuns();
      quitLog(`runs: ${choice}`);
      return choice;
    },
    cancelActive: async () => {
      quitLog("cancelling runs");
      await watch?.cancelActive();
    },
    stopWatch: () => {
      watch?.stop();
      watch = undefined;
    },
    stopServer: async () => {
      quitLog("stopping engine");
      await server?.stop();
      server = undefined;
      quitLog("engine stopped");
    },
    quit: () => {
      quitLog("quitting");
      app.quit();
    },
    onError: (err) => console.error("[steamtrain] shutdown step failed:", err),
  })
    .then((outcome) => {
      // Cancelled: back out of the quit entirely so a later one asks again.
      if (outcome === "cancelled") {
        quitting = false;
        shutdown = undefined;
        // The window may be gone already — closing it is one of the ways to reach
        // here. Staying is only a meaningful answer if there is something to stay
        // *in*.
        restoreWindow();
      }
    })
    .catch((err) => {
      // `performQuit` handles its own step failures, so reaching here means the
      // teardown itself broke. The quit is already prevented, so let it through
      // rather than leaving an app that cannot be quit at all. `shutdown` stays
      // set on purpose: that is what stops this handler intercepting the retry.
      console.error("[steamtrain] shutdown failed:", err);
      app.quit();
    });
});

main().catch((err) => {
  reportFatal(err);
  app.quit();
});
