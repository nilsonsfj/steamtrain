import { Box, Text } from "ink";
import { useMemo } from "react";
import { truncate } from "../agents/util";
import { formatAgentTarget } from "../agents";
import type { DispatchCheck } from "../orchestrator";
import { type WorkflowSourceKind, type WorkflowSpec, isAgentBackedStep, workflowStepKind } from "../workflow";
import { AGENT_COLOR, WORKFLOW_SOURCE_COLOR } from "./theme";
import {
  BLOCK_LABEL,
  type FlatSpecStep,
  blockSummary,
  distinctAgents,
  flattenSpecSteps,
  phaseStepOffsets,
  promptForStep,
  specDetailLines,
  specStepRowMeta,
} from "./workflow-spec-ui";

export type { FlatSpecStep };
export { flattenSpecSteps };

interface WorkflowPreviewProps {
  spec: WorkflowSpec;
  source: WorkflowSourceKind;
  input: string;
  width: number;
  height: number;
  selectedIndex: number;
  dispatchCheck: DispatchCheck;
  canResume?: boolean;
  promptEditing?: boolean;
}

/**
 * Pre-run workflow visualization: full spec drill-down before dispatch.
 * Ctrl+R from the prompt runs the workflow; Enter resumes from cache; Esc backs out when idle.
 */
export function WorkflowPreview({
  spec,
  source,
  input,
  width,
  height,
  selectedIndex,
  dispatchCheck,
  canResume = false,
  promptEditing = false,
}: WorkflowPreviewProps) {
  const innerWidth = Math.max(20, width - 4);
  const flat = useMemo(() => flattenSpecSteps(spec), [spec]);
  const phaseOffsets = useMemo(() => phaseStepOffsets(spec.phases), [spec]);
  const clampedIndex = Math.min(selectedIndex, Math.max(0, flat.length - 1));
  const selected = flat[clampedIndex];
  const phaseCount = spec.phases.length;
  const stepCount = flat.length;
  const agents = useMemo(() => distinctAgents(spec), [spec]);
  const blocks = useMemo(() => blockSummary(spec), [spec]);
  const inputLabel = input.length > 0 ? truncate(input, Math.max(24, innerWidth - 10)) : "(none)";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={dispatchCheck.ok ? "cyan" : "yellow"}
      paddingX={1}
      height={height}
    >
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          workflow preview · {spec.name}{" "}
          <Text color={WORKFLOW_SOURCE_COLOR[source]}>({source})</Text>
        </Text>
        <Text color="gray">
          {promptEditing
            ? `↑/↓ history${canResume ? " · Enter resume" : ""} · Esc list`
            : "↑/↓ step · type to edit · Ctrl+R run · Esc back"}
        </Text>
      </Box>

      {spec.description ? (
        <Text color="gray" wrap="truncate-end">
          {spec.description}
        </Text>
      ) : null}

      <Box flexDirection="column" marginBottom={1}>
        <Text color="white">
          input: <Text color={input.length > 0 ? "cyan" : "gray"}>{inputLabel}</Text>
        </Text>
        <Text color="gray">
          {phaseCount} phase{phaseCount === 1 ? "" : "s"} · {stepCount} step
          {stepCount === 1 ? "" : "s"}
          {agents.length > 0 ? ` · agents: ${agents.join(", ")}` : ""}
          {blocks ? ` · ${blocks}` : ""}
        </Text>
        <Text color={dispatchCheck.ok ? "green" : "yellow"}>
          {dispatchCheck.ok ? "ready to run" : `blocked: ${dispatchCheck.reason}`}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {spec.phases.length === 0 ? (
          <Text color="gray">No phases defined.</Text>
        ) : (
          spec.phases.map((phase, phaseIndex) => (
            <Box key={phase.id} flexDirection="column">
              <Box>
                <Text color="cyan" bold>
                  ─ {phase.title}
                </Text>
                <Text color="gray">
                  {"  "}
                  {phase.id} · {phase.steps.length} step{phase.steps.length === 1 ? "" : "s"}
                </Text>
              </Box>
              {phase.steps.map((step, stepIndex) => (
                <SpecStepRow
                  key={step.id}
                  step={step}
                  selected={(phaseOffsets[phaseIndex] ?? 0) + stepIndex === clampedIndex}
                  width={innerWidth}
                />
              ))}
            </Box>
          ))
        )}
      </Box>

      {selected ? <SpecStepDetail entry={selected} width={innerWidth} /> : null}
    </Box>
  );
}

function SpecStepRow({
  step,
  selected,
  width,
}: {
  step: FlatSpecStep["step"];
  selected: boolean;
  width: number;
}) {
  const kind = workflowStepKind(step);
  const agentColor = isAgentBackedStep(step) ? (AGENT_COLOR[step.agent] ?? "white") : "gray";
  const runner = isAgentBackedStep(step)
    ? formatAgentTarget({ agent: step.agent, model: step.model, effort: step.effort })
    : BLOCK_LABEL[kind];
  const meta = specStepRowMeta(step);
  return (
    <Box paddingLeft={1}>
      <Text color={selected ? "cyan" : "gray"}>{selected ? "▶ " : "  "}</Text>
      <Text color="magenta">{BLOCK_LABEL[kind]} </Text>
      <Text color="white" bold={selected}>
        {step.id}
      </Text>
      <Text color="gray">{"  "}</Text>
      <Text color={agentColor}>{runner}</Text>
      {meta ? <Text color="gray">{truncate(`  ${meta}`, Math.max(8, width - 44))}</Text> : null}
    </Box>
  );
}

function SpecStepDetail({ entry, width }: { entry: FlatSpecStep; width: number }) {
  const { step, phase } = entry;
  const kind = workflowStepKind(step);
  const lines = specDetailLines(step);
  const prompt = promptForStep(step);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan">
        {step.id} · {kind} · phase {phase.title}
      </Text>
      {lines.map((line) => (
        <Text key={line} color="gray" wrap="truncate-end">
          {line}
        </Text>
      ))}
      {prompt ? (
        <Box width={width} flexDirection="column">
          <Text color="gray">prompt:</Text>
          <Text wrap="wrap">{truncate(prompt, 900)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
