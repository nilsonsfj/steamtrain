/**
 * What to do about runs still in flight when the app is asked to quit.
 *
 * A detached run outliving the window is a feature, not an accident — the CLI
 * or a later launch re-attaches to it. But M1 did it silently, which makes a
 * deliberate design read like a leak: the user quits mid-run and has no idea
 * whether the work continued, and no way to say what they wanted.
 *
 * The choice offered is deliberately not a yes/no. "Leave running" and "Stop
 * them" are both legitimate; guessing either one is what caused the confusion.
 */

export type QuitChoice = "leave-running" | "stop-runs" | "cancel";

export interface QuitPromptSpec {
  message: string;
  detail: string;
  buttons: string[];
  /** Index of the button Enter activates. */
  defaultId: number;
  /** Index of the button Escape activates. */
  cancelId: number;
  /** Maps the returned button index back onto a choice. */
  choices: QuitChoice[];
}

/**
 * The dialog to show for `active` runs in flight.
 *
 * "Leave running" is the default because it is the non-destructive answer: a
 * mistaken Enter costs the user nothing, where the alternative throws away work
 * that may have been going for an hour.
 */
export function quitPromptSpec(active: number): QuitPromptSpec {
  const plural = active === 1 ? "run is" : "runs are";
  return {
    message: `${active} ${plural} still going.`,
    detail:
      "Background runs keep going after the app quits — you can re-attach from a later launch or from the CLI. Stopping them ends the work where it is.",
    buttons: ["Leave Running", "Stop Runs", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    choices: ["leave-running", "stop-runs", "cancel"],
  };
}

/** Resolve a `dialog.showMessageBox` response index to a choice. */
export function quitChoiceFor(spec: QuitPromptSpec, response: number): QuitChoice {
  // An out-of-range index can only come from a dismissed dialog, and cancelling
  // is the only safe reading of "the user didn't answer".
  return spec.choices[response] ?? "cancel";
}
