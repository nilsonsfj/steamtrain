import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import { createClaudeMapper } from "../src/agents/claude";
import { createCodexMapper } from "../src/agents/codex";
import { createOpenCodeMapper } from "../src/agents/opencode";
import type { AgentEvent, AgentId, TokenUsage } from "../src/types/events";
import {
  RunRecordBuilder,
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  addTokens,
  aggregateCosts,
  aggregateLeavesByModel,
  formatTokens,
  resultLeaves,
  runWorkflow,
  tokensForResults,
  totalTokens,
} from "../src/workflow";

/** A model→(cost, tokens) map drives the fake adapter's per-step billing. */
function makeBillingDeps(
  billing: Record<string, { cost: number; tokens?: TokenUsage }>,
  over: { maxConcurrency?: number } = {},
): WorkflowDeps {
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        const bill = billing[opts.model ?? ""] ?? { cost: 0 };
        yield {
          kind: "result",
          agent: "claude",
          ts: 0,
          isError: false,
          text: `out:${opts.model}`,
          costUsd: bill.cost,
          tokens: bill.tokens,
        } satisfies AgentEvent;
      })();
    },
  });
  return { createAdapter, maxConcurrency: over.maxConcurrency ?? 1, cwd: "/base" };
}

async function collect(spec: WorkflowSpec, deps: WorkflowDeps): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input: "go" }, deps)) events.push(ev);
  return events;
}

/** Three sequential steps, each on its own model so billing differs. */
function threeStepSpec(maxCostUsd?: number): WorkflowSpec {
  return {
    name: "budget-test",
    maxCostUsd,
    phases: [
      { id: "p1", title: "p1", steps: [{ id: "a", agent: "claude", model: "m1", prompt: "x" }] },
      {
        id: "p2",
        title: "p2",
        steps: [{ id: "b", agent: "claude", model: "m2", prompt: "x", dependsOn: ["a"] }],
      },
      {
        id: "p3",
        title: "p3",
        steps: [{ id: "c", agent: "claude", model: "m3", prompt: "x", dependsOn: ["b"] }],
      },
    ],
  };
}

describe("token cost helpers", () => {
  it("addTokens sums fields undefined-safely", () => {
    expect(addTokens({ input: 10, output: 5 }, { input: 2, cacheRead: 3 })).toEqual({
      input: 12,
      output: 5,
      cacheRead: 3,
      cacheWrite: 0,
      reasoning: 0,
    });
  });

  it("totalTokens excludes reasoning (billed inside output)", () => {
    expect(
      totalTokens({ input: 100, output: 50, reasoning: 30, cacheRead: 10, cacheWrite: 5 }),
    ).toBe(165);
  });

  it("formatTokens is compact", () => {
    expect(formatTokens(12)).toBe("12");
    expect(formatTokens(3400)).toBe("3.4k");
    expect(formatTokens(2_100_000)).toBe("2.1M");
  });

  it("aggregateLeavesByModel groups by agent/model and sorts by cost", () => {
    const byModel = aggregateLeavesByModel([
      { agent: "claude", model: "opus", costUsd: 0.1, tokens: { input: 100 } },
      { agent: "claude", model: "opus", costUsd: 0.2, tokens: { output: 50 } },
      { agent: "codex", model: "gpt", costUsd: 0.05, tokens: { input: 10 } },
    ]);
    expect(byModel).toHaveLength(2);
    expect(byModel[0]).toMatchObject({
      model: "claude/opus",
      costUsd: 0.30000000000000004,
      steps: 2,
    });
    expect(byModel[0]?.tokens).toMatchObject({ input: 100, output: 50 });
    expect(byModel[1]).toMatchObject({ model: "codex/gpt", steps: 1 });
  });
});

describe("adapters parse token usage", () => {
  it("claude maps usage to normalized tokens", () => {
    const line =
      '{"type":"result","subtype":"success","is_error":false,"duration_ms":10,"result":"hi","total_cost_usd":0.02,"usage":{"input_tokens":100,"output_tokens":40,"cache_read_input_tokens":20,"cache_creation_input_tokens":15}}';
    const events = createClaudeMapper()(JSON.parse(line));
    expect(events[0]).toMatchObject({
      kind: "result",
      tokens: { input: 100, output: 40, cacheRead: 20, cacheWrite: 15 },
    });
  });

  it("codex splits cached input out of input_tokens and keeps reasoning", () => {
    const line =
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":30,"output_tokens":40,"reasoning_output_tokens":12}}';
    const events = createCodexMapper()(JSON.parse(line));
    const result = events.find((e) => e.kind === "result");
    expect(result).toMatchObject({
      tokens: { input: 70, cacheRead: 30, output: 40, reasoning: 12 },
    });
  });

  it("opencode maps its per-step token block", () => {
    const line =
      '{"type":"step.finish","cost":0.01,"tokens":{"input":80,"output":20,"reasoning":5,"cache":{"read":10,"write":4}}}';
    const events = createOpenCodeMapper()(JSON.parse(line));
    const result = events.find((e) => e.kind === "result");
    expect(result).toMatchObject({
      tokens: { input: 80, output: 20, reasoning: 5, cacheRead: 10, cacheWrite: 4 },
    });
  });
});

describe("engine threads tokens into StepResult and totals", () => {
  it("records per-step tokens and rolls them into run totals", async () => {
    const deps = makeBillingDeps({
      m1: { cost: 0.01, tokens: { input: 100, output: 10 } },
      m2: { cost: 0.02, tokens: { input: 200, output: 20, cacheRead: 50 } },
      m3: { cost: 0.03, tokens: { output: 30 } },
    });
    const events = await collect(threeStepSpec(), deps);
    const done = events.filter((e) => e.kind === "step_done") as Extract<
      WorkflowEvent,
      { kind: "step_done" }
    >[];
    expect(done.find((e) => e.stepId === "a")?.result.tokens).toMatchObject({
      input: 100,
      output: 10,
    });

    const builder = new RunRecordBuilder({
      id: "r",
      workflow: "budget-test",
      input: "go",
      cwd: "/base",
    });
    for (const ev of events) builder.handle(ev);
    const record = builder.build({ status: "done" });
    expect(record.totals.tokens).toMatchObject({ input: 300, output: 60, cacheRead: 50 });
    expect(totalTokens(record.totals.tokens)).toBe(410);
  });
});

describe("live summary helpers do not double-count fan-out children", () => {
  // The engine flattens a fan-out into allResults as: each child (with
  // parentStepId) *and* the parent (with childResults). The summary helpers must
  // count the flat children once and skip the parent — never descend into it.
  const flatResults: StepResult[] = [
    { stepId: "a", ok: true, output: "x", durationMs: 1, costUsd: 0.01, tokens: { input: 50 } },
    // fan-out parent "f" with two children, also present flat below:
    {
      stepId: "f",
      ok: true,
      output: "sum",
      durationMs: 2,
      costUsd: 0.04,
      tokens: { input: 200 },
      childResults: [
        {
          stepId: "f#0",
          parentStepId: "f",
          ok: true,
          output: "c0",
          durationMs: 1,
          costUsd: 0.02,
          tokens: { input: 100 },
        },
        {
          stepId: "f#1",
          parentStepId: "f",
          ok: true,
          output: "c1",
          durationMs: 1,
          costUsd: 0.02,
          tokens: { input: 100 },
        },
      ],
    },
    {
      stepId: "f#0",
      parentStepId: "f",
      ok: true,
      output: "c0",
      durationMs: 1,
      costUsd: 0.02,
      tokens: { input: 100 },
    },
    {
      stepId: "f#1",
      parentStepId: "f",
      ok: true,
      output: "c1",
      durationMs: 1,
      costUsd: 0.02,
      tokens: { input: 100 },
    },
  ];

  it("tokensForResults counts each leaf exactly once", () => {
    // a(50) + f#0(100) + f#1(100) = 250, NOT 450 (would be doubled if it descended).
    expect(totalTokens(tokensForResults(flatResults))).toBe(250);
  });

  it("resultLeaves attributes children to the parent step's model, once each", () => {
    const stepMeta = new Map([
      ["a", { agent: "claude", model: "haiku" }],
      ["f", { agent: "claude", model: "opus" }],
    ]);
    const byModel = aggregateLeavesByModel(resultLeaves(flatResults, stepMeta));
    const opus = byModel.find((m) => m.model === "claude/opus");
    expect(opus).toMatchObject({ steps: 2 });
    expect(opus?.costUsd).toBeCloseTo(0.04, 5);
    expect(totalTokens(opus?.tokens ?? {})).toBe(200);
    expect(byModel.find((m) => m.model === "claude/haiku")).toMatchObject({ steps: 1 });
  });
});

describe("workflow-level cost budget", () => {
  it("stops scheduling once the cap is reached and marks the run budget-exceeded", async () => {
    // Each step costs $0.05; cap $0.08 → after step a ($0.05) b still runs, after
    // b ($0.10 ≥ 0.08) the budget latches and c never dispatches.
    const deps = makeBillingDeps({
      m1: { cost: 0.05 },
      m2: { cost: 0.05 },
      m3: { cost: 0.05 },
    });
    const events = await collect(threeStepSpec(0.08), deps);

    const budget = events.find((e) => e.kind === "budget_exceeded");
    expect(budget).toMatchObject({ kind: "budget_exceeded", scope: "workflow", limitUsd: 0.08 });

    const done = events.filter((e) => e.kind === "step_done");
    expect(done.map((e) => (e as { stepId: string }).stepId).sort()).toEqual(["a", "b"]);

    const final = events.at(-1) as Extract<WorkflowEvent, { kind: "workflow_done" }>;
    expect(final.kind).toBe("workflow_done");
    expect(final.budgetExceeded).toBe(true);
    expect(final.ok).toBe(false);
  });

  it("does not fire when the cap is not reached", async () => {
    const deps = makeBillingDeps({ m1: { cost: 0.01 }, m2: { cost: 0.01 }, m3: { cost: 0.01 } });
    const events = await collect(threeStepSpec(1), deps);
    expect(events.some((e) => e.kind === "budget_exceeded")).toBe(false);
    const final = events.at(-1) as Extract<WorkflowEvent, { kind: "workflow_done" }>;
    expect(final.budgetExceeded).toBe(false);
    expect(final.ok).toBe(true);
  });

  it("resumes from cache with prior spend counted toward the cap", async () => {
    // Pre-seed a + b as already run (cost $0.05 each = $0.10). With cap $0.08 the
    // resumed run is already over budget and never runs c.
    const deps = makeBillingDeps({ m1: { cost: 0.05 }, m2: { cost: 0.05 }, m3: { cost: 0.05 } });
    const cache = new Map<string, StepResult>([
      ["a", { stepId: "a", ok: true, output: "out:m1", durationMs: 1, costUsd: 0.05 }],
      ["b", { stepId: "b", ok: true, output: "out:m2", durationMs: 1, costUsd: 0.05 }],
    ]);
    const events: WorkflowEvent[] = [];
    for await (const ev of runWorkflow(threeStepSpec(0.08), { input: "go", cache }, deps)) {
      events.push(ev);
    }
    expect(events.some((e) => e.kind === "budget_exceeded")).toBe(true);
    const done = events.filter((e) => e.kind === "step_done");
    // a + b replay from cache; c never runs.
    expect(done.every((e) => (e as { stepId: string }).stepId !== "c")).toBe(true);
  });
});

describe("aggregateCosts across history", () => {
  it("breaks spend down by workflow, step, and model", () => {
    const mkRecord = (
      id: string,
      workflow: string,
    ): Parameters<typeof aggregateCosts>[0][number] => {
      const builder = new RunRecordBuilder({ id, workflow, input: "go", cwd: "/base" });
      builder.handle({
        kind: "workflow_start",
        name: workflow,
        phaseCount: 1,
        stepCount: 1,
        ts: 0,
      });
      builder.handle({
        kind: "phase_start",
        phaseId: "p1",
        title: "p1",
        index: 0,
        stepCount: 1,
        ts: 0,
      });
      builder.handle({
        kind: "step_start",
        phaseId: "p1",
        stepId: "s1",
        agent: "claude",
        model: "opus",
        ts: 0,
      });
      builder.handle({
        kind: "step_done",
        phaseId: "p1",
        stepId: "s1",
        cached: false,
        result: {
          stepId: "s1",
          ok: true,
          output: "x",
          durationMs: 5,
          costUsd: 0.1,
          tokens: { input: 100, output: 50 },
        },
        ts: 0,
      });
      builder.handle({ kind: "phase_done", phaseId: "p1", ok: true, ts: 0 });
      builder.handle({ kind: "workflow_done", ok: true, results: [], ts: 0 });
      return builder.build({ status: "done" });
    };

    const analytics = aggregateCosts([
      mkRecord("1", "wf-a"),
      mkRecord("2", "wf-a"),
      mkRecord("3", "wf-b"),
    ]);
    expect(analytics.runs).toBe(3);
    expect(analytics.costUsd).toBeCloseTo(0.3, 5);
    expect(analytics.byWorkflow[0]).toMatchObject({ workflow: "wf-a", runs: 2, steps: 2 });
    expect(analytics.byModel[0]).toMatchObject({ model: "claude/opus", steps: 3 });
    expect(totalTokens(analytics.tokens)).toBe(450);
    expect(analytics.byStep[0]).toMatchObject({ stepId: "s1" });
  });
});
