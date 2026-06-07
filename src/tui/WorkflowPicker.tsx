import { Box, Text } from "ink";
import type { WorkflowSpec } from "../workflow";
import { blockSummary } from "./workflow-spec-ui";

interface WorkflowPickerProps {
  workflows: { name: string; spec: WorkflowSpec }[];
  selectedIndex: number;
  height: number;
}

/** The workflow launcher: pick one with ↑/↓, Enter for preview, Ctrl+R to run. */
export function WorkflowPicker({ workflows, selectedIndex, height }: WorkflowPickerProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} height={height}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          workflows
        </Text>
        <Text color="gray">↑/↓ select · / edit · Ctrl+R run</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {workflows.length === 0 ? (
          <Text color="gray">No workflows defined.</Text>
        ) : (
          workflows.map(({ name, spec }, i) => {
            const active = i === selectedIndex;
            const phaseCount = spec.phases.length;
            const stepCount = spec.phases.reduce((n, p) => n + p.steps.length, 0);
            const blocks = blockSummary(spec);
            return (
              <Box key={name} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
                <Box>
                  <Text color={active ? "cyan" : "gray"}>{active ? "▶ " : "  "}</Text>
                  <Text color={active ? "cyan" : "white"} bold={active}>
                    {name}
                  </Text>
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
          })
        )}
      </Box>
    </Box>
  );
}
