import type { AgentRunFields, WorkflowSpec } from "./types";
import { isAgentBackedStep } from "./types";

export type WorkflowStepOverrides = Record<string, Partial<AgentRunFields>>;

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
        return { ...step, ...patch };
      }),
    })),
  };
}
