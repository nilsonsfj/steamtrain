import { effortsForModel, supportsEffort } from "../../agents";
import { isWorkspaceMode } from "../../tui/modes";
import { buildBulkEffortPatches, listRetargetableSteps } from "../../tui/workflow-step-editor";
import { completeDraftEffortArgs, executeDraftEffortCommand } from "../draft-effort-target";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "../types";
import {
  hasWorkflowStepTarget,
  takeAllFlag,
  workflowStepUnavailableNotice,
} from "../workflow-step-target";

export const effortCommand: SlashCommand = {
  name: "effort",
  description:
    "Set or list reasoning effort for the current workspace tab, workflow step, or draft target",
  usage: "/effort [level|clear] [--all]",
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
  const { args: bare, all } = takeAllFlag(args);

  if (!step.agent || !step.model) {
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "warn",
          text: `step '${step.stepId}' uses model-only/class binding — pin an agent with /agent before setting effort`,
        },
      ],
    };
  }

  const efforts = effortsForModel(step.agent, step.model, ctx.config);
  if (bare.length === 0) {
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
          text: `effort for ${step.model} on step '${step.stepId}': ${efforts.join(", ")} (current: ${current})${ctx.workflowSpec ? " · append --all to apply where supported" : ""}`,
        },
      ],
    };
  }

  const next = bare[0]!;
  if (next === "clear") {
    if (all && ctx.workflowSpec) {
      const steps = listRetargetableSteps(ctx.workflowSpec);
      const patches = buildBulkEffortPatches(steps, undefined, ctx.config);
      for (const [stepId, patch] of Object.entries(patches)) {
        update(stepId, patch);
      }
      const count = Object.keys(patches).length;
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text:
              count === 0
                ? "every agent step already uses the model default effort"
                : `effort cleared on ${count} step(s) · /save-workflows to persist`,
          },
        ],
      };
    }
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

  if (all && ctx.workflowSpec) {
    const steps = listRetargetableSteps(ctx.workflowSpec);
    const patches = buildBulkEffortPatches(steps, next, ctx.config);
    for (const [stepId, patch] of Object.entries(patches)) {
      update(stepId, patch);
    }
    const count = Object.keys(patches).length;
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "info",
          text:
            count === 0
              ? `every compatible step already on effort ${next}`
              : `effort set to ${next} on ${count} step(s) · /save-workflows to persist`,
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
  if (!step) return [];
  const { args: bare } = takeAllFlag(args);
  if (bare.length > 1) return [];
  // After stripping --all, a single bare value means suggest appending --all.
  if (
    bare.length === 1 &&
    bare[0] &&
    !bare[0].startsWith("-") &&
    !args.includes("--all") &&
    !args.includes("-a")
  ) {
    return ["--all"];
  }
  const efforts =
    step.agent && step.model ? effortsForModel(step.agent, step.model, ctx.config) : [];
  if (efforts.length === 0) return ["clear"];
  return [...efforts, "clear"];
}
