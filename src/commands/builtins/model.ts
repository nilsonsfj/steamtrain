import {
  effortForModelChange,
  formatModelOption,
  modelIdsForAgent,
  modelNameForAgent,
  modelsForAgent,
} from "../../agents";
import { isWorkspaceMode } from "../../tui/modes";
import { completeDraftModelArgs, executeDraftModelCommand } from "../draft-model-target";
import type { SlashCommand } from "../types";
import {
  completeWorkflowModelArgs,
  executeWorkflowModelCommand,
  hasWorkflowStepTarget,
  workflowStepUnavailableNotice,
} from "../workflow-step-target";

export const modelCommand: SlashCommand = {
  name: "model",
  description:
    "Set or list models for the current workspace tab, workflow step, or workflow drafting",
  usage: "/model [model-id]",
  execute(args, ctx) {
    if (hasWorkflowStepTarget(ctx)) {
      return executeWorkflowModelCommand(args, ctx);
    }

    if (!isWorkspaceMode(ctx.mode)) {
      // On the workflow picker, `/model` sets the model used to draft new
      // workflows (`/create-workflow`). Only available when the host wires it.
      if (ctx.draftModel) {
        return executeDraftModelCommand(args, ctx.draftModel);
      }
      return workflowStepUnavailableNotice("model");
    }

    const entry = ctx.workspaceMap.get(ctx.mode);
    if (!entry) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "error", text: `unknown workspace '${ctx.mode}'` }],
      };
    }

    const models = modelsForAgent(entry.agent, ctx.config);
    const modelIds = modelIdsForAgent(entry.agent, ctx.config);
    if (args.length === 0) {
      const currentName = modelNameForAgent(entry.agent, entry.model, ctx.config);
      const currentLabel =
        currentName === entry.model ? entry.model : `${currentName} (${entry.model})`;
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text: `models for ${entry.agent}: ${models.map(formatModelOption).join(", ")} (current: ${currentLabel})`,
          },
        ],
      };
    }

    const next = args[0]!;
    if (!modelIds.includes(next)) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "error",
            text: `unknown model '${next}' for ${entry.agent}; try: ${modelIds.join(", ")}`,
          },
        ],
      };
    }

    ctx.updateWorkspace(ctx.mode, {
      model: next,
      effort: effortForModelChange(entry.agent, next, entry.effort, ctx.config),
    });
    const nextName = modelNameForAgent(entry.agent, next, ctx.config);
    const nextLabel = nextName === next ? next : `${nextName} (${next})`;
    return {
      handled: true,
      clearInput: true,
      notices: [{ level: "info", text: `model set to ${nextLabel} for '${ctx.mode}'` }],
    };
  },
  complete(args, ctx) {
    if (hasWorkflowStepTarget(ctx)) {
      if (args.length > 1) return [];
      return completeWorkflowModelArgs(ctx);
    }
    if (!isWorkspaceMode(ctx.mode)) {
      if (ctx.draftModel && args.length <= 1) return completeDraftModelArgs(ctx.draftModel);
      return [];
    }
    const entry = ctx.workspaceMap.get(ctx.mode);
    if (!entry) return [];
    if (args.length > 1) return [];
    return modelIdsForAgent(entry.agent, ctx.config);
  },
};
