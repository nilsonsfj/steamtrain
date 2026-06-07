import type { SlashCommand } from "../types";

export const saveWorkflowsCommand: SlashCommand = {
  name: "saveworkflows",
  description: "Save session workflow step changes to ~/.steamtrain/workflows.json",
  usage: "/saveworkflows",
  execute(args, ctx) {
    if (args.length > 0) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "error", text: "usage: /saveworkflows" }],
      };
    }

    if (!ctx.saveWorkflows) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "/saveworkflows is only available in the TUI" }],
      };
    }

    return ctx.saveWorkflows();
  },
};
