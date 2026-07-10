import type { SlashCommand } from "../types";

/**
 * `/runs` — open the run browser: in-flight runs (Enter attaches) listed
 * above recorded history.
 */
export const runsCommand: SlashCommand = {
  name: "runs",
  description: "Browse in-flight and past workflow runs",
  execute(_args, ctx) {
    if (!ctx.openHistory) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "the run browser is not available here" }],
      };
    }
    return ctx.openHistory();
  },
};
