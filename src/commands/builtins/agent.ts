import {
  AGENT_IDS,
  defaultModelForAgent,
  isAgentProviderId,
  resolveAgentInstances,
} from "../../agents";
import type { AgentInstanceConfig } from "../../config/types";
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
  description: "Set, list, enable, disable, or add configured agents",
  usage:
    "/agent [id] · /agent list · /agent enable <id> · /agent disable <id> · /agent add <id> <provider> [binary]",
  execute(args, ctx) {
    const configuredAgents = resolveAgentInstances(ctx.config, { includeDisabled: true });
    const enabledAgents = configuredAgents.filter((agent) => agent.enabled);
    const enabledIds = enabledAgents.map((agent) => agent.id);

    if (args[0] === "list") {
      const text = configuredAgents
        .map((agent) => {
          const state = agent.enabled ? "enabled" : "disabled";
          const binary = agent.binary ? ` binary=${agent.binary}` : "";
          const provider = agent.provider === agent.id ? "" : ` provider=${agent.provider}`;
          return `${agent.id} (${state}${provider}${binary})`;
        })
        .join(", ");
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "info", text: `agents: ${text}` }],
      };
    }

    if (args[0] === "enable" || args[0] === "disable") {
      const id = args[1];
      if (!id) {
        return {
          handled: true,
          clearInput: true,
          notices: [{ level: "error", text: `usage: /agent ${args[0]} <id>` }],
        };
      }
      if (!ctx.updateConfig || !ctx.configPath) {
        return {
          handled: true,
          clearInput: true,
          notices: [
            { level: "warn", text: "agent config requires a writable project steamtrain.json" },
          ],
        };
      }
      const existing =
        ctx.config?.agents?.find((agent) => agent.id === id) ??
        configuredAgents.find((agent) => agent.id === id);
      if (!existing) {
        return {
          handled: true,
          clearInput: true,
          notices: [{ level: "error", text: `unknown agent '${id}'` }],
        };
      }
      const nextAgents = upsertAgentConfig(ctx.config?.agents ?? [], {
        id,
        provider: existing.provider,
        label: existing.label === id ? undefined : existing.label,
        enabled: args[0] === "enable",
        binary: existing.binary,
        env: existing.env,
        extraArgs: existing.extraArgs,
        defaultModel: existing.defaultModel,
      });
      const result = ctx.updateConfig({ agents: nextAgents });
      if (!result.ok) {
        return {
          handled: true,
          clearInput: true,
          notices: [{ level: "error", text: result.error ?? "failed to save config" }],
        };
      }
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "info", text: `${id} ${args[0]}d in ${ctx.configPath}` }],
      };
    }

    if (args[0] === "add") {
      const [id, provider, binary] = [args[1], args[2], args[3]];
      if (!id || !provider || !isAgentProviderId(provider)) {
        return {
          handled: true,
          clearInput: true,
          notices: [
            { level: "error", text: `usage: /agent add <id> <${AGENT_IDS.join("|")}> [binary]` },
          ],
        };
      }
      if (!ctx.updateConfig || !ctx.configPath) {
        return {
          handled: true,
          clearInput: true,
          notices: [
            { level: "warn", text: "agent config requires a writable project steamtrain.json" },
          ],
        };
      }
      const nextAgents = upsertAgentConfig(ctx.config?.agents ?? [], {
        id,
        provider,
        enabled: true,
        ...(binary ? { binary } : {}),
      });
      const result = ctx.updateConfig({ agents: nextAgents });
      if (!result.ok) {
        return {
          handled: true,
          clearInput: true,
          notices: [{ level: "error", text: result.error ?? "failed to save config" }],
        };
      }
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "info", text: `${id} added in ${ctx.configPath}` }],
      };
    }

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
            text: `agents: ${enabledIds.join(", ")} (current: ${entry.agent})`,
          },
        ],
      };
    }

    const next = args[0]!;
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

    const model = entry.agent === next ? entry.model : defaultModelForAgent(next, ctx.config);
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
    const enabledIds = resolveAgentInstances(ctx.config).map((agent) => agent.id);
    if (hasWorkflowStepTarget(ctx)) {
      if (args.length > 1) return [];
      return completeWorkflowAgentArgs(ctx);
    }
    if (!isWorkspaceMode(ctx.mode)) return [];
    if (!ctx.workspaceMap.get(ctx.mode)) return [];
    if (args.length > 1) return [];
    if (args.length === 1) return ["list", "enable", "disable", "add", ...enabledIds];
    if ((args[0] === "enable" || args[0] === "disable") && args.length === 2) {
      return resolveAgentInstances(ctx.config, { includeDisabled: true }).map((agent) => agent.id);
    }
    if (args[0] === "add" && args.length === 3) return AGENT_IDS;
    return enabledIds;
  },
};

function upsertAgentConfig(
  agents: readonly AgentInstanceConfig[],
  next: AgentInstanceConfig,
): AgentInstanceConfig[] {
  const out = agents.filter((agent) => agent.id !== next.id);
  out.push(next);
  return out;
}
