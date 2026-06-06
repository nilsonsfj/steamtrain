import { Box, Text } from "ink";
import { truncate } from "../agents/util";
import type { DispatchCheck } from "../orchestrator";
import {
  type GateCondition,
  type WorkflowPhase,
  type WorkflowSpec,
  type WorkflowStep,
  isAgentBackedStep,
  workflowStepKind,
} from "../workflow";
import { AGENT_COLOR } from "./theme";

export interface FlatSpecStep {
  phase: WorkflowPhase;
  phaseIndex: number;
  step: WorkflowStep;
  stepIndex: number;
}

interface WorkflowPreviewProps {
  spec: WorkflowSpec;
  input: string;
  width: number;
  height: number;
  selectedIndex: number;
  dispatchCheck: DispatchCheck;
}

const BLOCK_LABEL: Record<ReturnType<typeof workflowStepKind>, string> = {
  distributor: "fan-out",
  worker: "worker",
  processor: "process",
  consolidator: "merge",
  gate: "gate",
};

/** Flatten a workflow spec into a navigable step list (for ↑/↓ drill-in). */
export function flattenSpecSteps(spec: WorkflowSpec): FlatSpecStep[] {
  const flat: FlatSpecStep[] = [];
  spec.phases.forEach((phase, phaseIndex) => {
    phase.steps.forEach((step, stepIndex) => {
      flat.push({ phase, phaseIndex, step, stepIndex });
    });
  });
  return flat;
}

/**
 * Pre-run workflow visualization: full spec drill-down before dispatch.
 * Enter from the prompt runs the workflow; Esc returns to the picker.
 */
export function WorkflowPreview({
  spec,
  input,
  width,
  height,
  selectedIndex,
  dispatchCheck,
}: WorkflowPreviewProps) {
  const innerWidth = Math.max(20, width - 4);
  const flat = flattenSpecSteps(spec);
  const selected = flat[Math.min(selectedIndex, Math.max(0, flat.length - 1))];
  const phaseCount = spec.phases.length;
  const stepCount = flat.length;
  const agents = distinctAgents(spec);
  const blocks = blockSummary(spec);

  let flatIdx = -1;

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
          workflow preview · {spec.name}
        </Text>
        <Text color="gray">↑/↓ step · Enter run · Esc back</Text>
      </Box>

      {spec.description ? (
        <Text color="gray" wrap="truncate-end">
          {spec.description}
        </Text>
      ) : null}

      <Box flexDirection="column" marginBottom={1}>
        <Text color="white">
          input: <Text color="cyan">{truncate(input, Math.max(24, innerWidth - 10))}</Text>
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
        {spec.phases.map((phase) => (
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
            {phase.steps.map((step) => {
              flatIdx += 1;
              return (
                <SpecStepRow
                  key={step.id}
                  step={step}
                  selected={flatIdx === selectedIndex}
                  width={innerWidth}
                />
              );
            })}
          </Box>
        ))}
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
  step: WorkflowStep;
  selected: boolean;
  width: number;
}) {
  const kind = workflowStepKind(step);
  const agentColor = isAgentBackedStep(step) ? (AGENT_COLOR[step.agent] ?? "white") : "gray";
  const runner = isAgentBackedStep(step) ? `${step.agent}/${step.model}` : BLOCK_LABEL[kind];
  const meta = stepRowMeta(step);
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
      {promptForStep(step) ? (
        <Box width={width} flexDirection="column">
          <Text color="gray">prompt:</Text>
          <Text wrap="wrap">{truncate(promptForStep(step)!, 900)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function stepRowMeta(step: WorkflowStep): string {
  const bits: string[] = [];
  if (step.dependsOn?.length) bits.push(`deps: ${step.dependsOn.join(", ")}`);
  if ("forEach" in step && step.forEach) bits.push(`forEach: ${step.forEach}`);
  if ("cwd" in step && step.cwd) bits.push(`cwd: ${basename(step.cwd)}`);
  if (step.kind === "distributor" && step.items?.length) bits.push(`${step.items.length} items`);
  if (step.kind === "gate") bits.push(formatGateCondition(step.condition));
  return bits.join(" · ");
}

function specDetailLines(step: WorkflowStep): string[] {
  const lines: string[] = [];
  if (step.dependsOn?.length) lines.push(`dependsOn: ${step.dependsOn.join(", ")}`);
  if ("forEach" in step && step.forEach) lines.push(`forEach: ${step.forEach}`);
  if ("cwd" in step && step.cwd) lines.push(`cwd: ${step.cwd}`);
  if ("env" in step && step.env && Object.keys(step.env).length > 0) {
    lines.push(`env: ${Object.entries(step.env).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  if ("extraArgs" in step && step.extraArgs?.length) {
    lines.push(`extraArgs: ${step.extraArgs.join(" ")}`);
  }
  if (step.kind === "distributor") {
    if (step.separator) lines.push(`separator: ${JSON.stringify(step.separator)}`);
    if (step.items?.length) {
      lines.push(`items (${step.items.length}):`);
      for (const [i, item] of step.items.entries()) {
        lines.push(`  [${i}] ${truncate(item, 120)}`);
      }
    }
  }
  if (step.kind === "consolidator" && step.separator) {
    lines.push(`separator: ${JSON.stringify(step.separator)}`);
  }
  if (step.kind === "gate") {
    lines.push(`condition: ${formatGateCondition(step.condition)}`);
    if (step.target) lines.push(`target: ${step.target}`);
    if (step.onFalse) lines.push(`onFalse: ${step.onFalse}`);
  }
  return lines;
}

function promptForStep(step: WorkflowStep): string | undefined {
  if ("prompt" in step && typeof step.prompt === "string" && step.prompt.length > 0) {
    return step.prompt;
  }
  return undefined;
}

function formatGateCondition(condition: GateCondition): string {
  const parts: string[] = [];
  if (condition.step) parts.push(`step=${condition.step}`);
  if (condition.ok !== undefined) parts.push(`ok=${condition.ok}`);
  if (condition.contains !== undefined) parts.push(`contains=${JSON.stringify(condition.contains)}`);
  if (condition.matches !== undefined) parts.push(`matches=${condition.matches}`);
  if (condition.equals !== undefined) parts.push(`equals=${JSON.stringify(condition.equals)}`);
  if (condition.not) parts.push("not");
  return parts.join(" ");
}

function distinctAgents(spec: WorkflowSpec): string[] {
  const set = new Set<string>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (isAgentBackedStep(step)) set.add(step.agent);
    }
  }
  return [...set];
}

function blockSummary(spec: WorkflowSpec): string {
  const counts = new Map<string, number>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      const kind = workflowStepKind(step);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([kind, count]) => `${kind}:${count}`).join(" · ");
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
