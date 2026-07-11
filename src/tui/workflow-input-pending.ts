import { type PlanResult, type WorkflowSpec, planWorkflow } from "../workflow";

/** Pending state while the TUI collects workflow input parameters. */
export type InputFormPending =
  | { name: string; prompt: string; fresh: boolean; action: "run" }
  | { name: string; prompt: string; action: "plan" };

export function workflowHasDeclaredInputs(spec: WorkflowSpec): boolean {
  return Boolean(spec.inputs && Object.keys(spec.inputs).length > 0);
}

/**
 * Produce a plan after the input form submits for a plan action (Ctrl+D).
 * Returns null when the workflow spec is unavailable.
 */
export function planFromInputFormSubmit(
  spec: WorkflowSpec | undefined,
  pending: Extract<InputFormPending, { action: "plan" }>,
  params: Record<string, string | number | boolean>,
): PlanResult | null {
  if (!spec) return null;
  return planWorkflow(spec, pending.prompt, params);
}
