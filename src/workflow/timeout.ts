import type { SteamtrainConfig } from "../config/types";
import type { WorkflowSpec } from "./types";

/** Default per-agent subprocess wall-clock limit: 15 minutes. */
export const DEFAULT_STEP_TIMEOUT_MS = 15 * 60 * 1000;

/** Count static steps declared in a workflow spec (excludes dynamic fan-out children). */
export function countStaticWorkflowSteps(spec: WorkflowSpec): number {
  return spec.phases.reduce((n, phase) => n + phase.steps.length, 0);
}

function legacyTimeoutMs(config?: Pick<SteamtrainConfig, "timeoutMs">): number | undefined {
  return config?.timeoutMs;
}

/**
 * Resolve the per-agent subprocess timeout for one step.
 * Chain: step override → workflow default → config → legacy `timeoutMs` → built-in default.
 */
export function resolveStepTimeoutMs(
  step?: { stepTimeoutMs?: number },
  workflow?: Pick<WorkflowSpec, "stepTimeoutMs">,
  config?: Pick<SteamtrainConfig, "stepTimeoutMs" | "timeoutMs">,
): number {
  const fromStep = step?.stepTimeoutMs;
  if (fromStep !== undefined) return fromStep;
  if (workflow?.stepTimeoutMs !== undefined) return workflow.stepTimeoutMs;
  if (config?.stepTimeoutMs !== undefined) return config.stepTimeoutMs;
  const legacy = legacyTimeoutMs(config);
  if (legacy !== undefined) return legacy;
  return DEFAULT_STEP_TIMEOUT_MS;
}

/**
 * Resolve the whole-workflow wall-clock abort limit.
 * Chain: workflow override → config override → legacy `timeoutMs` → stepCount × step timeout.
 */
export function resolveWorkflowTimeoutMs(
  spec: WorkflowSpec,
  config?: Pick<SteamtrainConfig, "stepTimeoutMs" | "workflowTimeoutMs" | "timeoutMs">,
): number {
  if (spec.workflowTimeoutMs !== undefined) return spec.workflowTimeoutMs;
  if (config?.workflowTimeoutMs !== undefined) return config.workflowTimeoutMs;
  const legacy = legacyTimeoutMs(config);
  if (legacy !== undefined) return legacy;
  const stepTimeout = resolveStepTimeoutMs(undefined, spec, config);
  const steps = Math.max(1, countStaticWorkflowSteps(spec));
  return steps * stepTimeout;
}

/** Parse a duration token (`900000`, `15m`, `1h`, `30s`) into milliseconds. */
export function parseDurationMs(raw: string): number | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|min|mins|sec|secs|hr|hrs)$/.exec(trimmed);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  switch (match[2]) {
    case "ms":
      return Math.round(value);
    case "s":
    case "sec":
    case "secs":
      return Math.round(value * 1000);
    case "m":
    case "min":
    case "mins":
      return Math.round(value * 60 * 1000);
    case "h":
    case "hr":
    case "hrs":
      return Math.round(value * 60 * 60 * 1000);
    default:
      return undefined;
  }
}

/** Human-readable duration for notices and labels. */
export function formatDurationMs(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) return `${ms / (60 * 60 * 1000)}h`;
  if (ms % (60 * 1000) === 0) return `${ms / (60 * 1000)}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}
