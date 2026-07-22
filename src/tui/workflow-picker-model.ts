import type { WorkflowCatalogEntry, WorkflowSourceKind } from "../workflow";
import { TOUR_WORKFLOW_NAME } from "../workflow";

/** Display order for catalog folders: most specific first. */
export const WORKFLOW_FOLDER_ORDER: readonly WorkflowSourceKind[] = [
  "project",
  "user",
  "bundled",
] as const;

export const WORKFLOW_FOLDER_TITLE: Record<WorkflowSourceKind, string> = {
  project: "project",
  user: "user",
  bundled: "bundled",
};

export type WorkflowPickerNavItem =
  | {
      kind: "header";
      source: WorkflowSourceKind;
      count: number;
      collapsed: boolean;
    }
  | {
      kind: "workflow";
      entry: WorkflowCatalogEntry;
    }
  | { kind: "create" };

export type WorkflowFolderCollapseState = Readonly<Record<WorkflowSourceKind, boolean>>;

export const DEFAULT_FOLDER_COLLAPSE: WorkflowFolderCollapseState = {
  project: false,
  user: false,
  bundled: false,
};

/** Group catalog entries by source, preserving name order within each folder. */
export function groupWorkflowEntriesBySource(
  entries: readonly WorkflowCatalogEntry[],
): Array<{ source: WorkflowSourceKind; entries: WorkflowCatalogEntry[] }> {
  const buckets: Record<WorkflowSourceKind, WorkflowCatalogEntry[]> = {
    project: [],
    user: [],
    bundled: [],
  };
  for (const entry of entries) {
    buckets[entry.source].push(entry);
  }
  return WORKFLOW_FOLDER_ORDER.filter((source) => buckets[source].length > 0).map((source) => ({
    source,
    entries: buckets[source],
  }));
}

/**
 * Build the navigable picker rows: folder headers, visible workflows, and the
 * trailing create action. Collapsed folders keep their header but hide children.
 */
export function buildWorkflowPickerNav(
  entries: readonly WorkflowCatalogEntry[],
  collapsed: WorkflowFolderCollapseState = DEFAULT_FOLDER_COLLAPSE,
  options: { pinTourFirst?: boolean } = {},
): WorkflowPickerNavItem[] {
  const groups = groupWorkflowEntriesBySource(entries).map((group) => {
    if (!options.pinTourFirst || group.source !== "bundled") return group;
    const tourIdx = group.entries.findIndex((entry) => entry.name === TOUR_WORKFLOW_NAME);
    if (tourIdx <= 0) return group;
    const pinned = [
      group.entries[tourIdx]!,
      ...group.entries.slice(0, tourIdx),
      ...group.entries.slice(tourIdx + 1),
    ];
    return { ...group, entries: pinned };
  });

  const rows: WorkflowPickerNavItem[] = [];
  for (const group of groups) {
    const isCollapsed = Boolean(collapsed[group.source]);
    rows.push({
      kind: "header",
      source: group.source,
      count: group.entries.length,
      collapsed: isCollapsed,
    });
    if (!isCollapsed) {
      for (const entry of group.entries) {
        rows.push({ kind: "workflow", entry });
      }
    }
  }
  rows.push({ kind: "create" });
  return rows;
}

/** Content height of a nav row (no leading spacer). */
export function workflowPickerRowHeight(item: WorkflowPickerNavItem): number {
  if (item.kind === "header" || item.kind === "create") return 1;
  // name + block summary (+ optional description)
  return item.entry.spec.description ? 3 : 2;
}

export function toggleFolderCollapse(
  collapsed: WorkflowFolderCollapseState,
  source: WorkflowSourceKind,
): WorkflowFolderCollapseState {
  return { ...collapsed, [source]: !collapsed[source] };
}

/**
 * After a collapse change, keep selection coherent: if the selected workflow
 * vanished into a folder, land on that folder's header; otherwise remap by
 * identity (workflow name / header source / create).
 */
export function remapPickerIndexAfterCollapse(
  prevRows: readonly WorkflowPickerNavItem[],
  nextRows: readonly WorkflowPickerNavItem[],
  prevIndex: number,
): number {
  const prev = prevRows[Math.min(Math.max(0, prevIndex), Math.max(0, prevRows.length - 1))];
  if (!prev) return Math.min(prevIndex, Math.max(0, nextRows.length - 1));

  if (prev.kind === "create") {
    return Math.max(0, nextRows.length - 1);
  }
  if (prev.kind === "header") {
    const idx = nextRows.findIndex((row) => row.kind === "header" && row.source === prev.source);
    return idx >= 0 ? idx : Math.min(prevIndex, Math.max(0, nextRows.length - 1));
  }

  const workflowIdx = nextRows.findIndex(
    (row) => row.kind === "workflow" && row.entry.name === prev.entry.name,
  );
  if (workflowIdx >= 0) return workflowIdx;

  // Workflow is now hidden inside a collapsed folder — select that header.
  const headerIdx = nextRows.findIndex(
    (row) => row.kind === "header" && row.source === prev.entry.source,
  );
  return headerIdx >= 0 ? headerIdx : Math.min(prevIndex, Math.max(0, nextRows.length - 1));
}

/** Prefer a named workflow, else the first workflow row, else create. */
export function indexOfWorkflowOrFallback(
  rows: readonly WorkflowPickerNavItem[],
  name: string | null | undefined,
): number {
  if (name) {
    const idx = rows.findIndex((row) => row.kind === "workflow" && row.entry.name === name);
    if (idx >= 0) return idx;
  }
  const firstWorkflow = rows.findIndex((row) => row.kind === "workflow");
  if (firstWorkflow >= 0) return firstWorkflow;
  return Math.max(0, rows.length - 1);
}

export function selectedWorkflowFromNav(
  rows: readonly WorkflowPickerNavItem[],
  index: number,
): WorkflowCatalogEntry | undefined {
  const row = rows[index];
  return row?.kind === "workflow" ? row.entry : undefined;
}

export function isCreateNavIndex(rows: readonly WorkflowPickerNavItem[], index: number): boolean {
  return rows[index]?.kind === "create";
}

export function isHeaderNavIndex(rows: readonly WorkflowPickerNavItem[], index: number): boolean {
  return rows[index]?.kind === "header";
}
