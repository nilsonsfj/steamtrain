import { replayedSpend, totalTokens } from "./cost";
import type { StepState, WorkflowState } from "./reducer";
import { flattenSteps } from "./reducer";

/** Minimal result fields needed for the receipt (avoids importing types.ts). */
interface ArrivalStepResult {
  stepId: string;
  ok: boolean;
  skipped?: boolean;
  /** Set by the engine on a step that never ran because a dependency broke. */
  dependencyFailed?: string;
  error?: string;
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
  /**
   * Steps that broke on their own. A cascade victim is NOT one of these — it
   * never ran, so counting it here is what made a single broken step report as
   * "4 failed" and sent readers hunting for three failures that never happened.
   */
  failCount: number;
  /** Steps whose `when` condition was false. */
  skipCount: number;
  /** Steps that never started because a dependency broke first. */
  blockedCount: number;
  costUsd: number;
  tokens: number;
  /**
   * Whether any step reported a cost / token count at all. Several agents
   * (Antigravity, Kiro; Cursor and Amp for cost) report none, and "$0" for
   * those runs would read as "free" rather than "unknown".
   */
  costReported?: boolean;
  tokensReported?: boolean;
  /** True when no agent or API step ran (tour / command-only): genuinely $0. */
  agentless: boolean;
}

/**
 * The one step a stopped run broke on, and what its breaking cost downstream.
 *
 * This is the question a reader arrives with — which step broke, why, and what
 * did not get to run — so it is computed once, from the engine's own markers,
 * rather than re-derived by each surface out of the notice list.
 */
export interface ArrivalRootCause {
  stepId: string;
  blockKind: string;
  /** 1-based position of the phase the step belongs to, and that phase's title. */
  phaseNumber: number;
  phaseTitle: string;
  /** The engine's first error line, e.g. `command exited with code 1`. */
  error: string;
  durationMs?: number;
  /** True when a human (or the run's cancellation) killed the step. */
  killed: boolean;
  /** Steps that never started because this one broke, in run order. */
  blocked: string[];
}

/**
 * One thing about the run that is worth a reader's attention, ranked by how
 * much it should worry them.
 *
 * These are RUN OUTCOMES — a step that failed, was killed, needed retries —
 * not findings parsed out of an agent's report. steamtrain never reads an
 * agent's prose, so it cannot rank "unchecked JSON.parse crashes the manager"
 * above "leaked child process"; what it knows for certain is what the engine
 * observed. The severity vocabulary is the design's; the evidence is ours.
 */
export interface ArrivalNotice {
  /** critical: the run broke here · high: it was stopped or diverted · medium: it coped. */
  severity: "critical" | "high" | "medium";
  stepId: string;
  /** The headline, e.g. "scan-errors failed". */
  what: string;
  /** Supporting detail: the error's first line, the gate's target, the attempt count. */
  where?: string;
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
  /** What went wrong (or nearly did), worst first. Empty on a clean run. */
  notices: ArrivalNotice[];
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
  let blockedCount = 0;
  let costUsd = 0;
  let tokens = 0;
  let durationMs = 0;
  for (const result of leaves) {
    if (result.skipped) skipCount += 1;
    else if (result.ok) okCount += 1;
    else if (isCascadeVictim(result)) blockedCount += 1;
    else failCount += 1;
    costUsd += result.costUsd ?? 0;
    tokens += totalTokens(result.tokens);
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

  // Prefer an explicit credentialFree flag (tour). Otherwise ask whether an
  // agent or API step actually ran — "$0 and no tokens" alone can't tell a
  // command-only ride from an agent that reports no usage (Antigravity, Kiro).
  // Invariant: agentless implies costUsd === 0 && tokens === 0.
  const ranBilledStep = flat.some(({ step }) => Boolean(step.agent || step.api) && executed(step));
  // The run's spend is known only when every agent/API step that executed
  // either reported its own or was a cached replay — which billed nothing this
  // run, even for an agent that never reports spend (Antigravity, Kiro). One
  // silent step leaves the total unknown; no agent steps at all (commands
  // only) is a known $0. Fan-out parents carry no spend of their own.
  const billedSteps = flat
    .map(({ step }) => step)
    .filter(
      (step) =>
        Boolean(step.agent || step.api) && executed(step) && !step.result?.childResults?.length,
    );
  const costReported = billedSteps.every(
    (step) => step.cached || step.result?.costUsd !== undefined,
  );
  const tokensReported = billedSteps.every(
    (step) => step.cached || step.result?.tokens !== undefined,
  );
  const agentless =
    opts.credentialFree === true ||
    (!ranBilledStep && costUsd === 0 && tokens === 0 && failCount === 0 && blockedCount === 0);

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
      blockedCount,
      costUsd,
      tokens,
      costReported,
      tokensReported,
      agentless,
    },
    notices: arrivalNotices(flat.map((f) => f.step)),
    destinations,
  };
}

/**
 * The exact message `cascadeResult` in engine.ts writes for a step that never
 * ran: `dependency '<id>' failed` (optionally followed by a reason). Matching
 * the whole template, not just a `dependency '` prefix, keeps a step whose own
 * error happens to open with that word from being written off as a victim.
 */
const LEGACY_CASCADE_ERROR = /^dependency '[^']+' failed(:|$)/;

/**
 * True when this not-ok result is a step that never ran because a dependency
 * broke first. The engine marks these `dependencyFailed`; run records written
 * before that marker existed only carry the message it replaced, so that
 * message is still matched as a fallback.
 */
/**
 * A step that actually ran: not skipped, not blocked by a failed dependency,
 * and not a fan-out child left undispatched by a cost cap.
 */
function executed(step: StepState): boolean {
  const r = step.result;
  return r !== undefined && !r.skipped && !r.notRun && !isCascadeVictim(r);
}

export function isCascadeVictim(
  result: { dependencyFailed?: string; error?: string } | undefined,
): boolean {
  if (!result) return false;
  return Boolean(result.dependencyFailed) || LEGACY_CASCADE_ERROR.test(result.error ?? "");
}

/**
 * The step a stopped run broke on, plus the steps its breaking blocked.
 * Returns null for a run that finished, or one whose only not-ok steps are
 * cascade victims (no identifiable root — the caller should fall back to the
 * notice list rather than nominate an arbitrary victim as the cause).
 */
export function arrivalRootCause(state: WorkflowState): ArrivalRootCause | null {
  if (!state.done || state.ok) return null;
  const blocked: string[] = [];
  let root: { step: StepState; phaseNumber: number; phaseTitle: string } | null = null;
  for (const phase of state.phases) {
    for (const step of phase.steps) {
      const result = step.result;
      // A fan-out parent restates its children; the children are the steps.
      if (!result || result.childResults?.length) continue;
      if (result.ok || result.skipped) continue;
      if (isCascadeVictim(result)) {
        blocked.push(step.stepId);
        continue;
      }
      if (!root) {
        root = { step, phaseNumber: phase.index + 1, phaseTitle: phase.title };
      }
    }
  }
  if (!root) return null;
  const result = root.step.result;
  const firstLine = (result?.error ?? "").split("\n", 1)[0]?.trim();
  return {
    stepId: root.step.stepId,
    blockKind: root.step.blockKind,
    phaseNumber: root.phaseNumber,
    phaseTitle: root.phaseTitle,
    error: firstLine || "failed",
    durationMs: result?.durationMs,
    killed: Boolean(result?.killed),
    blocked,
  };
}

/** Rank order for {@link ArrivalNotice.severity}; lower sorts first. */
const SEVERITY_RANK: Record<ArrivalNotice["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
};

/**
 * What the run's own steps say went wrong, worst first.
 *
 * A root failure is critical: the run broke there. A cascade victim, a killed
 * step and a gate that stopped the run are high — the run was stopped or
 * diverted, but the cause is elsewhere or deliberate. Retries and skips are
 * medium: the run coped, and the reader may still want to know.
 */
export function arrivalNotices(steps: StepState[]): ArrivalNotice[] {
  const notices: ArrivalNotice[] = [];
  for (const step of steps) {
    const result = step.result;
    // A fan-out parent is summarised by its children, which are their own
    // steps: reporting both would say the same thing twice.
    if (result?.childResults?.length) continue;
    if (result && !result.ok && !result.skipped) {
      const firstLine = (result.error ?? "").split("\n", 1)[0]?.trim();
      const detail =
        firstLine && firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine;
      if (result.killed) {
        // "killed by human:web" → "by human:web": the headline already says it
        // was killed, so the detail line is for who (and, when the step was
        // failing anyway, what it was failing of).
        notices.push({
          severity: "high",
          stepId: step.stepId,
          what: `${step.stepId} was killed`,
          where: detail?.startsWith("killed ") ? detail.slice("killed ".length) : detail,
        });
      } else if (result.dependencyFailed) {
        notices.push({
          severity: "high",
          stepId: step.stepId,
          what: `${step.stepId} never ran`,
          where: `${result.dependencyFailed} failed before it`,
        });
      } else {
        notices.push({
          severity: "critical",
          stepId: step.stepId,
          what: `${step.stepId} failed`,
          where: detail,
        });
      }
      continue;
    }
    // A gate that did not pass and does not loop stopped (or failed) the run.
    if (step.gate && step.gate.passed === false && !step.loopTo) {
      notices.push({
        severity: "high",
        stepId: step.stepId,
        what: `gate ${step.stepId} did not pass`,
        where: step.gate.target ? `expected ${step.gate.target}` : undefined,
      });
      continue;
    }
    const attempts = step.attempts ?? result?.attempts;
    if (typeof attempts === "number" && attempts > 1) {
      notices.push({
        severity: "medium",
        stepId: step.stepId,
        what: `${step.stepId} needed ${attempts} attempts`,
        where: "it succeeded on the last one",
      });
      continue;
    }
    if (result?.skipped) {
      notices.push({
        severity: "medium",
        stepId: step.stepId,
        what: `${step.stepId} was skipped`,
        where: "its condition was false",
      });
    }
  }
  return sortNotices(notices);
}

/** Worst first; ties keep run order, which is the order they were collected in. */
function sortNotices(notices: ArrivalNotice[]): ArrivalNotice[] {
  return notices
    .map((notice, index) => ({ notice, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.notice.severity] - SEVERITY_RANK[b.notice.severity] || a.index - b.index,
    )
    .map((entry) => entry.notice);
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
  // An agent that reports no cost is unknown, not free — leave it out.
  else if (receipt.costReported !== false) parts.push("$0");
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
  const notRun = receipt.skipCount + (receipt.blockedCount ?? 0);
  if (notRun) ranParts.push(`${notRun} skipped`);
  const cost = receipt.agentless
    ? "$0 · no agents"
    : receipt.costUsd > 0
      ? `$${receipt.costUsd.toFixed(4)}`
      : receipt.costReported === false
        ? "not reported"
        : "$0";
  const produced =
    receipt.tokens > 0
      ? `${compactTokens(receipt.tokens)} tokens`
      : receipt.agentless
        ? "workflow output"
        : receipt.tokensReported === false
          ? "tokens not reported"
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
  const notRun = receipt.skipCount + (receipt.blockedCount ?? 0);
  if (notRun) parts.push(`${notRun} skipped`);
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
      // A cached replay's spend belongs to the run that produced it.
      if (step.result) out.push(step.cached ? replayedSpend(step.result) : step.result);
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
  const roots = failed.filter((s) => !isCascadeVictim(s.result));
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

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
