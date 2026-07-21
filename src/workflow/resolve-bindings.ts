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
}

function stepNeedsResolve(
  step: WorkflowStep,
  preservePinned: boolean,
  isReady?: (agent: AgentInstanceId) => boolean,
): boolean {
  if (!isAgentBackedStep(step)) return false;
  if (typeof step.modelClass === "string") return true;
  if (step.fallbackModels && step.fallbackModels.length > 0) return true;
  if (typeof step.agent !== "string") return true;
  if (typeof step.model !== "string") return true;
  if (!preservePinned) return true;
  // Remap a pinned agent that is not ready when a model family alternative exists.
  if (isReady && !isReady(step.agent)) return true;
  return false;
}

function applyBinding(step: WorkflowStep, primary: ResolvedModelCandidate): WorkflowStep {
  const next = {
    ...step,
    agent: primary.agent,
    model: primary.model,
  } as WorkflowStep & { effort?: string };
  if (primary.effort && !(step as { effort?: string }).effort) {
    next.effort = primary.effort;
  }
  return next;
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
  const resolutions: StepBindingResolution[] = [];
  const phases: WorkflowSpec["phases"] = [];
  /** Sticky agent preference for session-continue chains within this pass. */
  const resolvedAgentByStep = new Map<string, AgentInstanceId>();

  for (const phase of spec.phases) {
    const steps: WorkflowStep[] = [];
    for (const step of phase.steps) {
      if (!stepNeedsResolve(step, preservePinned, options.isReady)) {
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

      const request = bindingRequestFromStep(backed);
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
      const next = applyBinding(step, resolved.primary);
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
  const request = bindingRequestFromStep(step as AgentBackedWorkflowStep);
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
