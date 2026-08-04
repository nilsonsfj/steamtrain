import { describe, expect, it } from "vitest";
import {
  ARRIVAL_NEXT_CANDIDATES,
  TOUR_WORKFLOW_NAME,
  type WorkflowEvent,
  type WorkflowSpec,
  type WorkflowState,
  appendNarration,
  arrivalNotices,
  arrivalReceiptCards,
  buildArrivalReport,
  findArrivalStep,
  formatArrivalHeadline,
  formatArrivalReceipt,
  initialWorkflowIndex,
  isAgentlessWorkflow,
  isCredentialFreeWorkflow,
  narrateEvent,
  narrateFromState,
  shouldOfferStationLanding,
  workflowReducer,
  workflowStateFromSpec,
} from "../src/workflow";
import { BUNDLED_WORKFLOWS } from "../src/workflow/bundled";

describe("first-run / Station landing", () => {
  it("offers the Station only with no history and no remembered selection", () => {
    expect(shouldOfferStationLanding({ hasRunHistory: false })).toBe(true);
    expect(shouldOfferStationLanding({ hasRunHistory: true })).toBe(false);
    expect(
      shouldOfferStationLanding({ hasRunHistory: false, rememberedSelection: "bug-hunt" }),
    ).toBe(false);
  });

  it("indexes the tour when preferTour is set", () => {
    const entries = Object.keys(BUNDLED_WORKFLOWS).map((name) => ({ name }));
    const idx = initialWorkflowIndex(entries, { preferTour: true });
    expect(entries[idx]?.name).toBe(TOUR_WORKFLOW_NAME);
  });

  it("marks the tour as credential-free", () => {
    expect(isCredentialFreeWorkflow(BUNDLED_WORKFLOWS.tour!)).toBe(true);
    expect(isAgentlessWorkflow(BUNDLED_WORKFLOWS.tour!)).toBe(true);
    expect(isCredentialFreeWorkflow(BUNDLED_WORKFLOWS["bug-hunt"]!)).toBe(false);
    expect(isAgentlessWorkflow(BUNDLED_WORKFLOWS["bug-hunt"]!)).toBe(false);
  });
});

describe("narration", () => {
  it("projects lifecycle events into past-tense one-liners", () => {
    const start = narrateEvent({
      kind: "workflow_start",
      name: "tour",
      phaseCount: 5,
      stepCount: 8,
      ts: 1,
    });
    expect(start?.text).toContain("Started tour");
    expect(start?.text).toContain("8 steps");

    const held = narrateEvent({
      kind: "gate_evaluated",
      phaseId: "signal",
      stepId: "loop-signal",
      passed: false,
      onFalse: "continue",
      ts: 2,
    });
    expect(held?.text).toContain("another iteration");

    const skip = narrateEvent({
      kind: "step_done",
      phaseId: "ride",
      stepId: "express-service",
      result: {
        stepId: "express-service",
        ok: true,
        skipped: true,
        output: "",
        durationMs: 0,
      },
      cached: false,
      ts: 3,
    });
    expect(skip?.text).toContain("was skipped");

    expect(
      narrateEvent({
        kind: "step_event",
        phaseId: "a",
        stepId: "b",
        event: { type: "text", text: "x" } as never,
        ts: 4,
      }),
    ).toBeNull();
  });

  it("keeps the loop iteration on clickable step lines", () => {
    const result = {
      stepId: "inspect",
      ok: true,
      output: "done",
      durationMs: 1,
    };
    let lines: ReturnType<typeof appendNarration> = [];
    lines = appendNarration(lines, {
      kind: "step_done",
      phaseId: "check",
      stepId: "inspect",
      iteration: 1,
      result,
      cached: false,
      ts: 10,
    });
    lines = appendNarration(lines, {
      kind: "step_done",
      phaseId: "check",
      stepId: "inspect",
      iteration: 2,
      result,
      cached: false,
      ts: 10,
    });

    expect(lines.map((line) => line.iteration)).toEqual([1, 2]);
    expect(new Set(lines.map((line) => line.id)).size).toBe(2);
  });

  it("deduplicates non-adjacent narration lines with the same base id", () => {
    let lines: ReturnType<typeof appendNarration> = [];
    lines = appendNarration(lines, {
      kind: "step_retry",
      phaseId: "check",
      stepId: "inspect",
      iteration: 1,
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      reason: "transient failure",
      ts: 10,
    });
    lines = appendNarration(lines, {
      kind: "phase_start",
      phaseId: "report",
      title: "Report",
      index: 1,
      stepCount: 1,
      ts: 11,
    });
    lines = appendNarration(lines, {
      kind: "step_retry",
      phaseId: "check",
      stepId: "inspect",
      iteration: 1,
      attempt: 2,
      maxAttempts: 3,
      delayMs: 200,
      reason: "transient failure",
      ts: 10,
    });

    const ids = lines.map((line) => line.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[2]).toBe(`${ids[0]}-2`);
  });

  it("caps the live ticker", () => {
    let lines: ReturnType<typeof appendNarration> = [];
    for (let i = 0; i < 50; i++) {
      lines = appendNarration(lines, {
        kind: "phase_start",
        phaseId: `p${i}`,
        title: `Station ${i}`,
        index: i,
        stepCount: 1,
        ts: i,
      });
    }
    expect(lines.length).toBeLessThanOrEqual(40);
    expect(lines.at(-1)?.text).toContain("Station 49");
  });
});

describe("arrival report", () => {
  it("surfaces the consolidator output as the hero with a receipt", () => {
    let state: WorkflowState = workflowStateFromSpec(BUNDLED_WORKFLOWS.tour!);
    const events: WorkflowEvent[] = [
      {
        kind: "workflow_start",
        name: "tour",
        phaseCount: 5,
        stepCount: 8,
        ts: 1,
      },
      {
        kind: "step_done",
        phaseId: "arrive",
        stepId: "conductor",
        result: {
          stepId: "conductor",
          ok: true,
          output: "END OF THE LINE — tour complete",
          durationMs: 12,
          costUsd: 0,
        },
        cached: false,
        ts: 2,
      },
      {
        kind: "workflow_done",
        ok: true,
        results: [
          {
            stepId: "conductor",
            ok: true,
            output: "END OF THE LINE — tour complete",
            durationMs: 12,
            costUsd: 0,
          },
        ],
        ts: 3,
      },
    ];
    // Seed the consolidator step into the tree so findArrivalStep can see it.
    state = {
      ...state,
      started: true,
      name: "tour",
      phases: state.phases.map((p) =>
        p.phaseId === "arrive"
          ? {
              ...p,
              steps: p.steps.map((s) =>
                s.stepId === "conductor"
                  ? {
                      ...s,
                      status: "done" as const,
                      text: "END OF THE LINE — tour complete",
                      result: {
                        stepId: "conductor",
                        ok: true,
                        output: "END OF THE LINE — tour complete",
                        durationMs: 12,
                        costUsd: 0,
                      },
                    }
                  : s,
              ),
            }
          : p,
      ),
    };
    for (const ev of events) {
      state = workflowReducer(state, { type: "event", event: ev });
    }

    const report = buildArrivalReport(state, { elapsedMs: 700, credentialFree: true });
    expect(report).not.toBeNull();
    expect(report!.hero).toContain("END OF THE LINE");
    expect(report!.receipt.agentless).toBe(true);
    expect(formatArrivalReceipt(report!.receipt)).toContain("$0");
    expect(formatArrivalHeadline(report!.receipt, "tour")).toBe("Tour complete · $0 · 0.7s");
    const cards = arrivalReceiptCards(report!.receipt);
    expect(cards.map((c) => c.id)).toEqual(["ran", "cost", "produced"]);
    expect(cards[0]?.label).toBe("What ran");
    expect(cards[1]?.value).toContain("$0 · no agents");
    expect(cards[2]?.value).toBe("engine demo");
    expect(report!.destinations).toHaveLength(3);
    expect(report!.destinations[0]).toMatchObject({ id: "again", label: "Ride again" });
    expect(report!.destinations[2]).toMatchObject({ id: "history", label: "See past runs" });
    expect(ARRIVAL_NEXT_CANDIDATES[0]).toBe("bug-hunt");
  });

  it("prefers the consolidator when picking the arrival hero step", () => {
    const state = workflowStateFromSpec(BUNDLED_WORKFLOWS.tour!);
    const steps = state.phases.flatMap((p) =>
      p.steps.map((s) =>
        s.stepId === "conductor"
          ? {
              ...s,
              status: "done" as const,
              text: "report",
              result: {
                stepId: "conductor",
                ok: true,
                output: "report",
                durationMs: 1,
              },
            }
          : s.stepId === "car-parallel"
            ? {
                ...s,
                status: "done" as const,
                text: "parallel",
                result: {
                  stepId: "car-parallel",
                  ok: true,
                  output: "parallel",
                  durationMs: 1,
                },
              }
            : s,
      ),
    );
    const hero = findArrivalStep(steps);
    expect(hero?.stepId).toBe("conductor");
  });

  it("leads the arrival hero with root-cause failures when the run stops short", () => {
    const spec: WorkflowSpec = {
      name: "fail-demo",
      phases: [
        {
          id: "list",
          title: "List",
          steps: [{ id: "list-prs", kind: "processor", agent: "claude", model: "m", prompt: "x" }],
        },
        {
          id: "summary",
          title: "Summary",
          steps: [{ id: "report", kind: "consolidator", dependsOn: ["list-prs"], prompt: "y" }],
        },
      ],
    };
    const base = workflowStateFromSpec(spec);
    const state: WorkflowState = {
      ...base,
      done: true,
      ok: false,
      phases: [
        {
          ...base.phases[0]!,
          steps: [
            {
              ...base.phases[0]!.steps[0]!,
              status: "error" as const,
              result: {
                stepId: "list-prs",
                ok: false,
                error:
                  "structured output retry failed: no parseable JSON found in the step output\nsecond line",
                output: "raw agent reply",
                durationMs: 5,
              },
            },
          ],
        },
        {
          ...base.phases[1]!,
          steps: [
            {
              ...base.phases[1]!.steps[0]!,
              status: "error" as const,
              result: {
                stepId: "report",
                ok: false,
                dependencyFailed: "list-prs",
                error:
                  "dependency 'list-prs' failed: structured output retry failed: no parseable JSON found in the step output",
                output: "",
                durationMs: 0,
              },
            },
          ],
        },
      ],
    };

    const report = buildArrivalReport(state, { elapsedMs: 100 });
    expect(report).not.toBeNull();
    // Root cause first, first line only…
    expect(report!.hero).toContain(
      "✗ list-prs: structured output retry failed: no parseable JSON found in the step output",
    );
    expect(report!.hero).not.toContain("second line");
    // …cascade victims are not repeated as their own failures…
    expect(report!.hero).not.toContain("✗ report:");
    // …and the failed step's raw output stays below for context.
    expect(report!.hero).toContain("raw agent reply");
  });

  it("formats headlines and receipt cards for success, failure, and billed runs", () => {
    const base = {
      durationMs: 12400,
      okCount: 3,
      failCount: 0,
      skipCount: 0,
      costUsd: 0,
      tokens: 0,
      agentless: true,
      ok: true,
    };
    expect(formatArrivalHeadline(base, "tour")).toBe("Tour complete · $0 · 12.4s");
    expect(formatArrivalHeadline(base, null)).toBe("Run complete · $0 · 12.4s");
    expect(
      formatArrivalHeadline(
        { ...base, ok: false, failCount: 2, agentless: false, costUsd: 1.2345, tokens: 1500 },
        "bug-hunt",
      ),
    ).toBe("bug-hunt stopped · $1.2345 · 12.4s · 2 failed");

    const freeCards = arrivalReceiptCards(base);
    expect(freeCards.map((c) => c.id)).toEqual(["ran", "cost", "produced"]);
    expect(freeCards[1]?.value).toContain("$0 · no agents");
    expect(freeCards[1]?.value).not.toContain("12.4s");
    expect(freeCards[2]?.value).toBe("engine demo");

    const billed = arrivalReceiptCards({
      ...base,
      agentless: false,
      costUsd: 0.42,
      tokens: 2500,
      failCount: 1,
      skipCount: 1,
    });
    expect(billed[0]?.value).toContain("1 failed");
    expect(billed[1]?.value).toBe("$0.4200");
    expect(billed[2]?.value).toBe("2.5k tokens");
  });

  it("reconstructs narration from folded state", () => {
    const state = workflowReducer(workflowStateFromSpec(BUNDLED_WORKFLOWS.tour!), {
      type: "event",
      event: {
        kind: "workflow_start",
        name: "tour",
        phaseCount: 5,
        stepCount: 8,
        ts: 1,
      },
    });
    const lines = narrateFromState(state);
    expect(lines[0]?.text).toContain("Started tour");
  });
});

/**
 * The arrival's severity labels (design 02). They rank what the ENGINE saw —
 * a step that failed, was killed, retried — not findings parsed out of an
 * agent's report, which steamtrain never reads.
 */
describe("arrival notices", () => {
  type Step = Parameters<typeof arrivalNotices>[0][number];
  const step = (over: Partial<Step> & { stepId: string }): Step =>
    ({
      blockKind: "worker",
      status: "done",
      text: "",
      cached: false,
      ...over,
    }) as Step;

  it("ranks a root failure above the steps it took down with it", () => {
    const notices = arrivalNotices([
      step({
        stepId: "report",
        status: "error",
        result: {
          stepId: "report",
          ok: false,
          output: "",
          durationMs: 0,
          dependencyFailed: "scan",
          error: "dependency 'scan' failed",
        },
      }),
      step({
        stepId: "scan",
        status: "error",
        result: {
          stepId: "scan",
          ok: false,
          output: "",
          durationMs: 1,
          error: "runner timeout after 900s\nstack line",
        },
      }),
    ]);

    expect(notices.map((n) => [n.severity, n.what])).toEqual([
      ["critical", "scan failed"],
      ["high", "report never ran"],
    ]);
    // First line of the error only — the rest is for the step record.
    expect(notices[0]?.where).toBe("runner timeout after 900s");
    expect(notices[1]?.where).toBe("scan failed before it");
  });

  it("separates a deliberate stop from a breakage", () => {
    const notices = arrivalNotices([
      step({
        stepId: "slow",
        status: "error",
        result: {
          stepId: "slow",
          ok: false,
          output: "",
          durationMs: 1,
          killed: true,
          error: "killed by human:web",
        },
      }),
      step({ stepId: "flaky", attempts: 3 }),
      step({
        stepId: "findings-ready",
        blockKind: "gate",
        gate: { passed: false },
      }),
    ]);

    expect(notices.map((n) => [n.severity, n.what])).toEqual([
      ["high", "slow was killed"],
      ["high", "gate findings-ready did not pass"],
      ["medium", "flaky needed 3 attempts"],
    ]);
    // The headline says it was killed, so the detail line carries who.
    expect(notices[0]?.where).toBe("by human:web");
  });

  it("says nothing about a clean run, or about a loop gate mid-loop", () => {
    expect(arrivalNotices([step({ stepId: "a" }), step({ stepId: "b" })])).toEqual([]);
    // A loop gate that has not converged yet is the loop working, not a stop.
    expect(
      arrivalNotices([
        step({ stepId: "lap-gate", blockKind: "gate", gate: { passed: false }, loopTo: "p1" }),
      ]),
    ).toEqual([]);
  });

  it("leaves a fan-out parent to its children", () => {
    const notices = arrivalNotices([
      step({
        stepId: "fan",
        result: {
          stepId: "fan",
          ok: false,
          output: "",
          durationMs: 1,
          error: "one child failed",
          childResults: [{ stepId: "fan[0]", ok: false, output: "", durationMs: 1 }],
        },
      }),
      step({
        stepId: "fan[0]",
        status: "error",
        result: { stepId: "fan[0]", ok: false, output: "", durationMs: 1, error: "boom" },
      }),
    ]);
    expect(notices.map((n) => n.stepId)).toEqual(["fan[0]"]);
  });
});
