import type { SlashCommand } from "../types";

export const cloneWorkflowCommand: SlashCommand = {
  name: "cloneworkflow",
  description: "Save the selected workflow under a new name as a user copy",
  usage: "/cloneworkflow <new-name>",
  execute(args, ctx) {
    if (!ctx.cloneWorkflow) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "/cloneworkflow is only available in the TUI" }],
      };
    }

    const newName = args.join(" ").trim();
    if (!newName) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "error", text: "usage: /cloneworkflow <new-name>" }],
      };
    }

    return ctx.cloneWorkflow(newName);
  },
};
