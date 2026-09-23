import { describe, expect, it } from "vitest";
import { type WorkflowEvent, type WorkflowSpec, runWorkflow } from "../src/workflow";

/**
 * A step the run's cancel takes down did not fail on its own. Its error is
 * whatever the process said as it died (an exit code, a signal), so UIs used
 * to name it the run's root cause; the engine now says so explicitly.
 */
describe("a step taken down by a canceled run", () => {
  it("is marked interrupted, and a step that never started is not", async () => {
    const spec: WorkflowSpec = {
      name: "interrupted",
      phases: [
        { id: "p1", title: "Slow", steps: [{ id: "slow", kind: "command", cmd: "sleep 5" }] },
        { id: "p2", title: "Next", steps: [{ id: "next", kind: "command", cmd: "echo next" }] },
      ],
    };
    const ac = new AbortController();
    const events: WorkflowEvent[] = [];
    for await (const ev of runWorkflow(
      spec,
      { input: "task" },
      {
        createAdapter: () => {
          throw new Error("no agents");
        },
        maxConcurrency: 2,
        cwd: process.cwd(),
      },
      ac.signal,
    )) {
      events.push(ev);
      if (ev.kind === "step_start" && ev.stepId === "slow") setTimeout(() => ac.abort(), 100);
    }
    const slow = events.find((e) => e.kind === "step_done" && e.stepId === "slow");
    expect(slow?.kind === "step_done" && slow.result).toMatchObject({
      ok: false,
      interrupted: true,
    });
    const next = events.find((e) => e.kind === "step_done" && e.stepId === "next");
    expect(next?.kind === "step_done" && next.result.interrupted).toBeFalsy();
  });
});
