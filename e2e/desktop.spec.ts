import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron, expect, test } from "@playwright/test";
import { STATE_FILE } from "../electron/main/store";
import { TITLE_BAR_INSET_PX } from "../electron/shared/title-bar";

/**
 * Does the app actually launch?
 *
 * Every decision the main process makes lives in a pure module with unit tests
 * — recents, window geometry, run polling, the shutdown sequence. What none of
 * them can see is the wiring: whether `index.ts` bolts those modules to the
 * Electron events correctly, whether the CLI bundle is where the shell looks
 * for it, and whether the window ends up showing the UI rather than an error
 * page. That gap shipped once already, as #199.
 *
 * So this suite is small and end-to-end on purpose. It launches the real built
 * app, against a real forked engine, and asserts the two things a user would
 * notice first: the UI appears, and quitting leaves nothing behind.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = join(ROOT, "dist-electron", "main.cjs");
const CLI = join(ROOT, "dist", "index.js");

/**
 * A packaged executable to test instead of the built source layout.
 *
 * The two are not the same app: a package boots through `package.json`'s `main`
 * rather than an explicit script argument, runs the engine out of an asar
 * archive, and resolves its own binary as the Node runtime. Every one of those
 * can break without the dev layout noticing — the first packaged build of this
 * app started the CLI instead of the shell — so CI points this at the artifact
 * it just produced and runs the same assertions again.
 */
const PACKAGED = process.env.STEAMTRAIN_E2E_APP;

declare global {
  interface Window {
    steamtrainDesktop?: {
      platform: string;
      version: string;
      listProjects?: () => Promise<unknown>;
      openProject?: (path: string) => Promise<void>;
    };
  }
}

/** Temp directories to remove once the suite is done. */
const scratch: string[] = [];

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * Chromium's setuid sandbox needs conditions a CI box often cannot offer: it
 * refuses to run as root, and the `chrome-sandbox` helper npm installs is not
 * owned by root, so it cannot elevate. Both are environment facts rather than
 * anything about this app.
 *
 * Turning it off costs nothing this suite is testing. It disables the *browser
 * process* sandbox only; the renderer still runs under the `sandbox: true`
 * preference the app sets for itself, which is the one that matters here and
 * which the macOS leg exercises with everything intact.
 */
function sandboxArgs(): string[] {
  const forced = process.env.STEAMTRAIN_E2E_NO_SANDBOX === "1";
  const asRoot = process.getuid?.() === 0;
  return forced || asRoot ? ["--no-sandbox"] : [];
}

/** `process.env` minus the undefined values, which Playwright will not take. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // `resolveShellPath` reads a set TERM as "already launched from a terminal"
  // and skips the login-shell probe. That is what we want: the probe spawns the
  // user's real shell, which is neither this suite's subject nor reproducible
  // across machines.
  env.TERM ??= "xterm";
  return env;
}

interface Launched {
  app: ElectronApplication;
  /** The project directory the app was seeded to reopen. */
  project: string;
  /** Electron `userData`, so a test can read back what the app persisted. */
  userData: string;
  /** Everything the main process and the forked engine have written so far. */
  output(): string;
  /** Resolves once the app's output pipes have closed, or after a bound. */
  drained(): Promise<void>;
}

const running: Launched[] = [];

async function launchApp(projectArgument?: string, alsoRecent: string[] = []): Promise<Launched> {
  const project = scratchDir("steamtrain-project-");
  const userData = scratchDir("steamtrain-userdata-");
  // Seeding the state file is how the app is told which project to open: it
  // reopens `recents[0]` and only shows the folder picker when there is nothing
  // to return to. Without this the test would block on a native modal.
  writeFileSync(join(userData, STATE_FILE), JSON.stringify({ recents: [project, ...alsoRecent] }));

  // A packaged app has no script argument — it boots whatever its own manifest
  // names as `main`, which is the part worth testing.
  const args = [
    ...(PACKAGED ? [] : [MAIN]),
    ...(projectArgument ? [projectArgument] : []),
    `--user-data-dir=${userData}`,
    ...sandboxArgs(),
  ];
  const app = await electron.launch({
    ...(PACKAGED ? { executablePath: PACKAGED } : {}),
    args,
    env: childEnv(),
  });

  const chunks: string[] = [];
  const child = app.process();
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));

  let pipesClosed = false;
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  void closed.then(() => {
    pipesClosed = true;
  });
  const launched: Launched = {
    app,
    project,
    userData,
    output: () => chunks.join(""),
    // An exited app's last lines can still be in the pipe; a live one has
    // nothing more to give yet, so do not wait on it.
    drained: () =>
      pipesClosed || isRunning(child)
        ? Promise.resolve()
        : Promise.race([closed, new Promise<void>((done) => setTimeout(done, 2_000))]),
  };
  running.push(launched);
  return launched;
}

/** Neither exited nor killed by a signal. */
function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * SIGKILL the app and the engine it forked. Playwright starts the app as a
 * process group leader, and the fork stays in that group; killing only the
 * app would leave the engine serving for the rest of the suite.
 */
function killWithEngine(child: ChildProcess): void {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Is anything still listening on this port? */
function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const settle = (open: boolean): void => {
      socket.destroy();
      resolveOpen(open);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(2_000, () => settle(false));
  });
}

test.beforeAll(() => {
  if (PACKAGED) {
    if (existsSync(PACKAGED)) return;
    throw new Error(`STEAMTRAIN_E2E_APP points at ${PACKAGED}, which does not exist.`);
  }
  for (const path of [CLI, MAIN]) {
    if (existsSync(path)) continue;
    throw new Error(
      `${path} is missing.\nRun \`npm run build && npm run build:electron\` before the e2e suite.`,
    );
  }
});

test.afterEach(async () => {
  // `test.info()` rather than the hook's fixtures argument: Playwright insists
  // that argument be a destructuring pattern, and there is no fixture to take.
  const testInfo = test.info();
  for (const launched of running) {
    // The app's own stdout carries the engine's banner and any stack trace, and
    // is the only useful thing to look at when a launch assertion fails.
    // Written to a file and attached by path, not as a body: CI uploads
    // `test-results/`, and only a file lands there whole (the reporter cuts a
    // body short). The main process logs each quit step, so a quit that hung
    // shows where.
    if (testInfo.status !== testInfo.expectedStatus) {
      await launched.drained();
      const path = testInfo.outputPath("app-output.txt");
      writeFileSync(path, launched.output());
      await testInfo.attach("app-output", { path, contentType: "text/plain" });
    }
    // Bounded, so an app that will not quit fails its own test and not the
    // next one's setup too. Whatever close() reported, the process decides:
    // one still running is killed along with the engine it forked.
    const child = launched.app.process();
    await Promise.race([
      launched.app.close().catch(() => {}),
      new Promise<void>((done) => setTimeout(done, 15_000)),
    ]);
    if (isRunning(child)) killWithEngine(child);
  }
  running.length = 0;
});

test.afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  scratch.length = 0;
});

test("launches into the last project and shows the web UI", async () => {
  const { app, project } = await launchApp();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Loopback HTTP, not `file://` — the server enforces same-origin on every
  // mutation, so a window that ended up anywhere else would 403 on first use.
  expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  // The client puts the project in the title, so this is also the assertion
  // that the app reopened the *seeded* recent rather than picking its own.
  await expect(page).toHaveTitle(`steamtrain · ${basename(project)}`);
  await expect(page.locator("#topbar .wordmark")).toHaveText("steamtrain");

  // The rail scaffolding is built by the client bundle, so its presence means
  // the hashed static assets resolved and the scripts ran.
  await expect(page.locator("#wflist")).toHaveCount(1);

  // A health chip needs a round trip to `/api/doctor` and back into the DOM:
  // shell → forked engine → REST → client, asserted in one place.
  await expect(page.locator("#health .chip").first()).toBeVisible();

  // The preload bridge is the one thing the renderer cannot get over HTTP.
  const bridge = await page.evaluate(() => window.steamtrainDesktop);
  expect(bridge?.platform).toBe(process.platform);
});

test("lists the app's projects in the topbar switcher", async () => {
  // The switcher is the one surface whose data comes over IPC rather than
  // HTTP, so nothing short of the real app proves the chain: crumb click →
  // preload bridge → main → each project's own `.steamtrain/runs` → rows.
  const other = scratchDir("steamtrain-other-");
  const { app, project } = await launchApp(undefined, [other]);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.locator("#projectCrumb").click();
  const rows = page.locator("#projectMenu .proj-row:not(.open-folder)");
  await expect(rows).toHaveCount(2);
  // The open project leads and is the marked one; the other recent follows.
  await expect(rows.nth(0)).toHaveClass(/current/);
  await expect(rows.nth(0).locator(".name")).toHaveText(basename(project));
  await expect(rows.nth(1).locator(".name")).toHaveText(basename(other));
  // Neither scratch project has ever run anything.
  await expect(rows.nth(0).locator(".state")).toHaveText("idle");

  // Escape puts it away without switching anything.
  await page.keyboard.press("Escape");
  await expect(page.locator("#projectMenu")).toBeHidden();
  await expect(page).toHaveTitle(`steamtrain · ${basename(project)}`);
});

test("uses an explicit project path instead of the saved project", async () => {
  const requested = scratchDir("steamtrain-requested-");
  const { app } = await launchApp(requested);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await expect(page).toHaveTitle(`steamtrain · ${basename(requested)}`);
});

test("leaves the page room for the window controls", async () => {
  const { app } = await launchApp();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Set by the preload, before the client scripts run.
  await expect(page.locator("html")).toHaveClass(/desktop-app/);

  // On macOS the title bar is hidden and the controls land inside the topbar,
  // so the row has to start clear of them. Everywhere else the window has its
  // own title bar and the topbar keeps its ordinary padding.
  const padding = await page.evaluate(() => {
    const bar = document.getElementById("topbar");
    return bar ? Number.parseFloat(getComputedStyle(bar).paddingLeft) : Number.NaN;
  });
  if (process.platform === "darwin") expect(padding).toBeGreaterThanOrEqual(72);
  else expect(padding).toBe(16);

  // The stylesheet's half of the arrangement is platform-independent, so it can
  // be measured anywhere: turning the class on has to move the row clear of the
  // controls *and* turn the bar into a drag handle, without swallowing the
  // presses meant for the controls drawn inside it. Only the macOS leg would
  // otherwise ever run these rules.
  const overlaid = await page.evaluate((inset) => {
    const root = document.documentElement;
    root.classList.add("desktop-titlebar-overlay");
    root.style.setProperty("--desktop-titlebar-inset", `${inset}px`);
    const bar = document.getElementById("topbar");
    const brand = document.querySelector("#topbar .brand");
    if (!bar || !brand) return null;
    const style = getComputedStyle(bar);
    return {
      padding: Number.parseFloat(style.paddingLeft),
      bar: style.getPropertyValue("-webkit-app-region"),
      brand: getComputedStyle(brand).getPropertyValue("-webkit-app-region"),
    };
  }, TITLE_BAR_INSET_PX);
  expect(overlaid).toEqual({ padding: TITLE_BAR_INSET_PX, bar: "drag", brand: "no-drag" });
});

test("quits when its window is closed", async () => {
  const { app } = await launchApp();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const port = Number(new URL(page.url()).port);
  // Held onto now: once the app is gone, `app.process()` has nothing to return.
  const child = app.process();

  // What the close button does, from the main process's point of view.
  // Swallowing the failure is deliberate: this call is what makes the app exit,
  // so the reply can lose the race with the process it just ended.
  await app
    .evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.close();
    })
    .catch(() => {});

  // Closing the last window has to reach the same shutdown that Quit does.
  // Anything less leaves a forked engine serving a window nobody can see.
  await expect.poll(() => child.exitCode !== null, { timeout: 20_000 }).toBe(true);
  expect(await portAccepts(port)).toBe(false);
});

test("stops the engine and saves its window when it quits", async () => {
  const { app, userData } = await launchApp();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const port = Number(new URL(page.url()).port);
  expect(port).toBeGreaterThan(0);
  expect(await portAccepts(port)).toBe(true);

  await app.close();

  // The engine is a forked child, so nothing stops it unless `will-quit` gets
  // all the way through — the invariant that shipped broken in M1.
  await expect.poll(() => portAccepts(port), { timeout: 20_000 }).toBe(false);

  // Geometry is captured on `close`, which is the only path that runs when the
  // app is quit outright rather than having its window closed first.
  const saved: unknown = JSON.parse(readFileSync(join(userData, STATE_FILE), "utf8"));
  const window = (saved as { window?: { width?: unknown; height?: unknown } }).window;
  expect(typeof window?.width).toBe("number");
  expect(typeof window?.height).toBe("number");
});
