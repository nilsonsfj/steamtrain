import { describe, expect, it } from "vitest";
import { type WorkflowEvent, type WorkflowSpec, runWorkflow } from "../src/workflow";

/**
 * A step the run's cancel takes down did not fail on its own. Its error is
 * whatever the process said as it died (an exit code, a signal), so UIs used
 * to name it the run's root cause; the engine now says so explicitly.
 */
describe("a step taken down by a canceled run", () => {
  it("is marked interrupted, and the run stops before the next step starts", async () => {
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
    // The cancel stops the run before `next` starts, so it has no result to mark.
    expect(events.some((e) => e.kind === "step_start" && e.stepId === "next")).toBe(false);
    expect(events.some((e) => e.kind === "step_done" && e.stepId === "next")).toBe(false);
  });
});
