import {
  defaultModelForAgent,
  effortForModelChange,
  formatModelOption,
  modelIdsForAgent,
  modelNameForAgent,
  modelsForAgent,
  resolveAgentInstances,
} from "../agents";
import {
  buildBulkModelPatches,
  buildBulkRetargetPatches,
  listRetargetableSteps,
  summarizeBulkRetarget,
} from "../tui/workflow-step-editor";
import type { SlashCommandContext, SlashCommandResult } from "./types";

/** Strip `--all` / `-a` from anywhere in the args (order-independent). */
export function takeAllFlag(args: string[]): { args: string[]; all: boolean } {
  let all = false;
  const out: string[] = [];
  for (const arg of args) {
    if (arg === "--all" || arg === "-a") {
      all = true;
      continue;
    }
    out.push(arg);
  }
  return { args: out, all };
}

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
  const enabledIds = resolveAgentInstances(ctx.config).map((agent) => agent.id);
  const { args: bare, all } = takeAllFlag(args);

  if (bare.length === 0) {
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "info",
          text: `agents: ${enabledIds.join(", ")} (step '${step.stepId}': ${step.agent})${ctx.workflowSpec ? " · append --all to retarget every agent step" : ""}`,
        },
      ],
    };
  }

  const next = bare[0]!;
  if (!enabledIds.includes(next)) {
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "error",
          text: `unknown or disabled agent '${next}'; try: ${enabledIds.join(", ")}`,
        },
      ],
    };
  }

  if (all && ctx.workflowSpec) {
    const steps = listRetargetableSteps(ctx.workflowSpec);
    const model = defaultModelForAgent(next, ctx.config);
    const desire = { agent: next, model };
    const patches = buildBulkRetargetPatches(steps, desire, ctx.config);
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
              ? `all ${steps.length} agent step(s) already on ${next}`
              : `retargeted ${summarizeBulkRetarget(patches, desire, ctx.config)} · /save-workflows to persist`,
        },
      ],
    };
  }

  const model = step.agent === next ? step.model : defaultModelForAgent(next, ctx.config);
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
  const { args: bare, all } = takeAllFlag(args);

  const models = modelsForAgent(step.agent, ctx.config);
  const modelIds = modelIdsForAgent(step.agent, ctx.config);
  if (bare.length === 0) {
    const currentName = modelNameForAgent(step.agent, step.model, ctx.config);
    const currentLabel = currentName === step.model ? step.model : `${currentName} (${step.model})`;
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "info",
          text: `models for ${step.agent} on step '${step.stepId}': ${models.map(formatModelOption).join(", ")} (current: ${currentLabel})${ctx.workflowSpec ? " · append --all to apply to every step on this agent" : ""}`,
        },
      ],
    };
  }

  const next = bare[0]!;
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

  if (all && ctx.workflowSpec) {
    const steps = listRetargetableSteps(ctx.workflowSpec);
    const patches = buildBulkModelPatches(steps, step.agent, next, ctx.config);
    for (const [stepId, patch] of Object.entries(patches)) {
      update(stepId, patch);
    }
    const count = Object.keys(patches).length;
    const nextName = modelNameForAgent(step.agent, next, ctx.config);
    const nextLabel = nextName === next ? next : `${nextName} (${next})`;
    const sameAgent = steps.filter((s) => s.agent === step.agent).length;
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "info",
          text:
            count === 0
              ? `all ${sameAgent} ${step.agent} step(s) already on ${nextLabel}`
              : `model set to ${nextLabel} on ${count} ${step.agent} step(s) · /save-workflows to persist`,
        },
      ],
    };
  }

  update(step.stepId, {
    model: next,
    effort: effortForModelChange(step.agent, next, step.effort, ctx.config),
  });
  const nextName = modelNameForAgent(step.agent, next, ctx.config);
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
  return modelIdsForAgent(step.agent, ctx.config);
}

export function completeWorkflowAgentArgs(ctx?: SlashCommandContext): readonly string[] {
  return resolveAgentInstances(ctx?.config).map((agent) => agent.id);
}

/** Completions for `/agent <id>` including optional `--all`. */
export function completeWorkflowAgentArgsWithAll(
  args: string[],
  ctx?: SlashCommandContext,
): readonly string[] {
  if (args.length <= 1) return completeWorkflowAgentArgs(ctx);
  if (args.length === 2 && args[0] && !args[0].startsWith("-")) return ["--all"];
  return [];
}

/** Completions for `/model <id>` including optional `--all`. */
export function completeWorkflowModelArgsWithAll(
  args: string[],
  ctx: SlashCommandContext,
): readonly string[] {
  if (args.length <= 1) return completeWorkflowModelArgs(ctx);
  if (args.length === 2 && args[0] && !args[0].startsWith("-")) return ["--all"];
  return [];
}
