import type { SlashCommand } from "../types";

export const historyCommand: SlashCommand = {
  name: "history",
  description: "Browse past workflow runs",
  execute(_args, ctx) {
    if (!ctx.openHistory) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "run history is not available here" }],
      };
    }
    return ctx.openHistory();
  },
};
