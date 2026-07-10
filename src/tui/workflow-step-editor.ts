import {
  defaultModelForAgent,
  effortForModelChange,
  effortsForModel,
  resolveAgentInstances,
} from "../agents";
import type { SteamtrainConfig } from "../config";
import { type WorkflowStep, isAgentBackedStep, workflowStepKind } from "../workflow";
import { promptForStep } from "./workflow-spec-ui";

/**
 * In-place step editing model shared by the TUI step editor (`WorkflowStepEditor`)
 * and its tests. Editing here stages *session overrides* through the same
 * `patchWorkflowStep` path the `/agent`, `/model`, `/effort`, and `/prompt`
 * slash commands use — nothing is written to disk until `/save-workflows`.
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
  effort?: string;
  prompt: string;
}

/** A staged patch, matching the shape `patchWorkflowStep` accepts. */
export interface StepEditorPatch {
  agent?: string;
  model?: string;
  effort?: string;
  prompt?: string;
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
  if (target.agentBacked && target.agent) {
    fields.push("agent");
    fields.push("model");
    if (target.model && effortsForModel(target.agent, target.model, config).length > 0) {
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
