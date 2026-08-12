import { describe, expect, it } from "vitest";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  runWorkflow,
} from "../src/workflow";

/**
 * A cached step result is a function of the inputs it was computed from, so a
 * step may only replay while those inputs are unchanged. The case that made
 * this concrete: `babysit-all-prs`'s summary step references the per-PR fan-out
 * only through a template (deliberately, so a partial fan-out still gets
 * summarized), which lets the summary succeed and cache while the fan-out
 * fails. The next run re-ran the fan-out — every PR landed — and replayed the
 * cached summary reporting every PR as blocked.
 */

function deps(): WorkflowDeps {
  return {
    createAdapter: () => {
      throw new Error("this workflow must not create agent adapters");
    },
    maxConcurrency: 4,
    cwd: process.cwd(),
  };
}

/** `source` → `summary`, where summary only references source via a template. */
function spec(): WorkflowSpec {
  return {
    name: "stale-cache",
    phases: [
      {
        id: "p1",
        title: "Source",
        steps: [{ id: "source", kind: "command", cmd: "echo this-run" }],
      },
      {
        id: "p2",
        title: "Summary",
        steps: [
          {
            id: "summary",
            kind: "command",
            dependsOn: ["source"],
            cmd: "echo 'summary of {{steps.source.output}}'",
          },
        ],
      },
    ],
  };
}

async function run(cache: Map<string, StepResult>): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec(), { input: "task", cache }, deps())) events.push(ev);
  return events;
}

function stepDone(events: WorkflowEvent[], stepId: string) {
  for (const ev of events) if (ev.kind === "step_done" && ev.stepId === stepId) return ev;
  throw new Error(`no step_done for '${stepId}'`);
}

function cachedResult(stepId: string, output: string): StepResult {
  return { stepId, ok: true, output, durationMs: 1 };
}

describe("cache staleness", () => {
  it("re-runs a cached step whose dependency re-ran, instead of replaying a stale summary", async () => {
    // The exact resume shape: the upstream step's result was never persisted
    // (it failed last time), the downstream one's was.
    const cache = new Map([["summary", cachedResult("summary", "summary of last-run")]]);
    const events = await run(cache);

    const summary = stepDone(events, "summary");
    expect(summary.cached).toBe(false);
    expect(summary.result.output).toContain("summary of this-run");
    expect(summary.result.output).not.toContain("last-run");
  });

  it("still replays a cached step when nothing upstream re-ran", async () => {
    // The point of the cache: a clean resume must not re-execute settled work.
    const cache = new Map([
      ["source", cachedResult("source", "this-run\n")],
      ["summary", cachedResult("summary", "summary of this-run")],
    ]);
    const events = await run(cache);

    expect(stepDone(events, "source").cached).toBe(true);
    expect(stepDone(events, "summary").cached).toBe(true);
  });

  it("propagates the invalidation down a chain, one edge at a time", async () => {
    const chain: WorkflowSpec = {
      name: "stale-chain",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", kind: "command", cmd: "echo a-fresh" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [{ id: "b", kind: "command", dependsOn: ["a"], cmd: "echo b-fresh" }],
        },
        {
          id: "p3",
          title: "P3",
          steps: [{ id: "c", kind: "command", dependsOn: ["b"], cmd: "echo c-fresh" }],
        },
      ],
    };
    // `c` does not depend on `a` at all: it re-runs because `b` re-ran, which
    // is only true if the invalidation walks the graph rather than checking a
    // single hop against the run's one changed step.
    const cache = new Map([
      ["b", cachedResult("b", "b-stale")],
      ["c", cachedResult("c", "c-stale")],
    ]);
    const events: WorkflowEvent[] = [];
    for await (const ev of runWorkflow(chain, { input: "task", cache }, deps())) events.push(ev);

    expect(stepDone(events, "b").result.output.trim()).toBe("b-fresh");
    expect(stepDone(events, "c").cached).toBe(false);
    expect(stepDone(events, "c").result.output.trim()).toBe("c-fresh");
  });
});
