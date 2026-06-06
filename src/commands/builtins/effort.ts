import { effortsForAgent } from "../../agents";
import { isWorkspaceMode } from "../../tui/modes";
import type { SlashCommand } from "../types";

export const effortCommand: SlashCommand = {
  name: "effort",
  description: "Set or list reasoning effort for the current workspace tab",
  usage: "/effort [level|clear]",
  execute(args, ctx) {
    if (!isWorkspaceMode(ctx.mode)) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "warn", text: "/effort only applies to workspace tabs (not workflow)" }],
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

    const efforts = effortsForAgent(entry.agent);
    if (args.length === 0) {
      const current = entry.effort ?? "default";
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text: `effort for ${entry.agent}: ${efforts.join(", ")} (current: ${current})`,
          },
        ],
      };
    }

    const next = args[0]!;
    if (next === "clear") {
      ctx.updateWorkspace(ctx.mode, { effort: undefined });
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "info", text: `effort cleared for '${ctx.mode}' (agent default)` }],
      };
    }

    if (!efforts.includes(next)) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "error",
            text: `unknown effort '${next}' for ${entry.agent}; try: ${efforts.join(", ")} or clear`,
          },
        ],
      };
    }

    ctx.updateWorkspace(ctx.mode, { effort: next });
    return {
      handled: true,
      clearInput: true,
      notices: [{ level: "info", text: `effort set to ${next} for '${ctx.mode}'` }],
    };
  },
  complete(args, ctx) {
    if (!isWorkspaceMode(ctx.mode)) return [];
    const entry = ctx.workspaceMap.get(ctx.mode);
    if (!entry) return [];
    if (args.length > 1) return [];
    return [...effortsForAgent(entry.agent), "clear"];
  },
};
