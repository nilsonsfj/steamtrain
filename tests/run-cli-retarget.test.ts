import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import { DEFAULT_CONFIG } from "../src/config/defaults";
import type { DoctorResult } from "../src/doctor";
import * as doctorMod from "../src/doctor";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import { parseRunOptions, runWorkflowCommand } from "../src/run-cli";
import { hashWorkflowSpec } from "../src/workflow/cache-store";
import type { HistoryPhase, HistoryStep, RunRecord } from "../src/workflow/history";
import { RUN_RECORD_VERSION } from "../src/workflow/history";
import { WORKFLOW_HISTORY_DIR } from "../src/workflow/history-store";
import type { WorkflowSpec } from "../src/workflow/types";

const doctorSpies: Array<{ mockRestore(): void }> = [];

afterEach(() => {
  while (doctorSpies.length) doctorSpies.pop()?.mockRestore();
});

function healthy(
  agent: string,
  provider: DoctorResult["provider"] = agent as DoctorResult["provider"],
): DoctorResult {
  return {
    agent,
    provider,
    status: "ok",
    binary: agent,
    message: "ready",
  };
}

function histStep(over: Partial<HistoryStep> & { stepId: string }): HistoryStep {
  return {
    blockKind: "worker",
    status: "done",
    text: "",
    cached: false,
    result: { stepId: over.stepId, ok: true, output: "out", durationMs: 1 },
    ...over,
  };
}

function phase(steps: HistoryStep[]): HistoryPhase {
  return {
    phaseId: "p1",
    title: "P1",
    index: 0,
    stepCount: steps.length,
    steps,
    done: true,
    ok: true,
  };
}

const retargetSpec: WorkflowSpec = {
  name: "demo",
  phases: [
    {
      id: "p1",
      title: "P1",
      steps: [
        { id: "ok-step", kind: "worker", agent: "kiro", model: "auto", prompt: "ok" },
        { id: "fail-step", kind: "worker", agent: "kiro", model: "auto", prompt: "fail" },
      ],
    },
  ],
};

function failedRecord(cwd: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    version: RUN_RECORD_VERSION,
    id: "r1",
    workflow: "demo",
    input: "in",
    cwd,
    status: "error",
    ok: false,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    specHash: hashWorkflowSpec(retargetSpec),
    phases: [
      phase([
        histStep({ stepId: "ok-step", agent: "kiro" }),
        histStep({
          stepId: "fail-step",
          agent: "kiro",
          status: "error",
          result: { stepId: "fail-step", ok: false, output: "x", error: "x", durationMs: 1 },
        }),
      ]),
    ],
    totals: {
      steps: 2,
      ok: 1,
      failed: 1,
      cached: 0,
      costUsd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      durationMs: 0,
    },
    ...over,
  };
}

function writeHistory(cwd: string, record: RunRecord): void {
  const dir = join(cwd, WORKFLOW_HISTORY_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

function capture(cwd?: string) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd: cwd ?? mkdtempSync(join(tmpdir(), "steamtrain-cli-retarget-")),
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

describe("parseRunOptions retarget flags", () => {
  it("parses --retarget-agent, --retarget-model, and repeatable --step", () => {
    const opts = parseRunOptions([
      "--from",
      "r1",
      "--retry-failed",
      "--retarget-agent",
      "claude",
      "--retarget-model",
      "claude-sonnet-5",
      "--step",
      "cross-check",
      "--step",
      "report",
    ]);
    expect(opts).toMatchObject({
      from: "r1",
      retryFailed: true,
      retargetAgent: "claude",
      retargetModel: "claude-sonnet-5",
      steps: ["cross-check", "report"],
    });
  });

  it("defaults steps to an empty array", () => {
    expect(parseRunOptions(["--input", "x"])?.steps).toEqual([]);
  });
});

describe("runWorkflowCommand --retarget-agent", () => {
  it("applies retarget overrides onto the launched spec", async () => {
    const c = capture();
    writeHistory(c.io.cwd, failedRecord(c.io.cwd));

    doctorSpies.push(
      vi
        .spyOn(doctorMod, "runDoctor")
        .mockResolvedValue([healthy("claude"), healthy("kiro", "kiro")]),
    );

    const launched: WorkflowSpec[] = [];
    const orch = new Orchestrator(DEFAULT_CONFIG, { workspaces: [] }, [], {
      workflows: { demo: retargetSpec },
      sources: { demo: "project" },
    });
    orch.runWorkflow = ((
      _name: string,
      _input: string,
      _signal?: AbortSignal,
      _cache?: unknown,
      _cwd?: string,
      specOverride?: WorkflowSpec,
    ) => {
      if (specOverride) launched.push(specOverride);
      return (async function* () {
        yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() } as never;
      })();
    }) as typeof orch.runWorkflow;

    const code = await runWorkflowCommand(
      orch,
      DEFAULT_CONFIG,
      [
        "--from",
        "r1",
        "--retry-failed",
        "--retarget-agent",
        "claude",
        "--retarget-model",
        "claude-sonnet-5",
      ],
      c.io,
      (t) => {
        c.io.stdout(t);
      },
      (t) => {
        c.io.stderr(t);
      },
    );

    expect(code).toBe(0);
    expect(c.stdout + c.stderr).toMatch(/retarget .* → claude\/claude-sonnet-5/);
    expect(launched[0]?.phases[0]?.steps[1]).toMatchObject({
      id: "fail-step",
      agent: "claude",
      model: "claude-sonnet-5",
    });
    // Done step keeps its original agent; only failed candidates are retargeted.
    expect(launched[0]?.phases[0]?.steps[0]).toMatchObject({
      id: "ok-step",
      agent: "kiro",
    });
  });

  it("refuses retarget when retry-failed would downgrade", async () => {
    const c = capture();
    const agentless = {
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "areas", kind: "distributor", items: ["a: {{input}}", "b"] }],
        },
      ],
    };
    writeFileSync(join(c.io.cwd, "steamtrain.json"), JSON.stringify({ workflows: { agentless } }));

    expect(await runCli(["workflow", "run", "agentless", "--input", "task"], c.io)).toBe(0);

    const historyDir = join(c.io.cwd, WORKFLOW_HISTORY_DIR);
    const records = readdirSync(historyDir)
      .filter((f) => f.endsWith(".json"))
      .map(
        (f) =>
          JSON.parse(readFileSync(join(historyDir, f), "utf8")) as {
            id: string;
            startedAt: number;
          },
      );
    records.sort((a, b) => b.startedAt - a.startedAt);
    const id = records[0]!.id;

    const retry = capture(c.io.cwd);
    const code = await runCli(
      [
        "workflow",
        "run",
        "--from",
        id,
        "--retry-failed",
        "--retarget-agent",
        "claude",
        "--input",
        "different",
      ],
      retry.io,
    );
    expect(code).toBe(1);
    expect(retry.stderr).toMatch(/cannot retarget\/narrow retry/);
  });
});
