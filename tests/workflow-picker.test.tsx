import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { WorkflowPicker } from "../src/tui/WorkflowPicker";
import { DEFAULT_FOLDER_COLLAPSE, buildWorkflowPickerNav } from "../src/tui/workflow-picker-model";
import { BUNDLED_WORKFLOWS } from "../src/workflow";
import type { WorkflowCatalogEntry } from "../src/workflow";

function entry(
  name: string,
  source: WorkflowCatalogEntry["source"],
  description?: string,
): WorkflowCatalogEntry {
  const base = BUNDLED_WORKFLOWS["target-sweep"] ?? Object.values(BUNDLED_WORKFLOWS)[0]!;
  return {
    name,
    source,
    spec: {
      ...base,
      name,
      description: description === undefined ? base.description : description,
    },
  };
}

const mixed: WorkflowCatalogEntry[] = [
  entry("alpha-bundled", "bundled", "A bundled workflow"),
  entry("beta-user", "user", "A user workflow"),
  entry("gamma-project", "project", "A project workflow"),
  entry("delta-user", "user"),
];

function renderPicker(
  workflows: WorkflowCatalogEntry[],
  selectedIndex: number,
  height: number,
  collapsed = DEFAULT_FOLDER_COLLAPSE,
  stationLanding = false,
) {
  const nav = buildWorkflowPickerNav(workflows, collapsed, { pinTourFirst: stationLanding });
  return render(
    <WorkflowPicker
      workflows={workflows}
      nav={nav}
      selectedIndex={selectedIndex}
      height={height}
      stationLanding={stationLanding}
    />,
  );
}

describe("WorkflowPicker create affordance", () => {
  it("always renders a selectable create row after the workflows", () => {
    const { lastFrame } = renderPicker(mixed, 1, 40);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("gamma-project");
    expect(frame).toContain("+ Create a new workflow…");
    expect(frame).toContain("Ctrl+N");
  });

  it("highlights the create row when it is selected (last nav index)", () => {
    // project header, gamma, user header, beta, delta, bundled header, alpha, create
    const createIndex = 7;
    const { lastFrame } = renderPicker(mixed, createIndex, 40);
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/▶\s+\+ Create a new workflow…/);
  });

  it("does not mark the create row when a workflow is selected", () => {
    const { lastFrame } = renderPicker(mixed, 1, 40);
    const frame = lastFrame() ?? "";
    expect(frame).not.toMatch(/▶\s+\+ Create a new workflow…/);
  });

  it("shows a call-to-action and the create row when there are no workflows", () => {
    const { lastFrame } = renderPicker([], 0, 24);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("No workflows yet");
    expect(frame).toMatch(/▶\s+\+ Create a new workflow…/);
  });

  it("advertises folder and paging hints in the header", () => {
    const { lastFrame } = renderPicker(mixed, 1, 40);
    expect(lastFrame() ?? "").toContain("folders");
    expect(lastFrame() ?? "").toContain("PgUp/PgDn");
  });
});

describe("WorkflowPicker folders and spacing", () => {
  it("renders collapsible folder headers for each source present", () => {
    const { lastFrame } = renderPicker(mixed, 1, 40);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("project");
    expect(frame).toContain("user");
    expect(frame).toContain("bundled");
    expect(frame).toMatch(/▾\s+project/);
    expect(frame).toMatch(/▾\s+user/);
    expect(frame).toMatch(/▾\s+bundled/);
  });

  it("hides workflows inside a collapsed folder", () => {
    const { lastFrame } = renderPicker(mixed, 0, 40, {
      ...DEFAULT_FOLDER_COLLAPSE,
      user: true,
    });
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/▸\s+user/);
    expect(frame).toContain("folded");
    expect(frame).not.toContain("beta-user");
    expect(frame).not.toContain("delta-user");
    expect(frame).toContain("gamma-project");
    expect(frame).toContain("alpha-bundled");
  });

  it("keeps exactly one blank line between consecutive list entries", () => {
    const { lastFrame } = renderPicker(mixed, 1, 40);
    const lines = (lastFrame() ?? "").split("\n").map(contentLine);
    // Find the project header line and the workflow under it; ensure a single blank between.
    const projectIdx = lines.findIndex((line) => /▾\s+project/.test(line));
    expect(projectIdx).toBeGreaterThanOrEqual(0);
    const gammaIdx = lines.findIndex((line) => line.includes("gamma-project"));
    expect(gammaIdx).toBeGreaterThan(projectIdx);
    const between = lines.slice(projectIdx + 1, gammaIdx);
    expect(between).toEqual([""]);

    // And between two sibling workflows.
    const betaIdx = lines.findIndex((line) => line.includes("beta-user"));
    const deltaIdx = lines.findIndex((line) => line.includes("delta-user"));
    expect(deltaIdx).toBeGreaterThan(betaIdx);
    // beta has description → skip name/blocks/desc, expect one blank before delta.
    const siblingGap = lines.slice(betaIdx + 1, deltaIdx).filter((line) => line === "");
    expect(siblingGap).toHaveLength(1);
  });

  it("shows scroll cues when the list exceeds the height budget", () => {
    const many: WorkflowCatalogEntry[] = Array.from({ length: 20 }, (_, i) =>
      entry(`wf-${String(i).padStart(2, "0")}`, i % 2 === 0 ? "bundled" : "user", `desc ${i}`),
    );
    const { lastFrame } = renderPicker(many, 12, 16);
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/[↑↓]/);
    expect(frame).toContain("hidden");
  });

  it("keeps station landing nav order in sync with the selection index", () => {
    const withTour: WorkflowCatalogEntry[] = [
      entry("zebra", "bundled", "later"),
      entry("tour", "bundled", "the door"),
      entry("alpha-user", "user", "user wf"),
    ];
    // Mirror the hook: pinTourFirst when station landing is on.
    const nav = buildWorkflowPickerNav(withTour, DEFAULT_FOLDER_COLLAPSE, {
      pinTourFirst: true,
    });
    const tourIdx = nav.findIndex((row) => row.kind === "workflow" && row.entry.name === "tour");
    expect(tourIdx).toBeGreaterThanOrEqual(0);
    // Tour should be the first workflow inside bundled (right after the bundled header).
    const bundledHeader = nav.findIndex((row) => row.kind === "header" && row.source === "bundled");
    expect(nav[bundledHeader + 1]).toMatchObject({
      kind: "workflow",
      entry: { name: "tour" },
    });

    const { lastFrame } = render(
      <WorkflowPicker
        workflows={withTour}
        nav={nav}
        selectedIndex={tourIdx}
        height={40}
        stationLanding
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/▶\s+tour/);
    expect(frame).toContain("start here");
  });
});

function stripAnsi(text: string): string {
  const esc = String.fromCharCode(27);
  return text.replaceAll(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

/** Inner text of an Ink bordered row, trimmed of box art and padding. */
function contentLine(text: string): string {
  return stripAnsi(text)
    .replace(/^[╭╰│]./, "")
    .replace(/[│╮╯]\s*$/, "")
    .trimEnd()
    .replace(/^\s+/, (spaces) => (spaces.length >= 2 ? spaces.slice(2) : spaces))
    .trim();
}
