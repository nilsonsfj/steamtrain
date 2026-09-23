/**
 * The step drill-in keeps a multiline prompt and multiline output readable,
 * and Enter drills in before it resumes (#68, from the change in #67).
 */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { WorkflowStepDetails } from "../src/tui/WorkflowStepDetails";
import { workflowEnterAction } from "../src/tui/workflow-enter";
import type { PhaseState, StepState, WorkflowState } from "../src/tui/workflow-state";
import type { WorkflowSpec } from "../src/workflow";

/** The frame's lines, without colors and the box border. */
function rows(frame: string | undefined): string[] {
  return (frame ?? "").split("\n").map((raw) => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color codes
    const line = raw.replace(/\u001b\[[0-9;]*m/g, "");
    if (line.startsWith("╰")) return "╰";
    return line
      .replace(/^[│╭]\s?/, "")
      .replace(/\s?[│╮]$/, "")
      .trimEnd();
  });
}

function preview(prompt: string) {
  const spec: WorkflowSpec = {
    name: "multi",
    phases: [
      {
        id: "p",
        title: "P",
        steps: [{ id: "write", agent: "claude", model: "claude-sonnet-5", prompt }],
      },
    ],
  };
  const phase = spec.phases[0]!;
  return rows(
    render(
      <WorkflowStepDetails
        kind="preview"
        spec={spec}
        source="project"
        input="go"
        entry={{ phase, phaseIndex: 0, step: phase.steps[0]!, stepIndex: 0, flatIndex: 0 }}
        width={100}
        height={30}
        selectedIndex={0}
        totalSteps={1}
        dispatchOk
      />,
    ).lastFrame(),
  );
}

function live(output: string) {
  const step: StepState = {
    stepId: "write",
    blockKind: "worker",
    agent: "claude",
    model: "claude-sonnet-5",
    status: "done",
    text: output,
    result: { stepId: "write", ok: true, output, durationMs: 1000 },
    cached: false,
  };
  const phase: PhaseState = {
    phaseId: "p",
    title: "P",
    index: 0,
    stepCount: 1,
    steps: [step],
    done: true,
    ok: true,
  };
  const state: WorkflowState = {
    name: "multi",
    startedAt: 0,
    phases: [phase],
    results: [],
    started: true,
    done: true,
    ok: true,
  };
  return rows(
    render(
      <WorkflowStepDetails
        kind="live"
        state={state}
        entry={{ phase, step }}
        width={100}
        height={30}
        selectedIndex={0}
        totalSteps={1}
        elapsedMs={1000}
        scroll={{ offset: 0, follow: false }}
      />,
    ).lastFrame(),
  );
}

/** The output pane's rows: everything between its `── write · …` header and the bottom border. */
function outputPane(lines: string[]): string[] {
  const header = lines.findIndex((line) => line.startsWith("── write"));
  return lines.slice(header + 1, lines.indexOf("╰"));
}

describe("a multiline prompt in the step preview", () => {
  it("lists every line, marking blank ones", () => {
    const lines = preview("Fix the bug.\n\n  Then run the tests.\nReport back.");
    const at = lines.findIndex((line) => line.startsWith("prompt: "));
    expect(lines.slice(at, at + 4)).toEqual([
      "prompt: Fix the bug.",
      "  (blank)",
      "  Then run the tests.",
      "  Report back.",
    ]);
  });

  it("shows a one-line prompt on the prompt line alone", () => {
    const lines = preview("Just this.");
    expect(lines.filter((line) => line.startsWith("prompt: "))).toEqual(["prompt: Just this."]);
    expect(lines).not.toContain("  (blank)");
  });

  it("marks a prompt of blank lines as blank on every line", () => {
    const lines = preview(" \n\n");
    const at = lines.findIndex((line) => line.startsWith("prompt: "));
    expect(lines.slice(at, at + 3)).toEqual(["prompt: (blank)", "  (blank)", "  (blank)"]);
  });
});

describe("multiline output in the live drill-in", () => {
  it("keeps each line and each blank line where it was", () => {
    const lines = live("first\n\nthird\nfourth");
    expect(lines.some((line) => line.includes("lines 1–4/4"))).toBe(true);
    expect(outputPane(lines).slice(0, 4)).toEqual(["first", "", "third", "fourth"]);
  });

  it("shows a single line as one line", () => {
    const lines = live("only line");
    expect(lines.some((line) => line.includes("lines 1–1/1"))).toBe(true);
    expect(outputPane(lines)[0]).toBe("only line");
  });

  it("trims blank lines around the output but keeps the ones inside it", () => {
    const lines = live("\n\nfirst\n\nlast\n\n");
    expect(lines.some((line) => line.includes("lines 1–3/3"))).toBe(true);
    expect(outputPane(lines).slice(0, 3)).toEqual(["first", "", "last"]);
  });

  it("treats an all-blank output as no output", () => {
    const lines = live("\n \n\n");
    expect(lines.some((line) => line.includes("waiting for output"))).toBe(true);
  });

  it("says so when there is no output at all", () => {
    const lines = live("");
    expect(lines.some((line) => line.includes("waiting for output"))).toBe(true);
  });

  // Unlike the prompt's detail list, the output pane shows the text as the
  // agent wrote it, so a blank line stays blank rather than reading "(blank)".
  it("does not mark blank lines the way the prompt list does", () => {
    expect(live("a\n\nb").some((line) => line.includes("(blank)"))).toBe(false);
  });
});

describe("Enter in workflow mode", () => {
  const base = {
    runOnScreen: false,
    previewing: false,
    detailsOpen: false,
    onCreateRow: false,
    onHeaderRow: false,
  };

  it("opens the selected step's details on a run on screen", () => {
    expect(workflowEnterAction({ ...base, runOnScreen: true })).toEqual({
      kind: "open-details",
      view: "live",
    });
  });

  it("opens the selected step's details on a previewed workflow", () => {
    expect(workflowEnterAction({ ...base, previewing: true })).toEqual({
      kind: "open-details",
      view: "preview",
    });
  });

  it("falls through to resuming once the details are open", () => {
    expect(workflowEnterAction({ ...base, runOnScreen: true, detailsOpen: true })).toEqual({
      kind: "run",
    });
    expect(workflowEnterAction({ ...base, previewing: true, detailsOpen: true })).toEqual({
      kind: "run",
    });
  });

  it("prefers the run on screen over a preview behind it", () => {
    expect(workflowEnterAction({ ...base, runOnScreen: true, previewing: true })).toEqual({
      kind: "open-details",
      view: "live",
    });
  });

  it("acts on the picker row otherwise", () => {
    expect(workflowEnterAction({ ...base, onCreateRow: true })).toEqual({ kind: "focus-create" });
    expect(workflowEnterAction({ ...base, onHeaderRow: true })).toEqual({ kind: "toggle-folder" });
    expect(workflowEnterAction({ ...base, selected: "bug-hunt" })).toEqual({
      kind: "preview",
      name: "bug-hunt",
    });
    expect(workflowEnterAction(base)).toEqual({ kind: "none" });
  });

  it("acts on the picker row even with details left open", () => {
    expect(workflowEnterAction({ ...base, detailsOpen: true, selected: "bug-hunt" })).toEqual({
      kind: "preview",
      name: "bug-hunt",
    });
  });
});
