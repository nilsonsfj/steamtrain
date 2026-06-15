import type { SlashCommand } from "../types";

export const createWorkflowCommand: SlashCommand = {
  name: "createworkflow",
  description: "Generate a new workflow from a description, via an agent (LLM delegation)",
  usage: "/createworkflow <describe the workflow you want>",
  execute(args, ctx) {
    const description = args.join(" ").trim();
    if (!description) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "error",
            text: "usage: /createworkflow <describe the workflow you want>",
          },
        ],
      };
    }

    if (!ctx.createWorkflow) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "/createworkflow is only available in the TUI" }],
      };
    }

    return ctx.createWorkflow(description);
  },
};
