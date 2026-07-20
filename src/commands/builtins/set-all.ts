import {
  defaultModelForAgent,
  effortsForModel,
  modelIdsForAgent,
  modelNameForAgent,
  resolveAgentInstances,
} from "../../agents";
import {
  buildBulkRetargetPatches,
  listRetargetableSteps,
  resolveRetargetModel,
  summarizeBulkRetarget,
} from "../../tui/workflow-step-editor";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "../types";

/**
 * `/set-all <agent> [model] [effort]` — retarget every agent-backed step in the
 * previewed workflow onto one agent/model/effort triad. Stages session
 * overrides (persist with `/save-workflows`).
 */
export const setAllCommand: SlashCommand = {
  name: "set-all",
  description: "Retarget every agent-backed step in the previewed workflow to one agent/model",
  usage: "/set-all <agent> [model] [effort]",
  execute(args, ctx) {
    return executeSetAllCommand(args, ctx);
  },
  complete(args, ctx) {
    return completeSetAllArgs(args, ctx);
  },
};

export function executeSetAllCommand(args: string[], ctx: SlashCommandContext): SlashCommandResult {
  if (!ctx.workflowSpec || !ctx.updateWorkflowStep) {
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "warn",
          text: "/set-all requires an open workflow preview (Enter a workflow, then /set-all <agent>)",
        },
      ],
    };
  }

  const enabledIds = resolveAgentInstances(ctx.config).map((agent) => agent.id);
  if (args.length === 0) {
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "info",
          text: `usage: /set-all <agent> [model] [effort] · agents: ${enabledIds.join(", ") || "(none)"}`,
        },
      ],
    };
  }

  const nextAgent = args[0]!;
  if (!enabledIds.includes(nextAgent)) {
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "error",
          text: `unknown or disabled agent '${nextAgent}'; try: ${enabledIds.join(", ")}`,
        },
      ],
    };
  }

  const modelIds = modelIdsForAgent(nextAgent, ctx.config);
  let nextModel = args[1];
  if (nextModel !== undefined && !modelIds.includes(nextModel)) {
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "error",
          text: `unknown model '${nextModel}' for ${nextAgent}; try: ${modelIds.join(", ")}`,
        },
      ],
    };
  }
  nextModel = resolveRetargetModel(nextAgent, nextModel, ctx.config);

  let nextEffort = args[2];
  if (nextEffort !== undefined) {
    if (nextEffort === "clear" || nextEffort === "default") {
      nextEffort = undefined;
    } else {
      const efforts = effortsForModel(nextAgent, nextModel, ctx.config);
      if (!efforts.includes(nextEffort)) {
        return {
          handled: true,
          clearInput: true,
          notices: [
            {
              level: "error",
              text:
                efforts.length > 0
                  ? `unknown effort '${nextEffort}' for ${nextModel}; try: ${efforts.join(", ")} or clear`
                  : `${nextModel} does not support effort levels`,
            },
          ],
        };
      }
    }
  }

  const steps = listRetargetableSteps(ctx.workflowSpec);
  if (steps.length === 0) {
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "warn",
          text: `workflow '${ctx.workflowSpec.name}' has no agent-backed steps to retarget`,
        },
      ],
    };
  }

  const desire = {
    agent: nextAgent,
    model: nextModel,
    effort: nextEffort,
  };
  const patches = buildBulkRetargetPatches(steps, desire, ctx.config);
  const update = ctx.updateWorkflowStep;
  for (const [stepId, patch] of Object.entries(patches)) {
    update(stepId, patch);
  }

  const modelLabel = (() => {
    const name = modelNameForAgent(nextAgent, nextModel, ctx.config);
    return name === nextModel ? nextModel : `${name} (${nextModel})`;
  })();
  const summary = summarizeBulkRetarget(patches, desire, ctx.config);
  const unchanged = Object.keys(patches).length === 0;
  return {
    handled: true,
    clearInput: true,
    notices: [
      {
        level: "info",
        text: unchanged
          ? `all ${steps.length} agent step(s) already on ${nextAgent}/${modelLabel}`
          : `retargeted ${summary} · /save-workflows to persist`,
      },
    ],
  };
}

export function completeSetAllArgs(args: string[], ctx: SlashCommandContext): readonly string[] {
  const enabledIds = resolveAgentInstances(ctx.config).map((agent) => agent.id);
  if (args.length <= 1) return enabledIds;
  const agent = args[0];
  if (!agent || !enabledIds.includes(agent)) return [];
  if (args.length === 2) return modelIdsForAgent(agent, ctx.config);
  if (args.length === 3) {
    const model = args[1] ?? defaultModelForAgent(agent, ctx.config);
    const efforts = effortsForModel(agent, model, ctx.config);
    return efforts.length > 0 ? [...efforts, "clear"] : [];
  }
  return [];
}
