import { Box, Text } from "ink";
import type { WorkflowCatalogEntry, WorkflowSourceKind } from "../workflow";
import { TOUR_WORKFLOW_NAME, autonomyBadge, workflowAutonomy } from "../workflow";
import { AUTONOMY_COLOR, WORKFLOW_SOURCE_COLOR } from "./theme";
import { LIST_ITEM_SPACER, selectVisibleWindowWeighted } from "./workflow-list-window";
import {
  WORKFLOW_FOLDER_TITLE,
  type WorkflowPickerNavItem,
  workflowPickerRowHeight,
} from "./workflow-picker-model";
import { blockSummary } from "./workflow-spec-ui";

interface WorkflowPickerProps {
  workflows: WorkflowCatalogEntry[];
  /** Pre-built navigable rows from useWorkflowPicker (single source of truth). */
  nav: WorkflowPickerNavItem[];
  /** Index into `nav` (headers + workflows + create). */
  selectedIndex: number;
  height: number;
  /** Effective drafting agent · model for /create-workflow (right-aligned in the header). */
  draftLabel?: string;
  /** Station landing: first-open hint that the tour is the door. */
  stationLanding?: boolean;
}

/**
 * The workflow launcher: pick one with ↑/↓, Enter for preview, Ctrl+R to run.
 * Workflows are grouped into collapsible folders (project / user / bundled).
 * A trailing "+ Create a new workflow…" row drafts a new workflow.
 */
export function WorkflowPicker({
  workflows,
  nav,
  selectedIndex,
  height,
  draftLabel,
  stationLanding = false,
}: WorkflowPickerProps) {
  const createIndex = Math.max(0, nav.length - 1);
  const createRowActive = selectedIndex === createIndex && nav[createIndex]?.kind === "create";
  const scrollRows = nav[createIndex]?.kind === "create" ? nav.slice(0, -1) : nav;

  // height includes the round border (2). Title is 1; station hero is a double
  // bordered card (~7 content) + marginBottom; create is pinned below the window.
  const borderRows = 2;
  const titleRows = 1;
  const stationRows = stationLanding ? 8 : 0;
  const createBlock = LIST_ITEM_SPACER + 1; // leading blank line + create row
  const emptyHintRows = workflows.length === 0 ? 1 : 0;
  const listBudget = Math.max(
    1,
    height - borderRows - titleRows - stationRows - createBlock - emptyHintRows,
  );

  const windowSelected =
    scrollRows.length === 0
      ? 0
      : Math.min(
          selectedIndex >= scrollRows.length ? scrollRows.length - 1 : selectedIndex,
          scrollRows.length - 1,
        );

  const window = selectVisibleWindowWeighted(
    scrollRows.map((row) => ({ data: row, height: workflowPickerRowHeight(row) })),
    windowSelected,
    listBudget,
  );

  const resolveChildSpec = (child: string) => workflows.find((entry) => entry.name === child)?.spec;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} height={height}>
      <Box justifyContent="space-between">
        <Box>
          <Text color="cyan" bold>
            workflows
          </Text>
          {draftLabel ? (
            <Text color="gray">
              {"  "}draft: {draftLabel}
            </Text>
          ) : null}
        </Box>
        <Text color="gray">↑/↓ · ←/→ folders · PgUp/PgDn · Ctrl+N</Text>
      </Box>
      {stationLanding ? (
        <Box
          flexDirection="column"
          marginBottom={1}
          borderStyle="double"
          borderColor="cyan"
          paddingX={1}
        >
          <Text color="cyan" bold>
            steamtrain
          </Text>
          <Text color="gray">agent orchestrator on rails</Text>
          <Text color="white" bold>
            Parallel agents. One receipt.
          </Text>
          <Text color="gray">Platform 1 · free tour · no agents, no API key</Text>
          <Text color="green">
            → <Text bold>tour</Text> selected · Enter preview · Ctrl+R ride ($0)
          </Text>
        </Box>
      ) : null}
      <Box flexDirection="column" flexGrow={1}>
        {workflows.length === 0 ? (
          <Text color="gray">No workflows yet — create your first one:</Text>
        ) : (
          <>
            {window.hiddenBefore > 0 ? (
              <Text color="gray">↑ {describeHidden(scrollRows, 0, window.start)}</Text>
            ) : null}
            {window.visible.map((row, offset) => {
              const absoluteIndex = window.start + offset;
              const active = absoluteIndex === selectedIndex;
              const spacer = offset === 0 ? 0 : LIST_ITEM_SPACER;
              return (
                <Box key={rowKey(row, absoluteIndex)} flexDirection="column" marginTop={spacer}>
                  {row.kind === "header" ? (
                    <FolderHeader row={row} active={active} />
                  ) : row.kind === "workflow" ? (
                    <WorkflowEntry
                      entry={row.entry}
                      active={active}
                      stationLanding={stationLanding}
                      resolveChildSpec={resolveChildSpec}
                    />
                  ) : null}
                </Box>
              );
            })}
            {window.hiddenAfter > 0 ? (
              <Text color="gray">
                ↓{" "}
                {describeHidden(
                  scrollRows,
                  window.start + window.visible.length,
                  scrollRows.length,
                )}
              </Text>
            ) : null}
          </>
        )}
        {/* Synthetic trailing row: always pinned below the scroll window. */}
        <Box
          marginTop={workflows.length === 0 && window.visible.length === 0 ? 0 : LIST_ITEM_SPACER}
        >
          <Text color={createRowActive ? "cyan" : "gray"}>{createRowActive ? "▶ " : "  "}</Text>
          <Text color={createRowActive ? "cyan" : "green"} bold={createRowActive}>
            + Create a new workflow…
          </Text>
          <Text color="gray">{"  "}Ctrl+N</Text>
        </Box>
      </Box>
    </Box>
  );
}

function FolderHeader({
  row,
  active,
}: {
  row: Extract<WorkflowPickerNavItem, { kind: "header" }>;
  active: boolean;
}) {
  const chevron = row.collapsed ? "▸" : "▾";
  const color = active ? "cyan" : WORKFLOW_SOURCE_COLOR[row.source];
  return (
    <Box>
      <Text color={active ? "cyan" : "gray"}>{active ? "▶ " : "  "}</Text>
      <Text color={color} bold={active}>
        {chevron} {WORKFLOW_FOLDER_TITLE[row.source]}
      </Text>
      <Text color="gray">
        {"  "}
        {row.count} workflow{row.count === 1 ? "" : "s"}
        {row.collapsed ? " · folded" : ""}
        {active ? " · Enter/←/→ toggle" : ""}
      </Text>
    </Box>
  );
}

function WorkflowEntry({
  entry,
  active,
  stationLanding,
  resolveChildSpec,
}: {
  entry: WorkflowCatalogEntry;
  active: boolean;
  stationLanding: boolean;
  resolveChildSpec: (name: string) => WorkflowCatalogEntry["spec"] | undefined;
}) {
  const { name, spec } = entry;
  const isTour = name === TOUR_WORKFLOW_NAME;
  const blocks = blockSummary(spec);
  const phases = spec.phases.length;
  const steps = spec.phases.reduce((n, p) => n + p.steps.length, 0);
  const autonomy = workflowAutonomy(spec, resolveChildSpec);
  const meta =
    isTour && stationLanding
      ? "zero-cost guided ride · no agents"
      : `${phases} phase${phases === 1 ? "" : "s"} · ${steps} step${steps === 1 ? "" : "s"}`;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={active ? "cyan" : "gray"}>{active ? "▶ " : "  "}</Text>
        <Text color={active ? "cyan" : isTour ? "green" : "white"} bold={active || isTour}>
          {name}
        </Text>
        {isTour && stationLanding ? (
          <Text color="green"> ← start here</Text>
        ) : (
          <>
            <Text color={AUTONOMY_COLOR[autonomy]}> {autonomyBadge(autonomy)}</Text>
          </>
        )}
        <Text color="gray">
          {"  "}
          {meta}
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Text color="magenta" wrap="truncate-end">
          {isTour && stationLanding ? "distributor · command cars · gate · arrival" : blocks}
        </Text>
      </Box>
      {spec.description ? (
        <Box paddingLeft={2}>
          <Text color="gray" wrap="truncate-end">
            {spec.description}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function rowKey(row: WorkflowPickerNavItem, index: number): string {
  if (row.kind === "header") return `header:${row.source}`;
  if (row.kind === "workflow") return `wf:${row.entry.name}`;
  return `row:${index}`;
}

/** Compact scroll cue: "2 folders · 5 workflows" or a single count. */
function describeHidden(rows: readonly WorkflowPickerNavItem[], from: number, to: number): string {
  let headers = 0;
  let workflows = 0;
  for (let i = from; i < to; i += 1) {
    const row = rows[i];
    if (!row) continue;
    if (row.kind === "header") headers += 1;
    else if (row.kind === "workflow") workflows += 1;
  }
  const parts: string[] = [];
  if (headers > 0) parts.push(`${headers} folder${headers === 1 ? "" : "s"}`);
  if (workflows > 0) parts.push(`${workflows} workflow${workflows === 1 ? "" : "s"}`);
  if (parts.length === 0) return `${to - from} hidden`;
  return `${parts.join(" · ")} hidden`;
}

/** Exported for tests that assert folder chrome without mounting the full app. */
export function folderLabel(source: WorkflowSourceKind, count: number, collapsed: boolean): string {
  const chevron = collapsed ? "▸" : "▾";
  return `${chevron} ${WORKFLOW_FOLDER_TITLE[source]}  ${count} workflow${count === 1 ? "" : "s"}`;
}
