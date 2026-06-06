import { Box, Text } from "ink";
import type { WorkspaceConfig, WorkspaceEntry } from "../workspace";
import { workspaceById, workspaceLabel } from "../workspace";
import { type Mode, buildModes, isWorkspaceMode } from "./modes";
import { AGENT_COLOR } from "./theme";

interface TaskSelectorProps {
  workspaces: WorkspaceConfig;
  active: Mode;
  /** Name of the currently selected workflow (shown when in workflow mode). */
  workflowName?: string;
}

/** Mode bar: workflow plus user-configured workspace presets. */
export function TaskSelector({ workspaces, active, workflowName }: TaskSelectorProps) {
  const modes = buildModes(workspaces);
  const workspaceMap = workspaceById(workspaces);
  const current: WorkspaceEntry | undefined = isWorkspaceMode(active)
    ? workspaceMap.get(active)
    : undefined;

  return (
    <Box paddingX={1} flexDirection="row" justifyContent="space-between">
      <Box>
        <Text color="gray">mode </Text>
        {modes.map((mode) => {
          const isActive = mode === active;
          const label = mode === "workflow" ? "workflow" : workspaceLabel(workspaceMap.get(mode)!);
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
            <Text color="gray"> · {current.model}</Text>
          </>
        ) : (
          <>
            <Text color="gray">→ workflow</Text>
            {workflowName ? <Text color="cyan" bold>{`: ${workflowName}`}</Text> : null}
          </>
        )}
      </Box>
    </Box>
  );
}
