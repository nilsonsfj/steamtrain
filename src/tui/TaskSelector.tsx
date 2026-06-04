import { Box, Text } from "ink";
import { type SteamtrainConfig, TASK_TYPES, type TaskType } from "../config";
import { AGENT_COLOR } from "./theme";

interface TaskSelectorProps {
  config: SteamtrainConfig;
  active: TaskType;
}

/** Chips for plan/implement/review; the active one shows its agent + model. */
export function TaskSelector({ config, active }: TaskSelectorProps) {
  const current = config.tasks[active];
  return (
    <Box paddingX={1} flexDirection="row" justifyContent="space-between">
      <Box>
        <Text color="gray">task </Text>
        {TASK_TYPES.map((type) => {
          const isActive = type === active;
          return (
            <Box key={type} marginRight={1}>
              <Text
                color={isActive ? "black" : "gray"}
                backgroundColor={isActive ? "cyan" : undefined}
                bold={isActive}
              >
                {" "}
                {type}{" "}
              </Text>
            </Box>
          );
        })}
        <Text color="gray">(Tab to switch)</Text>
      </Box>
      <Box>
        <Text color="gray">→ </Text>
        <Text color={AGENT_COLOR[current.agent] ?? "white"} bold>
          {current.agent}
        </Text>
        <Text color="gray"> · {current.model}</Text>
      </Box>
    </Box>
  );
}
