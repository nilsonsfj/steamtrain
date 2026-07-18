import { describe, expect, it } from "vitest";
import {
  ARRIVAL_NEXT_CANDIDATES,
  TOUR_WORKFLOW_NAME,
  type WorkflowEvent,
  type WorkflowState,
  appendNarration,
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
    expect(isCredentialFreeWorkflow(BUNDLED_WORKFLOWS["quick-triage"]!)).toBe(false);
    expect(isAgentlessWorkflow(BUNDLED_WORKFLOWS["quick-triage"]!)).toBe(true);
  });
});

describe("conductor narration", () => {
  it("projects lifecycle events into past-tense one-liners", () => {
    const start = narrateEvent({
      kind: "workflow_start",
      name: "tour",
      phaseCount: 5,
      stepCount: 8,
      ts: 1,
    });
    expect(start?.text).toContain("All aboard");
    expect(start?.text).toContain("8 cars");

    const held = narrateEvent({
      kind: "gate_evaluated",
      phaseId: "signal",
      stepId: "loop-signal",
      passed: false,
      onFalse: "continue",
      ts: 2,
    });
    expect(held?.text).toContain("another lap");

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
    expect(skip?.text).toContain("uncoupled");

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
    expect(arrivalReceiptCards(report!.receipt)).toHaveLength(3);
    expect(report!.destinations).toHaveLength(3);
    expect(report!.destinations[0]).toMatchObject({ id: "again", label: "Ride again" });
    expect(report!.destinations[2]).toMatchObject({ id: "history", label: "See past runs" });
    expect(ARRIVAL_NEXT_CANDIDATES[0]).toBe("multi-plan");
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
    expect(lines[0]?.text).toContain("All aboard");
  });
});
