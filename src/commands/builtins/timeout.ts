import { type ProjectConfigPatch, saveProjectConfig } from "../../config/project-config";
import type { SteamtrainConfig } from "../../config/types";
import {
  formatDurationMs,
  parseDurationMs,
  resolveStepTimeoutMs,
  resolveWorkflowTimeoutMs,
  workflowTimeoutStepBudget,
} from "../../workflow/timeout";
import type { WorkflowSpec } from "../../workflow/types";
import type { SlashCommand, SlashCommandContext } from "../types";
import { hasWorkflowStepTarget } from "../workflow-step-target";

function describeTimeouts(config: SteamtrainConfig, spec?: WorkflowSpec): string {
  const stepMs = spec
    ? resolveStepTimeoutMs(undefined, spec, config)
    : resolveStepTimeoutMs(undefined, undefined, config);
  const lines = [
    `step timeout: ${formatDurationMs(stepMs)} (${stepMs}ms)`,
    config.stepTimeoutMs !== undefined
      ? `  project stepTimeoutMs: ${formatDurationMs(config.stepTimeoutMs)}`
      : "  project stepTimeoutMs: (default 15m)",
    config.workflowTimeoutMs !== undefined
      ? `  project workflowTimeoutMs: ${formatDurationMs(config.workflowTimeoutMs)}`
      : "  project workflowTimeoutMs: (auto: steps × step timeout)",
  ];
  if (spec) {
    const workflowMs = resolveWorkflowTimeoutMs(spec, config);
    if (spec.workflowTimeoutMs !== undefined) {
      lines.push(
        `  workflow '${spec.name}' workflowTimeoutMs: ${formatDurationMs(spec.workflowTimeoutMs)}`,
      );
    } else if (config.workflowTimeoutMs !== undefined) {
      lines.push(
        `  workflow '${spec.name}' run limit: ${formatDurationMs(workflowMs)} (project workflowTimeoutMs)`,
      );
    } else {
      // Auto: loop bodies are budgeted, so report the worst-case step count the
      // limit is sized against, not just the static step count.
      const budget = workflowTimeoutStepBudget(spec, config.loopMaxIterations);
      lines.push(
        `  workflow '${spec.name}' run limit: ${formatDurationMs(workflowMs)} (auto: ${budget} steps × step timeout)`,
      );
    }
  }
  return lines.join("\n");
}

export const timeoutCommand: SlashCommand = {
  name: "timeout",
  description: "View or set per-step and per-workflow timeouts",
  usage:
    "/timeout · /timeout step <duration> · /timeout workflow <duration|auto> · /timeout step <duration> (on selected step)",
  execute(args, ctx) {
    if (!ctx.config) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "error", text: "config is not available in this session" }],
      };
    }

    if (args.length === 0) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "info", text: describeTimeouts(ctx.config, ctx.workflowSpec) }],
      };
    }

    const scope = args[0]?.toLowerCase();
    if (scope === "step" && args.length >= 2 && hasWorkflowStepTarget(ctx)) {
      const ms = parseDurationMs(args[1]!);
      if (!ms) {
        return {
          handled: true,
          clearInput: true,
          notices: [
            { level: "error", text: `invalid duration '${args[1]}' (try 15m, 900000, 1h)` },
          ],
        };
      }
      ctx.updateWorkflowStep!(ctx.workflowStep!.stepId, { stepTimeoutMs: ms });
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text: `step '${ctx.workflowStep!.stepId}' timeout set to ${formatDurationMs(ms)}`,
          },
        ],
      };
    }

    if (scope !== "step" && scope !== "workflow") {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "error",
            text: "usage: /timeout [step|workflow] <duration|auto> — or /timeout alone to show current values",
          },
        ],
      };
    }

    if (args.length < 2) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "error", text: `usage: /timeout ${scope} <duration|auto>` }],
      };
    }

    if (!ctx.updateConfig || !ctx.configPath) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "warn",
            text: `/${scope} project timeout requires a writable project steamtrain.json`,
          },
        ],
      };
    }

    const raw = args[1]!.toLowerCase();
    if (scope === "workflow" && (raw === "auto" || raw === "clear" || raw === "default")) {
      const result = ctx.updateConfig({ workflowTimeoutMs: undefined });
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
        notices: [{ level: "info", text: "workflow timeout cleared (auto: steps × step timeout)" }],
      };
    }

    const ms = parseDurationMs(args[1]!);
    if (!ms) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          { level: "error", text: `invalid duration '${args[1]}' (try 15m, 900000, 1h, auto)` },
        ],
      };
    }

    const patch: ProjectConfigPatch =
      scope === "step" ? { stepTimeoutMs: ms } : { workflowTimeoutMs: ms };
    const result = ctx.updateConfig(patch);
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
      notices: [
        {
          level: "info",
          text: `${scope} timeout set to ${formatDurationMs(ms)} in ${ctx.configPath}`,
        },
      ],
    };
  },
  complete(args) {
    if (args.length === 0) return ["step", "workflow"];
    if (args.length === 1) {
      if (args[0] === "workflow") return ["auto", "clear", "15m", "30m", "1h"];
      if (args[0] === "step") return ["15m", "30m", "1h"];
      return ["step", "workflow"];
    }
    if (args.length === 2 && args[0] === "workflow") return ["auto", "clear", "15m", "30m", "1h"];
    if (args.length === 2 && args[0] === "step") return ["15m", "30m", "1h"];
    return [];
  },
};
