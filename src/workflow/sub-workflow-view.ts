import { type WorkflowAutonomy, workflowAutonomy } from "./autonomy";
import { applyWorkflowStepOverrides } from "./overrides";
import { MAX_WORKFLOW_NESTING_DEPTH, isAgentBackedStep, workflowStepKind } from "./step-kind";
import type { WorkflowCallStep, WorkflowSpec, WorkflowStep, WorkflowStepKind } from "./types";

/**
 * One step inside a resolved sub-workflow, with its EFFECTIVE run-time target
 * (the child spec's own value, after the parent call step's `overrides` are
 * layered on). This is the data behind "what actually runs in there" — the
 * insight the sub-workflow experience was missing.
 */
export interface SubWorkflowStepView {
  /**
   * Id relative to the parent call step, `::`-namespaced through any deeper
   * sub-workflows (`<childStepId>` or `<childWorkflowStepId>::<deeperStepId>`).
   * This is exactly the override-map key that retargets the step, so a UI can
   * offer per-step control by round-tripping this path.
   */
  path: string;
  /** The step's own id at its own level. */
  id: string;
  kind: WorkflowStepKind;
  /** Nesting depth below the call step (1 = a direct child step). */
  depth: number;
  agentBacked: boolean;
  agent?: string;
  model?: string;
  modelClass?: string;
  effort?: string;
  /** True when the effective target differs from the child spec's own default (an override is in play). */
  overridden: boolean;
  /**
   * The child spec's OWN default target (before any override), so an editor can
   * diff the effective value against it — persist only genuine overrides,
   * without shadowing the shared child spec.
   */
  base?: { agent?: string; model?: string; modelClass?: string; effort?: string };
  /** For a nested `workflow` step, the name of the workflow it invokes. */
  workflow?: string;
}

/**
 * A resolved, run-time-accurate view of a `workflow` call step's target — its
 * structure, the models/agents that will actually run, the autonomy it drags
 * in, and every effective per-step target (overrides applied). Shared by the
 * TUI preview, the web pipeline, and the server summary so all three describe a
 * sub-workflow the same way.
 */
export interface SubWorkflowView {
  /** The invoked workflow's name. */
  workflow: string;
  /** False when the name can't be resolved (unknown workflow, or no resolver). */
  resolved: boolean;
  /** True when resolution stopped because of a cyclic reference. */
  cyclic: boolean;
  phaseCount: number;
  stepCount: number;
  agentStepCount: number;
  /** Distinct agents across the child (agent-backed steps that pin one). */
  agents: string[];
  /** Distinct `agent/model` (or `class:<x>` / bare model) targets, for a compact rollup. */
  targets: string[];
  autonomy: WorkflowAutonomy;
  /** How many effective step targets differ from the child spec's own defaults. */
  overrideCount: number;
  /** The call step's rendered/raw `input` template, when set. */
  input?: string;
  /** The call step's declared child input params, when set. */
  params?: Record<string, string>;
  /** Flattened steps, depth-first, in phase order (structural + agent-backed). */
  steps: SubWorkflowStepView[];
}

/** Compact `agent/model` (or class / bare-model) target label for rollups. */
export function formatSubWorkflowTarget(step: {
  agent?: string;
  model?: string;
  modelClass?: string;
}): string | undefined {
  if (step.agent && step.model) return `${step.agent}/${step.model}`;
  if (step.agent) return step.agent;
  if (step.model) return step.model;
  if (step.modelClass) return `class:${step.modelClass}`;
  return undefined;
}

/** The agent/model/effort target of a step, read type-safely across the union. */
function stepTarget(step: WorkflowStep): {
  agent?: string;
  model?: string;
  modelClass?: string;
  effort?: string;
} {
  return {
    agent: "agent" in step ? step.agent : undefined,
    model: "model" in step ? step.model : undefined,
    modelClass: "modelClass" in step ? step.modelClass : undefined,
    effort: "effort" in step ? step.effort : undefined,
  };
}

function targetFieldsEqual(a: WorkflowStep, b: WorkflowStep): boolean {
  const ta = stepTarget(a);
  const tb = stepTarget(b);
  return (
    ta.agent === tb.agent &&
    ta.model === tb.model &&
    ta.modelClass === tb.modelClass &&
    ta.effort === tb.effort
  );
}

/**
 * Walk a resolved child spec (base + effective, zipped by position) into a flat
 * step view, recursing into nested `workflow` steps. `base`/`effective` share
 * identical structure (overrides only change field values, never add/remove/
 * reorder phases or steps), so index alignment is exact — this function
 * assumes that invariant holds and does not re-validate it; if `effPhase` or
 * `effPhase.steps[si]` is ever missing, it silently falls back to `baseStep`
 * rather than throwing.
 */
function collectSteps(
  base: WorkflowSpec,
  effective: WorkflowSpec,
  resolve: ((name: string) => WorkflowSpec | undefined) | undefined,
  prefix: string,
  depth: number,
  seen: ReadonlySet<string>,
  out: SubWorkflowStepView[],
): void {
  base.phases.forEach((basePhase, pi) => {
    const effPhase = effective.phases[pi];
    basePhase.steps.forEach((baseStep, si) => {
      const step = effPhase?.steps[si] ?? baseStep;
      const kind = workflowStepKind(step);
      const path = `${prefix}${step.id}`;
      const agentBacked = isAgentBackedStep(step);
      out.push({
        path,
        id: step.id,
        kind,
        depth,
        agentBacked,
        agent: agentBacked ? step.agent : undefined,
        model: agentBacked ? step.model : undefined,
        modelClass: agentBacked ? step.modelClass : undefined,
        effort: agentBacked ? step.effort : undefined,
        overridden: !targetFieldsEqual(baseStep, step),
        base: agentBacked ? stepTarget(baseStep) : undefined,
        workflow: step.kind === "workflow" ? step.workflow : undefined,
      });
      if (
        step.kind === "workflow" &&
        resolve &&
        depth < MAX_WORKFLOW_NESTING_DEPTH &&
        !seen.has(step.workflow)
      ) {
        const childBase = resolve(step.workflow);
        if (!childBase) return;
        const childEffective = step.overrides
          ? applyWorkflowStepOverrides(childBase, step.overrides)
          : childBase;
        collectSteps(
          childBase,
          childEffective,
          resolve,
          `${path}::`,
          depth + 1,
          new Set([...seen, step.workflow]),
          out,
        );
      }
    });
  });
}

/**
 * Build a resolved {@link SubWorkflowView} for a `workflow` call step. `resolve`
 * returns BASE (catalog) child specs — the call step's own `overrides` are
 * layered here to compute effective targets, so this never double-applies. When
 * the workflow can't be resolved, returns an unresolved shell (name + params +
 * input) so a UI can still say "invokes X" without contents.
 */
export function describeSubWorkflow(
  step: WorkflowCallStep,
  resolve?: (name: string) => WorkflowSpec | undefined,
  seen: ReadonlySet<string> = new Set(),
): SubWorkflowView {
  const shell: SubWorkflowView = {
    workflow: step.workflow,
    resolved: false,
    cyclic: seen.has(step.workflow),
    phaseCount: 0,
    stepCount: 0,
    agentStepCount: 0,
    agents: [],
    targets: [],
    autonomy: "autonomous",
    overrideCount: 0,
    input: step.input,
    params: step.params,
    steps: [],
  };
  if (!resolve || shell.cyclic) return shell;
  const base = resolve(step.workflow);
  if (!base) return shell;
  const effective = step.overrides ? applyWorkflowStepOverrides(base, step.overrides) : base;

  const steps: SubWorkflowStepView[] = [];
  collectSteps(base, effective, resolve, "", 1, new Set([...seen, step.workflow]), steps);

  const agents = new Set<string>();
  const targets = new Set<string>();
  let agentStepCount = 0;
  let overrideCount = 0;
  for (const s of steps) {
    if (s.agentBacked) {
      agentStepCount += 1;
      if (s.agent) agents.add(s.agent);
      const t = formatSubWorkflowTarget(s);
      if (t) targets.add(t);
    }
    if (s.overridden) overrideCount += 1;
  }

  return {
    workflow: step.workflow,
    resolved: true,
    cyclic: false,
    phaseCount: base.phases.length,
    stepCount: base.phases.reduce((n, p) => n + p.steps.length, 0),
    agentStepCount,
    agents: [...agents],
    targets: [...targets],
    autonomy: workflowAutonomy(effective, resolve),
    overrideCount,
    input: step.input,
    params: step.params,
    steps,
  };
}

/**
 * Compact one-line rollup for a sub-workflow row: step count, the models that
 * actually run, and an override marker. Falls back to a plain "→ <name>" when
 * the workflow can't be resolved (its own listing carries the detail).
 */
export function subWorkflowRollup(view: SubWorkflowView): string {
  if (!view.resolved) {
    return view.cyclic ? `↻ ${view.workflow} (cyclic)` : `→ ${view.workflow} (unresolved)`;
  }
  const bits = [`→ ${view.workflow}`];
  bits.push(`${view.stepCount} step${view.stepCount === 1 ? "" : "s"}`);
  if (view.targets.length > 0) {
    const shown = view.targets.slice(0, 3).join(", ");
    bits.push(view.targets.length > 3 ? `${shown}, +${view.targets.length - 3}` : shown);
  }
  if (view.overrideCount > 0) {
    bits.push(`${view.overrideCount} override${view.overrideCount === 1 ? "" : "s"}`);
  }
  return bits.join(" · ");
}
