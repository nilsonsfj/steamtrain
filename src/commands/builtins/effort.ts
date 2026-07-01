import { effortsForModel, supportsEffort } from "../../agents";
import { isWorkspaceMode } from "../../tui/modes";
import { completeDraftEffortArgs, executeDraftEffortCommand } from "../draft-effort-target";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "../types";
import { hasWorkflowStepTarget, workflowStepUnavailableNotice } from "../workflow-step-target";

export const effortCommand: SlashCommand = {
  name: "effort",
  description:
    "Set or list reasoning effort for the current workspace tab, workflow step, or draft target",
  usage: "/effort [level|clear]",
  execute(args, ctx) {
    if (hasWorkflowStepTarget(ctx)) {
      return executeWorkflowEffortCommand(args, ctx);
    }

    if (ctx.draftModel) {
      return executeDraftEffortCommand(args, ctx.draftModel);
    }

    if (!isWorkspaceMode(ctx.mode)) {
      return workflowStepUnavailableNotice("effort");
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
    if (hasWorkflowStepTarget(ctx)) {
      return completeWorkflowEffortArgs(args, ctx);
    }
    if (ctx.draftModel) {
      return completeDraftEffortArgs(args, ctx.draftModel);
    }
    if (!isWorkspaceMode(ctx.mode)) return [];
    const entry = ctx.workspaceMap.get(ctx.mode);
    if (!entry) return [];
    if (args.length > 1) return [];
    const efforts = effortsForModel(entry.agent, entry.model, ctx.config);
    if (efforts.length === 0) return ["clear"];
    return [...efforts, "clear"];
  },
};

function executeWorkflowEffortCommand(
  args: string[],
  ctx: SlashCommandContext,
): SlashCommandResult {
  const step = ctx.workflowStep!;
  const update = ctx.updateWorkflowStep!;

  const efforts = effortsForModel(step.agent, step.model, ctx.config);
  if (args.length === 0) {
    const current = step.effort ?? "default";
    if (!supportsEffort(step.agent, step.model, ctx.config)) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text: `${step.model} does not support effort levels (step '${step.stepId}': ${current})`,
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
          text: `effort for ${step.model} on step '${step.stepId}': ${efforts.join(", ")} (current: ${current})`,
        },
      ],
    };
  }

  const next = args[0]!;
  if (next === "clear") {
    update(step.stepId, { effort: undefined });
    return {
      handled: true,
      clearInput: true,
      notices: [
        { level: "info", text: `effort cleared for step '${step.stepId}' (model default)` },
      ],
    };
  }

  if (!supportsEffort(step.agent, step.model, ctx.config)) {
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "error",
          text: `${step.model} does not support effort levels`,
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
          text: `unknown effort '${next}' for ${step.model}; try: ${efforts.join(", ")} or clear`,
        },
      ],
    };
  }

  update(step.stepId, { effort: next });
  return {
    handled: true,
    clearInput: true,
    notices: [{ level: "info", text: `step '${step.stepId}' effort set to ${next}` }],
  };
}

function completeWorkflowEffortArgs(args: string[], ctx: SlashCommandContext): readonly string[] {
  const step = ctx.workflowStep;
  if (!step || args.length > 1) return [];
  const efforts = effortsForModel(step.agent, step.model, ctx.config);
  if (efforts.length === 0) return ["clear"];
  return [...efforts, "clear"];
}
