import type { QuitChoice } from "./quit-prompt";

/**
 * The quit sequence, separated from the `will-quit` wiring so it can be tested.
 *
 * This is worth extracting because of one invariant that is easy to break and
 * expensive when broken: the handler calls `event.preventDefault()`, so every
 * path through here must end at `quit()`. It has already failed once — a
 * rejected teardown promise left the app permanently unquittable, with no way
 * out but a force-kill.
 *
 * The one exception is the user choosing Cancel, which is a decision not to
 * quit; that returns `"cancelled"` so the caller can re-arm.
 */

export interface ShutdownDeps {
  /** What to do about runs in flight. */
  askAboutRuns: () => Promise<QuitChoice>;
  /** Cancel everything in flight — only called for `"stop-runs"`. */
  cancelActive: () => Promise<void>;
  /** Stop polling. */
  stopWatch: () => void;
  /** Stop the engine child process. */
  stopServer: () => Promise<void>;
  /** `app.quit()`. */
  quit: () => void;
  /** Somewhere to report a failure that must not stop the quit. */
  onError?: (err: unknown) => void;
}

export type ShutdownOutcome = "quit" | "cancelled";

/**
 * Run the quit sequence.
 *
 * Every step after the user's choice is best-effort: a run that refuses to
 * cancel, or an engine that will not stop, must not strand the user in an app
 * that cannot be closed. Failures are reported, then the quit proceeds.
 */
export async function performQuit(deps: ShutdownDeps): Promise<ShutdownOutcome> {
  let choice: QuitChoice;
  try {
    choice = await deps.askAboutRuns();
  } catch (err) {
    // If we cannot even ask, quitting is the safer default: leaving runs going
    // is what quitting has always done, and refusing to quit is not an option.
    deps.onError?.(err);
    choice = "leave-running";
  }

  if (choice === "cancel") return "cancelled";

  if (choice === "stop-runs") {
    try {
      await deps.cancelActive();
    } catch (err) {
      deps.onError?.(err);
    }
  }

  try {
    deps.stopWatch();
  } catch (err) {
    deps.onError?.(err);
  }

  try {
    await deps.stopServer();
  } catch (err) {
    deps.onError?.(err);
  }

  deps.quit();
  return "quit";
}
