import { mkdtempSync, readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { emptyTokens } from "../src/workflow/cost";
import type { HistoryPhase, HistoryStep, RunRecord } from "../src/workflow/history";
import {
  EXIT_CODES,
  type RunOutcome,
  buildReportModel,
  classifyRun,
  exitCodeForRun,
  isReportFormat,
  renderReport,
} from "../src/workflow/report";

function step(overrides: Partial<HistoryStep> = {}): HistoryStep {
  return {
    stepId: "work",
    blockKind: "worker",
    status: "done",
    text: "",
    cached: false,
    ...overrides,
  };
}

function phase(steps: HistoryStep[], overrides: Partial<HistoryPhase> = {}): HistoryPhase {
  return {
    phaseId: "p1",
    title: "Phase 1",
    index: 0,
    stepCount: steps.length,
    steps,
    done: true,
    ok: steps.every((s) => s.status === "done"),
    ...overrides,
  };
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  const phases = overrides.phases ?? [phase([step()])];
  return {
    version: 1,
    id: "run-1",
    workflow: "demo",
    input: "do the thing",
    cwd: "/tmp/demo",
    status: "done",
    ok: true,
    startedAt: 1_000,
    endedAt: 4_000,
    durationMs: 3_000,
    phases,
    totals: {
      steps: 1,
      ok: 1,
      failed: 0,
      cached: 0,
      costUsd: 0,
      tokens: emptyTokens(),
      durationMs: 3_000,
    },
    ...overrides,
  };
}

describe("exit-code contract", () => {
  it("exposes the documented stable codes", () => {
    expect(EXIT_CODES).toEqual({
      success: 0,
      "step-failed": 1,
      "gate-failed": 2,
      timeout: 3,
      "budget-exceeded": 4,
      canceled: 130,
    });
  });
});

describe("classifyRun", () => {
  it("classifies a clean run as success", () => {
    expect(classifyRun(record())).toBe("success");
  });

  it("classifies a step error as step-failed", () => {
    const rec = record({
      status: "error",
      ok: false,
      phases: [phase([step({ stepId: "build", status: "error", result: { ok: false } as never })])],
    });
    expect(classifyRun(rec)).toBe("step-failed");
  });

  it("classifies a failing gate (onFalse fail) as gate-failed", () => {
    const rec = record({
      status: "error",
      ok: false,
      phases: [
        phase([
          step({
            stepId: "qa",
            blockKind: "gate",
            status: "error",
            gate: { passed: false, onFalse: "fail" },
          }),
        ]),
      ],
    });
    expect(classifyRun(rec)).toBe("gate-failed");
  });

  it("treats a gate with onFalse stop as a step-failed (graceful halt, not a gate rejection)", () => {
    const rec = record({
      status: "error",
      ok: false,
      phases: [
        phase([
          step({
            stepId: "qa",
            blockKind: "gate",
            status: "error",
            gate: { passed: false, onFalse: "stop" },
          }),
        ]),
      ],
    });
    expect(classifyRun(rec)).toBe("step-failed");
  });

  it("classifies budget-exceeded", () => {
    const rec = record({
      status: "budget-exceeded",
      ok: false,
      budget: { scope: "workflow", limitUsd: 1, spentUsd: 1.2 },
    });
    expect(classifyRun(rec)).toBe("budget-exceeded");
  });

  it("classifies budget-exceeded even when a gate also failed (budget takes precedence)", () => {
    const rec = record({
      status: "budget-exceeded",
      ok: false,
      budget: { scope: "workflow", limitUsd: 1, spentUsd: 1.2 },
      phases: [
        phase([
          step({
            stepId: "qa",
            blockKind: "gate",
            status: "error",
            gate: { passed: false, onFalse: "fail" },
          }),
        ]),
      ],
    });
    expect(classifyRun(rec)).toBe("budget-exceeded");
    expect(exitCodeForRun(rec)).toBe(4);
  });

  it("classifies a plain cancel as canceled", () => {
    expect(classifyRun(record({ status: "canceled", ok: false }))).toBe("canceled");
  });

  it("classifies a timeout abort (canceled + timedOut) as timeout", () => {
    expect(classifyRun(record({ status: "canceled", ok: false }), { timedOut: true })).toBe(
      "timeout",
    );
  });

  it("maps every outcome to its exit code via exitCodeForRun", () => {
    const cases: [RunRecord, number, RunOutcome][] = [
      [record(), 0, "success"],
      [record({ status: "error", ok: false }), 1, "step-failed"],
      [record({ status: "budget-exceeded", ok: false }), 4, "budget-exceeded"],
      [record({ status: "canceled", ok: false }), 130, "canceled"],
    ];
    for (const [rec, code] of cases) {
      expect(exitCodeForRun(rec)).toBe(code);
    }
  });
});

describe("isReportFormat", () => {
  it("accepts the three formats and rejects others", () => {
    expect(isReportFormat("json")).toBe(true);
    expect(isReportFormat("markdown")).toBe(true);
    expect(isReportFormat("junit")).toBe(true);
    expect(isReportFormat("yaml")).toBe(false);
    expect(isReportFormat("")).toBe(false);
  });
});

describe("renderReport json", () => {
  it("emits a self-describing document with outcome and exit code", () => {
    const rec = record({
      status: "error",
      ok: false,
      phases: [
        phase([
          step({
            stepId: "qa",
            blockKind: "gate",
            status: "error",
            gate: { passed: false, onFalse: "fail" },
            result: { ok: false, error: "tests failed", durationMs: 1200 } as never,
          }),
        ]),
      ],
    });
    const parsed = JSON.parse(renderReport(rec, "json"));
    expect(parsed.schema).toBe("steamtrain.run-report");
    expect(parsed.version).toBe(1);
    expect(parsed.outcome).toBe("gate-failed");
    expect(parsed.exitCode).toBe(2);
    expect(parsed.run.workflow).toBe("demo");
    expect(parsed.run.ok).toBe(false);
    expect(parsed.failedSteps).toHaveLength(1);
    expect(parsed.failedSteps[0].stepId).toBe("qa");
    expect(parsed.failedSteps[0].gate).toEqual({ passed: false, onFalse: "fail" });
  });

  it("honors an explicit outcome override", () => {
    const parsed = JSON.parse(renderReport(record(), "json", { outcome: "timeout" }));
    expect(parsed.outcome).toBe("timeout");
    expect(parsed.exitCode).toBe(3);
  });
});

describe("renderReport markdown", () => {
  it("renders a human-readable summary with the failed step", () => {
    const rec = record({
      status: "error",
      ok: false,
      phases: [
        phase([
          step({
            stepId: "build",
            status: "error",
            text: "boom: compile error",
            result: { ok: false, error: "exit 1", durationMs: 800 } as never,
          }),
        ]),
      ],
    });
    const md = renderReport(rec, "markdown");
    expect(md).toContain("## steamtrain · demo");
    expect(md).toContain("exit code `1`");
    expect(md).toContain("### Failed steps");
    expect(md).toContain("**build**");
    expect(md).toContain("| Step | Kind | Status | Duration | Cost |");
  });

  it("prices a cached replay at $0 in the step table, matching the totals", () => {
    const rec = record({
      phases: [
        phase([
          step({
            stepId: "review",
            cached: true,
            result: { ok: true, durationMs: 800, costUsd: 0.5 } as never,
          }),
        ]),
      ],
    });
    const md = renderReport(rec, "markdown");
    expect(md).toContain("| ✅ review | worker | cached | 0.8s | $0 |");
    expect(md).not.toContain("0.5");
  });

  it("includes the budget breach line when budget data is present", () => {
    const rec = record({
      status: "budget-exceeded",
      ok: false,
      budget: { scope: "workflow", limitUsd: 2.5, spentUsd: 3.1 },
      phases: [phase([step({ stepId: "llm", status: "error", text: "too expensive" })])],
    });
    const md = renderReport(rec, "markdown");
    expect(md).toContain("Budget:** workflow cap");
    expect(md).toContain("$2.50");
    expect(md).toContain("$3.10");
  });
});

describe("renderReport junit", () => {
  it("renders valid JUnit XML with a failure element for a failed step", () => {
    const rec = record({
      status: "error",
      ok: false,
      phases: [
        phase([
          step({ stepId: "ok-step", status: "done" }),
          step({
            stepId: "bad-step",
            status: "error",
            text: "assertion failed",
            result: { ok: false, error: "expected 1 got 2", durationMs: 500 } as never,
          }),
        ]),
      ],
    });
    const xml = renderReport(rec, "junit");
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<testsuites name="steamtrain demo"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('<testcase name="ok-step"');
    expect(xml).toContain('<failure message="expected 1 got 2" type="StepFailure">');
    expect(xml).toContain("assertion failed");
  });

  it("escapes XML metacharacters in step output", () => {
    const rec = record({
      status: "error",
      ok: false,
      phases: [
        phase([
          step({
            stepId: "x",
            status: "error",
            text: '<script> & "quotes"',
            result: { ok: false, durationMs: 1 } as never,
          }),
        ]),
      ],
    });
    const xml = renderReport(rec, "junit");
    expect(xml).toContain("&lt;script&gt; &amp; &quot;quotes&quot;");
    expect(xml).not.toContain("<script>");
  });

  it("marks a gate failure with the GateFailure type", () => {
    const rec = record({
      status: "error",
      ok: false,
      phases: [
        phase([
          step({
            stepId: "qa",
            blockKind: "gate",
            status: "error",
            gate: { passed: false, onFalse: "fail" },
          }),
        ]),
      ],
    });
    const xml = renderReport(rec, "junit");
    expect(xml).toContain('type="GateFailure"');
  });

  it("renders skipped steps as <skipped/>", () => {
    const rec = record({
      status: "error",
      ok: false,
      phases: [
        phase([
          step({ stepId: "first", status: "done" }),
          step({ stepId: "not-run", status: "pending" }),
          step({
            stepId: "skipped",
            status: "done",
            result: { ok: false, skipped: true } as never,
          }),
        ]),
      ],
    });
    const xml = renderReport(rec, "junit");
    expect(xml).toContain('errors="0"');
    expect(xml).toContain('skipped="2"');
    expect(xml).toContain("<skipped/>");
    expect(xml).not.toContain('<testcase name="not-run">');
  });

  it("includes <system-out> for passing steps with output", () => {
    const rec = record({
      phases: [
        phase([
          step({ stepId: "quiet", status: "done", text: "" }),
          step({ stepId: "loud", status: "done", text: "all tests passed" }),
        ]),
      ],
    });
    const xml = renderReport(rec, "junit");
    expect(xml).toContain('<testcase name="quiet"');
    expect(xml).toContain('<testcase name="loud"');
    expect(xml).toContain("<system-out>all tests passed</system-out>");
    expect(xml.match(/<system-out>/g)?.length).toBe(1);
  });
});

describe("buildReportModel", () => {
  it("rolls up totals and lists failed steps up front", () => {
    const rec = record({
      status: "error",
      ok: false,
      phases: [
        phase([
          step({ stepId: "a", status: "done" }),
          step({ stepId: "b", status: "error", result: { ok: false } as never }),
        ]),
      ],
    });
    const model = buildReportModel(rec);
    expect(model.outcome).toBe("step-failed");
    expect(model.failedSteps.map((s) => s.stepId)).toEqual(["b"]);
    expect(model.phases).toHaveLength(1);
    expect(model.phases[0]?.steps).toHaveLength(2);
  });

  it("carries the error but no output for a step with empty text", () => {
    const rec = record({
      status: "error",
      ok: false,
      phases: [
        phase([
          step({
            stepId: "b",
            status: "error",
            text: "",
            result: { ok: false, error: "tool returned non-zero" } as never,
          }),
        ]),
      ],
    });
    const model = buildReportModel(rec);
    const failed = model.failedSteps[0];
    expect(failed).toBeDefined();
    expect(failed?.stepId).toBe("b");
    expect(failed?.error).toBe("tool returned non-zero");
    expect(failed?.output).toBeUndefined();
  });
});

// ── CLI integration ──────────────────────────────────────────────────────────

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd: mkdtempSync(join(tmpdir(), "steamtrain-report-")),
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

function writeAgentless(cwd: string, spec: unknown): void {
  writeFileSync(join(cwd, "steamtrain.json"), JSON.stringify({ workflows: { agentless: spec } }));
}

const passingWorkflow = {
  phases: [
    { id: "only", title: "Only", steps: [{ id: "split", kind: "distributor", items: ["a"] }] },
  ],
};

const failingGateWorkflow = {
  phases: [
    {
      id: "gate",
      title: "Gate",
      steps: [{ id: "qa", kind: "gate", condition: { contains: "pass" }, onFalse: "fail" }],
    },
  ],
};

describe("workflow run --report (CLI)", () => {
  it("writes a JSON report to --output and exits 0 on success", async () => {
    const c = capture();
    writeAgentless(c.io.cwd, passingWorkflow);
    const out = join(c.io.cwd, "report.json");
    const code = await runCli(
      ["workflow", "run", "agentless", "--input", "task", "--report", "json", "--output", out],
      c.io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(readFileSync(out, "utf8"));
    expect(parsed.outcome).toBe("success");
    expect(parsed.exitCode).toBe(0);
    expect(parsed.run.workflow).toBe("agentless");
    expect(c.stderr).toContain("report: wrote json report");
  });

  it("writes a gate-failed report and exits 2", async () => {
    const c = capture();
    writeAgentless(c.io.cwd, failingGateWorkflow);
    const out = join(c.io.cwd, "report.json");
    const code = await runCli(
      ["workflow", "run", "agentless", "--input", "nope", "--report", "json", "--output", out],
      c.io,
    );
    expect(code).toBe(2);
    const parsed = JSON.parse(readFileSync(out, "utf8"));
    expect(parsed.outcome).toBe("gate-failed");
    expect(parsed.exitCode).toBe(2);
    expect(parsed.failedSteps[0].stepId).toBe("qa");
  });

  it("prints the report to stdout when --output is omitted", async () => {
    const c = capture();
    writeAgentless(c.io.cwd, passingWorkflow);
    const code = await runCli(
      ["workflow", "run", "agentless", "--input", "task", "--report", "markdown"],
      c.io,
    );
    expect(code).toBe(0);
    expect(c.stdout).toContain("## steamtrain · agentless");
  });

  it("writes a JUnit report a CI test reporter can consume", async () => {
    const c = capture();
    writeAgentless(c.io.cwd, failingGateWorkflow);
    const out = join(c.io.cwd, "junit.xml");
    const code = await runCli(
      ["workflow", "run", "agentless", "--input", "nope", "--report", "junit", "--output", out],
      c.io,
    );
    expect(code).toBe(2);
    const xml = readFileSync(out, "utf8");
    expect(xml).toContain("<testsuites");
    expect(xml).toContain('type="GateFailure"');
  });

  it("rejects --report with --detach", async () => {
    const c = capture();
    writeAgentless(c.io.cwd, passingWorkflow);
    const code = await runCli(
      ["workflow", "run", "agentless", "--input", "task", "--report", "json", "--detach"],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.stderr).toContain("--report cannot be used with --detach");
  });

  it("rejects --report (stdout) combined with --json", async () => {
    const c = capture();
    writeAgentless(c.io.cwd, passingWorkflow);
    const code = await runCli(
      ["workflow", "run", "agentless", "--input", "task", "--report", "json", "--json"],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.stderr).toContain("cannot be combined with --json");
  });

  it("rejects an unknown --report format", async () => {
    const c = capture();
    writeAgentless(c.io.cwd, passingWorkflow);
    const code = await runCli(
      ["workflow", "run", "agentless", "--input", "task", "--report", "yaml"],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.stderr).toContain("usage:");
  });

  it("rejects --output without --report", async () => {
    const c = capture();
    writeAgentless(c.io.cwd, passingWorkflow);
    const code = await runCli(
      ["workflow", "run", "agentless", "--input", "task", "--output", "x.json"],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.stderr).toContain("usage:");
  });
});

describe("report: interrupted steps", () => {
  it("keeps a step the run's cancel took down out of failures, in JSON and JUnit", async () => {
    const { RunRecordBuilder, buildReportModel, renderReport } = await import("../src/workflow");
    const builder = new RunRecordBuilder({ id: "r", workflow: "w", input: "", cwd: "/" });
    builder.handle({ kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 1 });
    builder.handle({
      kind: "phase_start",
      phaseId: "p",
      title: "P",
      index: 0,
      stepCount: 1,
      ts: 1,
    });
    builder.handle({ kind: "step_start", phaseId: "p", stepId: "s", blockKind: "worker", ts: 1 });
    builder.handle({
      kind: "step_done",
      phaseId: "p",
      stepId: "s",
      result: {
        stepId: "s",
        ok: false,
        output: "",
        error: "cancelled",
        durationMs: 1,
        interrupted: true,
      },
      cached: false,
      ts: 2,
    });
    const record = builder.build({ status: "canceled" });
    const model = buildReportModel(record);
    expect(model.failedSteps).toEqual([]);
    expect(model.totals).toMatchObject({ failed: 0, interrupted: 1 });
    const junit = renderReport(record, "junit");
    expect(junit).toContain('failures="0"');
    expect(junit).toContain("interrupted: the run was stopped while it ran");
    const markdown = renderReport(record, "markdown");
    expect(markdown).toContain("| ⏹ s | worker | stopped |");
    expect(markdown).not.toContain("### Failed steps");
  });
});
