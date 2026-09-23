import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ArrivalReportView } from "../src/tui/ArrivalReport";
import type { ArrivalReport } from "../src/workflow";

function report(ok = true): ArrivalReport {
  return {
    hero: "END OF THE LINE — tour complete for: all aboard\n\nCar details…",
    heroStepId: "arrival",
    receipt: {
      ok,
      durationMs: 700,
      okCount: 7,
      failCount: ok ? 0 : 1,
      skipCount: 1,
      blockedCount: 0,
      interruptedCount: 0,
      costUsd: 0,
      tokens: 0,
      agentless: true,
    },
    notices: ok
      ? []
      : [{ severity: "critical" as const, stepId: "scan", what: "scan failed", where: "boom" }],
    destinations: [
      { id: "again", label: "Ride again", key: "r" },
      { id: "history", label: "See past runs", key: "h" },
    ],
  };
}

describe("ArrivalReportView", () => {
  it("keeps the kicker separate from formatArrivalHeadline (no double-prefix)", () => {
    const { lastFrame } = render(
      <ArrivalReportView report={report(true)} width={80} height={20} workflowName="tour" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("End of the line");
    expect(frame).toContain("Tour complete · $0 · 0.7s");
    expect(frame).not.toContain("End of the line · Tour complete");
  });

  it("uses Stopped short as the failure kicker without concatenating the headline", () => {
    const { lastFrame } = render(
      <ArrivalReportView report={report(false)} width={80} height={20} workflowName="tour" />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Stopped short");
    expect(frame).toContain("Tour stopped");
    expect(frame).not.toContain("Stopped short · Tour stopped");
  });
});
