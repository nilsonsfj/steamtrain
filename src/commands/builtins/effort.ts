import { effortsForModel, supportsEffort } from "../../agents";
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

    const efforts = effortsForModel(entry.agent, entry.model, ctx.config);
    if (args.length === 0) {
      const current = entry.effort ?? "default";
      if (!supportsEffort(entry.agent, entry.model, ctx.config)) {
        return {
          handled: true,
          clearInput: true,
          notices: [
            {
              level: "info",
              text: `${entry.model} does not support effort levels (current: ${current})`,
            },
          ],
        };
      }
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text: `effort for ${entry.model}: ${efforts.join(", ")} (current: ${current})`,
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
        notices: [{ level: "info", text: `effort cleared for '${ctx.mode}' (model default)` }],
      };
    }

    if (!supportsEffort(entry.agent, entry.model, ctx.config)) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "error",
            text: `${entry.model} does not support effort levels`,
          },
        ],
      };
    }

    if (!efforts.includes(next)) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "error",
            text: `unknown effort '${next}' for ${entry.model}; try: ${efforts.join(", ")} or clear`,
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
    const efforts = effortsForModel(entry.agent, entry.model, ctx.config);
    if (efforts.length === 0) return ["clear"];
    return [...efforts, "clear"];
  },
};
