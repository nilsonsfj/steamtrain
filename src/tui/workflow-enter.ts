/** What Enter does in workflow mode, once no command or pending form claimed it. */
export type WorkflowEnterAction =
  /** Drill into the selected step of the run on screen. */
  | { kind: "open-details"; view: "live" | "preview" }
  /** Already drilled in: resume (or run) the workflow on screen. */
  | { kind: "run" }
  | { kind: "focus-create" }
  | { kind: "toggle-folder" }
  /** Preview the workflow selected in the picker. */
  | { kind: "preview"; name: string }
  | { kind: "none" };

export interface WorkflowEnterContext {
  /** A run was started (it may be running, done or failed) and is still on screen. */
  runOnScreen: boolean;
  /** The workflow previewed from the picker, if any. */
  previewing: boolean;
  /** Whether a step's details are already open. */
  detailsOpen: boolean;
  onCreateRow: boolean;
  onHeaderRow: boolean;
  /** The workflow under the picker's cursor. */
  selected?: string;
}

/**
 * Enter first drills into the selected step, and only once inside falls
 * through to resuming the workflow, so a stray Enter on a finished run
 * shows what happened instead of re-running it.
 */
export function workflowEnterAction(ctx: WorkflowEnterContext): WorkflowEnterAction {
  if (ctx.runOnScreen || ctx.previewing) {
    if (!ctx.detailsOpen)
      return { kind: "open-details", view: ctx.runOnScreen ? "live" : "preview" };
    return { kind: "run" };
  }
  if (ctx.onCreateRow) return { kind: "focus-create" };
  if (ctx.onHeaderRow) return { kind: "toggle-folder" };
  if (ctx.selected !== undefined) return { kind: "preview", name: ctx.selected };
  return { kind: "none" };
}
