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
 * So every uncaught exception is logged, and the box is kept for the one case
 * where it helps: the app is up, not quitting, and has a window to show it over.
 */

export interface UncaughtDeps {
  /** A quit is under way. */
  quitting: () => boolean;
  /** A live window exists for the box to appear over. */
  hasWindow: () => boolean;
  /** Record the error. Must not throw, and should not be lost at exit. */
  log: (text: string) => void;
  /** `dialog.showErrorBox`. */
  showErrorBox: (title: string, content: string) => void;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

export function handleUncaught(err: unknown, deps: UncaughtDeps): void {
  const detail = describeError(err);
  deps.log(`[steamtrain] uncaught exception in the main process: ${detail}`);
  if (deps.quitting() || !deps.hasWindow()) return;
  deps.showErrorBox("A JavaScript error occurred in the main process", detail);
}
