import { describe, expect, it } from "vitest";
import type { AgentAdapter } from "../src/agents";
import { initialWorkflowState, workflowReducer } from "../src/tui/workflow-state";
import type { AgentEvent } from "../src/types/events";
import { runWorkflow } from "../src/workflow/engine";
import type { WorkflowEvent } from "../src/workflow/events";
import { RunRecordBuilder } from "../src/workflow/history";
import type { WorkflowSpec } from "../src/workflow/types";

/** Fake adapter: emits a result whose text is provided by `script(stepPrompt, callIndex)`. */
function fakeAdapter(
  script: (prompt: string, call: number) => { text: string; isError?: boolean },
) {
  let call = 0;
  const adapter: AgentAdapter = {
    id: "opencode",
    binary: "opencode",
    run(opts): AsyncIterable<AgentEvent> {
      const c = call++;
      const out = script(opts.prompt, c);
      async function* gen() {
        yield { kind: "text_delta", agent: "opencode", ts: 0, text: out.text } as AgentEvent;
        yield {
          kind: "result",
          agent: "opencode",
          ts: 0,
          isError: Boolean(out.isError),
          text: out.text,
        } as AgentEvent;
      }
      return gen();
    },
  };
  return adapter;
}

async function collect(spec: WorkflowSpec, deps: Parameters<typeof runWorkflow>[2], input = "go") {
  const events: WorkflowEvent[] = [];
  for await (const e of runWorkflow(spec, { input }, deps)) events.push(e);
  return events;
}

function workerPhase(id: string, prompt: string) {
  return {
    id,
    title: id,
    steps: [{ id: `${id}-step`, agent: "opencode" as const, model: "m", prompt }],
  };
}

/** A loop: review → fix → check(gate loops to review until fix output contains DONE). */
function loopSpec(maxIterations?: number): WorkflowSpec {
  return {
    name: "loop",
    phases: [
      workerPhase("review", "review {{input}} (iter {{iteration}})"),
      workerPhase("fix", "fix based on {{steps.review-step.output}}"),
      {
        id: "check",
        title: "check",
        steps: [
          {
            id: "check-gate",
            kind: "gate" as const,
            dependsOn: ["fix-step"],
            condition: { step: "fix-step", contains: "DONE" },
            loopTo: "review",
            ...(maxIterations !== undefined ? { maxIterations } : {}),
            onFalse: "fail" as const,
          },
        ],
      },
    ],
  };
}

describe("engine loops", () => {
  it("re-runs the body until the gate condition is met", async () => {
    // fix-step returns NOPE on first 2 calls, DONE on the 3rd.
    let fixCalls = 0;
    const deps = {
      createAdapter: () =>
        fakeAdapter((prompt) => {
          if (prompt.startsWith("fix")) {
            fixCalls++;
            return { text: fixCalls >= 3 ? "DONE" : "NOPE" };
          }
          return { text: "reviewed" };
        }),
      maxConcurrency: 2,
      cwd: "/tmp",
      loopMaxIterations: 10,
    };
    const events = await collect(loopSpec(), deps);
    const loops = events.filter((e) => e.kind === "loop_iteration");
    expect(loops.length).toBe(2); // looped back twice, converged on iteration 3
    const done = events.find((e) => e.kind === "workflow_done");
    expect(done && (done as { ok: boolean }).ok).toBe(true);
    // review re-ran each iteration (3 review-step starts across iterations 1,2,3)
    const reviewStarts = events.filter(
      (e) => e.kind === "step_start" && (e as { stepId: string }).stepId === "review-step",
    );
    expect(reviewStarts.length).toBe(3);
  });

  it("stops at the cap and applies onFalse=fail when never converging", async () => {
    const deps = {
      createAdapter: () => fakeAdapter(() => ({ text: "NOPE" })),
      maxConcurrency: 2,
      cwd: "/tmp",
      loopMaxIterations: 10,
    };
    const events = await collect(loopSpec(3), deps); // cap 3
    const loops = events.filter((e) => e.kind === "loop_iteration");
    expect(loops.length).toBe(2); // iterations 2 and 3 (first pass is iteration 1)
    const done = events.find((e) => e.kind === "workflow_done") as { ok: boolean };
    expect(done.ok).toBe(false); // onFalse=fail after exhaustion
  });

  it("falls back to deps.loopMaxIterations when the gate omits maxIterations", async () => {
    const deps = {
      createAdapter: () => fakeAdapter(() => ({ text: "NOPE" })),
      maxConcurrency: 2,
      cwd: "/tmp",
      loopMaxIterations: 2, // cap via config
    };
    const events = await collect(loopSpec(), deps); // no per-gate cap
    const loops = events.filter((e) => e.kind === "loop_iteration");
    expect(loops.length).toBe(1); // iteration 2 only (cap 2)
  });

  it("exposes {{iteration}} to the body each pass", async () => {
    const seenPrompts: string[] = [];
    let fixCalls = 0;
    const deps = {
      createAdapter: () =>
        fakeAdapter((prompt) => {
          seenPrompts.push(prompt);
          if (prompt.startsWith("fix")) {
            fixCalls++;
            return { text: fixCalls >= 2 ? "DONE" : "NOPE" };
          }
          return { text: "reviewed" };
        }),
      maxConcurrency: 2,
      cwd: "/tmp",
      loopMaxIterations: 10,
    };
    await collect(loopSpec(), deps);
    expect(seenPrompts).toContain("review go (iter 1)");
    expect(seenPrompts).toContain("review go (iter 2)");
  });

  it("does not loop when the gate is skipped because its dependency failed", async () => {
    // fix-step always errors, so check-gate (dependsOn fix-step) is skipped, never
    // evaluating its condition. A skipped gate must not trigger a loop-back jump.
    const spec: WorkflowSpec = {
      name: "loop-skip-gate",
      phases: [
        workerPhase("review", "review {{input}} (iter {{iteration}})"),
        workerPhase("fix", "fix based on {{steps.review-step.output}}"),
        {
          id: "check",
          title: "check",
          steps: [
            {
              id: "check-gate",
              kind: "gate" as const,
              dependsOn: ["fix-step"],
              condition: { step: "fix-step", contains: "DONE" },
              loopTo: "review",
              onFalse: "fail" as const,
            },
          ],
        },
      ],
    };
    const deps = {
      createAdapter: () =>
        fakeAdapter((prompt) => {
          if (prompt.startsWith("fix")) return { text: "boom", isError: true };
          return { text: "reviewed" };
        }),
      maxConcurrency: 2,
      cwd: "/tmp",
      loopMaxIterations: 10,
    };
    const events = await collect(spec, deps);
    const loops = events.filter((e) => e.kind === "loop_iteration");
    expect(loops.length).toBe(0);
    const done = events.find((e) => e.kind === "workflow_done") as { ok: boolean };
    expect(done.ok).toBe(false);
  });

  it("runs the inner loop's full budget on every outer pass (nested loops)", async () => {
    // Topology: seed -> inner-body -> inner-gate(loopTo: inner-body) -> outer-tail
    //           -> outer-gate(loopTo: seed)
    // inner-gate allows 2 inner passes per outer pass; outer-gate allows 2 outer
    // passes. So inner-body must execute exactly innerPasses * outerPasses = 4
    // times total — and the run must terminate (workflow_done emitted).
    const innerPasses = 2;
    const outerPasses = 2;

    let innerBodyCalls = 0; // total inner-body executions across the whole run
    let innerBodyCallsThisOuterPass = 0;
    let outerTailCalls = 0;

    const spec: WorkflowSpec = {
      name: "nested-loop",
      phases: [
        {
          id: "seed",
          title: "seed",
          steps: [{ id: "seed-step", agent: "opencode", model: "m", prompt: "seed {{input}}" }],
        },
        {
          id: "inner-body",
          title: "inner-body",
          steps: [
            {
              id: "inner-body-step",
              agent: "opencode",
              model: "m",
              prompt: "inner-body run",
            },
          ],
        },
        {
          id: "inner-gate-phase",
          title: "inner-gate-phase",
          steps: [
            {
              id: "inner-gate",
              kind: "gate" as const,
              dependsOn: ["inner-body-step"],
              condition: { step: "inner-body-step", contains: "INNER_DONE" },
              loopTo: "inner-body",
              maxIterations: innerPasses,
              onFalse: "continue" as const,
            },
          ],
        },
        {
          id: "outer-tail",
          title: "outer-tail",
          steps: [
            { id: "outer-tail-step", agent: "opencode", model: "m", prompt: "outer-tail run" },
          ],
        },
        {
          id: "outer-gate-phase",
          title: "outer-gate-phase",
          steps: [
            {
              id: "outer-gate",
              kind: "gate" as const,
              dependsOn: ["outer-tail-step"],
              condition: { step: "outer-tail-step", contains: "OUTER_DONE" },
              loopTo: "seed",
              maxIterations: outerPasses,
              onFalse: "continue" as const,
            },
          ],
        },
      ],
    };

    const deps = {
      createAdapter: () =>
        fakeAdapter((prompt) => {
          if (prompt.startsWith("inner-body")) {
            innerBodyCalls++;
            innerBodyCallsThisOuterPass++;
            // Converge (report INNER_DONE) only on the last allotted inner pass
            // of this outer pass, so each outer pass burns the full inner budget.
            const done = innerBodyCallsThisOuterPass >= innerPasses;
            return { text: done ? "INNER_DONE" : "inner not yet" };
          }
          if (prompt.startsWith("outer-tail")) {
            outerTailCalls++;
            innerBodyCallsThisOuterPass = 0; // reset for the next outer pass
            const done = outerTailCalls >= outerPasses;
            return { text: done ? "OUTER_DONE" : "outer not yet" };
          }
          return { text: "seeded" };
        }),
      maxConcurrency: 2,
      cwd: "/tmp",
      loopMaxIterations: 10,
    };

    const events = await collect(spec, deps);

    // Bug B check: the inner loop must run its FULL budget on EACH outer pass.
    const innerBodyStarts = events.filter(
      (e) => e.kind === "step_start" && (e as { stepId: string }).stepId === "inner-body-step",
    );
    expect(innerBodyStarts.length).toBe(innerPasses * outerPasses);
    expect(innerBodyCalls).toBe(innerPasses * outerPasses);

    // The run must terminate.
    const done = events.find((e) => e.kind === "workflow_done");
    expect(done).toBeDefined();
    expect((done as { ok: boolean }).ok).toBe(true);

    // Bug A check: no fold collision. Feed the stream through BOTH the live
    // reducer and the history builder, and confirm the number of distinct
    // inner-body phase instances/step records equals the actual execution
    // count — a collision would silently overwrite instead of appending.
    let state = initialWorkflowState;
    for (const e of events) state = workflowReducer(state, { type: "event", event: e });
    const innerBodyPhaseInstances = state.phases.filter((p) => p.phaseId === "inner-body");
    expect(innerBodyPhaseInstances.length).toBe(innerPasses * outerPasses);

    const builder = new RunRecordBuilder({ id: "r", workflow: "w", input: "", cwd: "/tmp" });
    for (const e of events) builder.handle(e);
    const record = builder.build({ status: "done" });
    const innerBodyHistoryInstances = record.phases.filter((p) => p.phaseId === "inner-body");
    expect(innerBodyHistoryInstances.length).toBe(innerPasses * outerPasses);
  });

  it("inspects every loop gate in a phase, not just the first (two gates, one phase)", async () => {
    // Topology with BOTH loop gates in the same phase — legal per validation
    // (outer region [seed..gate] fully contains inner [inner-body..gate]):
    //   seed -> inner-body -> gate-phase[ outer-gate(loopTo: seed, always passes),
    //                                    inner-gate(loopTo: inner-body, converges on iter 2) ]
    // outer-gate is listed first, so decideLoopJump scans it first. It passes,
    // which must NOT terminate the scan — the inner-gate still wants to jump.
    let innerBodyCalls = 0;
    const spec: WorkflowSpec = {
      name: "two-gates-one-phase",
      phases: [
        {
          id: "seed",
          title: "seed",
          steps: [{ id: "seed-step", agent: "opencode", model: "m", prompt: "seed {{input}}" }],
        },
        {
          id: "inner-body",
          title: "inner-body",
          steps: [
            { id: "inner-body-step", agent: "opencode", model: "m", prompt: "inner-body run" },
          ],
        },
        {
          id: "gate",
          title: "gate",
          steps: [
            {
              id: "outer-gate",
              kind: "gate" as const,
              dependsOn: ["seed-step"],
              condition: { step: "seed-step", ok: true },
              loopTo: "seed",
              maxIterations: 3,
              onFalse: "continue" as const,
            },
            {
              id: "inner-gate",
              kind: "gate" as const,
              dependsOn: ["inner-body-step"],
              condition: { step: "inner-body-step", contains: "DONE" },
              loopTo: "inner-body",
              maxIterations: 3,
              onFalse: "fail" as const,
            },
          ],
        },
      ],
    };

    const deps = {
      createAdapter: () =>
        fakeAdapter((prompt) => {
          if (prompt.startsWith("inner-body")) {
            innerBodyCalls++;
            return { text: innerBodyCalls >= 2 ? "DONE" : "NOPE" };
          }
          if (prompt.startsWith("seed")) return { text: "seeded" };
          return { text: "ok" };
        }),
      maxConcurrency: 2,
      cwd: "/tmp",
      loopMaxIterations: 10,
    };

    const events = await collect(spec, deps);

    // The inner loop must fire even though the (first-scanned) outer gate
    // passes. A short-circuit on the outer gate would leave 0 loops and fail
    // the run via inner-gate onFalse=fail.
    const loops = events.filter((e) => e.kind === "loop_iteration");
    expect(loops.length).toBe(1);
    const innerBodyStarts = events.filter(
      (e) => e.kind === "step_start" && (e as { stepId: string }).stepId === "inner-body-step",
    );
    expect(innerBodyStarts.length).toBe(2);
    const done = events.find((e) => e.kind === "workflow_done") as { ok: boolean };
    expect(done.ok).toBe(true);
  });

  it("releases the forEach dynamic-step budget on each loop pass (forEach inside a loop)", async () => {
    // A forEach distributor inside a loop body re-spawns its N children every
    // pass. The dynamic-step budget (`generatedSteps`) must be released when
    // invalidateRegion drops the prior pass's children, otherwise the budget
    // accumulates N per pass and a later pass falsely hits the MAX_STEPS cap.
    //
    //   src(100 items) -> body[ each(forEach src.items) ] -> check-gate(loopTo body, cap 12)
    //
    // N=100, cap=12. Budget = MAX_STEPS - totalSteps = 1000 - 3 = 997. With the
    // H3 bug (monotonic accumulator), pass 10 reserves 100 on top of 900 cached
    // → 1000 > 997 → "exceed max workflow steps" and the run aborts at pass 10
    // (9 loops). With the fix, each pass re-syncs to 0 after invalidation, so
    // the full cap of 12 is used (11 loops) and no spurious budget error fires.
    const itemCount = 100;
    const cap = 12;
    const items = Array.from({ length: itemCount }, (_, i) => `i${i}`);
    const spec: WorkflowSpec = {
      name: "foreach-in-loop",
      phases: [
        {
          id: "src",
          title: "src",
          steps: [{ id: "src", kind: "distributor" as const, items }],
        },
        {
          id: "body",
          title: "body",
          steps: [
            {
              id: "each",
              kind: "processor" as const,
              agent: "opencode",
              model: "m",
              dependsOn: ["src"],
              forEach: "steps.src.items",
              prompt: "do {{item}}",
            },
          ],
        },
        {
          id: "check",
          title: "check",
          steps: [
            {
              id: "check-gate",
              kind: "gate" as const,
              dependsOn: ["each"],
              // Never converges (the forEach output never contains "NEVER") so
              // the loop burns its full cap and then applies onFalse=fail.
              condition: { step: "each", contains: "NEVER" },
              loopTo: "body",
              maxIterations: cap,
              onFalse: "fail" as const,
            },
          ],
        },
      ],
    };

    const deps = {
      createAdapter: () => fakeAdapter(() => ({ text: "ok" })),
      maxConcurrency: 8,
      cwd: "/tmp",
      loopMaxIterations: cap,
    };

    const events = await collect(spec, deps);

    // Full cap used — not cut short by a spurious budget exhaustion.
    const loops = events.filter((e) => e.kind === "loop_iteration");
    expect(loops.length).toBe(cap - 1);

    // The forEach parent re-ran every pass and re-spawned all children each time.
    const eachStarts = events.filter(
      (e) => e.kind === "step_start" && (e as { stepId: string }).stepId === "each",
    );
    expect(eachStarts.length).toBe(cap);
    const childStarts = events.filter(
      (e) => e.kind === "step_start" && (e as { parentStepId?: string }).parentStepId === "each",
    );
    expect(childStarts.length).toBe(itemCount * cap);

    // No child/parent hit the MAX_STEPS budget cap — the run ended only via the
    // gate's onFalse=fail after exhaustion, which is the expected terminal state.
    const budgetError = events.find(
      (e) =>
        e.kind === "step_done" &&
        typeof (e as { result?: { error?: string } }).result?.error === "string" &&
        /(exceed max workflow steps|would expand)/.test(
          (e as { result: { error: string } }).result.error,
        ),
    );
    expect(budgetError).toBeUndefined();

    const done = events.find((e) => e.kind === "workflow_done") as { ok: boolean };
    expect(done.ok).toBe(false); // onFalse=fail after the cap was exhausted
  });
});
