import {
  AGENT_IDS,
  defaultModelForAgent,
  effortForModelChange,
  formatModelOption,
  isAgentId,
  modelIdsForAgent,
  modelNameForAgent,
  modelsForAgent,
} from "../agents";
import type { SlashCommandContext, SlashCommandResult } from "./types";

export function hasWorkflowStepTarget(ctx: SlashCommandContext): boolean {
  return ctx.workflowStep !== undefined && ctx.updateWorkflowStep !== undefined;
}

export function workflowStepUnavailableNotice(command: string): SlashCommandResult {
  return {
    handled: true,
    clearInput: true,
    notices: [
      {
        level: "warn",
        text: `/${command} requires a selected agent-backed workflow step (open workflow preview and select a worker step)`,
      },
    ],
  };
}

export function executeWorkflowAgentCommand(
  args: string[],
  ctx: SlashCommandContext,
): SlashCommandResult {
  const step = ctx.workflowStep!;
  const update = ctx.updateWorkflowStep!;

  if (args.length === 0) {
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "info",
          text: `agents: ${AGENT_IDS.join(", ")} (step '${step.stepId}': ${step.agent})`,
        },
      ],
    };
  }

  const next = args[0]!;
  if (!isAgentId(next)) {
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "error",
          text: `unknown agent '${next}'; try: ${AGENT_IDS.join(", ")}`,
        },
      ],
    };
  }

  const model = step.agent === next ? step.model : defaultModelForAgent(next);
  const effort = step.agent === next ? step.effort : undefined;
  update(step.stepId, { agent: next, model, effort });
  const effortNote = effort ? ` · ${effort}` : "";
  return {
    handled: true,
    clearInput: true,
    notices: [
      {
        level: "info",
        text: `step '${step.stepId}' agent set to ${next} (model: ${model}${effortNote})`,
      },
    ],
  };
}

export function executeWorkflowModelCommand(
  args: string[],
  ctx: SlashCommandContext,
): SlashCommandResult {
  const step = ctx.workflowStep!;
  const update = ctx.updateWorkflowStep!;

  const models = modelsForAgent(step.agent);
  const modelIds = modelIdsForAgent(step.agent);
  if (args.length === 0) {
    const currentName = modelNameForAgent(step.agent, step.model);
    const currentLabel =
      currentName === step.model ? step.model : `${currentName} (${step.model})`;
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "info",
          text: `models for ${step.agent} on step '${step.stepId}': ${models.map(formatModelOption).join(", ")} (current: ${currentLabel})`,
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
          text: `unknown model '${next}' for ${step.agent}; try: ${modelIds.join(", ")}`,
        },
      ],
    };
  }

  update(step.stepId, {
    model: next,
    effort: effortForModelChange(step.agent, next, step.effort),
  });
  const nextName = modelNameForAgent(step.agent, next);
  const nextLabel = nextName === next ? next : `${nextName} (${next})`;
  return {
    handled: true,
    clearInput: true,
    notices: [{ level: "info", text: `step '${step.stepId}' model set to ${nextLabel}` }],
  };
}

export function completeWorkflowModelArgs(ctx: SlashCommandContext): readonly string[] {
  const step = ctx.workflowStep;
  if (!step) return [];
  return modelIdsForAgent(step.agent);
}

export function completeWorkflowAgentArgs(): readonly string[] {
  return AGENT_IDS;
}
