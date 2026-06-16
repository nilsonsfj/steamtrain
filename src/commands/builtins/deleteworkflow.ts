import type { SlashCommand } from "../types";

export const deleteWorkflowCommand: SlashCommand = {
  name: "deleteworkflow",
  description: "Delete a user workflow from ~/.steamtrain/workflows.json",
  usage: "/deleteworkflow <name>",
  execute(args, ctx) {
    if (!ctx.deleteWorkflow) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "/deleteworkflow is only available in the TUI" }],
      };
    }

    const name = args.join(" ").trim();
    if (!name) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "error", text: "usage: /deleteworkflow <name>" }],
      };
    }

    return ctx.deleteWorkflow(name);
  },
  complete(args, ctx) {
    if (args.length > 1) return [];
    const token = (args[0] ?? "").toLowerCase();
    return (ctx.userWorkflowNames ?? []).filter((name) => name.toLowerCase().startsWith(token));
  },
};
