import { z } from "zod";
import type { AgentId } from "../types/events";

/**
 * The declarative workflow model. A `WorkflowSpec` is a sequence of phases;
 * phases run one after another, and the steps inside a phase run in parallel
 * (bounded by `maxConcurrency`). Each step is one agent run — and steamtrain's
 * twist over a single dynamic workflow is that every step picks its own
 * agent, model, and target (cwd + optional env/flags).
 */

export interface WorkflowStep {
  /** Unique across the whole workflow; referenced by `dependsOn` and templates. */
  id: string;
  agent: AgentId;
  /** Model string in the agent's own format (claude: `claude-…`, opencode: `provider/model`). */
  model: string;
  /** Prompt template; may reference `{{input}}` and `{{steps.<id>.output}}`. */
  prompt: string;
  /** Target working directory (absolute, or relative to the run's base cwd). */
  cwd?: string;
  /** Extra env vars merged over `process.env` for this step only. */
  env?: Record<string, string>;
  /** Extra CLI flags appended to the agent's own args (advanced targets). */
  extraArgs?: string[];
  /** Step ids (in earlier phases) whose outputs this step's prompt references. */
  dependsOn?: string[];
}

export interface WorkflowPhase {
  id: string;
  title: string;
  /** Steps run in parallel within the phase. */
  steps: WorkflowStep[];
}

export interface WorkflowSpec {
  /** Launch name; unique among available workflows. */
  name: string;
  description?: string;
  phases: WorkflowPhase[];
}

/** The outcome of one step, fed into downstream templates and the cache. */
export interface StepResult {
  stepId: string;
  ok: boolean;
  /** Final text (a failed step's output is its error message, for templating). */
  output: string;
  error?: string;
  durationMs: number;
  costUsd?: number;
}

/** Total steps a single run may contain (matches the dynamic-workflows cap). */
export const MAX_STEPS = 1000;
/** Hard ceiling on parallel agents; the configured value is clamped to this. */
export const MAX_CONCURRENCY = 16;

const agentId = z.enum(["claude", "opencode"]);

const workflowStepSchema = z.object({
  id: z.string().min(1),
  agent: agentId,
  model: z.string().min(1),
  prompt: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
  extraArgs: z.array(z.string()).optional(),
  dependsOn: z.array(z.string().min(1)).optional(),
});

const workflowPhaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  steps: z.array(workflowStepSchema).min(1),
});

/**
 * Shape + size validation. `name` is optional here so a `steamtrain.json`
 * `workflows` map can key by name without repeating it; the loader injects the
 * key as `name`. Cross-phase dependency rules live in {@link validateWorkflow}.
 */
export const workflowSpecSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    phases: z.array(workflowPhaseSchema).min(1),
  })
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    let total = 0;
    for (const phase of spec.phases) {
      for (const step of phase.steps) {
        total += 1;
        if (seen.has(step.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `duplicate step id '${step.id}'`,
          });
        }
        seen.add(step.id);
      }
    }
    if (total > MAX_STEPS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `workflow has ${total} steps (max ${MAX_STEPS})`,
      });
    }
  });

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Full validation: the zod shape plus the structural rule that a `dependsOn`
 * may only reference a step in an EARLIER phase. Phases run sequentially while
 * steps within a phase run in parallel, so same-phase and forward references
 * (and therefore cycles) are rejected.
 */
export function validateWorkflow(spec: WorkflowSpec): ValidationResult {
  const parsed = workflowSpecSchema.safeParse(spec);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid workflow" };
  }

  const allIds = new Set<string>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) allIds.add(step.id);
  }

  const earlierIds = new Set<string>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      for (const dep of step.dependsOn ?? []) {
        if (!earlierIds.has(dep)) {
          return {
            ok: false,
            error: allIds.has(dep)
              ? `step '${step.id}' dependsOn '${dep}', which is not in an earlier phase (deps must reference earlier phases)`
              : `step '${step.id}' dependsOn unknown step '${dep}'`,
          };
        }
      }
    }
    // Promote this phase's ids only after the whole phase is checked, so two
    // steps in the same phase can't depend on each other.
    for (const step of phase.steps) earlierIds.add(step.id);
  }

  return { ok: true };
}
