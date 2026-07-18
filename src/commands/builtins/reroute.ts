import type { SlashCommand } from "../types";

export const rerouteCommand: SlashCommand = {
  name: "reroute",
  description: "Re-route steps whose agent is not ready to a ready agent (staged; Ctrl+R to run)",
  usage: "/reroute",
  execute(args, ctx) {
    if (args.length > 0) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "error", text: "usage: /reroute" }],
      };
    }

    if (!ctx.rerouteWorkflow) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "/reroute is only available in the TUI workflow picker" }],
      };
    }

    return ctx.rerouteWorkflow();
  },
};
