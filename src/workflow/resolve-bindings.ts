import {
  type ModelBindingRequest,
  type ResolvedModelCandidate,
  bindingRequestFromStep,
  resolveModelBinding,
} from "../agents/model-resolve";
import type { SteamtrainConfig } from "../config/types";
import type { AgentInstanceId } from "../types/events";
import type { WorkflowSpec, WorkflowStep } from "./types";
import { type AgentBackedWorkflowStep, isAgentBackedStep } from "./types";

export interface StepBindingResolution {
  stepId: string;
  request: ModelBindingRequest;
  primary: ResolvedModelCandidate;
  candidates: ResolvedModelCandidate[];
  summary: string;
}

export type ResolveWorkflowBindingsResult =
  | {
      ok: true;
      spec: WorkflowSpec;
      resolutions: StepBindingResolution[];
    }
  | { ok: false; error: string; stepId?: string };

export interface ResolveWorkflowBindingsOptions {
  config?: SteamtrainConfig;
  isReady?: (agent: AgentInstanceId) => boolean;
  /**
   * When true, steps that already pin agent+model (no class/fallbacks) are
   * left untouched. Unbound / class / fallback steps still resolve.
   * Default true.
   */
  preservePinned?: boolean;
  /**
   * Workflow-level `fallbackModels` appended after each step's own list.
   * When set, even pinned steps get a resolution so mid-flight failover can
   * walk the chain.
   */
  workflowFallbackModels?: string[];
}

/**
 * Merge step-level and workflow-level fallback model queries.
 * Step entries win on collision; dedup is case-insensitive on the trimmed
 * string (model aliases like `Sonnet 5` / `sonnet 5` collapse) while the
 * first-seen spelling is preserved for the resolver.
 */
export function mergeFallbackModels(
  stepFallbacks: string[] | undefined,
  workflowFallbacks: string[] | undefined,
): string[] | undefined {
  if (!workflowFallbacks || workflowFallbacks.length === 0) return stepFallbacks;
  if (!stepFallbacks || stepFallbacks.length === 0) return [...workflowFallbacks];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...stepFallbacks, ...workflowFallbacks]) {
    // Case-insensitive dedup: model queries are matched that way by the
    // family/catalog resolver. Keep the first spelling (step before workflow).
    const key = entry.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

function stepNeedsResolve(
  step: WorkflowStep,
  preservePinned: boolean,
  isReady?: (agent: AgentInstanceId) => boolean,
  workflowFallbackModels?: string[],
): boolean {
  if (!isAgentBackedStep(step)) return false;
  if (typeof step.modelClass === "string") return true;
  if (step.fallbackModels && step.fallbackModels.length > 0) return true;
  if (workflowFallbackModels && workflowFallbackModels.length > 0) return true;
  // Templated `model` values (building block 5) must render at execution time
  // before family resolution. Leave them as-authored here.
  if (typeof step.model === "string" && /\{\{[^{}]+\}\}/.test(step.model)) return false;
  if (typeof step.agent !== "string") return true;
  if (typeof step.model !== "string") return true;
  if (!preservePinned) return true;
  // Remap a pinned agent that is not ready when a model family alternative exists.
  if (isReady && !isReady(step.agent)) return true;
  return false;
}

function applyBinding(
  step: AgentBackedWorkflowStep,
  primary: ResolvedModelCandidate,
): AgentBackedWorkflowStep {
  const next: AgentBackedWorkflowStep = {
    ...step,
    agent: primary.agent,
    model: primary.model,
  };
  if (primary.effort && !step.effort) {
    next.effort = primary.effort;
  }
  return next;
}

function bindingRequestForStep(
  step: AgentBackedWorkflowStep,
  workflowFallbackModels?: string[],
): ModelBindingRequest {
  const request = bindingRequestFromStep(step);
  const merged = mergeFallbackModels(request.fallbackModels, workflowFallbackModels);
  if (merged === request.fallbackModels) return request;
  return { ...request, fallbackModels: merged };
}

/**
 * Materialize every agent-backed step that uses model-only / modelClass /
 * fallback bindings into concrete `agent` + `model` pairs. Pinned
 * agent+model steps are preserved by default.
 *
 * Used by dispatch preflight and by the engine so authoring-time unbound
 * specs become runnable without rewriting the workflow file.
 */
export function resolveWorkflowBindings(
  spec: WorkflowSpec,
  options: ResolveWorkflowBindingsOptions = {},
): ResolveWorkflowBindingsResult {
  const preservePinned = options.preservePinned !== false;
  const workflowFallbackModels = options.workflowFallbackModels ?? spec.fallbackModels;
  const resolutions: StepBindingResolution[] = [];
  const phases: WorkflowSpec["phases"] = [];
  /** Sticky agent preference for session-continue chains within this pass. */
  const resolvedAgentByStep = new Map<string, AgentInstanceId>();

  for (const phase of spec.phases) {
    const steps: WorkflowStep[] = [];
    for (const step of phase.steps) {
      if (!stepNeedsResolve(step, preservePinned, options.isReady, workflowFallbackModels)) {
        steps.push(step);
        if (isAgentBackedStep(step) && typeof step.agent === "string") {
          resolvedAgentByStep.set(step.id, step.agent);
        }
        continue;
      }
      const backed = step as AgentBackedWorkflowStep;
      const sessionSrc =
        "session" in backed && typeof backed.session === "string"
          ? /^continue:(.+)$/.exec(backed.session)?.[1]
          : undefined;
      const sticky =
        (sessionSrc && resolvedAgentByStep.get(sessionSrc)) ||
        (typeof backed.agent === "string" ? backed.agent : undefined);

      const request = bindingRequestForStep(backed, workflowFallbackModels);
      const resolved = resolveModelBinding(request, {
        config: options.config,
        isReady: options.isReady,
        preferAgent: sticky,
      });
      if (!resolved.ok) {
        return {
          ok: false,
          error: `step '${step.id}': ${resolved.error}`,
          stepId: step.id,
        };
      }
      resolutions.push({
        stepId: step.id,
        request,
        primary: resolved.primary,
        candidates: resolved.candidates,
        summary: resolved.summary,
      });
      const next = applyBinding(backed, resolved.primary);
      steps.push(next);
      resolvedAgentByStep.set(step.id, resolved.primary.agent);
    }
    phases.push({ ...phase, steps });
  }

  return {
    ok: true,
    spec: { ...spec, phases },
    resolutions,
  };
}

/**
 * Collect failover candidates for a single step (primary first). Used by the
 * engine retry loop to switch agents/models after a transient provider failure.
 */
export function resolveStepFailoverChain(
  step: WorkflowStep,
  options: ResolveWorkflowBindingsOptions = {},
):
  | { ok: true; candidates: ResolvedModelCandidate[]; summary: string }
  | { ok: false; error: string } {
  if (!isAgentBackedStep(step)) {
    return { ok: false, error: "step is not agent-backed" };
  }
  const request = bindingRequestForStep(
    step as AgentBackedWorkflowStep,
    options.workflowFallbackModels,
  );
  const resolved = resolveModelBinding(request, {
    config: options.config,
    isReady: options.isReady,
    preferAgent:
      typeof (step as AgentBackedWorkflowStep).agent === "string"
        ? (step as AgentBackedWorkflowStep).agent
        : undefined,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return {
    ok: true,
    candidates: resolved.candidates,
    summary: resolved.summary,
  };
}
