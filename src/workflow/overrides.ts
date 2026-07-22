import type { AgentRunFields, WorkflowSpec } from "./types";
import { isAgentBackedStep, workflowStepKind } from "./types";

export type WorkflowStepOverrides = Record<string, Partial<AgentRunFields>>;

/** Staged overrides for one workflow: per-step patches plus optional workflow-level timeouts. */
export type WorkflowSessionOverrides = {
  steps?: WorkflowStepOverrides;
  stepTimeoutSec?: number | null;
  workflowTimeoutSec?: number | null;
};

const AGENT_FIELD_KEYS = new Set<keyof AgentRunFields>([
  "agent",
  "model",
  "modelClass",
  "fallbackModels",
  "modelFailover",
  "prompt",
  "cwd",
  "env",
  "extraArgs",
  "effort",
  "stepTimeoutSec",
  "stepTimeoutMs",
]);

/**
 * The agent-field subset that also exists on a direct-API `llm` step. Other
 * agent fields (`agent`, `cwd`, `env`, `extraArgs`) must never be patched onto
 * an llm step — adding an `agent` field would make it read as agent-backed.
 */
const LLM_FIELD_KEYS = new Set<keyof AgentRunFields>([
  "model",
  "prompt",
  "effort",
  "stepTimeoutSec",
]);

const LEGACY_WF_KEY_PREFIX = "__wf_";

function isWorkflowTimeoutValue(value: unknown): boolean {
  return value === null || typeof value === "number";
}

/** Distinguish structured `{ steps, stepTimeoutSec? }` from flat `{ stepId: patch }` maps. */
function isStructuredSessionOverridesPayload(record: Record<string, unknown>): boolean {
  if (
    ("stepTimeoutSec" in record && isWorkflowTimeoutValue(record.stepTimeoutSec)) ||
    ("workflowTimeoutSec" in record && isWorkflowTimeoutValue(record.workflowTimeoutSec))
  ) {
    return true;
  }
  if (!("steps" in record)) return false;
  const steps = record.steps;
  if (typeof steps !== "object" || steps === null || Array.isArray(steps)) return false;
  const stepEntries = Object.entries(steps as Record<string, unknown>);
  if (stepEntries.length === 0) return true;
  return stepEntries.every(
    ([, patch]) => patch !== null && typeof patch === "object" && !Array.isArray(patch),
  );
}

/**
 * Merge an agent-field patch into a step. A patch value of `null` removes that
 * field from the step (rather than setting it to null). Used by both the web
 * API and the TUI flat-map override path.
 */
function applyAgentPatch<T extends object>(step: T, patch: Partial<AgentRunFields>): T {
  const next = { ...step } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

function validateStepPatchKeys(
  stepId: string,
  patch: Record<string, unknown>,
  pathPrefix: string,
): string | null {
  for (const key of Object.keys(patch)) {
    if (!AGENT_FIELD_KEYS.has(key as keyof AgentRunFields)) {
      return `${pathPrefix}.${stepId}.${key} is not a recognized agent field`;
    }
  }
  return null;
}

/** True when a session override object carries no staged changes. */
export function sessionOverridesEmpty(overrides: WorkflowSessionOverrides | undefined): boolean {
  if (!overrides) return true;
  const hasSteps = overrides.steps && Object.keys(overrides.steps).length > 0;
  const hasWorkflowFields =
    overrides.stepTimeoutSec !== undefined || overrides.workflowTimeoutSec !== undefined;
  return !hasSteps && !hasWorkflowFields;
}

/**
 * Normalize flat step maps (TUI / legacy API) into structured session overrides.
 * Rejects legacy `__wf_*` magic keys.
 */
export function normalizeSessionOverrides(
  input: WorkflowSessionOverrides | WorkflowStepOverrides | undefined,
): WorkflowSessionOverrides | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;

  for (const key of Object.keys(input)) {
    if (key.startsWith(LEGACY_WF_KEY_PREFIX)) {
      throw new Error(`legacy override key '${key}' is not supported; use structured overrides`);
    }
  }

  const record = input as Record<string, unknown>;
  if (isStructuredSessionOverridesPayload(record)) {
    return input as WorkflowSessionOverrides;
  }

  return { steps: input as WorkflowStepOverrides };
}

/** Merge session overrides (steps + workflow-level fields) into a workflow spec. */
export function applyWorkflowSessionOverrides(
  spec: WorkflowSpec,
  overrides: WorkflowSessionOverrides | WorkflowStepOverrides | undefined,
): WorkflowSpec {
  const normalized = normalizeSessionOverrides(overrides);
  if (!normalized || sessionOverridesEmpty(normalized)) return spec;

  let next = applyWorkflowStepOverrides(spec, normalized.steps);
  if (normalized.stepTimeoutSec === null) {
    const { stepTimeoutSec: _removed, ...rest } = next;
    next = rest;
  } else if (normalized.stepTimeoutSec !== undefined) {
    next = { ...next, stepTimeoutSec: normalized.stepTimeoutSec };
  }
  if (normalized.workflowTimeoutSec === null) {
    const { workflowTimeoutSec: _removed, ...rest } = next;
    next = rest;
  } else if (normalized.workflowTimeoutSec !== undefined) {
    next = { ...next, workflowTimeoutSec: normalized.workflowTimeoutSec };
  }
  return next;
}

/**
 * Merge per-step overrides into a workflow spec (preview + run).
 * Patch values of `null` remove optional fields from the step; this applies to
 * the TUI flat-map path as well as structured session overrides.
 */
export function applyWorkflowStepOverrides(
  spec: WorkflowSpec,
  overrides: WorkflowStepOverrides | undefined,
): WorkflowSpec {
  if (!overrides || Object.keys(overrides).length === 0) return spec;
  return {
    ...spec,
    phases: spec.phases.map((phase) => ({
      ...phase,
      steps: phase.steps.map((step) => {
        const patch = overrides[step.id];
        if (!patch) return step;
        // llm steps accept the shared fields they actually carry (model,
        // prompt, effort, timeout); the rest of the patch is dropped rather
        // than silently no-oping the whole override.
        if (workflowStepKind(step) === "llm") {
          const safePatch: Partial<AgentRunFields> = {};
          for (const key of LLM_FIELD_KEYS) {
            if (key in patch) {
              (safePatch as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
            }
          }
          return applyAgentPatch(step, safePatch);
        }
        if (!isAgentBackedStep(step)) return step;
        const kind = workflowStepKind(step);
        if (kind === "distributor" || kind === "consolidator" || kind === "merge") {
          const safePatch: Partial<AgentRunFields> = {};
          for (const key of AGENT_FIELD_KEYS) {
            if (key in patch) {
              (safePatch as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
            }
          }
          return applyAgentPatch(step, safePatch);
        }
        return applyAgentPatch(step, patch);
      }),
    })),
  };
}

export type ParseSessionOverridesResult =
  | { ok: true; overrides: WorkflowSessionOverrides }
  | { ok: false; error: string };

/** Parse and validate a structured session overrides payload from the web API. */
export function parseSessionOverrides(raw: unknown): ParseSessionOverridesResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "overrides must be an object" };
  }

  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key.startsWith(LEGACY_WF_KEY_PREFIX)) {
      return {
        ok: false,
        error: `legacy override key '${key}' is not supported; use structured overrides with stepTimeoutSec / workflowTimeoutSec`,
      };
    }
  }

  const result: WorkflowSessionOverrides = {};
  const structured = isStructuredSessionOverridesPayload(obj);

  if (structured) {
    if ("steps" in obj) {
      const steps = obj.steps;
      if (steps === undefined || steps === null) {
        result.steps = {};
      } else if (typeof steps !== "object" || Array.isArray(steps)) {
        return { ok: false, error: "overrides.steps must be an object" };
      } else {
        const parsedSteps: WorkflowStepOverrides = {};
        for (const [stepId, patch] of Object.entries(steps as Record<string, unknown>)) {
          if (patch === null) continue;
          if (typeof patch !== "object" || Array.isArray(patch)) {
            return { ok: false, error: `overrides.steps.${stepId} must be an object` };
          }
          const keyError = validateStepPatchKeys(
            stepId,
            patch as Record<string, unknown>,
            "overrides.steps",
          );
          if (keyError) return { ok: false, error: keyError };
          parsedSteps[stepId] = patch as Partial<AgentRunFields>;
        }
        result.steps = parsedSteps;
      }
    }
  } else {
    const parsedSteps: WorkflowStepOverrides = {};
    for (const [key, val] of Object.entries(obj)) {
      if (val === null) continue;
      if (typeof val !== "object" || Array.isArray(val)) {
        return { ok: false, error: `overrides.${key} must be an object` };
      }
      const keyError = validateStepPatchKeys(key, val as Record<string, unknown>, "overrides");
      if (keyError) return { ok: false, error: keyError };
      parsedSteps[key] = val as Partial<AgentRunFields>;
    }
    result.steps = parsedSteps;
  }

  if ("stepTimeoutSec" in obj) {
    const value = obj.stepTimeoutSec;
    if (value !== null && typeof value !== "number") {
      return { ok: false, error: "overrides.stepTimeoutSec must be a number or null" };
    }
    result.stepTimeoutSec = value as number | null;
  }
  if ("workflowTimeoutSec" in obj) {
    const value = obj.workflowTimeoutSec;
    if (value !== null && typeof value !== "number") {
      return { ok: false, error: "overrides.workflowTimeoutSec must be a number or null" };
    }
    result.workflowTimeoutSec = value as number | null;
  }

  return { ok: true, overrides: result };
}
