import type { TokenUsage } from "../types/events";
import type { HistoryPhase, HistoryStep, RunRecord } from "./history";
import type { StepResult, WorkflowSpec } from "./types";

/**
 * Token + cost math shared by the engine, history roll-ups, the CLI/TUI/web
 * summaries, and the `workflow costs` analytics command — so every surface
 * reports the same categories the same way. Pure and dependency-light so it can
 * be unit-tested and bundled into the browser reducer.
 */

/** The token categories, in display order. Keeps every UI's column order in sync. */
export const TOKEN_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;
export type TokenKey = (typeof TOKEN_KEYS)[number];

/** Short human labels for each token category (for compact UIs). */
export const TOKEN_LABELS: Record<TokenKey, string> = {
  input: "in",
  output: "out",
  cacheRead: "cache r",
  cacheWrite: "cache w",
  reasoning: "reason",
};

/** A zeroed usage accumulator. */
export function emptyTokens(): Required<TokenUsage> {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

/** True when a usage object carries no non-zero fields (nothing to display). */
export function isEmptyTokens(t: TokenUsage | undefined): boolean {
  if (!t) return true;
  return TOKEN_KEYS.every((k) => !t[k]);
}

/** Add `b` into `a` field by field, returning `a` (mutating accumulator). */
export function addTokensInto(
  a: Required<TokenUsage>,
  b: TokenUsage | undefined,
): Required<TokenUsage> {
  if (!b) return a;
  for (const k of TOKEN_KEYS) a[k] += b[k] ?? 0;
  return a;
}

/** Immutable sum of two usage objects (undefined-safe). */
export function addTokens(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage {
  return addTokensInto(addTokensInto(emptyTokens(), a), b);
}

/**
 * Grand total of all billable tokens: input + output + cache reads + cache
 * writes. `reasoning` is deliberately excluded because providers that report it
 * (Codex) bill it inside `output`, so adding it would double-count.
 */
export function totalTokens(t: TokenUsage | undefined): number {
  if (!t) return 0;
  return (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
}

/** Compact human count: 12 → "12", 3400 → "3.4k", 2_100_000 → "2.1M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/** "$0.0123" style, matching the rest of the app's 4-dp convention. */
export function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/**
 * A compact one-line token summary, e.g. "12.3k tok (in 8k · out 3k · cache r
 * 1.3k)". Returns "" when there is nothing to show. Only non-zero categories
 * are listed so the line stays short.
 */
export function formatTokenSummary(t: TokenUsage | undefined): string {
  const total = totalTokens(t);
  if (total === 0 || !t) return "";
  const parts: string[] = [];
  for (const k of TOKEN_KEYS) {
    const v = t[k] ?? 0;
    if (v > 0) parts.push(`${TOKEN_LABELS[k]} ${formatTokens(v)}`);
  }
  return `${formatTokens(total)} tok (${parts.join(" · ")})`;
}

/** Aggregate cost + tokens attributed to one model (or agent/model pair). */
export interface ModelUsage {
  /** Display key: model string (or `agent/model` when both are known). */
  model: string;
  /** The configured model string (as declared on the step). */
  modelId?: string;
  /** The agent instance that ran the model, when known. */
  agent?: string;
  costUsd: number;
  tokens: Required<TokenUsage>;
  /** Number of leaf steps (agent invocations) attributed to this model. */
  steps: number;
}

/** Aggregate cost + tokens attributed to one workflow. */
export interface WorkflowUsage {
  workflow: string;
  runs: number;
  costUsd: number;
  tokens: Required<TokenUsage>;
  steps: number;
}

/** Aggregate cost + tokens attributed to one step id within a workflow. */
export interface StepUsage {
  workflow: string;
  stepId: string;
  costUsd: number;
  tokens: Required<TokenUsage>;
  runs: number;
}

function ensureModel(
  map: Map<string, ModelUsage>,
  key: string,
  seed: Partial<ModelUsage>,
): ModelUsage {
  let entry = map.get(key);
  if (!entry) {
    entry = { model: key, tokens: emptyTokens(), costUsd: 0, steps: 0, ...seed };
    map.set(key, entry);
  }
  return entry;
}

/**
 * A leaf agent invocation with its recorded model/agent — the unit every
 * aggregation attributes cost and tokens to. Fan-out parents are excluded by the
 * callers (their children are the leaves).
 */
export interface LeafUsage {
  agent?: string;
  model?: string;
  costUsd?: number;
  tokens?: TokenUsage;
}

/** The display key for a model breakdown row: `agent/model`, or `model`, or agent, or "unknown". */
export function modelKey(leaf: { agent?: string; model?: string }): string {
  if (leaf.model && leaf.agent) return `${leaf.agent}/${leaf.model}`;
  if (leaf.model) return leaf.model;
  if (leaf.agent) return leaf.agent;
  return "unknown";
}

/** Roll up an arbitrary list of leaf invocations by model, sorted by descending cost. */
export function aggregateLeavesByModel(leaves: Iterable<LeafUsage>): ModelUsage[] {
  const map = new Map<string, ModelUsage>();
  for (const leaf of leaves) {
    const key = modelKey(leaf);
    const entry = ensureModel(map, key, { modelId: leaf.model, agent: leaf.agent });
    entry.costUsd += leaf.costUsd ?? 0;
    addTokensInto(entry.tokens, leaf.tokens);
    entry.steps += 1;
  }
  return sortByCost([...map.values()]);
}

function sortByCost<T extends { costUsd: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.costUsd - a.costUsd);
}

/**
 * Walk a history record's phase tree yielding one {@link LeafUsage} per agent
 * invocation. Fan-out parents (their `result.childResults`) are skipped; their
 * children are the leaves. Steps that never ran (`pending`) contribute nothing.
 */
export function* recordLeaves(phases: HistoryPhase[]): Generator<LeafUsage & { stepId: string }> {
  for (const phase of phases) {
    for (const step of phase.steps) {
      if (step.result?.childResults?.length) continue;
      if (step.status === "pending") continue;
      yield {
        stepId: step.parentStepId ? step.parentStepId : step.stepId,
        agent: step.agent,
        model: step.model,
        costUsd: step.result?.costUsd,
        tokens: step.result?.tokens,
      };
    }
  }
}

/** Per-model breakdown for a single run's phase tree. */
export function modelBreakdownForRecord(record: Pick<RunRecord, "phases">): ModelUsage[] {
  return aggregateLeavesByModel(recordLeaves(record.phases));
}

/** Sum tokens across a single run's leaves. */
export function tokensForRecord(record: Pick<RunRecord, "phases">): Required<TokenUsage> {
  const total = emptyTokens();
  for (const leaf of recordLeaves(record.phases)) addTokensInto(total, leaf.tokens);
  return total;
}

/** The full cross-history analytics used by `steamtrain workflow costs`. */
export interface CostAnalytics {
  runs: number;
  costUsd: number;
  tokens: Required<TokenUsage>;
  byWorkflow: WorkflowUsage[];
  byStep: StepUsage[];
  byModel: ModelUsage[];
}

/**
 * Aggregate spend across many recorded runs, broken down by workflow, step id,
 * and model — answering "which step / model / workflow is eating the budget?".
 */
export function aggregateCosts(records: RunRecord[]): CostAnalytics {
  const byWorkflow = new Map<string, WorkflowUsage>();
  const byStep = new Map<string, StepUsage>();
  const modelLeaves: LeafUsage[] = [];
  const grand = emptyTokens();
  let grandCost = 0;

  for (const record of records) {
    const wf = byWorkflow.get(record.workflow) ?? {
      workflow: record.workflow,
      runs: 0,
      costUsd: 0,
      tokens: emptyTokens(),
      steps: 0,
    };
    wf.runs += 1;
    byWorkflow.set(record.workflow, wf);

    for (const leaf of recordLeaves(record.phases)) {
      const cost = leaf.costUsd ?? 0;
      wf.costUsd += cost;
      addTokensInto(wf.tokens, leaf.tokens);
      wf.steps += 1;
      grandCost += cost;
      addTokensInto(grand, leaf.tokens);
      modelLeaves.push(leaf);

      const stepKey = `${record.workflow} ${leaf.stepId}`;
      const step = byStep.get(stepKey) ?? {
        workflow: record.workflow,
        stepId: leaf.stepId,
        costUsd: 0,
        tokens: emptyTokens(),
        runs: 0,
      };
      step.costUsd += cost;
      addTokensInto(step.tokens, leaf.tokens);
      step.runs += 1;
      byStep.set(stepKey, step);
    }
  }

  return {
    runs: records.length,
    costUsd: grandCost,
    tokens: grand,
    byWorkflow: sortByCost([...byWorkflow.values()]),
    byStep: sortByCost([...byStep.values()]),
    byModel: aggregateLeavesByModel(modelLeaves),
  };
}

/** Build a `stepId → { agent, model }` map from a spec, for attributing live results. */
export function stepMetaFromSpec(
  spec: WorkflowSpec,
): Map<string, { agent?: string; model?: string }> {
  const map = new Map<string, { agent?: string; model?: string }>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      const agent = "agent" in step ? step.agent : undefined;
      const model = "model" in step ? step.model : undefined;
      map.set(step.id, { agent, model });
    }
  }
  return map;
}

/**
 * Leaves from a live {@link StepResult} list (used by the CLI end-of-run summary).
 *
 * The engine flattens every fan-out into `allResults`: each child is a top-level
 * entry (carrying `parentStepId`) *and* the parent (with `childResults`) is also
 * present. We therefore count the flat children and skip the parents, matching
 * the summary's per-row loop — descending into `childResults` here would
 * double-count. Children's model/agent come from the parent step's meta.
 */
export function* resultLeaves(
  results: StepResult[],
  stepMeta: Map<string, { agent?: string; model?: string }>,
): Generator<LeafUsage> {
  for (const r of results) {
    if (r.childResults?.length) continue; // parent — its children appear flat
    const meta = stepMeta.get(r.parentStepId ?? r.stepId);
    yield { agent: meta?.agent, model: meta?.model, costUsd: r.costUsd, tokens: r.tokens };
  }
}

/** Sum leaf token usage from the engine's flat {@link StepResult} list (skips fan-out parents). */
export function tokensForResults(results: StepResult[]): Required<TokenUsage> {
  const total = emptyTokens();
  for (const r of results) {
    if (r.childResults?.length) continue; // parent — its children appear flat
    addTokensInto(total, r.tokens);
  }
  return total;
}

/** Sum leaf cost from the engine's flat {@link StepResult} list (skips fan-out parents). */
export function costForResults(results: StepResult[]): number {
  let total = 0;
  for (const r of results) {
    if (r.childResults?.length) continue; // parent — its children appear flat
    total += r.costUsd ?? 0;
  }
  return total;
}

export type { HistoryStep };
