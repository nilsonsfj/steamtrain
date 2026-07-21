/**
 * Dry-run / plan preview for workflows. Produces a static analysis of a
 * workflow spec without executing any agents — the rendered prompts, expanded
 * step tree, dependency graph, gate conditions, loop structure, and step
 * counts. This powers the `workflow plan` CLI command, the TUI's dry-run
 * preview (Ctrl+D), and the web UI's "Plan" button.
 */

import { llmStepApiId, resolveLlmProvider } from "./llm";
import type { TemplateContext } from "./template";
import { renderPrompt } from "./template";
import type {
  GateCondition,
  GateStep,
  WorkflowPhase,
  WorkflowSpec,
  WorkflowStep,
  WorkflowStepKind,
} from "./types";
import { isAgentBackedStep, parseForEachSource, validateWorkflow, workflowStepKind } from "./types";

// ── Public types ─────────────────────────────────────────────────────────────

export interface PlanStep {
  stepId: string;
  phaseId: string;
  phaseTitle: string;
  phaseIndex: number;
  kind: WorkflowStepKind;
  agent?: string;
  model?: string;
  /** Role class when the step binds by class instead of (or alongside) a model. */
  modelClass?: string;
  /** API instance a direct-inference `llm` step calls (explicit `api`, else the built-in provider). */
  llmApi?: string;
  /** Resolved API dialect for direct-inference `llm` steps. */
  llmProvider?: string;
  effort?: string;
  dependsOn?: string[];
  /** The rendered prompt (agent steps) or cmd (command steps). */
  renderedPrompt?: string;
  isAgentBacked: boolean;
  /** True for command steps and pure (non-agent) consolidators. */
  isDeterministic: boolean;
  /** forEach source step id, if this step fans out. */
  forEachSource?: string;
  /** Static item count when the distributor has explicit `items`. */
  forEachCount?: number;
  /** True when the distributor is agent-backed (items unknown until runtime). */
  forEachDynamic?: boolean;
  /** Human-readable gate condition description. */
  gateCondition?: string;
  /** Gate onFalse behavior. */
  gateOnFalse?: string;
  /** Loop target phase id. */
  loopTo?: string;
  /** Loop max iterations. */
  maxIterations?: number;
  /** Human-readable when-condition description. */
  whenCondition?: string;
  /** Sub-workflow name for workflow steps. */
  workflowName?: string;
  /** Merge mode for merge steps. */
  mergeMode?: string;
  /** Workspace inherit/attach source. */
  workspaceSource?: string;
  /** Whether `workspaceSource` is an `inherit` or `attach` reference. */
  workspaceMode?: "inherit" | "attach";
  /** Declared artifact paths. */
  artifacts?: string[];
}

export interface PlanResult {
  ok: boolean;
  error?: string;
  warnings?: string[];
  steps: PlanStep[];
  /** Number of phases. */
  phaseCount: number;
  /** Number of static steps (before forEach expansion). */
  staticStepCount: number;
  /** Number of agent-backed steps (will spawn agent CLIs). */
  agentCallCount: number;
  /** Number of direct-API `llm` steps (no agent CLI, key from env). */
  llmCallCount: number;
  /** Number of deterministic steps (commands, pure consolidators). */
  deterministicCount: number;
  /** Steps that have forEach with known static item counts. */
  forEachSteps: { stepId: string; source: string; count: number }[];
  /** Steps that have forEach with agent-backed distributors (dynamic). */
  forEachDynamicSteps: { stepId: string; source: string }[];
  /** Loop gates in the workflow. */
  loopGates: { gateId: string; loopTo: string; maxIterations: number }[];
  /** Sub-workflow steps. */
  workflowSteps: { stepId: string; workflow: string }[];
  /** Distinct agents used. */
  agents: string[];
  /** Distinct API instances used by `llm` steps. */
  apis: string[];
  /** Workflow-level maxCostUsd, if set. */
  maxCostUsd?: number;
  /** Observed spend and duration from completed runs of this workflow, when available. */
  history?: PlanHistoryContext;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function describeCondition(condition: GateCondition): string {
  const parts: string[] = [];
  if (condition.step) parts.push(`step '${condition.step}'`);
  if (condition.ok !== undefined) parts.push(`ok = ${condition.ok}`);
  if (condition.path) parts.push(`path '${condition.path}'`);
  if (condition.contains) parts.push(`contains "${condition.contains}"`);
  if (condition.equals) parts.push(`equals "${condition.equals}"`);
  if (condition.matches) parts.push(`matches /${condition.matches}/`);
  if (condition.not) parts.push("(inverted)");
  return parts.join(" AND ") || "(empty)";
}

/**
 * Render a template with a dry-run context: resolve `{{input}}`,
 * `{{inputs.*}}`, `{{item}}`, and `{{iteration}}`, but leave `{{steps.*}}`
 * references as symbolic placeholders since no steps have run yet.
 */
function renderDryTemplate(
  template: string,
  input: string,
  inputs?: Record<string, string | number | boolean>,
): string {
  const ctx: TemplateContext = {
    input,
    inputs,
    outputs: new Map(),
  };
  return renderPrompt(template, ctx);
}

function stepIsDeterministic(step: WorkflowStep): boolean {
  const kind = workflowStepKind(step);
  if (kind === "command") return true;
  if (kind === "gate") return true;
  if (kind === "consolidator" && !isAgentBackedStep(step)) return true;
  if (kind === "distributor" && !isAgentBackedStep(step)) return true;
  if (kind === "merge") return true;
  // Agentless, costless, no LLM in the loop — same category as command/merge.
  if (kind === "issues") return true;
  // workflow steps invoke child workflows which may contain agent-backed steps,
  // so they are NOT deterministic — treat them as delegated.
  return false;
}

function describeGateCondition(step: WorkflowStep): string | undefined {
  if (!("condition" in step) || !step.condition) return undefined;
  return describeCondition(step.condition);
}

function describeWhenCondition(step: WorkflowStep): string | undefined {
  if (!step.when) return undefined;
  return describeCondition(step.when);
}

// ── Core plan function ───────────────────────────────────────────────────────

/**
 * Produce a static plan for a workflow spec without executing anything.
 *
 * @param spec The workflow spec to plan.
 * @param input The workflow input text (for `{{input}}` rendering).
 * @param params Resolved input parameters (for `{{inputs.*}}` rendering).
 */
export function planWorkflow(
  spec: WorkflowSpec,
  input: string,
  params?: Record<string, string | number | boolean>,
): PlanResult {
  const validation = validateWorkflow(spec);
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.error,
      warnings: validation.warnings,
      steps: [],
      phaseCount: 0,
      staticStepCount: 0,
      agentCallCount: 0,
      llmCallCount: 0,
      deterministicCount: 0,
      forEachSteps: [],
      forEachDynamicSteps: [],
      loopGates: [],
      workflowSteps: [],
      agents: [],
      apis: [],
    };
  }

  const steps: PlanStep[] = [];
  const forEachSteps: PlanResult["forEachSteps"] = [];
  const forEachDynamicSteps: PlanResult["forEachDynamicSteps"] = [];
  const loopGates: PlanResult["loopGates"] = [];
  const workflowSteps: PlanResult["workflowSteps"] = [];
  const agentSet = new Set<string>();
  const apiSet = new Set<string>();

  // Build step lookup for resolving forEach sources.
  const stepById = new Map<string, WorkflowStep>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) stepById.set(step.id, step);
  }

  for (let pi = 0; pi < spec.phases.length; pi++) {
    const phase = spec.phases[pi] as WorkflowPhase;
    for (const step of phase.steps) {
      const kind = workflowStepKind(step);
      const agentBacked = isAgentBackedStep(step);

      // Render prompt or cmd.
      let renderedPrompt: string | undefined;
      if (agentBacked && "prompt" in step && typeof step.prompt === "string") {
        renderedPrompt = renderDryTemplate(step.prompt, input, params);
      } else if (kind === "command" && "cmd" in step && typeof step.cmd === "string") {
        renderedPrompt = renderDryTemplate(step.cmd, input, params);
      } else if (kind === "consolidator" && "prompt" in step && typeof step.prompt === "string") {
        renderedPrompt = renderDryTemplate(step.prompt, input, params);
      } else if (kind === "llm" && "prompt" in step && typeof step.prompt === "string") {
        renderedPrompt = renderDryTemplate(step.prompt, input, params);
      } else if (kind === "workflow" && "input" in step && typeof step.input === "string") {
        renderedPrompt = renderDryTemplate(step.input, input, params);
      }

      // forEach analysis.
      let forEachSource: string | undefined;
      let forEachCount: number | undefined;
      let forEachDynamic: boolean | undefined;
      if (
        (kind === "worker" || kind === "processor" || kind === "llm") &&
        "forEach" in step &&
        step.forEach
      ) {
        const sourceId = parseForEachSource(step.forEach);
        if (sourceId) {
          forEachSource = sourceId;
          const sourceStep = stepById.get(sourceId);
          if (sourceStep?.kind === "distributor") {
            if (sourceStep.items && sourceStep.items.length > 0) {
              forEachCount = sourceStep.items.length;
              forEachSteps.push({ stepId: step.id, source: sourceId, count: forEachCount });
            } else if (isAgentBackedStep(sourceStep)) {
              forEachDynamic = true;
              forEachDynamicSteps.push({ stepId: step.id, source: sourceId });
            }
          } else if (sourceStep?.kind === "llm") {
            // llm splitters produce their items at run time.
            forEachDynamic = true;
            forEachDynamicSteps.push({ stepId: step.id, source: sourceId });
          }
        }
      }

      // Loop gate analysis.
      if (kind === "gate" && "loopTo" in step && step.loopTo) {
        loopGates.push({
          gateId: step.id,
          loopTo: step.loopTo,
          maxIterations: ("maxIterations" in step ? step.maxIterations : undefined) ?? 10,
        });
      }

      // Sub-workflow analysis.
      if (kind === "workflow" && "workflow" in step) {
        workflowSteps.push({ stepId: step.id, workflow: step.workflow });
      }

      // Merge mode.
      let mergeMode: string | undefined;
      if (kind === "merge" && "mode" in step) {
        mergeMode = step.mode ?? "apply";
      }

      // Workspace source.
      let workspaceSource: string | undefined;
      let workspaceMode: "inherit" | "attach" | undefined;
      if ("workspace" in step && typeof step.workspace === "string") {
        const m = /^(inherit|attach):(.+)$/.exec(step.workspace);
        if (m) {
          workspaceMode = m[1] as "inherit" | "attach";
          workspaceSource = m[2];
        }
      }

      // Artifacts.
      let artifacts: string[] | undefined;
      if ("artifacts" in step && Array.isArray(step.artifacts) && step.artifacts.length > 0) {
        artifacts = [...step.artifacts];
      }

      if (agentBacked) {
        if (typeof step.agent === "string") agentSet.add(step.agent);
      }
      if (step.kind === "llm") apiSet.add(llmStepApiId(step));

      steps.push({
        stepId: step.id,
        phaseId: phase.id,
        phaseTitle: phase.title,
        phaseIndex: pi,
        kind,
        agent: agentBacked && typeof step.agent === "string" ? step.agent : undefined,
        model: agentBacked || kind === "llm" ? (step as { model?: string }).model : undefined,
        modelClass: agentBacked ? (step as { modelClass?: string }).modelClass : undefined,
        llmApi: step.kind === "llm" ? llmStepApiId(step) : undefined,
        // A step that names neither provider nor model inherits the dialect
        // from its configured api instance at run time; the static plan then
        // reports the instance id (llmApi) without guessing a dialect.
        llmProvider:
          step.kind === "llm" && (step.provider || step.model)
            ? resolveLlmProvider(step)
            : undefined,
        effort: (agentBacked || kind === "llm") && "effort" in step ? step.effort : undefined,
        dependsOn: step.dependsOn,
        renderedPrompt,
        isAgentBacked: agentBacked,
        isDeterministic: stepIsDeterministic(step),
        forEachSource,
        forEachCount,
        forEachDynamic,
        gateCondition: describeGateCondition(step),
        gateOnFalse: kind === "gate" ? (step as GateStep).onFalse : undefined,
        loopTo: kind === "gate" ? (step as GateStep).loopTo : undefined,
        maxIterations: kind === "gate" ? (step as GateStep).maxIterations : undefined,
        whenCondition: describeWhenCondition(step),
        workflowName: kind === "workflow" ? (step as { workflow?: string }).workflow : undefined,
        mergeMode,
        workspaceSource,
        workspaceMode,
        artifacts,
      });
    }
  }

  return {
    ok: true,
    warnings: validation.warnings,
    steps,
    phaseCount: spec.phases.length,
    staticStepCount: steps.length,
    agentCallCount: steps.filter((s) => s.isAgentBacked).length,
    llmCallCount: steps.filter((s) => s.kind === "llm").length,
    deterministicCount: steps.filter((s) => s.isDeterministic).length,
    forEachSteps,
    forEachDynamicSteps,
    loopGates,
    workflowSteps,
    agents: [...agentSet],
    apis: [...apiSet],
    maxCostUsd: spec.maxCostUsd,
  };
}

/**
 * "What did this workflow cost last time?" — aggregated from recorded runs so
 * a plan can show real numbers instead of a guess. Only completed (`done`)
 * runs count: failed or canceled runs under-report what a full run spends.
 */
export interface PlanHistoryContext {
  /** Completed recorded runs of this workflow (any input). */
  runs: number;
  avgCostUsd: number;
  minCostUsd: number;
  maxCostUsd: number;
  avgDurationMs: number;
}

export function planHistoryContext(
  summaries: readonly {
    workflow: string;
    status: string;
    totals?: { costUsd: number };
    durationMs: number;
  }[],
  workflow: string,
): PlanHistoryContext | null {
  const done = summaries.filter((s) => s.workflow === workflow && s.status === "done");
  if (done.length === 0) return null;
  const costs = done.map((s) => s.totals?.costUsd ?? 0);
  const durations = done.map((s) => s.durationMs);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return {
    runs: done.length,
    avgCostUsd: sum(costs) / done.length,
    minCostUsd: Math.min(...costs),
    maxCostUsd: Math.max(...costs),
    avgDurationMs: sum(durations) / done.length,
  };
}
