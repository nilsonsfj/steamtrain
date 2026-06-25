import { Box, Text } from "ink";
import type { WorkflowCatalogEntry } from "../workflow";
import { WORKFLOW_SOURCE_COLOR } from "./theme";
import { blockSummary } from "./workflow-spec-ui";

interface WorkflowPickerProps {
  workflows: WorkflowCatalogEntry[];
  selectedIndex: number;
  height: number;
  /** Effective drafting agent · model for /createworkflow (right-aligned in the header). */
  draftLabel?: string;
}

/** The workflow launcher: pick one with ↑/↓, Enter for preview, Ctrl+R to run. */
export function WorkflowPicker({
  workflows,
  selectedIndex,
  height,
  draftLabel,
}: WorkflowPickerProps) {
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
        <Text color="gray">↑/↓ select · type to edit · Ctrl+R run</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {workflows.length === 0 ? (
          <Text color="gray">No workflows defined.</Text>
        ) : (
          workflows.map(({ name, spec, source }, i) => {
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
          })
        )}
      </Box>
    </Box>
  );
}
