import { describe, expect, it } from "vitest";
import type { AgentAdapter } from "../src/agents";
import type { AgentEvent } from "../src/types/events";
import { runWorkflow } from "../src/workflow/engine";
import type { WorkflowEvent } from "../src/workflow/events";
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
});
