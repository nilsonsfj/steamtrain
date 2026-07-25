import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { HistoryDiffPanel } from "../src/tui/HistoryDiffPanel";
import type { HistoryDiffStep } from "../src/tui/history-diff";

function step(overrides: Partial<HistoryDiffStep> = {}): HistoryDiffStep {
  return {
    stepId: "implement",
    branch: "steamtrain/demo/implement",
    exists: true,
    files: 1,
    additions: 2,
    deletions: 1,
    lines: [
      { text: "M src/foo.ts  +2 −1", color: "yellow", bold: true },
      { text: "@@ -1 +1,2 @@", color: "cyan", dimColor: true },
      { text: "   1      │ -const b = 2;", color: "red" },
      { text: "       1 │ +const b = 3;", color: "green" },
    ],
    ...overrides,
  };
}

const baseProps = {
  workflow: "demo",
  recordId: "abcdef1234567890",
  loading: false,
  scroll: 0,
  width: 100,
  height: 14,
};

describe("HistoryDiffPanel", () => {
  it("shows the title with workflow and short record id, plus run totals", () => {
    const { lastFrame } = render(
      <HistoryDiffPanel {...baseProps} steps={[step(), step({ stepId: "review" })]} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Run diff — demo · abcdef12");
    expect(frame).toContain("2 files");
    expect(frame).toContain("+4");
    expect(frame).toContain("−2");
  });

  it("renders step headers and diff line content", () => {
    const { lastFrame } = render(<HistoryDiffPanel {...baseProps} steps={[step()]} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⎇ implement · steamtrain/demo/implement · 1 file +2 −1");
    expect(frame).toContain("M src/foo.ts  +2 −1");
    expect(frame).toContain("@@ -1 +1,2 @@");
    expect(frame).toContain("+const b = 3;");
  });

  it("shows a loading placeholder while diffs are computed", () => {
    const { lastFrame } = render(<HistoryDiffPanel {...baseProps} loading steps={[]} />);
    expect(lastFrame()).toContain("Computing worktree diffs…");
  });

  it("shows an empty state when the run recorded no worktree changes", () => {
    const { lastFrame } = render(<HistoryDiffPanel {...baseProps} steps={[]} />);
    expect(lastFrame()).toContain("No worktree changes recorded for this run");
  });

  it("shows a per-step error under the step header", () => {
    const { lastFrame } = render(
      <HistoryDiffPanel
        {...baseProps}
        steps={[
          step({
            exists: false,
            files: 0,
            additions: 0,
            deletions: 0,
            lines: [],
            error:
              "worktree for step 'implement' no longer exists at /tmp/x (pruned or cleaned up?)",
          }),
        ]}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("⎇ implement");
    expect(frame).toContain("no longer exists");
  });

  it("shows a truncation notice with the CLI fallback", () => {
    const { lastFrame } = render(
      <HistoryDiffPanel {...baseProps} steps={[step({ truncated: true })]} />,
    );
    expect(lastFrame()).toContain(
      "diff truncated at 200 KB — full diff: steamtrain workflow history show abcdef1234567890 --diff",
    );
  });

  it("renders the footer key hints", () => {
    const { lastFrame } = render(<HistoryDiffPanel {...baseProps} steps={[step()]} />);
    expect(lastFrame()).toContain("↑/↓ scroll · PgUp/PgDn page · g/G top/bottom · v/Esc close");
  });

  it("windows long content by scroll and shows a position indicator", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ text: `line ${i}` }));
    // height 10 → budget 6; header (1) + 30 lines = 31 total.
    const { lastFrame } = render(
      <HistoryDiffPanel {...baseProps} height={10} scroll={10} steps={[step({ lines: many })]} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("lines 11-16 of 31");
    expect(frame).toContain("line 9");
    expect(frame).toContain("line 14");
    expect(frame).not.toContain("line 15");
    expect(frame).not.toContain("line 0");
    expect(frame).not.toContain("line 29");
  });

  it("clamps an out-of-range scroll offset", () => {
    const { lastFrame } = render(
      <HistoryDiffPanel {...baseProps} height={10} scroll={999} steps={[step()]} />,
    );
    // Everything fits: no indicator, first lines still visible.
    const frame = lastFrame() ?? "";
    expect(frame).toContain("M src/foo.ts");
    expect(frame).not.toContain(" of ");
  });

  it("reports totalLines and viewport through onMetrics", async () => {
    const onMetrics = vi.fn();
    render(<HistoryDiffPanel {...baseProps} height={10} steps={[step()]} onMetrics={onMetrics} />);
    // onMetrics fires from a useEffect, which flushes after the initial frame.
    await new Promise((resolve) => setImmediate(resolve));
    expect(onMetrics).toHaveBeenCalledWith({ totalLines: 5, viewport: 6 });
  });
});
