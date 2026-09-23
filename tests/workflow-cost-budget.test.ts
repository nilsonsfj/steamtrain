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
  costForResults,
  formatTokens,
  resultLeaves,
  runWorkflow,
  stepMetaFromSpec,
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
    defaultModel: "test",
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
      '{"type":"step_finish","part":{"type":"step-finish","cost":0.01,"tokens":{"input":80,"output":20,"reasoning":5,"cache":{"read":10,"write":4}}}}';
    const events = createOpenCodeMapper()(JSON.parse(line));
    const result = events.find((e) => e.kind === "result");
    // opencode's `output` excludes reasoning; the normalized one includes it.
    expect(result).toMatchObject({
      costUsd: 0.01,
      tokens: { input: 80, output: 25, reasoning: 5, cacheRead: 10, cacheWrite: 4 },
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

describe("engine folds live usage increments into the step result", () => {
  /** A fake adapter that replays a fixed event script for every step. */
  function scriptedDeps(script: AgentEvent[]): WorkflowDeps {
    return {
      createAdapter: (id: AgentId): AgentAdapter => ({
        id,
        binary: "fake",
        defaultModel: "test",
        run: () =>
          (async function* () {
            yield* script;
          })(),
      }),
      maxConcurrency: 1,
      cwd: "/base",
    };
  }
  const oneStep: WorkflowSpec = {
    name: "usage-fold",
    phases: [
      { id: "p", title: "p", steps: [{ id: "a", agent: "claude", model: "m", prompt: "x" }] },
    ],
  };
  const usage = (tokens: TokenUsage, costUsd?: number): AgentEvent => ({
    kind: "usage",
    agent: "claude",
    ts: 0,
    tokens,
    costUsd,
  });
  const stepResult = async (script: AgentEvent[]) => {
    const events = await collect(oneStep, scriptedDeps(script));
    const done = events.find((e) => e.kind === "step_done") as Extract<
      WorkflowEvent,
      { kind: "step_done" }
    >;
    return done.result;
  };

  it("keeps what was billed when the turn dies before its result", async () => {
    const result = await stepResult([
      usage({ input: 100, output: 10 }, 0.01),
      // A tool ran, so the failure is not retried: one attempt's spend.
      { kind: "tool_use", agent: "claude", ts: 0, name: "Bash" },
      usage({ output: 5 }, 0.002),
      { kind: "error", agent: "claude", ts: 0, message: "killed" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.costUsd).toBeCloseTo(0.012, 10);
    expect(result.tokens).toMatchObject({ input: 100, output: 15 });
  });

  it("lets a result's totals replace the increments it restates", async () => {
    const result = await stepResult([
      usage({ input: 100, output: 10 }, 0.01),
      {
        kind: "result",
        agent: "claude",
        ts: 0,
        isError: false,
        text: "ok",
        costUsd: 0.05,
        tokens: { input: 100, output: 40 },
      },
    ]);
    expect(result.costUsd).toBe(0.05);
    expect(result.tokens).toEqual({ input: 100, output: 40 });
  });

  it("adds increments that arrive after the last result", async () => {
    const result = await stepResult([
      { kind: "result", agent: "claude", ts: 0, isError: false, text: "ok", tokens: { input: 5 } },
      usage({ input: 7 }),
    ]);
    expect(result.tokens).toMatchObject({ input: 12 });
  });
});

describe("engine keeps a failed attempt's spend when the step retries", () => {
  it("sums every attempt's cost and tokens into the final result", async () => {
    let calls = 0;
    const deps: WorkflowDeps = {
      createAdapter: (id: AgentId): AgentAdapter => ({
        id,
        binary: "fake",
        defaultModel: "test",
        run: () =>
          (async function* (): AsyncGenerator<AgentEvent> {
            calls += 1;
            if (calls === 1) {
              // Billed, then died before a result: retryable, but not free.
              yield {
                kind: "usage",
                agent: "claude",
                ts: 0,
                tokens: { input: 40 },
                costUsd: 0.004,
              };
              yield { kind: "error", agent: "claude", ts: 0, message: "connection reset" };
              return;
            }
            yield {
              kind: "result",
              agent: "claude",
              ts: 0,
              isError: false,
              text: "ok",
              costUsd: 0.01,
              tokens: { input: 100, output: 10 },
            };
          })(),
      }),
      maxConcurrency: 1,
      cwd: "/base",
    };
    const spec: WorkflowSpec = {
      name: "retry-spend",
      phases: [
        {
          id: "p",
          title: "p",
          steps: [
            {
              id: "a",
              agent: "claude",
              model: "m",
              prompt: "x",
              retry: { maxAttempts: 2, initialDelayMs: 1, factor: 1, jitter: false },
            },
          ],
        },
      ],
    };
    const events = await collect(spec, deps);
    const done = events.find((e) => e.kind === "step_done") as Extract<
      WorkflowEvent,
      { kind: "step_done" }
    >;
    expect(calls).toBe(2);
    expect(done.result.ok).toBe(true);
    expect(done.result.costUsd).toBeCloseTo(0.014, 10);
    expect(done.result.tokens).toMatchObject({ input: 140, output: 10 });
  });
});

describe("run summary keeps every loop pass's spend", () => {
  it("rolls earlier passes' cost and tokens into the step's final result", async () => {
    let calls = 0;
    const deps: WorkflowDeps = {
      createAdapter: (id: AgentId): AgentAdapter => ({
        id,
        binary: "fake",
        defaultModel: "test",
        run: () =>
          (async function* (): AsyncGenerator<AgentEvent> {
            calls += 1;
            yield {
              kind: "result",
              agent: "claude",
              ts: 0,
              isError: false,
              // The gate passes on the third pass.
              text: calls >= 3 ? "x" : "not yet",
              costUsd: 0.01,
              tokens: { input: 10 },
            };
          })(),
      }),
      maxConcurrency: 1,
      cwd: "/base",
    };
    const spec: WorkflowSpec = {
      name: "loop-spend",
      phases: [
        {
          id: "fix",
          title: "fix",
          steps: [{ id: "fix-step", agent: "claude", model: "m", prompt: "p" }],
        },
        {
          id: "check",
          title: "check",
          steps: [
            {
              id: "g",
              kind: "gate",
              loopTo: "fix",
              maxIterations: 5,
              condition: { step: "fix-step", contains: "x" },
            },
          ],
        },
      ],
    };
    const events = await collect(spec, deps);
    const done = events.find((e) => e.kind === "workflow_done") as Extract<
      WorkflowEvent,
      { kind: "workflow_done" }
    >;
    expect(calls).toBe(3);
    const fix = done.results.find((r) => r.stepId === "fix-step")!;
    expect(fix.output).toBe("x");
    expect(fix.costUsd).toBeCloseTo(0.03, 10);
    expect(fix.tokens).toMatchObject({ input: 30 });
  });
});

describe("a resumed run's summary does not re-bill cached steps", () => {
  it("reports $0 for replays while step_done keeps the original cost", async () => {
    const deps = makeBillingDeps({
      m1: { cost: 0.01, tokens: { input: 100 } },
      m2: { cost: 0.02, tokens: { input: 200 } },
      m3: { cost: 0.03, tokens: { input: 300 } },
    });
    const cache = new Map<string, StepResult>();
    const run = async () => {
      const events: WorkflowEvent[] = [];
      for await (const ev of runWorkflow(threeStepSpec(), { input: "go", cache }, deps))
        events.push(ev);
      return events;
    };
    const first = await run();
    const firstDone = first.find((e) => e.kind === "workflow_done") as Extract<
      WorkflowEvent,
      { kind: "workflow_done" }
    >;
    expect(costForResults(firstDone.results)).toBeCloseTo(0.06, 10);

    const second = await run();
    const replays = second.filter((e) => e.kind === "step_done") as Extract<
      WorkflowEvent,
      { kind: "step_done" }
    >[];
    expect(replays.every((e) => e.cached)).toBe(true);
    expect(replays.find((e) => e.stepId === "a")?.result.costUsd).toBe(0.01);
    const secondDone = second.find((e) => e.kind === "workflow_done") as Extract<
      WorkflowEvent,
      { kind: "workflow_done" }
    >;
    expect(costForResults(secondDone.results)).toBe(0);
    expect(totalTokens(tokensForResults(secondDone.results))).toBe(0);

    // History agrees: the replayed run's totals are $0 too.
    const builder = new RunRecordBuilder({
      id: "r2",
      workflow: "budget-test",
      input: "go",
      cwd: "/base",
    });
    for (const ev of second) builder.handle(ev);
    expect(builder.build({ status: "done" }).totals.costUsd).toBe(0);
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

  it("excludes budget-truncated not-run placeholders from the by-model breakdown", () => {
    const stepMeta = new Map([["f", { agent: "claude", model: "opus" }]]);
    const withPlaceholder: StepResult[] = [
      {
        stepId: "f#0",
        parentStepId: "f",
        ok: true,
        output: "c0",
        durationMs: 1,
        costUsd: 0.02,
        tokens: { input: 100 },
      },
      // undispatched child: no cost/tokens, marked notRun — must not count as a leaf.
      {
        stepId: "f#1",
        parentStepId: "f",
        ok: false,
        notRun: true,
        output: "not run",
        durationMs: 0,
      },
    ];
    const byModel = aggregateLeavesByModel(resultLeaves(withPlaceholder, stepMeta));
    expect(byModel.find((m) => m.model === "claude/opus")).toMatchObject({ steps: 1 });
  });
});

describe("cost attribution for a templated model (carry-over fix)", () => {
  /**
   * `model: "{{inputs.coderModel}}"` (building block 5) renders at execution
   * time; before this fix only `llm` steps recorded the rendered model on
   * `StepResult.model`, so `resultLeaves` fell back to the spec's raw
   * (unrendered) template string via `stepMetaFromSpec` and a cost breakdown
   * would show the literal `{{inputs.coderModel}}` text instead of what
   * actually ran and was billed.
   */
  it("attributes a templated worker's spend to the RENDERED model, not the raw template", async () => {
    const spec: WorkflowSpec = {
      name: "templated-model",
      inputs: { coderModel: { type: "string", default: "sonnet" } },
      phases: [
        {
          id: "p1",
          title: "p1",
          steps: [{ id: "a", agent: "claude", model: "{{inputs.coderModel}}", prompt: "x" }],
        },
      ],
    };
    const deps = makeBillingDeps({ sonnet: { cost: 0.02, tokens: { input: 10 } } });
    const events = await (async () => {
      const out: WorkflowEvent[] = [];
      for await (const ev of runWorkflow(
        spec,
        { input: "go", inputs: { coderModel: "sonnet" } },
        deps,
      )) {
        out.push(ev);
      }
      return out;
    })();
    const done = events.find((e) => e.kind === "step_done" && e.stepId === "a");
    const result = done && done.kind === "step_done" ? done.result : undefined;

    // The recorded result carries the rendered model, not the template text.
    expect(result?.model).toBe("sonnet");

    // stepMetaFromSpec (built from the raw spec) would still report the
    // template string; resultLeaves must prefer result.model over it.
    const stepMeta = stepMetaFromSpec(spec);
    expect(stepMeta.get("a")?.model).toBe("{{inputs.coderModel}}");
    const byModel = aggregateLeavesByModel(resultLeaves([result as StepResult], stepMeta));
    expect(byModel).toHaveLength(1);
    expect(byModel[0]?.model).toBe("claude/sonnet");
    expect(byModel[0]?.costUsd).toBeCloseTo(0.02, 5);
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

describe("per-step (forEach) cost budget", () => {
  /** A fan-out over three items, each billed on the same model, with a per-step cap. */
  function fanOutSpec(maxCostUsd: number): WorkflowSpec {
    return {
      name: "fanout-budget",
      phases: [
        {
          id: "split",
          title: "split",
          steps: [{ id: "targets", kind: "distributor", items: ["a", "b", "c"] }],
        },
        {
          id: "process",
          title: "process",
          steps: [
            {
              id: "review",
              kind: "processor",
              agent: "claude",
              model: "m1",
              dependsOn: ["targets"],
              forEach: "steps.targets.items",
              maxCostUsd,
              prompt: "review {{item}}",
            },
          ],
        },
      ],
    };
  }

  it("stops dispatching children once the per-step cap is reached", async () => {
    // Each child costs $0.05; cap $0.08. review[0] ($0.05) and review[1] ($0.10 ≥
    // 0.08) run, then the step budget latches and review[2] is left not-run.
    const deps = makeBillingDeps({ m1: { cost: 0.05, tokens: { input: 10 } } });
    const events = await collect(fanOutSpec(0.08), deps);

    const budget = events.find((e) => e.kind === "budget_exceeded");
    expect(budget).toMatchObject({ kind: "budget_exceeded", scope: "step", stepId: "review" });

    // Only two children actually ran (produced a real, non-cached result).
    const childDone = events.filter(
      (e): e is Extract<WorkflowEvent, { kind: "step_done" }> =>
        e.kind === "step_done" && (e as { stepId: string }).stepId.startsWith("review["),
    );
    const ran = childDone.filter((e) => !e.result.notRun).map((e) => e.stepId);
    expect(ran.sort()).toEqual(["review[0]", "review[1]"]);

    // The fan-out parent is marked not-ok with a budget message; run ends not-ok.
    const parentDone = events.find(
      (e) => e.kind === "step_done" && (e as { stepId: string }).stepId === "review",
    ) as Extract<WorkflowEvent, { kind: "step_done" }>;
    expect(parentDone.result.ok).toBe(false);
    expect(parentDone.result.error).toContain("step cost budget");
    const final = events.at(-1) as Extract<WorkflowEvent, { kind: "workflow_done" }>;
    expect(final.ok).toBe(false);
  });

  it("runs every child when the per-step cap is generous", async () => {
    const deps = makeBillingDeps({ m1: { cost: 0.01 } });
    const events = await collect(fanOutSpec(1), deps);
    expect(events.some((e) => e.kind === "budget_exceeded")).toBe(false);
    const ran = events.filter(
      (e): e is Extract<WorkflowEvent, { kind: "step_done" }> =>
        e.kind === "step_done" &&
        (e as { stepId: string }).stepId.startsWith("review[") &&
        !e.result.notRun,
    );
    expect(ran).toHaveLength(3);
    const final = events.at(-1) as Extract<WorkflowEvent, { kind: "workflow_done" }>;
    expect(final.ok).toBe(true);
  });
});

describe("a partially resumed fan-out", () => {
  it("bills only the children it re-ran, not the ones replayed from the cache", async () => {
    // First run: the $0.08 cap stops the fan-out after two $0.05 children, so
    // the parent fails and only review[0] and review[1] land in the cache.
    const deps = makeBillingDeps({ m1: { cost: 0.05, tokens: { input: 10 } } });
    const cache = new Map<string, StepResult>();
    const run = async (spec: WorkflowSpec) => {
      const events: WorkflowEvent[] = [];
      for await (const ev of runWorkflow(spec, { input: "go", cache }, deps)) events.push(ev);
      return events;
    };
    const fanOut = (maxCostUsd: number): WorkflowSpec => ({
      name: "fanout-resume",
      phases: [
        {
          id: "split",
          title: "split",
          steps: [{ id: "targets", kind: "distributor", items: ["a", "b", "c"] }],
        },
        {
          id: "process",
          title: "process",
          steps: [
            {
              id: "review",
              kind: "processor",
              agent: "claude",
              model: "m1",
              dependsOn: ["targets"],
              forEach: "steps.targets.items",
              maxCostUsd,
              prompt: "review {{item}}",
            },
          ],
        },
      ],
    });
    await run(fanOut(0.08));

    // The resume re-runs the parent: two children replay, one runs fresh.
    const second = await run(fanOut(1));
    const children = second.filter(
      (e): e is Extract<WorkflowEvent, { kind: "step_done" }> =>
        e.kind === "step_done" && e.stepId.startsWith("review["),
    );
    expect(children.filter((e) => e.cached).map((e) => e.stepId)).toEqual([
      "review[0]",
      "review[1]",
    ]);
    const done = second.at(-1) as Extract<WorkflowEvent, { kind: "workflow_done" }>;
    expect(done.ok).toBe(true);
    expect(costForResults(done.results)).toBeCloseTo(0.05, 10);
    expect(totalTokens(tokensForResults(done.results))).toBe(10);
  });
});

describe("aggregateCosts across history", () => {
  it("breaks spend down by workflow, step, and model", () => {
    const mkRecord = (
      id: string,
      workflow: string,
      cached = false,
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
        cached,
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

    // A later run that replays s1 from the cache spent nothing on it: the
    // replay is still a step, but its recorded cost belongs to run 1.
    const replay = mkRecord("4", "wf-a", true);
    expect(replay.totals.costUsd).toBe(0);
    expect(totalTokens(replay.totals.tokens)).toBe(0);
    const withReplay = aggregateCosts([mkRecord("1", "wf-a"), replay]);
    expect(withReplay.costUsd).toBeCloseTo(0.1, 5);
    expect(withReplay.byWorkflow[0]).toMatchObject({ runs: 2, steps: 2 });
    expect(totalTokens(withReplay.tokens)).toBe(150);
  });
});
