import { z } from "zod";
import type { AgentId } from "../types/events";

/**
 * The declarative workflow model. A `WorkflowSpec` is a sequence of phases;
 * phases run one after another, and the steps inside a phase run in parallel
 * (bounded by `maxConcurrency`). Steps are explicit workflow building blocks:
 * distributors fan one input into many items, workers/processors do 1:1 work,
 * consolidators fan results back in, and gates route/filter based on conditions.
 *
 * Existing specs without a `kind` field remain valid; those steps are treated as
 * `worker` blocks.
 */

export type WorkflowStepKind = "worker" | "processor" | "distributor" | "consolidator" | "gate";

export interface WorkflowStepBase {
  /** Unique across the whole workflow; referenced by `dependsOn` and templates. */
  id: string;
  /** Step ids (in earlier phases) whose outputs this step references. */
  dependsOn?: string[];
}

export interface WorkflowItem {
  /** The distributor step that produced this item. */
  sourceStepId: string;
  /** Zero-based position within the distributor output. */
  index: number;
  /** Item payload supplied to one generated worker/processor run. */
  value: string;
}

export interface AgentRunFields {
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
}

export interface WorkerStep extends WorkflowStepBase, AgentRunFields {
  kind?: "worker" | "processor";
  /**
   * Dynamically fan this worker/processor out over prior distributor items.
   * Syntax: `steps.<id>.items` (or `<id>.items`).
   */
  forEach?: string;
}

export interface DistributorStep extends WorkflowStepBase {
  kind: "distributor";
  /** Static items to distribute. Each item is templated before execution. */
  items?: string[];
  /** Separator used for the rendered text output (defaults to newline). */
  separator?: string;
  /**
   * Optional agent-backed splitter. When provided, the agent output becomes the
   * distributed payload; when `items` is also present, static items win.
   */
  agent?: AgentId;
  model?: string;
  prompt?: string;
  cwd?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
}

export interface ConsolidatorStep extends WorkflowStepBase {
  kind: "consolidator";
  /**
   * Optional agent-backed merge. Without an agent, the consolidator emits the
   * rendered prompt or a sectioned merge of its dependencies.
   */
  agent?: AgentId;
  model?: string;
  prompt?: string;
  cwd?: string;
  env?: Record<string, string>;
  extraArgs?: string[];
  separator?: string;
}

export interface GateCondition {
  /** Step whose result is inspected; omitted means inspect the workflow input. */
  step?: string;
  /** Match the referenced step's ok/error state. */
  ok?: boolean;
  /** Text condition against the referenced output (or input). */
  contains?: string;
  /** Regular expression condition against the referenced output (or input). */
  matches?: string;
  /** Exact text condition against the referenced output (or input). */
  equals?: string;
  /** Invert the final condition result. */
  not?: boolean;
}

export interface GateStep extends WorkflowStepBase {
  kind: "gate";
  condition: GateCondition;
  /** Optional state/label emitted when the gate evaluates. */
  target?: string;
  /** What to do when the condition is false (default: continue). */
  onFalse?: "continue" | "fail" | "stop";
}

export type WorkflowStep = WorkerStep | DistributorStep | ConsolidatorStep | GateStep;

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
  /** Distributed item payloads, when a distributor produced structured items. */
  items?: string[];
  /** The work item assigned to this generated child result, if any. */
  item?: WorkflowItem;
  /** Parent dynamic step id for generated child results. */
  parentStepId?: string;
  /** Generated child results for a dynamic fan-out parent. */
  childResults?: StepResult[];
  /** Gate target/state label, when a gate evaluated. */
  target?: string;
  gate?: {
    passed: boolean;
    onFalse: GateStep["onFalse"];
  };
  error?: string;
  durationMs: number;
  costUsd?: number;
}

/** Total steps a single run may contain (matches the dynamic-workflows cap). */
export const MAX_STEPS = 1000;
/** Hard ceiling on parallel agents; the configured value is clamped to this. */
export const MAX_CONCURRENCY = 16;

const agentId = z.enum(["claude", "opencode"]);

const baseStepShape = {
  id: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).optional(),
};

const agentRunShape = {
  agent: agentId,
  model: z.string().min(1),
  prompt: z.string().min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
  extraArgs: z.array(z.string()).optional(),
};

const optionalAgentRunShape = {
  agent: agentId.optional(),
  model: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
  extraArgs: z.array(z.string()).optional(),
};

const workflowWorkerStepSchema = z.object({
  ...baseStepShape,
  kind: z.enum(["worker", "processor"]).optional(),
  forEach: z.string().min(1).optional(),
  ...agentRunShape,
});

const workflowDistributorStepSchema = z
  .object({
    ...baseStepShape,
    kind: z.literal("distributor"),
    items: z.array(z.string()).min(1).optional(),
    separator: z.string().optional(),
    ...optionalAgentRunShape,
  })
  .superRefine((step, ctx) => {
    if (step.items) return;
    if (step.agent && step.model && step.prompt) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "distributor step requires either non-empty items or agent/model/prompt",
    });
  });

const workflowConsolidatorStepSchema = z
  .object({
    ...baseStepShape,
    kind: z.literal("consolidator"),
    separator: z.string().optional(),
    ...optionalAgentRunShape,
  })
  .superRefine((step, ctx) => {
    if ((step.agent || step.model) && !(step.agent && step.model && step.prompt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent-backed consolidator requires agent, model, and prompt together",
      });
    }
    if (!step.dependsOn?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "consolidator step requires dependsOn",
      });
    }
  });

const gateConditionSchema = z
  .object({
    step: z.string().min(1).optional(),
    ok: z.boolean().optional(),
    contains: z.string().optional(),
    matches: z.string().optional(),
    equals: z.string().optional(),
    not: z.boolean().optional(),
  })
  .superRefine((condition, ctx) => {
    if (
      condition.ok === undefined &&
      condition.contains === undefined &&
      condition.matches === undefined &&
      condition.equals === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "gate condition requires ok, contains, matches, or equals",
      });
    }
    if (condition.ok !== undefined && !condition.step) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "gate condition ok requires condition.step",
      });
    }
  });

const workflowGateStepSchema = z.object({
  ...baseStepShape,
  kind: z.literal("gate"),
  condition: gateConditionSchema,
  target: z.string().min(1).optional(),
  onFalse: z.enum(["continue", "fail", "stop"]).optional(),
});

const workflowStepSchema = z.union([
  workflowWorkerStepSchema,
  workflowDistributorStepSchema,
  workflowConsolidatorStepSchema,
  workflowGateStepSchema,
]);

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

export function workflowStepKind(step: WorkflowStep): WorkflowStepKind {
  return step.kind ?? "worker";
}

export type AgentBackedWorkflowStep = WorkflowStep & AgentRunFields;

export function parseForEachSource(source: string): string | undefined {
  const explicit = /^steps\.(.+)\.items$/.exec(source);
  if (explicit) return explicit[1];
  const shorthand = /^(.+)\.items$/.exec(source);
  return shorthand?.[1];
}

export function isAgentBackedStep(step: WorkflowStep): step is AgentBackedWorkflowStep {
  return "agent" in step && typeof step.agent === "string";
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

  const stepsById = new Map<string, WorkflowStep>();
  const allIds = new Set<string>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      allIds.add(step.id);
      stepsById.set(step.id, step);
    }
  }

  let maxPossibleSteps = spec.phases.reduce((n, p) => n + p.steps.length, 0);
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
      if (step.kind === "gate" && step.condition.step && !earlierIds.has(step.condition.step)) {
        return {
          ok: false,
          error: allIds.has(step.condition.step)
            ? `gate '${step.id}' condition references '${step.condition.step}', which is not in an earlier phase`
            : `gate '${step.id}' condition references unknown step '${step.condition.step}'`,
        };
      }
      if ((step.kind === "worker" || step.kind === "processor" || !step.kind) && step.forEach) {
        const sourceStepId = parseForEachSource(step.forEach);
        if (!sourceStepId) {
          return {
            ok: false,
            error: `step '${step.id}' has invalid forEach '${step.forEach}' (expected steps.<id>.items)`,
          };
        }
        const sourceStep = stepsById.get(sourceStepId);
        if (!earlierIds.has(sourceStepId)) {
          return {
            ok: false,
            error: allIds.has(sourceStepId)
              ? `step '${step.id}' forEach references '${sourceStepId}', which is not in an earlier phase`
              : `step '${step.id}' forEach references unknown step '${sourceStepId}'`,
          };
        }
        if (sourceStep?.kind !== "distributor") {
          return {
            ok: false,
            error: `step '${step.id}' forEach source '${sourceStepId}' must be a distributor step`,
          };
        }
        maxPossibleSteps += sourceStep.items?.length ?? 0;
      }
    }
    // Promote this phase's ids only after the whole phase is checked, so two
    // steps in the same phase can't depend on each other.
    for (const step of phase.steps) earlierIds.add(step.id);
  }

  if (maxPossibleSteps > MAX_STEPS) {
    return {
      ok: false,
      error: `workflow can expand to ${maxPossibleSteps} steps (max ${MAX_STEPS})`,
    };
  }

  return { ok: true };
}
