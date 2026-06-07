import { AGENT_IDS, defaultModelForAgent, isAgentId } from "../../agents";
import { isWorkspaceMode } from "../../tui/modes";
import type { SlashCommand } from "../types";
import {
  completeWorkflowAgentArgs,
  executeWorkflowAgentCommand,
  hasWorkflowStepTarget,
  workflowStepUnavailableNotice,
} from "../workflow-step-target";

export const agentCommand: SlashCommand = {
  name: "agent",
  description: "Set or list agents for the current workspace tab or workflow step",
  usage: "/agent [claude|opencode|codex]",
  execute(args, ctx) {
    if (hasWorkflowStepTarget(ctx)) {
      return executeWorkflowAgentCommand(args, ctx);
    }

    if (!isWorkspaceMode(ctx.mode)) {
      return workflowStepUnavailableNotice("agent");
    }

    const entry = ctx.workspaceMap.get(ctx.mode);
    if (!entry) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "error", text: `unknown workspace '${ctx.mode}'` }],
      };
    }

    if (args.length === 0) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text: `agents: ${AGENT_IDS.join(", ")} (current: ${entry.agent})`,
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

    const model = entry.agent === next ? entry.model : defaultModelForAgent(next);
    const effort = entry.agent === next ? entry.effort : undefined;
    ctx.updateWorkspace(ctx.mode, { agent: next, model, effort });
    const effortNote = effort ? ` · ${effort}` : "";
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "info",
          text: `agent set to ${next} (model: ${model}${effortNote}) for '${ctx.mode}'`,
        },
      ],
    };
  },
  complete(args, ctx) {
    if (hasWorkflowStepTarget(ctx)) {
      if (args.length > 1) return [];
      return completeWorkflowAgentArgs();
    }
    if (!isWorkspaceMode(ctx.mode)) return [];
    if (!ctx.workspaceMap.get(ctx.mode)) return [];
    if (args.length > 1) return [];
    return AGENT_IDS;
  },
};
