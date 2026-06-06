import { modelsForAgent } from "../../agents";
import { isWorkspaceMode } from "../../tui/modes";
import type { SlashCommand } from "../types";

export const modelCommand: SlashCommand = {
  name: "model",
  description: "Set or list models for the current workspace tab",
  usage: "/model [model-id]",
  execute(args, ctx) {
    if (!isWorkspaceMode(ctx.mode)) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "/model only applies to workspace tabs (not workflow)" }],
      };
    }

    const entry = ctx.workspaceMap.get(ctx.mode);
    if (!entry) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "error", text: `unknown workspace '${ctx.mode}'` }],
      };
    }

    const models = modelsForAgent(entry.agent);
    if (args.length === 0) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text: `models for ${entry.agent}: ${models.join(", ")} (current: ${entry.model})`,
          },
        ],
      };
    }

    const next = args[0]!;
    if (!models.includes(next)) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "error",
            text: `unknown model '${next}' for ${entry.agent}; try: ${models.join(", ")}`,
          },
        ],
      };
    }

    ctx.updateWorkspace(ctx.mode, { model: next });
    return {
      handled: true,
      clearInput: true,
      notices: [{ level: "info", text: `model set to ${next} for '${ctx.mode}'` }],
    };
  },
  complete(args, ctx) {
    if (!isWorkspaceMode(ctx.mode)) return [];
    const entry = ctx.workspaceMap.get(ctx.mode);
    if (!entry) return [];
    if (args.length > 1) return [];
    return modelsForAgent(entry.agent);
  },
};
