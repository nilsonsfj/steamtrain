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
 * `pending.prompt` may be empty — freeform `{{input}}` is optional.
 */
export function planFromInputFormSubmit(
  spec: WorkflowSpec | undefined,
  pending: Extract<InputFormPending, { action: "plan" }>,
  params: Record<string, string | number | boolean>,
): PlanResult | null {
  if (!spec) return null;
  return planWorkflow(spec, pending.prompt, params);
}

export type InputFormSubmitResult =
  | { action: "plan"; plan: PlanResult }
  | {
      action: "run";
      name: string;
      prompt: string;
      fresh: boolean;
      params: Record<string, string | number | boolean>;
    }
  | { action: "missing-spec" };

/** Route a submitted input form to either plan generation or workflow launch. */
export function resolveInputFormSubmit(
  pending: InputFormPending,
  spec: WorkflowSpec | undefined,
  params: Record<string, string | number | boolean>,
): InputFormSubmitResult {
  if (pending.action === "plan") {
    const plan = planFromInputFormSubmit(spec, pending, params);
    if (!plan) return { action: "missing-spec" };
    return { action: "plan", plan };
  }
  return {
    action: "run",
    name: pending.name,
    prompt: pending.prompt,
    fresh: pending.fresh,
    params,
  };
}
