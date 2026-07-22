import {
  defaultModelForAgent,
  effortForModelChange,
  effortsForModel,
  modelIdsForAgent,
  modelNameForAgent,
  resolveAgentInstances,
} from "../agents";
import type { SteamtrainConfig } from "../config";
import {
  type WorkflowSpec,
  type WorkflowStep,
  applyWorkflowStepOverrides,
  isAgentBackedStep,
  workflowStepKind,
} from "../workflow";
import { promptForStep } from "./workflow-spec-ui";

/**
 * In-place step editing model shared by the TUI step editor (`WorkflowStepEditor`)
 * and its tests. Editing here stages *session overrides* through the same
 * `patchWorkflowStep` path the `/agent`, `/model`, `/effort`, and `/prompt`
 * slash commands use — nothing is written to disk until `/save-workflows`.
 *
 * Bulk retarget helpers (`listRetargetableSteps`, `buildBulkRetargetPatches`, …)
 * power "apply this agent/model to every agent-backed step" in both the TUI
 * (`A` in the step editor, `/set-all`) and the Web Configure modal.
 */

/** The subset of a step the editor reads and mutates. */
export interface StepEditorTarget {
  workflowName: string;
  stepId: string;
  /** Human label for the step's block kind (worker/llm/…). */
  kindLabel: string;
  /** True for worker/processor (and agent-backed distributor/consolidator) steps. */
  agentBacked: boolean;
  /** True when the step carries an editable prompt. */
  hasPrompt: boolean;
  agent?: string;
  model?: string;
  modelClass?: string;
  effort?: string;
  prompt: string;
}

/** A staged patch, matching the shape `patchWorkflowStep` accepts. */
export interface StepEditorPatch {
  agent?: string;
  model?: string;
  modelClass?: string;
  effort?: string;
  prompt?: string;
}

/** One agent-backed step that can take a bulk agent/model/effort retarget. */
export interface RetargetableStep {
  stepId: string;
  kindLabel: string;
  agent?: string;
  model?: string;
  modelClass?: string;
  effort?: string;
  /**
   * `0` for a step in the spec itself, `1+` for a step reached through one or
   * more sub-workflow (`workflow`) call steps. The `stepId` of a nested step is
   * `::`-namespaced (`<workflowStepId>::<childStepId>`), which is exactly the
   * override-map key that retargets it — so a bulk patch built from this list
   * cascades straight into the sub-workflow. Absent ⇒ treat as `0` (a top-level
   * step); `listRetargetableSteps` always sets it explicitly.
   */
  depth?: number;
  /** The `workflow` step id this step is reached through (undefined at depth 0). */
  viaWorkflowStep?: string;
}

export type EditorField = "agent" | "model" | "effort" | "prompt";

/** Sentinel shown for "no explicit effort" (the model's own default). */
export const EDITOR_EFFORT_NONE = "(default)";

/** Build the editor target for a selected spec step, or `undefined` if nothing is editable. */
export function stepEditorTarget(
  workflowName: string,
  step: WorkflowStep,
): StepEditorTarget | undefined {
  const agentBacked = isAgentBackedStep(step);
  // Prompts are editable on agent-backed steps and direct-inference llm steps —
  // the block kinds where the prompt is the step's primary instruction.
  const hasPrompt = (agentBacked || step.kind === "llm") && promptForStep(step) !== undefined;
  if (!agentBacked && !hasPrompt) return undefined;
  return {
    workflowName,
    stepId: step.id,
    kindLabel: workflowStepKind(step),
    agentBacked,
    hasPrompt,
    agent: agentBacked ? step.agent : undefined,
    model: agentBacked ? step.model : undefined,
    modelClass: agentBacked ? step.modelClass : undefined,
    effort: agentBacked ? step.effort : undefined,
    prompt: promptForStep(step) ?? "",
  };
}

/** Ordered list of fields the editor renders for a target. */
export function editorFieldsFor(
  target: StepEditorTarget,
  config?: SteamtrainConfig,
): EditorField[] {
  const fields: EditorField[] = [];
  if (target.agentBacked) {
    fields.push("agent");
    fields.push("model");
    if (
      target.agent &&
      target.model &&
      effortsForModel(target.agent, target.model, config).length > 0
    ) {
      fields.push("effort");
    }
  }
  if (target.hasPrompt) fields.push("prompt");
  return fields;
}

/** Enabled agent ids selectable for a worker step. */
export function agentOptions(config?: SteamtrainConfig): string[] {
  return resolveAgentInstances(config).map((agent) => agent.id);
}

/** Effort options for the current agent/model, with the "(default)" sentinel first. */
export function effortOptions(agent: string, model: string, config?: SteamtrainConfig): string[] {
  return [EDITOR_EFFORT_NONE, ...effortsForModel(agent, model, config)];
}

/**
 * Step a value forward/back through an option list, wrapping at both ends.
 * Returns the current value unchanged when the list is empty or has one entry.
 */
export function cycleOption<T>(options: readonly T[], current: T, dir: 1 | -1): T {
  if (options.length <= 1) return current;
  const idx = options.indexOf(current);
  // An unknown current value starts the walk from the first option.
  const base = idx < 0 ? 0 : idx;
  const next = (base + dir + options.length) % options.length;
  return options[next] ?? current;
}

/**
 * Patch produced by switching a step to `nextAgent`. Mirrors
 * `executeWorkflowAgentCommand`: keep model/effort when the agent is unchanged,
 * otherwise reset to the new agent's default model and drop the effort.
 */
export function agentChangePatch(
  current: Pick<StepEditorTarget, "agent" | "model" | "effort">,
  nextAgent: string,
  config?: SteamtrainConfig,
): StepEditorPatch {
  if (current.agent === nextAgent) {
    return { agent: nextAgent, model: current.model, effort: current.effort };
  }
  return { agent: nextAgent, model: defaultModelForAgent(nextAgent, config), effort: undefined };
}

/**
 * Patch produced by switching a step to `nextModel`. Mirrors
 * `executeWorkflowModelCommand`: keep the effort only if the new model supports it.
 */
export function modelChangePatch(
  current: Pick<StepEditorTarget, "agent" | "model" | "effort">,
  nextModel: string,
  config?: SteamtrainConfig,
): StepEditorPatch {
  const agent = current.agent ?? "";
  return {
    model: nextModel,
    effort: effortForModelChange(agent, nextModel, current.effort, config),
  };
}

/** Patch produced by selecting `nextEffort` (or the "(default)" sentinel). */
export function effortChangePatch(nextEffort: string): StepEditorPatch {
  return { effort: nextEffort === EDITOR_EFFORT_NONE ? undefined : nextEffort };
}

/**
 * Every agent-backed step that a bulk retarget can reach, in phase order —
 * including steps hidden inside sub-workflows when a catalog `resolve` is
 * supplied.
 *
 * A `workflow` call step is not itself agent-backed, but the steps INSIDE the
 * workflow it invokes are. With `resolve`, this walks into each resolvable
 * sub-workflow (after layering the call step's own `overrides`, so the reported
 * agent/model/effort reflect any cascade already staged) and emits its
 * agent-backed steps under `::`-namespaced ids. That namespaced id is exactly
 * the override-map key that retargets the nested step, so `/set-all` and the
 * bulk-retarget helpers cascade into sub-workflows instead of stopping at the
 * boundary. Without `resolve` the behavior is unchanged (own steps only) — the
 * legacy single-arg call sites keep working.
 *
 * Cyclic references are guarded via `seen`; the depth cap mirrors the engine's
 * `MAX_WORKFLOW_NESTING_DEPTH` so a recursive catalog can't blow the stack.
 */
export function listRetargetableSteps(
  spec: WorkflowSpec,
  resolve?: (name: string) => WorkflowSpec | undefined,
  opts: { prefix?: string; depth?: number; seen?: ReadonlySet<string> } = {},
): RetargetableStep[] {
  const prefix = opts.prefix ?? "";
  const depth = opts.depth ?? 0;
  const seen = opts.seen ?? new Set<string>();
  const out: RetargetableStep[] = [];
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (isAgentBackedStep(step)) {
        out.push({
          stepId: `${prefix}${step.id}`,
          kindLabel: workflowStepKind(step),
          agent: step.agent,
          model: step.model,
          modelClass: step.modelClass,
          effort: step.effort,
          depth,
          viaWorkflowStep: depth > 0 ? prefix.split("::").filter(Boolean).pop() : undefined,
        });
        continue;
      }
      if (step.kind === "workflow" && resolve && depth < 5 && !seen.has(step.workflow)) {
        const base = resolve(step.workflow);
        if (!base) continue;
        // Reflect any cascade already staged on this call step so the listed
        // targets are the effective ones a fresh set-all should diff against.
        const child = step.overrides ? applyWorkflowStepOverrides(base, step.overrides) : base;
        out.push(
          ...listRetargetableSteps(child, resolve, {
            prefix: `${prefix}${step.id}::`,
            depth: depth + 1,
            seen: new Set([...seen, step.workflow]),
          }),
        );
      }
    }
  }
  return out;
}

/**
 * Desired agent/model/effort triad for a bulk retarget. `model` omitted ⇒ the
 * agent's default; `effort` omitted ⇒ clear to the model default (undefined).
 * Pass `effort: null` explicitly when the caller wants to leave each step's
 * existing effort alone only if still valid for the new model — use
 * {@link buildBulkRetargetPatches} which always revalidates.
 */
export interface BulkRetargetDesire {
  agent: string;
  /** When omitted, each step gets the agent's default model. */
  model?: string;
  /**
   * Desired effort. `undefined` clears to the model default; omit the key to
   * clear. Callers that want "keep when valid" should pass the effort and let
   * {@link effortForModelChange} decide.
   */
  effort?: string;
}

/**
 * Build per-step patches that retarget every listed step onto `desire`.
 * Steps already matching the triad produce no entry (so the caller can skip
 * no-ops). Effort is always revalidated against the destination model.
 */
export function buildBulkRetargetPatches(
  steps: readonly RetargetableStep[],
  desire: BulkRetargetDesire,
  config?: SteamtrainConfig,
): Record<string, StepEditorPatch> {
  const patches: Record<string, StepEditorPatch> = {};
  const nextModel = desire.model ?? defaultModelForAgent(desire.agent, config);
  const nextEffort = effortForModelChange(desire.agent, nextModel, desire.effort, config);

  for (const step of steps) {
    const sameAgent = step.agent === desire.agent;
    const sameModel = step.model === nextModel;
    const sameEffort = (step.effort ?? undefined) === (nextEffort ?? undefined);
    if (sameAgent && sameModel && sameEffort) continue;
    patches[step.stepId] = {
      agent: desire.agent,
      model: nextModel,
      effort: nextEffort,
    };
  }
  return patches;
}

/**
 * Build patches that change only the model (and revalidated effort) on steps
 * that already use `agent`. Steps on other agents are skipped — switching the
 * agent is {@link buildBulkRetargetPatches}'s job.
 */
export function buildBulkModelPatches(
  steps: readonly RetargetableStep[],
  agent: string,
  nextModel: string,
  config?: SteamtrainConfig,
): Record<string, StepEditorPatch> {
  const patches: Record<string, StepEditorPatch> = {};
  for (const step of steps) {
    if (step.agent !== agent) continue;
    const nextEffort = effortForModelChange(agent, nextModel, step.effort, config);
    if (step.model === nextModel && (step.effort ?? undefined) === (nextEffort ?? undefined)) {
      continue;
    }
    patches[step.stepId] = { model: nextModel, effort: nextEffort };
  }
  return patches;
}

/**
 * Build patches that set (or clear) effort on steps whose agent/model already
 * support `nextEffort`. Unsupported steps are skipped.
 */
export function buildBulkEffortPatches(
  steps: readonly RetargetableStep[],
  nextEffort: string | undefined,
  config?: SteamtrainConfig,
): Record<string, StepEditorPatch> {
  const patches: Record<string, StepEditorPatch> = {};
  for (const step of steps) {
    if (!step.agent || !step.model) continue;
    const supported = effortsForModel(step.agent, step.model, config);
    if (nextEffort !== undefined && !supported.includes(nextEffort)) continue;
    if ((step.effort ?? undefined) === (nextEffort ?? undefined)) continue;
    patches[step.stepId] = { effort: nextEffort };
  }
  return patches;
}

/** Resolve a model id against an agent's catalog; falls back to the default. */
export function resolveRetargetModel(
  agent: string,
  model: string | undefined,
  config?: SteamtrainConfig,
): string {
  if (model && modelIdsForAgent(agent, config).includes(model)) return model;
  return defaultModelForAgent(agent, config);
}

/** Human summary for a bulk apply notice ("3 steps → claude/sonnet"). */
export function summarizeBulkRetarget(
  patches: Record<string, StepEditorPatch>,
  desire: BulkRetargetDesire,
  config?: SteamtrainConfig,
): string {
  const count = Object.keys(patches).length;
  if (count === 0) return "every agent step already matches";
  const model = desire.model ?? defaultModelForAgent(desire.agent, config);
  const effortNote = desire.effort ? ` · ${desire.effort}` : "";
  const noun = count === 1 ? "step" : "steps";
  return `${count} ${noun} → ${desire.agent} · ${model}${effortNote}`;
}

/** Display label for an agent model id (name + id when they differ). */
export function modelLabel(
  agent: string | undefined,
  model: string | undefined,
  config?: SteamtrainConfig,
): string {
  if (!agent || !model) return model ?? "(none)";
  const name = modelNameForAgent(agent, model, config);
  return name === model ? model : `${name} (${model})`;
}
