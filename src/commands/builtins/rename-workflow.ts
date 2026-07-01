import type { SlashCommand } from "../types";

export const renameWorkflowCommand: SlashCommand = {
  name: "rename-workflow",
  description: "Rename a user or project workflow",
  usage: "/rename-workflow [old-name] <new-name>",
  execute(args, ctx) {
    if (!ctx.renameWorkflow) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "/rename-workflow is only available in the TUI" }],
      };
    }

    let oldName = "";
    let newName = "";
    if (args.length === 1) {
      newName = args[0]!.trim();
    } else if (args.length === 2) {
      oldName = args[0]!.trim();
      newName = args[1]!.trim();
    } else {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "error", text: "usage: /rename-workflow [old-name] <new-name>" }],
      };
    }

    if (!newName) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "error", text: "a new name is required" }],
      };
    }

    return ctx.renameWorkflow(oldName, newName);
  },
  complete(args, ctx) {
    if (args.length > 1) return [];
    const token = (args[0] ?? "").toLowerCase();
    return (ctx.userWorkflowNames ?? []).filter((name) => name.toLowerCase().startsWith(token));
  },
};
