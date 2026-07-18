import { Box, Text } from "ink";
import type { WorkflowCatalogEntry } from "../workflow";
import { TOUR_WORKFLOW_NAME, autonomyBadge, workflowAutonomy } from "../workflow";
import { AUTONOMY_COLOR } from "./theme";
import { WORKFLOW_SOURCE_COLOR } from "./theme";
import { selectVisibleWindow } from "./workflow-list-window";
import { blockSummary } from "./workflow-spec-ui";

interface WorkflowPickerProps {
  workflows: WorkflowCatalogEntry[];
  selectedIndex: number;
  height: number;
  /** Effective drafting agent · model for /create-workflow (right-aligned in the header). */
  draftLabel?: string;
  /** Station landing: first-open hint that the tour is the door. */
  stationLanding?: boolean;
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
  stationLanding = false,
}: WorkflowPickerProps) {
  // The synthetic "create" row sits one past the last workflow.
  const createRowActive = selectedIndex === workflows.length;
  const listBudget = Math.max(1, height - (stationLanding ? 6 : 3));
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
      {stationLanding ? (
        <Box flexDirection="column">
          <Text color="white" bold>
            steamtrain
          </Text>
          <Text color="cyan">Parallel agents. One receipt. Start with the free tour.</Text>
          <Text color="green">
            → select <Text bold>tour</Text> · Enter preview · Ctrl+R ride ($0 · ~1s)
          </Text>
        </Box>
      ) : null}
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
              const isTour = name === TOUR_WORKFLOW_NAME;
              const blocks = blockSummary(spec);
              const phases = spec.phases.length;
              const steps = spec.phases.reduce((n, p) => n + p.steps.length, 0);
              // Autonomy potential: what this workflow will need from a human,
              // visible before launch. Resolves sub-workflows via the catalog.
              const autonomy = workflowAutonomy(
                spec,
                (child) => workflows.find((entry) => entry.name === child)?.spec,
              );
              const meta =
                isTour && stationLanding
                  ? "zero-cost guided ride · no agents"
                  : `${phases} phase${phases === 1 ? "" : "s"} · ${steps} step${
                      steps === 1 ? "" : "s"
                    }`;
              return (
                <Box key={name} flexDirection="column" marginTop={offset === 0 ? 0 : 1}>
                  <Box>
                    <Text color={active ? "cyan" : "gray"}>{active ? "▶ " : "  "}</Text>
                    <Text
                      color={active ? "cyan" : isTour ? "green" : "white"}
                      bold={active || isTour}
                    >
                      {name}
                    </Text>
                    {isTour && stationLanding ? (
                      <Text color="green"> ← start here</Text>
                    ) : (
                      <>
                        <Text color={WORKFLOW_SOURCE_COLOR[source]}> {source}</Text>
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
                      {isTour && stationLanding
                        ? "distributor · command cars · gate · arrival"
                        : blocks}
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
