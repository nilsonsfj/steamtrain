import { join } from "node:path";
import { BrowserWindow, app, shell } from "electron";
import type { WindowStateShape } from "./store";
import { MIN_HEIGHT, MIN_WIDTH, type RestoredWindowState } from "./window-state";

/**
 * The app window and the navigation rules that keep it a steamtrain window.
 *
 * The UI is loaded over `http://127.0.0.1:<port>` rather than `file://` or a
 * custom scheme. That is not incidental: the server enforces same-origin on
 * every state-changing request and authenticates with a `SameSite=Strict`
 * cookie, both of which need a real HTTP origin. A `file://` document sends
 * `Origin: null` and a custom scheme is rejected outright, so either would turn
 * every mutation into a 403.
 */

/** Debounce for geometry writes — resize and move fire continuously. */
const SAVE_DEBOUNCE_MS = 400;

/** Open a URL in the user's browser, but only for schemes worth trusting. */
export function openExternal(url: string): void {
  // Deliberately https-only. This mirrors the client's own `safeExternalLink`,
  // and keeps `shell.openExternal` — which can launch arbitrary protocol
  // handlers — away from anything a page can inject.
  if (url.startsWith("https://")) void shell.openExternal(url);
}

/**
 * Apply navigation and permission rules to every web contents the app creates.
 *
 * Installed once against the `app` event rather than per-window, so anything
 * created later inherits them by construction instead of by remembering to.
 */
export function installWebContentsGuards(isAppUrl: (url: string) => boolean): void {
  app.on("web-contents-created", (_event, contents) => {
    // Links that would open a new window leave for the OS browser instead.
    contents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: "deny" };
    });

    // In-place navigation is confined to the local server; anything else is an
    // external link that happened not to use target=_blank.
    contents.on("will-navigate", (event, url) => {
      if (isAppUrl(url)) return;
      event.preventDefault();
      openExternal(url);
    });

    // The UI needs no camera, microphone, geolocation or notification
    // permission, so nothing has a legitimate reason to ask.
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
  });
}

export interface CreateWindowOptions {
  /** Origin of the local engine, e.g. `http://127.0.0.1:53412`. */
  url: string;
  /** Project directory, shown in the title bar. */
  projectName: string;
  /** Geometry to open at, already validated against the attached displays. */
  state: RestoredWindowState;
  /** Called (debounced) whenever the user resizes, moves or maximizes. */
  onStateChange?: (state: WindowStateShape) => void;
}

/**
 * Read back the geometry worth saving.
 *
 * `getNormalBounds` rather than `getBounds`: while maximized the latter reports
 * the screen, and restoring that on a later launch would leave a window that
 * un-maximizes to full screen and can never be made smaller.
 */
function captureState(win: BrowserWindow): WindowStateShape {
  const bounds = win.getNormalBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: win.isMaximized(),
  };
}

/**
 * Create the main window and load the UI.
 *
 * The window is created hidden and shown on `ready-to-show` so the user never
 * sees an empty white frame while the page loads.
 */
export function createWindow(options: CreateWindowOptions): BrowserWindow {
  const { state } = options;
  const win = new BrowserWindow({
    ...(typeof state.x === "number" && typeof state.y === "number"
      ? { x: state.x, y: state.y }
      : {}),
    width: state.width,
    height: state.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: `steamtrain — ${options.projectName}`,
    backgroundColor: "#0e1116",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });

  win.once("ready-to-show", () => {
    // Maximizing before the first paint would show the un-maximized frame for
    // a moment; doing it here keeps the restore invisible.
    if (state.maximized) win.maximize();
    win.show();
  });

  if (options.onStateChange) {
    const save = options.onStateChange;
    let timer: NodeJS.Timeout | undefined;
    const schedule = (): void => {
      if (win.isDestroyed()) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!win.isDestroyed()) save(captureState(win));
      }, SAVE_DEBOUNCE_MS);
      timer.unref?.();
    };
    // Listed one by one: the union of these event names does not satisfy any
    // single `on` overload, so a loop over them will not type-check.
    win.on("resize", schedule);
    win.on("move", schedule);
    win.on("maximize", schedule);
    win.on("unmaximize", schedule);
    // `close` fires before the window is gone, so this is the last chance to
    // read geometry — and the only one that runs when the app is quit outright.
    win.on("close", () => {
      clearTimeout(timer);
      if (!win.isDestroyed()) save(captureState(win));
    });
  }

  void win.loadURL(options.url);
  return win;
}

/** Render an in-window error page instead of leaving a blank frame behind. */
export function showErrorPage(win: BrowserWindow, title: string, detail: string): void {
  const esc = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>steamtrain — ${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0e1116; color: #e6edf3;
         font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { max-width: 44rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; color: #34d3c4; }
  p { margin: 0 0 1rem; color: #9aa7b2; }
  pre { background: #161b22; border: 1px solid #26303b; border-radius: 8px;
        padding: 1rem; overflow: auto; max-height: 22rem; font-size: 12px;
        white-space: pre-wrap; }
</style></head>
<body><main>
  <h1>${esc(title)}</h1>
  <p>The steamtrain engine stopped. Quit and reopen the app to try again.</p>
  <pre>${esc(detail || "(no output captured)")}</pre>
</main></body></html>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}
