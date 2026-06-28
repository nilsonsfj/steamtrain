import type { SteamtrainConfig } from "../config/types";
import { DEFAULT_LOOP_MAX_ITERATIONS, type WorkflowSpec } from "./types";

/** Default per-agent subprocess wall-clock limit: 15 minutes (in seconds). */
export const DEFAULT_STEP_TIMEOUT_SEC = 15 * 60;

/** Convert a second-based timeout to milliseconds for timers and subprocess kills. */
export function timeoutMsFromSec(sec: number): number {
  return Math.round(sec * 1000);
}

/** Count static steps declared in a workflow spec (excludes dynamic fan-out children). */
export function countStaticWorkflowSteps(spec: WorkflowSpec): number {
  return spec.phases.reduce((n, phase) => n + phase.steps.length, 0);
}

/**
 * Worst-case step count used to size the auto workflow timeout. Starts from the
 * static step count and adds the extra passes a loop gate (`loopTo`) re-runs its
 * body, so a looping workflow's auto limit reflects its real wall-clock envelope
 * instead of killing it mid-loop.
 */
export function workflowTimeoutStepBudget(spec: WorkflowSpec, loopMaxIterations?: number): number {
  const base = countStaticWorkflowSteps(spec);
  const phaseIndexById = new Map<string, number>();
  spec.phases.forEach((p, i) => phaseIndexById.set(p.id, i));
  const phaseStepCount = spec.phases.map((p) => p.steps.length);

  interface Region {
    start: number;
    end: number;
    maxIterations: number;
  }
  const regions: Region[] = [];
  for (let pi = 0; pi < spec.phases.length; pi++) {
    for (const step of spec.phases[pi]?.steps ?? []) {
      if (step.kind !== "gate" || step.loopTo === undefined) continue;
      const start = phaseIndexById.get(step.loopTo);
      if (start === undefined || start >= pi) continue;
      regions.push({
        start,
        end: pi,
        maxIterations: step.maxIterations ?? loopMaxIterations ?? DEFAULT_LOOP_MAX_ITERATIONS,
      });
    }
  }

  let expansion = 0;
  for (const r of regions) {
    let bodySteps = 0;
    for (let k = r.start; k <= r.end; k++) bodySteps += phaseStepCount[k] ?? 0;
    let outerMultiplier = 1;
    for (const o of regions) {
      if (o === r) continue;
      if (o.start <= r.start && r.end <= o.end) outerMultiplier *= o.maxIterations;
    }
    expansion += bodySteps * (r.maxIterations - 1) * outerMultiplier;
  }
  return base + expansion;
}

type StepTimeoutSource = {
  stepTimeoutSec?: number;
  /** @deprecated milliseconds — converted to seconds at resolve time. */
  stepTimeoutMs?: number;
};

type WorkflowTimeoutSource = {
  workflowTimeoutSec?: number;
  /** @deprecated milliseconds — converted to seconds at resolve time. */
  workflowTimeoutMs?: number;
};

type ConfigTimeoutSource = Pick<
  SteamtrainConfig,
  "stepTimeoutSec" | "workflowTimeoutSec" | "timeoutMs"
>;

function secFromMs(ms: number): number {
  return ms / 1000;
}

function stepTimeoutSecFromSource(source?: StepTimeoutSource): number | undefined {
  if (!source) return undefined;
  if (source.stepTimeoutSec !== undefined) return source.stepTimeoutSec;
  if (source.stepTimeoutMs !== undefined) return secFromMs(source.stepTimeoutMs);
  return undefined;
}

function workflowTimeoutSecFromSource(source?: WorkflowTimeoutSource): number | undefined {
  if (!source) return undefined;
  if (source.workflowTimeoutSec !== undefined) return source.workflowTimeoutSec;
  if (source.workflowTimeoutMs !== undefined) return secFromMs(source.workflowTimeoutMs);
  return undefined;
}

/**
 * Resolve the per-agent subprocess timeout for one step (seconds).
 * Chain: step override → workflow default → config → legacy `timeoutMs` → built-in default.
 */
export function resolveStepTimeoutSec(
  step?: StepTimeoutSource,
  workflow?: StepTimeoutSource,
  config?: ConfigTimeoutSource,
): number {
  const fromStep = stepTimeoutSecFromSource(step);
  if (fromStep !== undefined) return fromStep;
  const fromWorkflow = stepTimeoutSecFromSource(workflow);
  if (fromWorkflow !== undefined) return fromWorkflow;
  if (config?.stepTimeoutSec !== undefined) return config.stepTimeoutSec;
  if (config?.timeoutMs !== undefined) return secFromMs(config.timeoutMs);
  return DEFAULT_STEP_TIMEOUT_SEC;
}

/**
 * Resolve the whole-workflow wall-clock abort limit (seconds).
 * Chain: workflow override → config override → legacy `timeoutMs` → loop-aware
 * stepCount × step timeout.
 */
export function resolveWorkflowTimeoutSec(
  spec: WorkflowSpec,
  config?: Pick<SteamtrainConfig, "stepTimeoutSec" | "workflowTimeoutSec" | "timeoutMs" | "loopMaxIterations">,
): number {
  const fromSpec = workflowTimeoutSecFromSource(spec);
  if (fromSpec !== undefined) return fromSpec;
  if (config?.workflowTimeoutSec !== undefined) return config.workflowTimeoutSec;
  if (config?.timeoutMs !== undefined) return secFromMs(config.timeoutMs);
  const stepTimeout = resolveStepTimeoutSec(undefined, spec, config);
  const steps = Math.max(1, workflowTimeoutStepBudget(spec, config?.loopMaxIterations));
  return steps * stepTimeout;
}

/** Parse a duration token (`900`, `15m`, `1h`, `30s`, `500ms`) into seconds. */
export function parseDurationSec(raw: string): number | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|min|mins|sec|secs|hr|hrs)$/.exec(trimmed);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  switch (match[2]) {
    case "ms":
      return value / 1000;
    case "s":
    case "sec":
    case "secs":
      return value;
    case "m":
    case "min":
    case "mins":
      return value * 60;
    case "h":
    case "hr":
    case "hrs":
      return value * 60 * 60;
    default:
      return undefined;
  }
}

/** Human-readable duration for notices and labels (input is seconds). */
export function formatDurationSec(sec: number): string {
  if (sec % (60 * 60) === 0) return `${sec / (60 * 60)}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  if (sec >= 1 && Number.isInteger(sec)) return `${sec}s`;
  if (sec < 1) return `${Math.round(sec * 1000)}ms`;
  return `${sec}s`;
}
