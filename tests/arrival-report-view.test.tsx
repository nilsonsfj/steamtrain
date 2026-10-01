import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ArrivalReportView } from "../src/tui/ArrivalReport";
import { WorkflowView } from "../src/tui/WorkflowView";
import {
  type ArrivalReport,
  type WorkflowEvent,
  workflowReducer,
  workflowStateFromSpec,
} from "../src/workflow";
import { arrivalOutputLines } from "../src/workflow/arrival-report";

function report(ok = true, outputs: ArrivalReport["outputs"] = []): ArrivalReport {
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
    outputs,
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

  it("shows where each output was saved, relative to the project, or why not", () => {
    const { lastFrame } = render(
      <ArrivalReportView
        report={report(true, [
          {
            key: "report",
            written: true,
            path: "/work/app/.steamtrain/outputs/bug-hunt/r/report.md",
          },
          { key: "log", written: false, error: "step 'check' failed" },
        ])}
        width={80}
        height={20}
        workflowName="bug-hunt"
        cwd="/work/app"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("saved report → .steamtrain/outputs/bug-hunt/r/report.md");
    expect(frame).toContain("not saved log: step 'check' failed");
  });
});

describe("ArrivalReportView: many outputs", () => {
  it("keeps the destinations on screen, folding the outputs that do not fit", () => {
    const outputs = Array.from({ length: 12 }, (_, i) => ({
      key: `out${i}`,
      written: true,
      path: `/work/app/out${i}.md`,
    }));
    const { lastFrame } = render(
      <ArrivalReportView report={report(true, outputs)} width={80} height={14} cwd="/work/app" />,
    );
    const frame = lastFrame() ?? "";
    // 14 rows leave room for 7 output lines: six outputs and a count of the rest.
    expect(frame).toContain("saved out5 → out5.md");
    expect(frame).not.toContain("out6.md");
    expect(frame).toContain("… 6 more (workflow history show)");
    expect(frame).toContain("Ride again");
  });
});

describe("arrivalOutputLines: a not-saved output", () => {
  it("says where it would have gone, unless the reason already names the path", () => {
    expect(
      arrivalOutputLines(
        [
          { key: "a", written: false, error: "step 'x' failed", path: "/w/out/a.md" },
          { key: "b", written: false, error: "EISDIR: /w/out/b.md", path: "/w/out/b.md" },
          { key: "c", written: false, error: "the run was handed to a background runner" },
        ],
        "/w",
      ),
    ).toEqual([
      "not saved a: step 'x' failed (for out/a.md)",
      "not saved b: EISDIR: /w/out/b.md",
      "not saved c: the run was handed to a background runner",
    ]);
  });
});

describe("ArrivalReportView: a very short screen", () => {
  it("drops the output lines rather than overflowing by a row", () => {
    const outputs = [{ key: "report", written: true, path: "/work/app/report.md" }];
    const frame = (height: number) =>
      render(
        <ArrivalReportView
          report={report(true, outputs)}
          width={80}
          height={height}
          cwd="/work/app"
        />,
      ).lastFrame() ?? "";
    // Height 7 is chrome (6) plus one body row: no room left for an output line.
    expect(frame(7)).not.toContain("report.md");
    expect(frame(7).split("\n").length).toBeLessThanOrEqual(7);
    // One row more and it fits.
    expect(frame(8)).toContain("saved report → report.md");
  });
});

describe("WorkflowView: the run's directory", () => {
  it("shows saved paths relative to the directory the run ran in", () => {
    let state = workflowStateFromSpec({
      name: "hunt",
      phases: [{ id: "p", title: "P", steps: [{ id: "s", kind: "command", cmd: "true" }] }],
    });
    const events: WorkflowEvent[] = [
      { kind: "workflow_start", name: "hunt", phaseCount: 1, stepCount: 1, ts: 1 },
      {
        kind: "workflow_done",
        ok: true,
        results: [],
        outputs: [{ key: "report", written: true, path: "/work/repo/.steamtrain/outputs/r.md" }],
        ts: 2,
      },
    ];
    for (const event of events) state = workflowReducer(state, { type: "event", event });
    const { lastFrame } = render(
      <WorkflowView
        state={state}
        width={80}
        height={20}
        selectedIndex={0}
        elapsedMs={1}
        cwd="/work/repo"
      />,
    );
    expect(lastFrame() ?? "").toContain("saved report → .steamtrain/outputs/r.md");
  });
});
