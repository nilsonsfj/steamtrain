import type { SlashCommand } from "../types";

export const describeWorkflowCommand: SlashCommand = {
  name: "describe-workflow",
  description: "View or edit the description of a workflow",
  usage: "/describe-workflow [new-description]",
  execute(args, ctx) {
    if (!ctx.updateWorkflowDescription) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "/describe-workflow is only available in the TUI" }],
      };
    }

    if (!ctx.workflowSpec) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "warn",
            text: "/describe-workflow requires an active workflow preview",
          },
        ],
      };
    }

    if (args.length === 0) {
      const desc = ctx.workflowSpec.description ?? "(none)";
      const preview = desc.length > 120 ? `${desc.slice(0, 117)}...` : desc;
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text: `description for '${ctx.workflowSpec.name}': ${preview}`,
          },
        ],
      };
    }

    const newDesc = args.join(" ");
    return ctx.updateWorkflowDescription(ctx.workflowSpec.name, newDesc);
  },
};
