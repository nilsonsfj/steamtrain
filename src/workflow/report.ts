import { agentUiLabel } from "../agents";
import { formatElapsed, formatTokens, formatUsd, totalTokens } from "./cost";
import type { HistoryStep, RunRecord, RunRecordStatus } from "./history";

/**
 * Machine-readable run reporting for CI / headless consumers.
 *
 * A `workflow run` settles into exactly one {@link RunOutcome}; each outcome
 * maps to a stable process exit code ({@link EXIT_CODES}) so a pipeline can
 * branch on *why* a run failed without parsing logs:
 *
 *   0   success         the run completed and every step passed
 *   1   step-failed     a worker/processor/command/llm step errored
 *   2   gate-failed     a quality gate (or approval checkpoint) rejected the run
 *   3   timeout         the whole-workflow wall-clock budget elapsed
 *   4   budget-exceeded a cost cap (workflow- or step-level maxCostUsd) was hit
 *   130 canceled        the run was canceled (SIGINT/SIGTERM / `workflow cancel`)
 *
 * The same classification drives the `--report json|markdown|junit` documents,
 * so the exit code and the report always agree.
 */

export type ReportFormat = "json" | "markdown" | "junit";

export const REPORT_FORMATS: readonly ReportFormat[] = ["json", "markdown", "junit"];

export function isReportFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(value);
}

export type RunOutcome =
  | "success"
  | "step-failed"
  | "gate-failed"
  | "timeout"
  | "budget-exceeded"
  | "canceled";

/**
 * The stable exit-code contract. Consumed by the CLI directly and documented
 * for pipelines / the GitHub Action. Codes are chosen so the common "did it
 * pass?" check (`exit 0`) is unambiguous and every failure mode is distinct.
 */
export const EXIT_CODES: Record<RunOutcome, number> = {
  success: 0,
  "step-failed": 1,
  "gate-failed": 2,
  timeout: 3,
  "budget-exceeded": 4,
  canceled: 130,
};

/** Short human label for an outcome, used in report headers and summaries. */
export const OUTCOME_LABELS: Record<RunOutcome, string> = {
  success: "succeeded",
  "step-failed": "failed (step error)",
  "gate-failed": "failed (gate rejected)",
  timeout: "failed (timed out)",
  "budget-exceeded": "failed (cost budget exceeded)",
  canceled: "canceled",
};

export interface ClassifyRunOptions {
  /**
   * True when the run's abort came from the whole-workflow timeout timer rather
   * than a user cancel. Both surface as record status "canceled" (the engine
   * only knows it was aborted), so the driver passes this flag to tell them
   * apart.
   */
  timedOut?: boolean;
}

/**
 * Classify a settled run into a single {@link RunOutcome}. The record's own
 * `status` is the primary signal; the gate/step split for a not-ok run is
 * derived from the recorded step results.
 */
export function classifyRun(record: RunRecord, opts: ClassifyRunOptions = {}): RunOutcome {
  switch (record.status) {
    case "canceled":
      return (opts.timedOut ?? record.timedOut) ? "timeout" : "canceled";
    case "budget-exceeded":
      return "budget-exceeded";
    case "done":
      return "success";
    case "error":
      return hasGateFailure(record) ? "gate-failed" : "step-failed";
  }
}

export function exitCodeForOutcome(outcome: RunOutcome): number {
  return EXIT_CODES[outcome];
}

export function exitCodeForRun(record: RunRecord, opts: ClassifyRunOptions = {}): number {
  return exitCodeForOutcome(classifyRun(record, opts));
}

/**
 * Whether the run failed because a quality gate rejected it. A gate (or an
 * approval checkpoint, which the engine records as a gate) that evaluated and
 * did not pass with `onFalse: "fail"` is the failure signal. Gates skipped
 * because a dependency failed are `ok` and carry no `gate.passed === false`,
 * so a genuine failing gate means the steps feeding it passed — the gate itself
 * is what stopped the run.
 */
function hasGateFailure(record: RunRecord): boolean {
  for (const phase of record.phases) {
    for (const step of phase.steps) {
      if (step.gate && step.gate.passed === false && step.gate.onFalse === "fail") return true;
    }
  }
  return false;
}

// ── report model ─────────────────────────────────────────────────────────────

export const RUN_REPORT_SCHEMA = "steamtrain.run-report";
export const RUN_REPORT_VERSION = 1;

/** Cap on per-step output embedded in a report so a document stays bounded. */
const REPORT_STEP_OUTPUT_CAP = 4_000;

export interface ReportStep {
  stepId: string;
  kind: string;
  status: "done" | "error" | "pending";
  ok: boolean;
  cached: boolean;
  skipped: boolean;
  agent?: string;
  api?: string;
  model?: string;
  durationMs?: number;
  /**
   * What the step's result reported. For a `cached` step that is the original
   * run's spend, not this run's (which is $0) — skip cached steps when summing;
   * `totals` already does.
   */
  costUsd?: number;
  tokens?: number;
  gate?: { passed: boolean; onFalse?: string; target?: string };
  error?: string;
  /** The step's raw output text (before truncation). Used by the JUnit renderer for `<system-out>`. */
  text?: string;
  /** Truncated final output — present on failed steps so CI shows the cause. */
  output?: string;
}

export interface ReportPhase {
  phaseId: string;
  title: string;
  index: number;
  ok: boolean;
  steps: ReportStep[];
}

export interface RunReportModel {
  schema: typeof RUN_REPORT_SCHEMA;
  version: typeof RUN_REPORT_VERSION;
  outcome: RunOutcome;
  outcomeLabel: string;
  exitCode: number;
  run: {
    id: string;
    workflow: string;
    input: string;
    cwd: string;
    status: RunRecordStatus;
    ok: boolean;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    error?: string;
  };
  totals: {
    steps: number;
    ok: number;
    failed: number;
    /** Taken down by the run's cancel or timeout, not broken on their own. */
    interrupted: number;
    cached: number;
    costUsd: number;
    tokens: number;
    durationMs: number;
  };
  budget?: { scope: "workflow" | "step"; stepId?: string; limitUsd: number; spentUsd: number };
  /** Steps that did not pass — the ones a CI reader cares about, up front. */
  failedSteps: ReportStep[];
  phases: ReportPhase[];
}

export function buildReportModel(
  record: RunRecord,
  outcome: RunOutcome = classifyRun(record),
): RunReportModel {
  const phases: ReportPhase[] = record.phases.map((phase) => ({
    phaseId: phase.phaseId,
    title: phase.title,
    index: phase.index,
    ok: phase.ok,
    steps: phase.steps.map(toReportStep),
  }));
  const failedSteps = phases.flatMap((phase) => phase.steps).filter((step) => !step.ok);
  return {
    schema: RUN_REPORT_SCHEMA,
    version: RUN_REPORT_VERSION,
    outcome,
    outcomeLabel: OUTCOME_LABELS[outcome],
    exitCode: exitCodeForOutcome(outcome),
    run: {
      id: record.id,
      workflow: record.workflow,
      input: record.input,
      cwd: record.cwd,
      status: record.status,
      ok: record.ok,
      startedAt: new Date(record.startedAt).toISOString(),
      endedAt: new Date(record.endedAt).toISOString(),
      durationMs: record.durationMs,
      ...(record.error ? { error: record.error } : {}),
    },
    totals: {
      steps: record.totals.steps,
      ok: record.totals.ok,
      failed: record.totals.failed,
      interrupted: record.totals.interrupted ?? 0,
      cached: record.totals.cached,
      costUsd: record.totals.costUsd,
      tokens: totalTokens(record.totals.tokens),
      durationMs: record.totals.durationMs,
    },
    ...(record.budget ? { budget: record.budget } : {}),
    failedSteps,
    phases,
  };
}

function toReportStep(step: HistoryStep): ReportStep {
  const tokens = totalTokens(step.result?.tokens);
  // A settled record never leaves a step "running" (the builder finalizes it to
  // "error"), but normalize defensively so the report type stays narrow.
  const status: ReportStep["status"] = step.status === "running" ? "error" : step.status;
  return {
    stepId: step.stepId,
    kind: step.blockKind,
    status,
    ok: status === "done",
    cached: step.cached,
    skipped: Boolean(step.result?.skipped),
    ...(step.agent ? { agent: step.agent } : {}),
    ...(step.api ? { api: step.api } : {}),
    ...(step.model ? { model: step.model } : {}),
    ...(step.result?.durationMs !== undefined ? { durationMs: step.result.durationMs } : {}),
    ...(step.result?.costUsd ? { costUsd: step.result.costUsd } : {}),
    ...(tokens > 0 ? { tokens } : {}),
    ...(step.gate
      ? {
          gate: {
            passed: step.gate.passed,
            ...(step.gate.onFalse ? { onFalse: step.gate.onFalse } : {}),
            ...(step.gate.target ? { target: step.gate.target } : {}),
          },
        }
      : {}),
    ...(step.result?.error ? { error: step.result.error } : {}),
    ...(step.text.trim() ? { text: step.text } : {}),
    ...(step.status !== "done" && step.text.trim() ? { output: capOutput(step.text) } : {}),
  };
}

function capOutput(text: string): string {
  if (text.length <= REPORT_STEP_OUTPUT_CAP) return text;
  return `${text.slice(0, REPORT_STEP_OUTPUT_CAP)}\n… [truncated ${text.length - REPORT_STEP_OUTPUT_CAP} chars]`;
}

// ── renderers ────────────────────────────────────────────────────────────────

export interface RenderReportOptions {
  outcome?: RunOutcome;
}

/** Render a settled run into one of the machine-readable report formats. */
export function renderReport(
  record: RunRecord,
  format: ReportFormat,
  opts: RenderReportOptions = {},
): string {
  const model = buildReportModel(record, opts.outcome ?? classifyRun(record));
  switch (format) {
    case "json":
      return `${JSON.stringify(model, null, 2)}\n`;
    case "markdown":
      return renderMarkdownReport(model);
    case "junit":
      return renderJunitReport(model);
  }
}

const OUTCOME_BADGE: Record<RunOutcome, string> = {
  success: "✅ passed",
  "step-failed": "❌ failed",
  "gate-failed": "🚧 gate failed",
  timeout: "⏱ timed out",
  "budget-exceeded": "💸 budget exceeded",
  canceled: "⏹ canceled",
};

function renderMarkdownReport(model: RunReportModel): string {
  const lines: string[] = [];
  const { run, totals } = model;
  lines.push(`## steamtrain · ${run.workflow} ${OUTCOME_BADGE[model.outcome]}`);
  lines.push("");
  lines.push(`**${model.outcomeLabel}** · exit code \`${model.exitCode}\``);
  lines.push("");
  const summaryBits = [
    `${totals.ok}/${totals.steps} steps ok`,
    totals.failed > 0 ? `${totals.failed} failed` : null,
    totals.interrupted > 0 ? `${totals.interrupted} interrupted` : null,
    totals.cached > 0 ? `${totals.cached} cached` : null,
    formatElapsed(totals.durationMs),
    totals.costUsd > 0 ? formatUsd(totals.costUsd) : null,
    totals.tokens > 0 ? `${formatTokens(totals.tokens)} tokens` : null,
  ].filter((bit): bit is string => Boolean(bit));
  lines.push(summaryBits.join(" · "));
  lines.push("");
  lines.push(`> ${truncate(run.input, 240)}`);
  lines.push("");
  if (run.error) {
    lines.push(`**Error:** ${run.error}`);
    lines.push("");
  }
  if (model.budget) {
    const scope =
      model.budget.scope === "step" && model.budget.stepId
        ? `step \`${model.budget.stepId}\``
        : "workflow";
    lines.push(
      `**Budget:** ${scope} cap ${formatUsd(model.budget.limitUsd)} reached (spent ${formatUsd(model.budget.spentUsd)})`,
    );
    lines.push("");
  }

  if (model.failedSteps.length > 0) {
    lines.push("### Failed steps");
    lines.push("");
    for (const step of model.failedSteps) {
      const runner = stepRunnerLabel(step);
      lines.push(
        `- **${step.stepId}**${runner ? ` (${runner})` : ""} — ${stepFailureReason(step)}`,
      );
      if (step.error) lines.push(`  - ${truncate(step.error, 400)}`);
      if (step.output) {
        lines.push("  ```");
        for (const outLine of step.output.split("\n").slice(0, 12)) lines.push(`  ${outLine}`);
        lines.push("  ```");
      }
    }
    lines.push("");
  }

  lines.push("### Steps");
  lines.push("");
  lines.push("| Step | Kind | Status | Duration | Cost |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const phase of model.phases) {
    for (const step of phase.steps) {
      const glyph = step.ok ? "✅" : step.status === "pending" ? "⏭" : "❌";
      const status = step.ok
        ? step.cached
          ? "cached"
          : "ok"
        : step.status === "pending"
          ? "not run"
          : step.skipped
            ? "skipped"
            : "failed";
      const duration = step.durationMs !== undefined ? formatElapsed(step.durationMs) : "—";
      // A cached replay billed nothing this run (the totals agree); the JSON
      // keeps its original `costUsd` alongside `cached` for consumers.
      const cost = step.cached ? "$0" : step.costUsd ? formatUsd(step.costUsd) : "—";
      lines.push(`| ${glyph} ${step.stepId} | ${step.kind} | ${status} | ${duration} | ${cost} |`);
    }
  }
  lines.push("");
  lines.push(
    `_run ${run.id} · ${run.startedAt} → ${run.endedAt} · steamtrain ${RUN_REPORT_SCHEMA} v${RUN_REPORT_VERSION}_`,
  );
  lines.push("");
  return lines.join("\n");
}

function stepRunnerLabel(step: ReportStep): string | undefined {
  if (step.agent && step.model) return `${agentUiLabel(step.agent)}/${step.model}`;
  if (step.agent) return agentUiLabel(step.agent);
  if (step.api && step.model) return `${step.api}/${step.model}`;
  if (step.api) return step.api;
  return step.model;
}

function stepFailureReason(step: ReportStep): string {
  if (step.gate && step.gate.passed === false) {
    return step.gate.onFalse === "fail" ? "gate condition not met" : "gate not passed";
  }
  if (step.status === "pending") return "never ran";
  return "step error";
}

function renderJunitReport(model: RunReportModel): string {
  const { run, totals } = model;
  const failures = model.failedSteps.filter((step) => step.status !== "pending").length;
  const skipped = model.phases
    .flatMap((phase) => phase.steps)
    .filter((step) => step.status === "pending" || step.skipped).length;
  const time = (totals.durationMs / 1000).toFixed(3);
  const suites: string[] = [];
  for (const phase of model.phases) {
    const phaseFailures = phase.steps.filter(
      (step) => !step.ok && step.status !== "pending",
    ).length;
    const phaseSkipped = phase.steps.filter(
      (step) => step.status === "pending" || step.skipped,
    ).length;
    const phaseTime = (
      phase.steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0) / 1000
    ).toFixed(3);
    const cases: string[] = [];
    for (const step of phase.steps) {
      const stepTime = ((step.durationMs ?? 0) / 1000).toFixed(3);
      const className = `${run.workflow}.${phase.phaseId}`;
      const open = `    <testcase name=${xmlAttr(step.stepId)} classname=${xmlAttr(className)} time="${stepTime}"`;
      if (step.status === "pending" || step.skipped) {
        cases.push(`${open}>\n      <skipped/>\n    </testcase>`);
        continue;
      }
      if (step.ok) {
        const raw = step.text ?? "";
        const stepOutput = raw.trim() ? capOutput(raw) : "";
        cases.push(
          stepOutput
            ? `${open}>\n      <system-out>${escapeXml(stepOutput)}</system-out>\n    </testcase>`
            : `${open}/>`,
        );
        continue;
      }
      const message = stepFailureMessage(step);
      const body = step.output ?? step.error ?? "";
      cases.push(
        `${open}>\n      <failure message=${xmlAttr(message)} type=${xmlAttr(stepFailureType(step))}>${escapeXml(body)}</failure>\n    </testcase>`,
      );
    }
    // JUnit distinguishes 'errors' (infrastructure problems) from 'failures'
    // (assertion/gate failures). Steamtrain's model treats step errors and
    // gate rejections as failures, so 'errors' is always 0 here.
    suites.push(
      `  <testsuite name=${xmlAttr(`${run.workflow} · ${phase.title}`)} tests="${phase.steps.length}" failures="${phaseFailures}" errors="0" skipped="${phaseSkipped}" time="${phaseTime}">\n${cases.join("\n")}\n  </testsuite>`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name=${xmlAttr(`steamtrain ${run.workflow}`)} tests="${totals.steps}" failures="${failures}" errors="0" skipped="${skipped}" time="${time}">
${suites.join("\n")}
</testsuites>
`;
}

function stepFailureMessage(step: ReportStep): string {
  if (step.gate && step.gate.passed === false) return `gate '${step.stepId}' condition not met`;
  return step.error ? truncate(step.error, 240) : `step '${step.stepId}' failed`;
}

function stepFailureType(step: ReportStep): string {
  if (step.gate && step.gate.passed === false) return "GateFailure";
  return "StepFailure";
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlAttr(value: string): string {
  return `"${escapeXml(value)}"`;
}
