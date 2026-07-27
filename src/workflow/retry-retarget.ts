import {
  defaultModelForAgent,
  effortForModelChange,
  modelIdsForAgent,
  resolveAgentInstances,
} from "../agents";
import { bindingRequestFromStep, resolveModelBinding } from "../agents/model-resolve";
import type { SteamtrainConfig } from "../config";
import type { AgentInstanceId } from "../types/events";
import type { HistoryStep, RunRecord } from "./history";
import type { WorkflowStepOverrides } from "./overrides";
import { isAgentBackedStep } from "./step-kind";
import type { StepResult, WorkflowSpec } from "./types";

export interface RetryRetargetOptions {
  /** Agent every eligible failed/not-run agent step is forced onto. */
  agent: AgentInstanceId;
  /** Optional explicit model on that agent; otherwise same-family / default. */
  model?: string;
  /** Optional filter: only these step ids are retargeted (and, via the filter helper, re-executed). */
  stepIds?: string[];
}

export type PlanRetryRetargetResult =
  | { ok: true; overrides: WorkflowStepOverrides; stepIds: string[]; targetModel: string }
  | { ok: false; error: string };

/** Non-done history steps (failed / never finished), in record order. */
export function listRetryCandidateSteps(record: RunRecord): HistoryStep[] {
  const out: HistoryStep[] = [];
  for (const phase of record.phases) {
    for (const step of phase.steps) {
      if (step.status !== "done") out.push(step);
    }
  }
  return out;
}

/** True when a history record has at least one non-done step worth retrying. */
export function recordHasRetryCandidates(record: RunRecord): boolean {
  return listRetryCandidateSteps(record).length > 0;
}

/**
 * When `stepIds` is set, seed synthetic skipped results for every non-done
 * history step that is not in the filter so the engine does not launch them.
 * Selected failed steps stay absent from the seed and re-execute.
 *
 * When `spec` is provided, unknown ids (not in the workflow and not in the
 * record) throw.
 */
export function applyRetryStepFilter(
  record: RunRecord,
  seed: Map<string, StepResult>,
  stepIds: string[] | undefined,
  spec?: WorkflowSpec,
): Map<string, StepResult> {
  if (!stepIds || stepIds.length === 0) return new Map(seed);

  const known = knownStepIds(record, spec);
  for (const id of stepIds) {
    if (!known.has(id)) {
      throw new Error(`unknown step '${id}'`);
    }
  }

  const selected = new Set(stepIds);
  const next = new Map(seed);
  for (const step of listRetryCandidateSteps(record)) {
    if (selected.has(step.stepId)) continue;
    if (next.has(step.stepId)) continue;
    next.set(step.stepId, syntheticSkippedResult(step.stepId));
  }
  return next;
}

/**
 * Plan session overrides that force failed/not-run agent-backed steps onto
 * `options.agent` (optionally with an explicit model). Does not touch done
 * steps, llm/command/gate steps, or steps outside an optional `stepIds` filter.
 */
export function planRetryRetarget(
  spec: WorkflowSpec,
  record: RunRecord,
  config: SteamtrainConfig,
  isReady: (agent: AgentInstanceId) => boolean,
  options: RetryRetargetOptions,
): PlanRetryRetargetResult {
  const enabledIds = resolveAgentInstances(config).map((agent) => agent.id);
  const enabled = new Set<string>(enabledIds);
  const target = options.agent;

  if (!enabled.has(target)) {
    return { ok: false, error: `agent '${target}' is disabled or not configured` };
  }
  if (!isReady(target)) {
    return { ok: false, error: `agent '${target}' is not ready (doctor check failed)` };
  }

  if (options.stepIds && options.stepIds.length > 0) {
    try {
      applyRetryStepFilter(record, new Map(), options.stepIds, spec);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const offered = new Set(modelIdsForAgent(target, config));
  let targetModel = options.model;
  if (targetModel !== undefined) {
    if (!offered.has(targetModel)) {
      return {
        ok: false,
        error: `model '${targetModel}' is not offered by agent '${target}'`,
      };
    }
  } else {
    targetModel = defaultModelForAgent(target, config);
  }

  const filter = options.stepIds?.length ? new Set(options.stepIds) : undefined;
  const candidates = listRetryCandidateSteps(record).filter((s) => !filter || filter.has(s.stepId));

  const overrides: WorkflowStepOverrides = {};
  const stepIds: string[] = [];

  for (const hist of candidates) {
    const step = findSpecStep(spec, hist.stepId);
    if (!step || !isAgentBackedStep(step)) continue;

    stepIds.push(step.id);

    if (options.model !== undefined) {
      overrides[step.id] = {
        agent: target,
        model: options.model,
        effort: effortForModelChange(target, options.model, step.effort, config),
      };
      continue;
    }

    // Prefer keeping the step's model family on the new agent.
    const request = bindingRequestFromStep(step);
    const remapped = resolveModelBinding(
      { ...request, agent: target },
      { config, isReady, preferAgent: target },
    );
    if (remapped.ok) {
      const agent = remapped.primary.agent;
      const model = remapped.primary.model;
      overrides[step.id] = {
        agent,
        model,
        effort: effortForModelChange(agent, model, step.effort ?? remapped.primary.effort, config),
      };
      continue;
    }

    overrides[step.id] = {
      agent: target,
      model: targetModel,
      effort: effortForModelChange(target, targetModel, step.effort, config),
    };
  }

  if (stepIds.length === 0) {
    return { ok: false, error: "no agent-backed failed steps to retarget" };
  }

  return { ok: true, overrides, stepIds, targetModel };
}

function syntheticSkippedResult(stepId: string): StepResult {
  // ok:true + skipped:true matches engine skip semantics: treat as settled so
  // dependents can proceed without re-launching this step.
  return {
    stepId,
    ok: true,
    skipped: true,
    output: "",
    target: "skipped",
    durationMs: 0,
  };
}

function knownStepIds(record: RunRecord, spec?: WorkflowSpec): Set<string> {
  const ids = new Set<string>();
  for (const phase of record.phases) {
    for (const step of phase.steps) ids.add(step.stepId);
  }
  if (spec) {
    for (const phase of spec.phases) {
      for (const step of phase.steps) ids.add(step.id);
    }
  }
  return ids;
}

function findSpecStep(spec: WorkflowSpec, stepId: string) {
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (step.id === stepId) return step;
    }
  }
  return undefined;
}
