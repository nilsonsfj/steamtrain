import type { SlashCommand } from "../types";
import { hasWorkflowStepTarget, workflowStepUnavailableNotice } from "../workflow-step-target";

export const promptCommand: SlashCommand = {
  name: "prompt",
  description: "View or edit the prompt for a selected workflow step",
  usage: "/prompt [new-prompt-text]",
  execute(args, ctx) {
    if (!hasWorkflowStepTarget(ctx)) {
      return workflowStepUnavailableNotice("prompt");
    }
    const step = ctx.workflowStep!;
    const update = ctx.updateWorkflowStep!;

    if (args.length === 0) {
      const current = step.prompt ?? "(none)";
      const preview = current.length > 120 ? `${current.slice(0, 117)}...` : current;
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text: `prompt for '${step.stepId}': ${preview}`,
          },
        ],
      };
    }

    const newPrompt = args.join(" ");
    update(step.stepId, { prompt: newPrompt });
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "info",
          text: `prompt updated for '${step.stepId}' (${newPrompt.length} chars)`,
        },
      ],
    };
  },
  complete(args, ctx) {
    if (!hasWorkflowStepTarget(ctx) || args.length > 0) return [];
    return [];
  },
};
