import type { SlashCommand } from "../types";

/**
 * `/cancel-run [runId]` — request cancellation of a live run through the
 * shared registry (works on runs owned by other processes, e.g. a detached
 * CLI run). With no id, targets the currently attached run.
 */
export const cancelRunCommand: SlashCommand = {
  name: "cancel-run",
  description: "Cancel a live workflow run by id (default: the attached run)",
  usage: "/cancel-run [runId]",
  execute(args, ctx) {
    if (!ctx.cancelLiveRun) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "run cancellation is not available here" }],
      };
    }
    return ctx.cancelLiveRun(args[0]);
  },
};
