import {
  AGENT_IDS,
  agentConfigScope,
  defaultModelForAgent,
  isAgentProviderId,
  resolveAgentInstances,
  upsertAgent,
} from "../../agents";
import type { AgentConfigScope, AgentInstanceConfig } from "../../config/types";
import { isWorkspaceMode } from "../../tui/modes";
import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "../types";
import {
  completeWorkflowAgentArgs,
  executeWorkflowAgentCommand,
  hasWorkflowStepTarget,
  workflowStepUnavailableNotice,
} from "../workflow-step-target";

const SCOPE_FLAGS = ["--global", "--project"] as const;

/** Strip `--global`/`-g`/`--project`/`-p` from args and return the requested scope. */
function extractScopeFlag(args: string[]): { args: string[]; scope?: AgentConfigScope } {
  const out: string[] = [];
  let scope: AgentConfigScope | undefined;
  for (const arg of args) {
    if (arg === "--global" || arg === "-g") scope = "user";
    else if (arg === "--project" || arg === "-p") scope = "project";
    else out.push(arg);
  }
  return { args: out, scope };
}

function scopeName(scope: AgentConfigScope): string {
  return scope === "user" ? "global" : "project";
}

/** Persist an agents array into the config file for `scope`. */
function saveAgentsInScope(
  ctx: SlashCommandContext,
  scope: AgentConfigScope,
  agents: AgentInstanceConfig[],
): { ok: boolean; error?: string; path?: string } {
  if (scope === "user") {
    if (!ctx.updateUserConfig || !ctx.userConfigPath) {
      return {
        ok: false,
        error: "global agent config is unavailable (running with --config?); use --project",
      };
    }
    return { ...ctx.updateUserConfig({ agents }), path: ctx.userConfigPath };
  }
  if (!ctx.updateConfig || !ctx.configPath) {
    return { ok: false, error: "agent config requires a writable project steamtrain.json" };
  }
  return { ...ctx.updateConfig({ agents }), path: ctx.configPath };
}

function errorNotice(text: string): SlashCommandResult {
  return { handled: true, clearInput: true, notices: [{ level: "error", text }] };
}

export const agentCommand: SlashCommand = {
  name: "agent",
  description: "Set, list, enable, disable, or add configured agents",
  usage:
    "/agent [id] · /agent list · /agent enable|disable <id> [--global|--project] · /agent add <id> <provider> [binary] [--global|--project]",
  execute(rawArgs, ctx) {
    const { args, scope: scopeArg } = extractScopeFlag(rawArgs);
    const configuredAgents = resolveAgentInstances(ctx.config, { includeDisabled: true });
    const enabledAgents = configuredAgents.filter((agent) => agent.enabled);
    const enabledIds = enabledAgents.map((agent) => agent.id);
    // Legacy contexts pass only the merged config; treat its agents as
    // project-scoped so enable/disable keeps preserving their fields.
    const layers = {
      userAgents: ctx.userAgents,
      projectAgents:
        ctx.projectAgents ??
        (ctx.userAgents === undefined && !ctx.updateUserConfig ? ctx.config?.agents : undefined),
    };
    // Global is the primary scope for agent definitions; fall back to the
    // project file only when no global file can be written (custom --config).
    const defaultScope: AgentConfigScope = ctx.updateUserConfig ? "user" : "project";

    if (args[0] === "list") {
      const text = configuredAgents
        .map((agent) => {
          const state = agent.enabled ? "enabled" : "disabled";
          const binary = agent.binary ? ` binary=${agent.binary}` : "";
          const provider = agent.provider === agent.id ? "" : ` provider=${agent.provider}`;
          const scope = agentConfigScope(agent.id, layers);
          const scopeNote = scope ? ` ${scopeName(scope)}` : "";
          return `${agent.id} (${state}${scopeNote}${provider}${binary})`;
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
        return errorNotice(`usage: /agent ${args[0]} <id> [--global|--project]`);
      }
      const existing = configuredAgents.find((agent) => agent.id === id);
      if (!existing) {
        return errorNotice(`unknown agent '${id}'`);
      }
      // Write to the scope that configures the agent; built-ins default to global.
      const scope = scopeArg ?? agentConfigScope(id, layers) ?? defaultScope;
      const rawList = scope === "user" ? layers.userAgents : layers.projectAgents;
      // When a flag forces a scope the agent is not configured in, copy the
      // entry from its owning scope so binary/env/extraArgs/defaultModel are
      // not silently dropped by the new (shadowing) entry.
      const raw =
        rawList?.find((agent) => agent.id === id) ??
        (scope === "user" ? layers.projectAgents : layers.userAgents)?.find(
          (agent) => agent.id === id,
        ) ??
        ctx.config?.agents?.find((agent) => agent.id === id);
      const enabled = args[0] === "enable";
      const entry: AgentInstanceConfig = raw
        ? { ...raw, enabled }
        : { id, provider: existing.provider, enabled };
      const result = saveAgentsInScope(ctx, scope, upsertAgent(rawList, entry));
      if (!result.ok) {
        return errorNotice(result.error ?? "failed to save config");
      }
      const shadowed =
        scope === "user" && agentConfigScope(id, layers) === "project"
          ? " (note: shadowed by a project entry in steamtrain.json)"
          : "";
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "info", text: `${id} ${args[0]}d in ${result.path}${shadowed}` }],
      };
    }

    if (args[0] === "add") {
      const [id, provider, binary] = [args[1], args[2], args[3]];
      if (!id || !provider || !isAgentProviderId(provider)) {
        return errorNotice(
          `usage: /agent add <id> <${AGENT_IDS.join("|")}> [binary] [--global|--project]`,
        );
      }
      const scope = scopeArg ?? defaultScope;
      const rawList = scope === "user" ? layers.userAgents : layers.projectAgents;
      const entry: AgentInstanceConfig = {
        id,
        provider,
        enabled: true,
        ...(binary ? { binary } : {}),
      };
      const result = saveAgentsInScope(ctx, scope, upsertAgent(rawList, entry));
      if (!result.ok) {
        return errorNotice(result.error ?? "failed to save config");
      }
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "info", text: `${id} added (${scopeName(scope)}) in ${result.path}` }],
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
      return errorNotice(`unknown workspace '${ctx.mode}'`);
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
      return errorNotice(`unknown or disabled agent '${next}'; try: ${enabledIds.join(", ")}`);
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
    if (args[0] === "enable" || args[0] === "disable") {
      if (args.length === 2) {
        return resolveAgentInstances(ctx.config, { includeDisabled: true }).map(
          (agent) => agent.id,
        );
      }
      if (args.length === 3) return SCOPE_FLAGS;
      return [];
    }
    if (args[0] === "add") {
      if (args.length === 3) return AGENT_IDS;
      if (args.length === 4 || args.length === 5) return SCOPE_FLAGS;
      return [];
    }
    if (hasWorkflowStepTarget(ctx)) {
      if (args.length > 1) return [];
      return completeWorkflowAgentArgs(ctx);
    }
    if (!isWorkspaceMode(ctx.mode)) return [];
    if (!ctx.workspaceMap.get(ctx.mode)) return [];
    if (args.length > 1) return [];
    if (args.length === 1) return ["list", "enable", "disable", "add", ...enabledIds];
    return enabledIds;
  },
};
