/**
 * Double-press confirmation for destructive TUI actions (quit while a run is
 * owned, Ctrl+Q cancel). Matches the history delete / arrival re-run pattern:
 * first press arms a short window; second press within the window confirms.
 */

export const CONFIRM_WINDOW_MS = 3000;

export type ConfirmAction = "quit" | "cancel";

export interface ConfirmArm {
  action: ConfirmAction;
  at: number;
}

export const QUIT_CONFIRM_NOTICE =
  "a workflow is still running — press Ctrl+C or /exit again to quit and cancel it (or d to detach first)";

export const CANCEL_CONFIRM_NOTICE = "press Ctrl+Q again to cancel the running workflow";

/**
 * Arm a confirmation, or confirm if the same action is already armed within
 * the window. Switching actions (quit ↔ cancel) re-arms rather than confirming.
 */
export function armOrConfirm(
  armed: ConfirmArm | null,
  action: ConfirmAction,
  now = Date.now(),
  windowMs = CONFIRM_WINDOW_MS,
): { confirmed: boolean; next: ConfirmArm | null } {
  if (armed && armed.action === action && now - armed.at <= windowMs) {
    return { confirmed: true, next: null };
  }
  return { confirmed: false, next: { action, at: now } };
}
