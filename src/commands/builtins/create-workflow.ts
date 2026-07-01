import type { SlashCommand } from "../types";
import { extractWorkflowScope } from "../workflow-scope";

export const createWorkflowCommand: SlashCommand = {
  name: "create-workflow",
  description: "Generate a new workflow from a description, via an agent (LLM delegation)",
  usage: "/create-workflow [--project] <describe the workflow you want>",
  execute(args, ctx) {
    const { scope, rest } = extractWorkflowScope(args);
    const description = rest.join(" ").trim();
    if (!description) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "error",
            text: "usage: /create-workflow [--project] <describe the workflow you want>",
          },
        ],
      };
    }

    if (!ctx.createWorkflow) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "/create-workflow is only available in the TUI" }],
      };
    }

    return ctx.createWorkflow(description, scope);
  },
};
