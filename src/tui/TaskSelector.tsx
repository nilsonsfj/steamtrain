import { Box, Text } from "ink";
import type { SteamtrainConfig } from "../config";
import { MODES, type Mode, isTaskType } from "./modes";
import { AGENT_COLOR } from "./theme";

interface TaskSelectorProps {
  config: SteamtrainConfig;
  active: Mode;
  /** Name of the currently selected workflow (shown when in workflow mode). */
  workflowName?: string;
}

/** Chips for plan/implement/review/workflow; the active one shows its target. */
export function TaskSelector({ config, active, workflowName }: TaskSelectorProps) {
  const current = isTaskType(active) ? config.tasks[active] : undefined;
  return (
    <Box paddingX={1} flexDirection="row" justifyContent="space-between">
      <Box>
        <Text color="gray">mode </Text>
        {MODES.map((mode) => {
          const isActive = mode === active;
          return (
            <Box key={mode} marginRight={1}>
              <Text
                color={isActive ? "black" : "gray"}
                backgroundColor={isActive ? "cyan" : undefined}
                bold={isActive}
              >
                {" "}
                {mode}{" "}
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
