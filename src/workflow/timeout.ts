import type { SteamtrainConfig } from "../config/types";
import { DEFAULT_LOOP_MAX_ITERATIONS, type WorkflowSpec } from "./types";

/** Default per-agent subprocess wall-clock limit: 15 minutes. */
export const DEFAULT_STEP_TIMEOUT_MS = 15 * 60 * 1000;

/** Count static steps declared in a workflow spec (excludes dynamic fan-out children). */
export function countStaticWorkflowSteps(spec: WorkflowSpec): number {
  return spec.phases.reduce((n, phase) => n + phase.steps.length, 0);
}

/**
 * Worst-case step count used to size the auto workflow timeout. Starts from the
 * static step count and adds the extra passes a loop gate (`loopTo`) re-runs its
 * body, so a looping workflow's auto limit reflects its real wall-clock envelope
 * instead of killing it mid-loop. Mirrors the loop-expansion accounting in
 * {@link validateWorkflow} (each region's body runs `maxIterations` times,
 * multiplied by every region that fully contains it).
 *
 * Dynamic fan-out (`forEach`) children are deliberately excluded: their count is
 * not known until run time, and they execute in parallel (bounded by
 * concurrency) so they add far less wall-clock than a sequential loop re-run.
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
 * Chain: workflow override → config override → legacy `timeoutMs` → loop-aware
 * stepCount × step timeout. The auto default uses {@link workflowTimeoutStepBudget}
 * so a looping workflow's body re-runs are budgeted (otherwise the default limit
 * would abort a bounded loop mid-iteration even though each step is well within
 * its own step timeout).
 */
export function resolveWorkflowTimeoutMs(
  spec: WorkflowSpec,
  config?: Pick<
    SteamtrainConfig,
    "stepTimeoutMs" | "workflowTimeoutMs" | "timeoutMs" | "loopMaxIterations"
  >,
): number {
  if (spec.workflowTimeoutMs !== undefined) return spec.workflowTimeoutMs;
  if (config?.workflowTimeoutMs !== undefined) return config.workflowTimeoutMs;
  const legacy = legacyTimeoutMs(config);
  if (legacy !== undefined) return legacy;
  const stepTimeout = resolveStepTimeoutMs(undefined, spec, config);
  const steps = Math.max(1, workflowTimeoutStepBudget(spec, config?.loopMaxIterations));
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
