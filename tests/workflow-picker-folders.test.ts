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
  const base = BUNDLED_WORKFLOWS["bug-hunt"] ?? Object.values(BUNDLED_WORKFLOWS)[0]!;
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

  it("returns only the create row for an empty catalog", () => {
    expect(groupWorkflowEntriesBySource([])).toEqual([]);
    expect(buildWorkflowPickerNav([])).toEqual([{ kind: "create" }]);
  });

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
    // Unknown names fall back to the first workflow row (not create / header).
    expect(nav[indexOfWorkflowOrFallback(nav, "ghost")]?.kind).toBe("workflow");
    expect(indexOfWorkflowOrFallback(nav, "ghost")).toBe(
      nav.findIndex((row) => row.kind === "workflow"),
    );
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

  it("pins tour first inside bundled when requested", () => {
    const entries = [entry("zebra", "bundled"), entry("tour", "bundled"), entry("alpha", "user")];
    const nav = buildWorkflowPickerNav(entries, DEFAULT_FOLDER_COLLAPSE, { pinTourFirst: true });
    const bundledHeader = nav.findIndex((row) => row.kind === "header" && row.source === "bundled");
    expect(nav[bundledHeader + 1]).toMatchObject({
      kind: "workflow",
      entry: { name: "tour" },
    });
  });

  it("keeps the same workflow identity when pinTourFirst reorders the nav", () => {
    const entries = [entry("zebra", "bundled"), entry("tour", "bundled"), entry("alpha", "user")];
    const unpinned = buildWorkflowPickerNav(entries, DEFAULT_FOLDER_COLLAPSE, {
      pinTourFirst: false,
    });
    const pinned = buildWorkflowPickerNav(entries, DEFAULT_FOLDER_COLLAPSE, { pinTourFirst: true });
    const tourUnpinned = unpinned.findIndex(
      (row) => row.kind === "workflow" && row.entry.name === "tour",
    );
    const remapped = remapPickerIndexAfterCollapse(unpinned, pinned, tourUnpinned);
    expect(pinned[remapped]).toMatchObject({
      kind: "workflow",
      entry: { name: "tour" },
    });
    expect(remapped).not.toBe(tourUnpinned);
  });

  it("exposes a workflow again after expanding its folded folder", () => {
    const collapsed = buildWorkflowPickerNav(catalog, {
      ...DEFAULT_FOLDER_COLLAPSE,
      user: true,
    });
    expect(collapsed.some((row) => row.kind === "workflow" && row.entry.name === "beta")).toBe(
      false,
    );
    const expanded = buildWorkflowPickerNav(catalog, DEFAULT_FOLDER_COLLAPSE);
    expect(indexOfWorkflowOrFallback(expanded, "beta")).toBe(
      expanded.findIndex((row) => row.kind === "workflow" && row.entry.name === "beta"),
    );
  });
});

describe("weighted visible window", () => {
  it("keeps unit-weight behavior within budget without phantom spacers", () => {
    const window = selectVisibleWindow(["a", "b", "c", "d", "e", "f"], 4, 4);
    expect(window.visible).toContain("e");
    const used =
      window.visible.length + (window.hiddenBefore > 0 ? 1 : 0) + (window.hiddenAfter > 0 ? 1 : 0);
    expect(used).toBeLessThanOrEqual(4);
    // Unit-height lists do not render blank gaps, so the window must pack
    // rows tightly (3 rows + 1 marker for budget 4 with hidden sides).
    expect(used).toBe(4);
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
