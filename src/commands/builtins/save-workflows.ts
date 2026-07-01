import type { SlashCommand } from "../types";

export const saveWorkflowsCommand: SlashCommand = {
  name: "save-workflows",
  description: "Save session workflow step changes to ~/.steamtrain/workflows.json",
  usage: "/save-workflows",
  execute(args, ctx) {
    if (args.length > 0) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "error", text: "usage: /save-workflows" }],
      };
    }

    if (!ctx.saveWorkflows) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "/save-workflows is only available in the TUI" }],
      };
    }

    return ctx.saveWorkflows();
  },
};
