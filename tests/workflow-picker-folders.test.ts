import { describe, expect, it } from "vitest";
import { selectVisibleWindow, selectVisibleWindowWeighted } from "../src/tui/workflow-list-window";
import {
  DEFAULT_FOLDER_COLLAPSE,
  buildWorkflowPickerNav,
  groupWorkflowEntriesBySource,
  indexOfWorkflowOrFallback,
  remapPickerIndexAfterCollapse,
  toggleFolderCollapse,
  workflowPickerRowHeight,
} from "../src/tui/workflow-picker-model";
import type { WorkflowCatalogEntry } from "../src/workflow";
import { BUNDLED_WORKFLOWS } from "../src/workflow";

function entry(
  name: string,
  source: WorkflowCatalogEntry["source"],
  description?: string,
): WorkflowCatalogEntry {
  const base = BUNDLED_WORKFLOWS["target-sweep"] ?? Object.values(BUNDLED_WORKFLOWS)[0]!;
  return {
    name,
    source,
    spec: { ...base, name, description: description ?? base.description },
  };
}

describe("workflow picker folders", () => {
  const catalog: WorkflowCatalogEntry[] = [
    entry("alpha", "bundled", "bundled one"),
    entry("beta", "user"),
    entry("gamma", "project", "project one"),
    entry("delta", "user", "user two"),
  ];

  it("groups by source with project → user → bundled order", () => {
    const groups = groupWorkflowEntriesBySource(catalog);
    expect(groups.map((g) => g.source)).toEqual(["project", "user", "bundled"]);
    expect(groups[0]!.entries.map((e) => e.name)).toEqual(["gamma"]);
    expect(groups[1]!.entries.map((e) => e.name)).toEqual(["beta", "delta"]);
    expect(groups[2]!.entries.map((e) => e.name)).toEqual(["alpha"]);
  });

  it("builds navigable rows with headers, workflows, and create", () => {
    const nav = buildWorkflowPickerNav(catalog);
    expect(nav.map((row) => row.kind)).toEqual([
      "header",
      "workflow",
      "header",
      "workflow",
      "workflow",
      "header",
      "workflow",
      "create",
    ]);
    expect(nav[0]).toMatchObject({ kind: "header", source: "project", count: 1, collapsed: false });
    expect(nav.at(-1)).toEqual({ kind: "create" });
  });

  it("hides workflows inside collapsed folders but keeps the header", () => {
    const nav = buildWorkflowPickerNav(catalog, {
      ...DEFAULT_FOLDER_COLLAPSE,
      user: true,
    });
    const userHeader = nav.find((row) => row.kind === "header" && row.source === "user");
    expect(userHeader).toMatchObject({ collapsed: true, count: 2 });
    expect(nav.some((row) => row.kind === "workflow" && row.entry.name === "beta")).toBe(false);
    expect(nav.some((row) => row.kind === "workflow" && row.entry.name === "gamma")).toBe(true);
  });

  it("remaps selection onto the folder header when its workflow is folded away", () => {
    const open = buildWorkflowPickerNav(catalog);
    const betaIdx = open.findIndex((row) => row.kind === "workflow" && row.entry.name === "beta");
    const collapsed = buildWorkflowPickerNav(catalog, {
      ...DEFAULT_FOLDER_COLLAPSE,
      user: true,
    });
    const remapped = remapPickerIndexAfterCollapse(open, collapsed, betaIdx);
    expect(collapsed[remapped]).toMatchObject({ kind: "header", source: "user", collapsed: true });
  });

  it("toggles folder collapse state immutably", () => {
    const next = toggleFolderCollapse(DEFAULT_FOLDER_COLLAPSE, "bundled");
    expect(next.bundled).toBe(true);
    expect(DEFAULT_FOLDER_COLLAPSE.bundled).toBe(false);
  });

  it("prefers a named workflow when seeding the picker index", () => {
    const nav = buildWorkflowPickerNav(catalog);
    expect(indexOfWorkflowOrFallback(nav, "delta")).toBe(
      nav.findIndex((row) => row.kind === "workflow" && row.entry.name === "delta"),
    );
    expect(nav[indexOfWorkflowOrFallback(nav, null)]?.kind).toBe("workflow");
  });

  it("sizes workflow rows by whether they have a description", () => {
    const withDesc = buildWorkflowPickerNav([entry("a", "bundled", "hello")])[1]!;
    const without = buildWorkflowPickerNav([entry("b", "bundled", "")])[1]!;
    // empty description still comes from base spec — force undefined
    const bare: WorkflowCatalogEntry = {
      ...entry("c", "bundled"),
      spec: { ...entry("c", "bundled").spec, description: undefined },
    };
    const bareRow = buildWorkflowPickerNav([bare])[1]!;
    expect(workflowPickerRowHeight(withDesc)).toBe(3);
    expect(workflowPickerRowHeight(bareRow)).toBe(2);
    expect(without.kind).toBe("workflow");
  });
});

describe("weighted visible window", () => {
  it("keeps unit-weight behavior within budget (legacy callers)", () => {
    const window = selectVisibleWindow(["a", "b", "c", "d", "e", "f"], 4, 4);
    expect(window.visible).toContain("e");
    expect(
      window.visible.length + (window.hiddenBefore > 0 ? 1 : 0) + (window.hiddenAfter > 0 ? 1 : 0),
    ).toBeLessThanOrEqual(4);
  });

  it("accounts for multi-line item heights so the frame does not overflow", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      data: `wf-${i}`,
      height: i % 2 === 0 ? 3 : 2,
    }));
    const budget = 10;
    const window = selectVisibleWindowWeighted(items, 6, budget);

    let used = (window.hiddenBefore > 0 ? 1 : 0) + (window.hiddenAfter > 0 ? 1 : 0);
    window.visible.forEach((_, offset) => {
      const absolute = window.start + offset;
      used += items[absolute]!.height;
      if (offset > 0) used += 1; // spacer
    });
    expect(used).toBeLessThanOrEqual(budget);
    expect(window.visible).toContain("wf-6");
  });

  it("still shows the selection when it alone barely fits", () => {
    const items = [
      { data: "short", height: 2 },
      { data: "tall", height: 5 },
      { data: "short-2", height: 2 },
    ];
    const window = selectVisibleWindowWeighted(items, 1, 5);
    expect(window.visible).toEqual(["tall"]);
  });
});
