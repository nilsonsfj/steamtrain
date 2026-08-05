import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { BrowserWindow, app, dialog } from "electron";
import { buildMenu } from "./menu";
import { type ServerHandle, startServer } from "./server-child";
import { resolveShellPath } from "./shell-path";
import { createWindow, installWebContentsGuards, showErrorPage } from "./window";

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
/** Set on the way out so an expected child exit isn't reported as a crash. */
let quitting = false;

/** Absolute path to the built CLI entry the engine runs from. */
function resolveEntry(): string {
  // `app.getAppPath()` is the repo root in development and the packaged app
  // directory in production; `dist/index.js` sits at the same place in both.
  const entry = join(app.getAppPath(), "dist", "index.js");
  if (!existsSync(entry)) {
    throw new Error(
      `steamtrain is not built: ${entry} does not exist.\nRun \`npm run build\` and try again.`,
    );
  }
  return entry;
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

/** Fork the engine for `cwd` and show its UI, replacing anything already open. */
async function openProject(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const previous = server;
  server = undefined;
  await previous?.stop();

  const handle = await startServer({
    entry: resolveEntry(),
    cwd,
    env,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  server = handle;
  projectDir = cwd;

  const origin = new URL(handle.ready.url).origin;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(`steamtrain — ${basename(cwd)}`);
    void mainWindow.loadURL(origin);
  } else {
    mainWindow = createWindow({ url: origin, projectName: basename(cwd) });
    mainWindow.on("closed", () => {
      mainWindow = undefined;
    });
  }

  handle.onExit(() => {
    // A detached background run outliving the app is by design; the *engine*
    // stopping while a window is open is not.
    if (quitting || server !== handle) return;
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

  // A GUI launch inherits a minimal PATH; recover the user's real one before
  // anything tries to resolve `claude`, `codex` or `git`.
  const resolved = await resolveShellPath();
  // Recorded because it is the first thing to check when the doctor reports
  // agents that the user knows are installed.
  console.log(`[steamtrain] PATH resolved from ${resolved.source}`);
  process.env.PATH = resolved.path;
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: resolved.path };

  installWebContentsGuards((url) => {
    if (!server) return false;
    try {
      return new URL(url).origin === new URL(server.ready.url).origin;
    } catch {
      return false;
    }
  });

  buildMenu({
    onOpenProject: () => {
      void (async () => {
        const dir = await promptForProject();
        if (!dir || dir === projectDir) return;
        try {
          await openProject(dir, env);
        } catch (err) {
          reportFatal(err);
        }
      })();
    },
  });

  const dir = await promptForProject();
  if (!dir) {
    app.quit();
    return;
  }
  await openProject(dir, env);
}

app.on("window-all-closed", () => {
  // No dock-relaunch story yet (that arrives with the project picker window),
  // so closing the window means quitting on every platform.
  app.quit();
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
  shutdown = server
    .stop()
    .catch((err: unknown) => {
      console.error("[steamtrain] engine shutdown failed:", err);
    })
    .finally(() => {
      server = undefined;
      app.quit();
    });
});

main().catch((err) => {
  reportFatal(err);
  app.quit();
});
