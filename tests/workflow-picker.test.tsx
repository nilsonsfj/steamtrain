import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { WorkflowPicker } from "../src/tui/WorkflowPicker";
import { BUNDLED_WORKFLOWS } from "../src/workflow";
import type { WorkflowCatalogEntry } from "../src/workflow";

const entries: WorkflowCatalogEntry[] = [
  { name: "target-sweep", spec: BUNDLED_WORKFLOWS["target-sweep"]!, source: "bundled" },
];

describe("WorkflowPicker create affordance", () => {
  it("always renders a selectable create row after the workflows", () => {
    const { lastFrame } = render(
      <WorkflowPicker workflows={entries} selectedIndex={0} height={24} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("target-sweep");
    expect(frame).toContain("+ Create a new workflow…");
    expect(frame).toContain("Ctrl+N");
  });

  it("highlights the create row when it is selected (index === workflow count)", () => {
    const { lastFrame } = render(
      <WorkflowPicker workflows={entries} selectedIndex={entries.length} height={24} />,
    );
    const frame = lastFrame() ?? "";
    // The selection marker precedes the create label only when it is active.
    expect(frame).toMatch(/▶\s+\+ Create a new workflow…/);
  });

  it("does not mark the create row when a workflow is selected", () => {
    const { lastFrame } = render(
      <WorkflowPicker workflows={entries} selectedIndex={0} height={24} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toMatch(/▶\s+\+ Create a new workflow…/);
  });

  it("shows a call-to-action and the create row when there are no workflows", () => {
    const { lastFrame } = render(<WorkflowPicker workflows={[]} selectedIndex={0} height={24} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No workflows yet");
    expect(frame).toMatch(/▶\s+\+ Create a new workflow…/);
  });

  it("advertises Ctrl+N in the header hint", () => {
    const { lastFrame } = render(
      <WorkflowPicker workflows={entries} selectedIndex={0} height={24} />,
    );
    expect(lastFrame() ?? "").toContain("Ctrl+N new");
  });
});
