import type { AgentRunFields, WorkflowSpec } from "./types";
import { isAgentBackedStep, workflowStepKind } from "./types";

export type WorkflowStepOverrides = Record<string, Partial<AgentRunFields>>;

const AGENT_FIELD_KEYS = new Set<keyof AgentRunFields>([
  "agent",
  "model",
  "prompt",
  "cwd",
  "env",
  "extraArgs",
  "effort",
  "stepTimeoutSec",
  "stepTimeoutMs",
]);

/** Merge session overrides into a workflow spec (preview + run). */
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
        if (!patch || !isAgentBackedStep(step)) return step;
        const kind = workflowStepKind(step);
        if (kind === "distributor" || kind === "consolidator") {
          const safePatch: Partial<AgentRunFields> = {};
          for (const key of AGENT_FIELD_KEYS) {
            if (key in patch) {
              (safePatch as Record<string, unknown>)[key] = (patch as Record<string, unknown>)[key];
            }
          }
          return { ...step, ...safePatch };
        }
        return { ...step, ...patch };
      }),
    })),
  };
}
