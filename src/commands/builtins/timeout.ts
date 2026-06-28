import { type ProjectConfigPatch, saveProjectConfig } from "../../config/project-config";
import type { SteamtrainConfig } from "../../config/types";
import type { WorkflowSpec } from "../../workflow/types";
import {
  formatDurationSec,
  parseDurationSec,
  resolveStepTimeoutSec,
  resolveWorkflowTimeoutSec,
  workflowTimeoutStepBudget,
} from "../../workflow/timeout";
import { hasWorkflowStepTarget } from "../workflow-step-target";
import type { SlashCommand, SlashCommandContext } from "../types";

function describeTimeouts(config: SteamtrainConfig, spec?: WorkflowSpec): string {
  const stepSec = spec
    ? resolveStepTimeoutSec(undefined, spec, config)
    : resolveStepTimeoutSec(undefined, undefined, config);
  const lines = [
    `step timeout: ${formatDurationSec(stepSec)} (${stepSec}s)`,
    config.stepTimeoutSec !== undefined
      ? `  project stepTimeoutSec: ${formatDurationSec(config.stepTimeoutSec)}`
      : "  project stepTimeoutSec: (default 15m)",
    config.workflowTimeoutSec !== undefined
      ? `  project workflowTimeoutSec: ${formatDurationSec(config.workflowTimeoutSec)}`
      : "  project workflowTimeoutSec: (auto: steps × step timeout)",
  ];
  if (spec) {
    const workflowSec = resolveWorkflowTimeoutSec(spec, config);
    if (spec.workflowTimeoutSec !== undefined) {
      lines.push(
        `  workflow '${spec.name}' workflowTimeoutSec: ${formatDurationSec(spec.workflowTimeoutSec)}`,
      );
    } else if (config.workflowTimeoutSec !== undefined) {
      lines.push(
        `  workflow '${spec.name}' run limit: ${formatDurationSec(workflowSec)} (project workflowTimeoutSec)`,
      );
    } else {
      const budget = workflowTimeoutStepBudget(spec, config.loopMaxIterations);
      lines.push(
        `  workflow '${spec.name}' run limit: ${formatDurationSec(workflowSec)} (auto: ${budget} steps × step timeout)`,
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
      const sec = parseDurationSec(args[1]!);
      if (!sec) {
        return {
          handled: true,
          clearInput: true,
          notices: [{ level: "error", text: `invalid duration '${args[1]}' (try 15m, 900, 1h)` }],
        };
      }
      ctx.updateWorkflowStep!(ctx.workflowStep!.stepId, { stepTimeoutSec: sec });
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text: `step '${ctx.workflowStep!.stepId}' timeout set to ${formatDurationSec(sec)}`,
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
      const result = ctx.updateConfig({ workflowTimeoutSec: undefined });
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

    const sec = parseDurationSec(args[1]!);
    if (!sec) {
      return {
        handled: true,
        clearInput: true,
        notices: [{ level: "error", text: `invalid duration '${args[1]}' (try 15m, 900, 1h, auto)` }],
      };
    }

    const patch: ProjectConfigPatch =
      scope === "step" ? { stepTimeoutSec: sec } : { workflowTimeoutSec: sec };
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
          text: `${scope} timeout set to ${formatDurationSec(sec)} in ${ctx.configPath}`,
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
