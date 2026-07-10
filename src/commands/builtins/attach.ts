import type { SlashCommand } from "../types";

/**
 * `/attach [runId]` — attach the live view to an in-flight run (detached CLI
 * run, another process, or a queued one): replay its record so far, then tail
 * live. With no id, attaches to the single active run or lists candidates.
 */
export const attachCommand: SlashCommand = {
  name: "attach",
  description: "Attach to an in-flight workflow run (replay + live tail)",
  usage: "/attach [runId]",
  execute(args, ctx) {
    if (!ctx.attachRun) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "attaching to runs is not available here" }],
      };
    }
    return ctx.attachRun(args[0]);
  },
};
