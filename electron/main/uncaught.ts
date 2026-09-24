/**
 * What to do about an exception nothing in the main process caught.
 *
 * Electron's own answer is a modal error box. With a window up, that is an
 * unwelcome but visible report. Without one, it is an app-modal alert with
 * nothing to sit in front of: it blocks the main thread, so a quit in progress
 * never finishes and only a force-kill ends the process (#266). That is not a
 * hypothetical. Electron 33 throws one of its own during teardown: its
 * `BrowserWindow` visibility listener can run on a `hide` that arrives after
 * the window is destroyed, and fails with "Object has been destroyed".
 *
 * So every uncaught exception is logged, and the box is dropped exactly where
 * it would strand the user: during a quit, or once the app's window has gone.
 * Before the first window opens the box stays, as it does in `reportFatal`: at
 * launch the app is frontmost, so an app-modal alert is seen, and a startup
 * error with no report at all would be worse.
 */

export interface UncaughtDeps {
  /** A quit is under way. */
  quitting: () => boolean;
  /** The app had a window and no longer does. */
  windowGone: () => boolean;
  /** Record the error. Must not throw, and should not be lost at exit. */
  log: (text: string) => void;
  /** `dialog.showErrorBox`. */
  showErrorBox: (title: string, content: string) => void;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * `kind` is how the error escaped. An unhandled rejection is only logged:
 * Electron's own default for those is a console warning, never a box, and
 * some are routine (a `loadURL` superseded by the next navigation rejects).
 */
export function handleUncaught(
  err: unknown,
  deps: UncaughtDeps,
  kind: "exception" | "rejection" = "exception",
): void {
  const detail = describeError(err);
  deps.log(
    `[steamtrain] ${kind === "rejection" ? "unhandled rejection" : "uncaught exception"} in the main process: ${detail}`,
  );
  if (kind === "rejection" || deps.quitting() || deps.windowGone()) return;
  deps.showErrorBox("A JavaScript error occurred in the main process", detail);
}
