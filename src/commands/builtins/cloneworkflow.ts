import type { SlashCommand } from "../types";
import { extractWorkflowScope } from "../workflow-scope";

export const cloneWorkflowCommand: SlashCommand = {
  name: "cloneworkflow",
  description: "Save the selected workflow under a new name (user copy, or --project)",
  usage: "/cloneworkflow [--project] <new-name>",
  execute(args, ctx) {
    if (!ctx.cloneWorkflow) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "/cloneworkflow is only available in the TUI" }],
      };
    }

    const { scope, rest } = extractWorkflowScope(args);
    const newName = rest.join(" ").trim();
    if (!newName) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "error", text: "usage: /cloneworkflow [--project] <new-name>" }],
      };
    }

    return ctx.cloneWorkflow(newName, scope);
  },
};
