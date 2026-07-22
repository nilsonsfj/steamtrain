import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { WorkflowView } from "../src/tui/WorkflowView";
import type { StepState, WorkflowState } from "../src/tui/workflow-state";

function plainLines(frame: string): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return frame.split("\n").map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
}

describe("step row single-line hardening", () => {
  it("keeps rows single-line when activity has wide glyphs and newlines", () => {
    const children: StepState[] = Array.from({ length: 4 }, (_, i) => ({
      stepId: `babysit[${i}]`,
      parentStepId: "babysit",
      blockKind: "processor",
      agent: "claude",
      model: "opus",
      status: i % 2 === 0 ? "running" : "error",
      text: "x",
      startedAt: 1000,
      // Reducer tool_use activity uses ⚙; a newline must not become a ghost
      // "|" row under the child (string-width counts \\n as 0 columns).
      activity: "⚙ Bash\n| leftover",
      cached: false,
      worktree: {
        originalCwd: "/repo",
        cwd: `/tmp/babysit-${i}-1-fe75aa53a6`,
        root: "/tmp",
        branch: "claude/hopeful-shannon-lx8lxp",
      },
      item: {
        sourceStepId: "babysit",
        index: i,
        value: `${417 + i}\nclaude/hopeful-shannon-lx8lxp`,
      },
      result:
        i % 2 === 1
          ? {
              stepId: `babysit[${i}]`,
              ok: false,
              output: "fail",
              durationMs: 5000,
              attempts: 3,
            }
          : undefined,
    }));
    const state: WorkflowState = {
      name: "babysit-all-prs",
      startedAt: 0,
      phases: [
        {
          phaseId: "babysit-phase",
          title: "Babysit each PR",
          index: 0,
          stepCount: children.length,
          steps: children,
          done: false,
          ok: true,
        },
      ],
      results: [],
      started: true,
      done: false,
      ok: true,
    };
    const width = 90;
    const height = 20;
    const { lastFrame } = render(
      <WorkflowView
        state={state}
        width={width}
        height={height}
        selectedIndex={0}
        elapsedMs={10_000}
        now={11_000}
      />,
    );
    const lines = plainLines(lastFrame() ?? "");
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lastFrame() ?? "").toContain("workflow · babysit-all-prs");
    // No orphan "|" / border-only continuation rows between children.
    expect(lines.some((line) => /^\s*│\s*\|\s*│\s*$/.test(line))).toBe(false);
    const babysitIndexes = lines
      .map((line, i) => (/↳\s*babysit\[\d+]/.test(line) ? i : -1))
      .filter((i) => i >= 0);
    expect(babysitIndexes).toHaveLength(4);
    for (let i = 1; i < babysitIndexes.length; i++) {
      expect(babysitIndexes[i]).toBe(babysitIndexes[i - 1]! + 1);
    }
    // ASCII worktree marker (not ambiguous-width ⎇); activity glyphs sanitized
    // when they fit, and never left as ⚙ on the tree row.
    expect(lines[babysitIndexes[0]!]).toContain("~babysit-0-1-fe75aa53a6");
    expect(lastFrame() ?? "").not.toContain("⎇");
    expect(lastFrame() ?? "").not.toMatch(/⚙/);
  });
});
