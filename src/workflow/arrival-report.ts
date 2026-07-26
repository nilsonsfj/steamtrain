import type { StepState, WorkflowState } from "./reducer";
import { flattenSteps } from "./reducer";

/** Minimal result fields needed for the receipt (avoids importing types.ts). */
interface ArrivalStepResult {
  stepId: string;
  ok: boolean;
  skipped?: boolean;
  output?: string;
  durationMs?: number;
  costUsd?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
  };
  childResults?: ArrivalStepResult[];
}

export interface ArrivalReceipt {
  ok: boolean;
  durationMs: number;
  okCount: number;
  failCount: number;
  skipCount: number;
  costUsd: number;
  tokens: number;
  /** True when the run spent $0 and used no tokens (tour / command-only). */
  agentless: boolean;
}

export interface ArrivalDestination {
  id: string;
  label: string;
  /** Workflow to select, when this destination launches another ride. */
  workflow?: string;
  /** Key binding hint for the TUI. */
  key?: string;
}

export interface ArrivalReport {
  /** Consolidator (or last meaningful step) output — the artifact. */
  hero: string;
  /** Step that produced the hero, when known. */
  heroStepId?: string;
  receipt: ArrivalReceipt;
  destinations: ArrivalDestination[];
}

const DEFAULT_NEXT_CANDIDATES = ["bug-hunt", "code-review", "mainline-stream", "mainline"];

/** Preference order for the Arrival "Try …" destination. */
export const ARRIVAL_NEXT_CANDIDATES = DEFAULT_NEXT_CANDIDATES;

/**
 * Build the Arrival Report from a finished (or finishing) workflow state.
 * Returns null when the run has not completed.
 *
 * Kept free of `cost.ts` / `history.ts` imports so the browser reducer bundle
 * does not pull the analytics graph.
 */
export function buildArrivalReport(
  state: WorkflowState,
  opts: {
    elapsedMs?: number;
    nextWorkflow?: string;
    /** Candidate workflows for the "Try …" destination, in preference order. */
    nextCandidates?: string[];
    /** When set, only advertise a next workflow that is present in this set. */
    availableWorkflows?: ReadonlySet<string>;
    /** When true, advertise the $0 agentless receipt even if cost fields are absent. */
    credentialFree?: boolean;
  } = {},
): ArrivalReport | null {
  if (!state.done) return null;

  const flat = flattenSteps(state);
  const leaves = leafResults(state);
  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;
  let costUsd = 0;
  let tokens = 0;
  let durationMs = 0;
  for (const result of leaves) {
    if (result.skipped) skipCount += 1;
    else if (result.ok) okCount += 1;
    else failCount += 1;
    costUsd += result.costUsd ?? 0;
    tokens += tokenTotal(result.tokens);
    durationMs += result.durationMs ?? 0;
  }

  const heroStep = findArrivalStep(flat.map((f) => f.step));
  let hero = (heroStep?.result?.output ?? heroStep?.text ?? "").trim() || fallbackHero(state);

  // A failed run's hero is usually the last step's raw output — useless for
  // "what broke?". Lead with the root-cause failures so the arrival screen
  // answers that directly, then keep the hero output below for context.
  if (!state.ok) {
    const failures = rootFailureLines(flat.map((f) => f.step));
    if (failures.length > 0) hero = [...failures, "", hero].join("\n");
  }

  // Prefer an explicit credentialFree flag (tour). The $0/0-token heuristic is
  // a best-effort fallback — a cancelled agent run that never billed can look
  // the same, which is rare on the Arrival surface.
  // Invariant: agentless implies costUsd === 0 && tokens === 0.
  const agentless =
    opts.credentialFree === true || (costUsd === 0 && tokens === 0 && failCount === 0);

  const nextCandidates = opts.nextCandidates ?? DEFAULT_NEXT_CANDIDATES;
  const current = state.name;
  const next =
    opts.nextWorkflow ??
    nextCandidates.find(
      (name) => name !== current && (!opts.availableWorkflows || opts.availableWorkflows.has(name)),
    );

  const destinations: ArrivalDestination[] = [{ id: "again", label: "Ride again", key: "r" }];
  if (next) {
    destinations.push({
      id: "next",
      label: `Try ${next}`,
      workflow: next,
      key: "n",
    });
  }
  destinations.push({ id: "history", label: "See past runs", key: "h" });

  return {
    hero,
    heroStepId: heroStep?.stepId,
    receipt: {
      ok: Boolean(state.ok),
      durationMs: opts.elapsedMs && opts.elapsedMs > 0 ? opts.elapsedMs : durationMs,
      okCount,
      failCount,
      skipCount,
      costUsd,
      tokens,
      agentless,
    },
    destinations,
  };
}

/** Prefer the latest successful consolidator; else the last successful leaf with output. */
export function findArrivalStep(steps: StepState[]): StepState | undefined {
  const consolidators = steps.filter(
    (s) => s.blockKind === "consolidator" && s.status === "done" && s.result?.ok !== false,
  );
  if (consolidators.length > 0) return consolidators[consolidators.length - 1];

  const withOutput = [...steps]
    .reverse()
    .find(
      (s) =>
        (s.status === "done" || s.status === "error") &&
        (s.result?.output ?? s.text).trim().length > 0 &&
        !s.result?.skipped,
    );
  return withOutput;
}

/**
 * Plain-English climax headline for both UIs.
 * Examples: `Tour complete · $0 · 0.7s` / `bug-hunt stopped · 1 failed · 12.4s`
 * Empty or missing workflowName falls back to `Run …`.
 */
export function formatArrivalHeadline(
  receipt: ArrivalReceipt,
  workflowName?: string | null,
): string {
  const name = (workflowName ?? "").trim();
  const subject = name === "tour" ? "Tour" : name || "Run";
  const outcome = receipt.ok ? "complete" : "stopped";
  const parts: string[] = [`${subject} ${outcome}`];
  if (receipt.agentless) parts.push("$0");
  else if (receipt.costUsd > 0) parts.push(`$${receipt.costUsd.toFixed(4)}`);
  else parts.push("$0");
  parts.push(`${(receipt.durationMs / 1000).toFixed(1)}s`);
  if (receipt.failCount > 0) parts.push(`${receipt.failCount} failed`);
  return parts.join(" · ");
}

/** Structured receipt facts for card layouts (what ran / cost / produced). */
export function arrivalReceiptCards(receipt: ArrivalReceipt): Array<{
  id: "ran" | "cost" | "produced";
  label: string;
  value: string;
}> {
  const ranParts = [`${receipt.okCount} ok`];
  if (receipt.failCount) ranParts.push(`${receipt.failCount} failed`);
  if (receipt.skipCount) ranParts.push(`${receipt.skipCount} skipped`);
  const cost = receipt.agentless
    ? "$0 · no agents"
    : receipt.costUsd > 0
      ? `$${receipt.costUsd.toFixed(4)}`
      : "$0";
  const produced =
    receipt.tokens > 0
      ? `${compactTokens(receipt.tokens)} tokens`
      : receipt.agentless
        ? "engine demo"
        : "no tokens billed";
  return [
    { id: "ran", label: "What ran", value: ranParts.join(" · ") },
    { id: "cost", label: "What it cost", value: cost },
    { id: "produced", label: "What it produced", value: produced },
  ];
}

/** One-line receipt for compact UI chrome. */
export function formatArrivalReceipt(receipt: ArrivalReceipt): string {
  const parts: string[] = [];
  parts.push(`${(receipt.durationMs / 1000).toFixed(1)}s`);
  parts.push(`${receipt.okCount} ok`);
  if (receipt.failCount) parts.push(`${receipt.failCount} failed`);
  if (receipt.skipCount) parts.push(`${receipt.skipCount} skipped`);
  if (receipt.agentless) parts.push("$0 · no agents");
  else {
    if (receipt.costUsd > 0) parts.push(`$${receipt.costUsd.toFixed(4)}`);
    if (receipt.tokens > 0) parts.push(`${compactTokens(receipt.tokens)} tok`);
  }
  return parts.join(" · ");
}

function leafResults(state: WorkflowState): ArrivalStepResult[] {
  const fromResults = (state.results ?? []).filter((r) => !r.childResults?.length);
  if (fromResults.length > 0) return fromResults;
  const out: ArrivalStepResult[] = [];
  for (const phase of state.phases) {
    for (const step of phase.steps) {
      if (step.result) out.push(step.result);
    }
  }
  return out.filter((r) => !r.childResults?.length);
}

/**
 * One `✗ <step>: <error>` line per root-cause failure in a stopped run.
 * Cascade victims — marked `dependencyFailed` by the engine, or matching its
 * "dependency '<id>' failed" message prefix in run records persisted before
 * the marker existed — are dropped when at least one genuine root failure
 * exists; they only restate what the root lines already explain. When no
 * root is identifiable at all, every failure is listed: a noisy pointer
 * beats a hero that says nothing about why the run stopped.
 */
function rootFailureLines(steps: StepState[]): string[] {
  const failed = steps.filter((s) => s.result && !s.result.ok && !s.result.skipped);
  const roots = failed.filter(
    (s) => !s.result?.dependencyFailed && !(s.result?.error ?? "").startsWith("dependency '"),
  );
  const shown = roots.length > 0 ? roots : failed;
  return shown.map((s) => {
    const firstErrLine = (s.result?.error ?? "failed").split("\n", 1)[0]?.trim() || "failed";
    const capped = firstErrLine.length > 200 ? `${firstErrLine.slice(0, 199)}…` : firstErrLine;
    return `✗ ${s.stepId}: ${capped}`;
  });
}

function fallbackHero(state: WorkflowState): string {
  if (state.ok) {
    return state.name
      ? `Workflow '${state.name}' finished, but no consolidator report was produced. Press i to show step details.`
      : "Workflow finished, but no consolidator report was produced. Press i to show step details.";
  }
  return state.name
    ? `Workflow '${state.name}' stopped short. Press i to show step details and find the stall.`
    : "Workflow stopped short. Press i to show step details and find the stall.";
}

function tokenTotal(t: ArrivalStepResult["tokens"] | undefined): number {
  if (!t) return 0;
  return (
    (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) + (t.reasoning ?? 0)
  );
}

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
