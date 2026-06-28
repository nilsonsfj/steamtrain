import { Box, Text } from "ink";
import type { WorkflowCatalogEntry } from "../workflow";
import { WORKFLOW_SOURCE_COLOR } from "./theme";
import { selectVisibleWindow } from "./workflow-list-window";
import { blockSummary } from "./workflow-spec-ui";

interface WorkflowPickerProps {
  workflows: WorkflowCatalogEntry[];
  selectedIndex: number;
  height: number;
  /** Effective drafting agent · model for /createworkflow (right-aligned in the header). */
  draftLabel?: string;
}

/**
 * The workflow launcher: pick one with ↑/↓, Enter for preview, Ctrl+R to run.
 * A trailing "+ Create a new workflow…" row (selectable, or via Ctrl+N) drafts a
 * new workflow; it is the only row when none exist yet.
 */
export function WorkflowPicker({
  workflows,
  selectedIndex,
  height,
  draftLabel,
}: WorkflowPickerProps) {
  // The synthetic "create" row sits one past the last workflow.
  const createRowActive = selectedIndex === workflows.length;
  const listBudget = Math.max(1, height - 3);
  const window = selectVisibleWindow(workflows, selectedIndex, listBudget);
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
        <Text color="gray">↑/↓ select · Ctrl+N new · Ctrl+R run</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {workflows.length === 0 ? (
          <Text color="gray">No workflows yet — create your first one:</Text>
        ) : (
          <>
            {window.hiddenBefore > 0 ? (
              <Text color="gray">
                {window.hiddenBefore} earlier workflow{window.hiddenBefore === 1 ? "" : "s"} hidden
                ↑
              </Text>
            ) : null}
            {window.visible.map(({ name, spec, source }, offset) => {
              const i = window.start + offset;
              const active = i === selectedIndex;
              const phaseCount = spec.phases.length;
              const stepCount = spec.phases.reduce((n, p) => n + p.steps.length, 0);
              const blocks = blockSummary(spec);
              return (
                <Box key={name} flexDirection="column" marginTop={offset === 0 ? 0 : 1}>
                  <Box>
                    <Text color={active ? "cyan" : "gray"}>{active ? "▶ " : "  "}</Text>
                    <Text color={active ? "cyan" : "white"} bold={active}>
                      {name}
                    </Text>
                    <Text color={WORKFLOW_SOURCE_COLOR[source]}> {source}</Text>
                    <Text color="gray">
                      {"  "}
                      {phaseCount} phase{phaseCount === 1 ? "" : "s"} · {stepCount} step
                      {stepCount === 1 ? "" : "s"}
                    </Text>
                  </Box>
                  <Box paddingLeft={2}>
                    <Text color="magenta">{blocks}</Text>
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
            })}
            {window.hiddenAfter > 0 ? (
              <Text color="gray">
                {window.hiddenAfter} later workflow{window.hiddenAfter === 1 ? "" : "s"} hidden ↓
              </Text>
            ) : null}
          </>
        )}
        {/* Synthetic trailing row: the always-present "create" action. Its index
            is one past the last workflow, so it is selectable with ↑/↓. */}
        <Box marginTop={workflows.length === 0 ? 0 : 1}>
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
