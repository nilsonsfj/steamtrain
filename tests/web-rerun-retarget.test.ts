import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults";
import { type WorkflowHost, WorkflowRunManager } from "../src/web/runs";
import type { WorkflowCacheStore } from "../src/workflow";
import { hashWorkflowSpec } from "../src/workflow/cache-store";
import type { HistoryPhase, HistoryStep, RunRecord } from "../src/workflow/history";
import { RUN_RECORD_VERSION } from "../src/workflow/history";
import { planRetryRetarget } from "../src/workflow/retry-retarget";
import type { StepResult, WorkflowSpec } from "../src/workflow/types";

function createInMemoryStore(): WorkflowCacheStore {
  const store = new Map<string, Map<string, StepResult>>();
  return {
    rootDir: "/tmp/test-cache",
    async load(key) {
      const k = `${key.workflow}:${key.cwd}:${key.input}:${key.specHash}`;
      return store.get(k) ?? new Map();
    },
    async save(key, cache) {
      const k = `${key.workflow}:${key.cwd}:${key.input}:${key.specHash}`;
      store.set(k, new Map(cache));
    },
    async clear(key) {
      store.delete(`${key.workflow}:${key.cwd}:${key.input}:${key.specHash}`);
    },
    async clearAll() {
      store.clear();
    },
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

const spec: WorkflowSpec = {
  name: "demo",
  phases: [
    {
      id: "p1",
      title: "P1",
      steps: [
        { id: "ok-step", kind: "worker", agent: "claude", model: "claude-sonnet-5", prompt: "ok" },
        { id: "fail-step", kind: "worker", agent: "kiro", model: "auto", prompt: "fail" },
      ],
    },
  ],
};

function failedRecord(): RunRecord {
  return {
    version: RUN_RECORD_VERSION,
    id: "r1",
    workflow: "demo",
    input: "in",
    cwd: tmpdir(),
    status: "error",
    ok: false,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    specHash: hashWorkflowSpec(spec),
    phases: [
      phase([
        histStep({ stepId: "ok-step", agent: "claude" }),
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
  };
}

describe("WorkflowRunManager.rerunFromRecord retarget", () => {
  it("applies retarget overrides and refuses on downgrade", async () => {
    const launched: { specOverride?: WorkflowSpec; seed?: Map<string, StepResult> }[] = [];
    const host: WorkflowHost = {
      listWorkflows: () => ({ demo: spec }),
      canDispatchWorkflowSpec: () => ({ ok: true }),
      planWorkflowRetryRetarget: (s, record, options) =>
        planRetryRetarget(s, record, DEFAULT_CONFIG, () => true, options),
      runWorkflow: async function* () {
        yield { kind: "workflow_done", ok: true, results: [], ts: Date.now() } as never;
      },
    };
    const runs = new WorkflowRunManager({
      host,
      cacheStore: createInMemoryStore(),
      cwd: tmpdir(),
      config: DEFAULT_CONFIG,
    });
    const originalStart = runs.start.bind(runs);
    runs.start = ((workflow, input, opts) => {
      launched.push({ specOverride: opts?.specOverride, seed: opts?.seed });
      return originalStart(workflow, input, opts);
    }) as typeof runs.start;

    const ok = runs.rerunFromRecord(failedRecord(), "retry-failed", {
      retargetAgent: "claude",
      retargetModel: "claude-sonnet-5",
    });
    expect(ok.ok).toBe(true);
    expect(launched[0]?.specOverride?.phases[0]?.steps[1]).toMatchObject({
      id: "fail-step",
      agent: "claude",
      model: "claude-sonnet-5",
    });
    expect(launched[0]?.seed?.has("ok-step")).toBe(true);
    expect(launched[0]?.seed?.has("fail-step")).toBe(false);

    const stale = failedRecord();
    stale.specHash = "stale";
    const refused = runs.rerunFromRecord(stale, "retry-failed", { retargetAgent: "claude" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatch(/cannot retarget/);
  });
});
