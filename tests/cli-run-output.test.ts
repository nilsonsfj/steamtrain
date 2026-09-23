import { describe, expect, it } from "vitest";
import { ownWorkRewriter, printHumanEvent, printRunSummary, priorOwnerWork } from "../src/run-cli";
import { describeIssue } from "../src/util/zod-issue";
import type { WorkflowEvent } from "../src/workflow";

function capture() {
  let text = "";
  const out = (chunk: string) => {
    text += chunk;
  };
  return { out, text: () => text };
}

const ts = 0;
const delta = (text: string): WorkflowEvent => ({
  kind: "step_event",
  phaseId: "a",
  stepId: "s1",
  event: { kind: "text_delta", agent: "opencode", ts, text },
  ts,
});
const done = (ok: boolean, error?: string): WorkflowEvent => ({
  kind: "step_done",
  phaseId: "a",
  stepId: "s1",
  result: { stepId: "s1", ok, output: "", error, durationMs: 1 },
  cached: false,
  ts,
});

describe("printHumanEvent", () => {
  it("starts a status line on a fresh line after streamed agent text", () => {
    const { out, text } = capture();
    printHumanEvent(delta("noted"), out);
    printHumanEvent(done(true), out);
    expect(text()).toBe("noted\n  done s1\n");
  });

  it("adds no blank line when the agent text already ended its line", () => {
    const { out, text } = capture();
    printHumanEvent(delta("noted\n"), out);
    printHumanEvent(done(true), out);
    expect(text()).toBe("noted\n  done s1\n");
  });

  it("says why a step failed", () => {
    const { out, text } = capture();
    printHumanEvent(done(false, "'opencode' exited with code 1: boom\nmore detail"), out);
    expect(text()).toBe("  fail s1\n     'opencode' exited with code 1: boom\n");
  });

  it("does not blame a step the run's cancel took down, whatever its error says", () => {
    const { out, text } = capture();
    const interrupted = done(false, "'claude' exited with code 143");
    if (interrupted.kind === "step_done") interrupted.result.interrupted = true;
    printHumanEvent(interrupted, out);
    expect(text()).toBe("  stop s1\n");
  });

  it("lists a step the cancel took down as stopped in the summary, not failed", () => {
    const { out, text } = capture();
    printRunSummary(
      [
        { stepId: "a", ok: true, output: "", durationMs: 1000 },
        { stepId: "b", ok: false, output: "", durationMs: 500, interrupted: true, error: "x" },
        { stepId: "c", ok: false, output: "", durationMs: 500, error: "boom" },
      ],
      out,
    );
    expect(text()).toContain("  stop b ");
    expect(text()).toContain("  fail c ");
    expect(text()).toContain("── 1 ok · 1 failed · 1 interrupted");
  });

  it("says a timed-out run timed out", () => {
    const { out, text } = capture();
    printHumanEvent({ kind: "workflow_done", ok: false, results: [], ts }, out, { timedOut: true });
    expect(text()).toBe("\nworkflow timed out\n");
  });

  it("reports a canceled run as canceled, without blaming its interrupted steps", () => {
    const { out, text } = capture();
    printHumanEvent(done(false, "cancelled"), out, { canceled: true });
    printHumanEvent({ kind: "workflow_done", ok: false, results: [], ts }, out, { canceled: true });
    expect(text()).toBe("  fail s1\n\nworkflow canceled\n");
  });
});

describe("describeIssue", () => {
  it("names the field a schema issue is about", () => {
    expect(
      describeIssue({ path: ["workflows", "x", "phases", 0, "title"], message: "Required" }),
    ).toBe("workflows.x.phases.0.title: Required");
    expect(describeIssue({ path: [], message: "Expected object" })).toBe("config: Expected object");
    expect(describeIssue(undefined)).toBe("schema error");
  });
});

describe("a mid-run handoff keeps the run's own work", () => {
  const stepDone = (stepId: string, cached: boolean, costUsd: number): WorkflowEvent => ({
    kind: "step_done",
    phaseId: "a",
    stepId,
    result: { stepId, ok: true, output: "", durationMs: 1, costUsd },
    cached,
    ts,
  });

  it("reads what the previous owner ran itself, and when it started", () => {
    const prior = priorOwnerWork([
      { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 3, ts: 1000 },
      stepDone("planner", false, 0.01),
      stepDone("from-an-earlier-run", true, 0.02),
    ]);
    expect(prior.startedAt).toBe(1000);
    expect([...prior.ran]).toEqual(["planner"]);
  });

  it("reports the previous owner's steps as this run's, spend included", () => {
    const own = ownWorkRewriter(
      priorOwnerWork([
        { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 2, ts: 1000 },
        stepDone("planner", false, 0.01),
      ]),
    );
    expect(
      own({ kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 2, ts: 5000 }),
    ).toMatchObject({
      ts: 1000,
    });
    expect(own(stepDone("planner", true, 0.01))).toMatchObject({ cached: false });
    // A step replayed from an earlier run's cache stays a replay.
    expect(own(stepDone("older", true, 0.02))).toMatchObject({ cached: true });
    // The engine zeroes a replay's spend in its final results; the handed-off
    // step's spend is restored, the earlier run's replay stays at $0.
    const done = own({
      kind: "workflow_done",
      ok: true,
      results: [
        { stepId: "planner", ok: true, output: "", durationMs: 1, costUsd: 0, tokens: {} },
        { stepId: "older", ok: true, output: "", durationMs: 1, costUsd: 0, tokens: {} },
      ],
      ts,
    });
    expect(done.kind === "workflow_done" && done.results.map((r) => r.costUsd)).toEqual([0.01, 0]);
  });

  it("adds every pass the previous owner ran of a loop step to this process's own", () => {
    // Pass 1 ran (and failed) and pass 2 ran before the handoff; the new owner
    // replays pass 2 from the cache and runs pass 3 live. Its final result
    // carries only pass 3's spend — the replay is zeroed — so all three must
    // add up, not one of them replace the rest.
    const failedPass: WorkflowEvent = {
      kind: "step_done",
      phaseId: "a",
      stepId: "rev",
      result: { stepId: "rev", ok: false, output: "", durationMs: 1, costUsd: 0.01 },
      cached: false,
      ts,
    };
    const own = ownWorkRewriter(priorOwnerWork([failedPass, stepDone("rev", false, 0.02)]));
    const done = own({
      kind: "workflow_done",
      ok: true,
      results: [{ stepId: "rev", ok: true, output: "", durationMs: 1, costUsd: 0.04 }],
      ts,
    });
    expect(done.kind === "workflow_done" && done.results[0]?.costUsd).toBeCloseTo(0.07);
  });

  it("does not bill a step twice across two handoffs", () => {
    // Owner 1 ran rev ($0.02); owner 2 replayed it (re-labeled as its own
    // work, so it reads live) and handed off again. Owner 3 must still see
    // $0.02, not the claim added on top.
    const start = (ts: number): WorkflowEvent => ({
      kind: "workflow_start",
      name: "w",
      phaseCount: 1,
      stepCount: 1,
      ts,
    });
    // Owner 2's replay went through ownWorkRewriter, which tags it claimed.
    const claim = ownWorkRewriter(priorOwnerWork([start(1), stepDone("rev", false, 0.02)]))(
      stepDone("rev", true, 0.02),
    );
    const prior = priorOwnerWork([start(1), stepDone("rev", false, 0.02), start(2), claim]);
    expect(prior.spend.get("rev")?.costUsd).toBeCloseTo(0.02);
    expect([...prior.ran]).toEqual(["rev"]);
    expect(prior.startedAt).toBe(1);
  });

  it("still counts a step an intermediate owner genuinely re-ran", () => {
    // Owner 2's cached rev went stale (an input re-ran), so it ran live again:
    // that $0.03 is real spend on top of owner 1's $0.02.
    const start = (ts: number): WorkflowEvent => ({
      kind: "workflow_start",
      name: "w",
      phaseCount: 1,
      stepCount: 1,
      ts,
    });
    const prior = priorOwnerWork([
      start(1),
      stepDone("rev", false, 0.02),
      start(2),
      stepDone("rev", false, 0.03),
    ]);
    expect(prior.spend.get("rev")?.costUsd).toBeCloseTo(0.05);
  });

  it("changes nothing for a run that was not handed off", () => {
    const own = ownWorkRewriter(priorOwnerWork([]));
    const event = stepDone("planner", true, 0.01);
    expect(own(event)).toBe(event);
  });
});

describe("a timed-out run's record", () => {
  it("keeps timedOut, and classifies as a timeout without being told", async () => {
    const { RunRecordBuilder, classifyRun } = await import("../src/workflow");
    const builder = new RunRecordBuilder({ id: "r", workflow: "w", input: "", cwd: "/" });
    const timedOut = builder.build({ status: "canceled", timedOut: true });
    expect(timedOut.timedOut).toBe(true);
    expect(classifyRun(timedOut)).toBe("timeout");
    // A person's cancel stays a cancel, and timedOut never sticks to another status.
    expect(classifyRun(builder.build({ status: "canceled" }))).toBe("canceled");
    expect(builder.build({ status: "error", timedOut: true }).timedOut).toBeUndefined();
  });
});
