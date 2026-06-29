import { Box, Text } from "ink";
import { formatModelDisplay } from "../agents";
import { truncate } from "../agents/util";
import type { WorkflowSourceKind } from "../workflow";
import type { WorkspaceEntry } from "../workspace";
import { workspaceLabel } from "../workspace";
import { type Mode, isWorkspaceMode } from "./modes";
import { AGENT_COLOR, WORKFLOW_SOURCE_COLOR } from "./theme";

interface TaskSelectorProps {
  modes: readonly Mode[];
  workspaceMap: Map<string, WorkspaceEntry>;
  active: Mode;
  /** Name of the currently selected workflow (shown when in workflow mode). */
  workflowName?: string;
  workflowSource?: WorkflowSourceKind;
}

/** Mode bar: workflow plus user-configured workspace presets. */
export function TaskSelector({
  modes,
  workspaceMap,
  active,
  workflowName,
  workflowSource,
}: TaskSelectorProps) {
  const current: WorkspaceEntry | undefined = isWorkspaceMode(active)
    ? workspaceMap.get(active)
    : undefined;

  return (
    <Box paddingX={1} flexDirection="row" justifyContent="space-between">
      <Box>
        <Text color="gray">mode </Text>
        {modes.map((mode) => {
          const isActive = mode === active;
          const entry = workspaceMap.get(mode);
          const label = mode === "workflow" ? "workflow" : entry ? workspaceLabel(entry) : mode;
          return (
            <Box key={mode} marginRight={1}>
              <Text
                color={isActive ? "black" : "gray"}
                backgroundColor={isActive ? "cyan" : undefined}
                bold={isActive}
              >
                {" "}
                {label}{" "}
              </Text>
            </Box>
          );
        })}
        <Text color="gray">(Tab to switch)</Text>
      </Box>
      <Box>
        {current ? (
          <>
            <Text color="gray">→ </Text>
            <Text color={AGENT_COLOR[current.agent] ?? "white"} bold>
              {current.agent}
            </Text>
            <Text color="gray"> · {truncate(formatModelDisplay(current), 40)}</Text>
          </>
        ) : (
          <>
            <Text color="gray">→ workflow</Text>
            {workflowName ? (
              <>
                <Text color="cyan" bold>{`: ${workflowName}`}</Text>
                {workflowSource ? (
                  <Text color={WORKFLOW_SOURCE_COLOR[workflowSource]}> {workflowSource}</Text>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </Box>
    </Box>
  );
}
