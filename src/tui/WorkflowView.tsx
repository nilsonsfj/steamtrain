import { basename } from "node:path";
import { Box, Text } from "ink";
import { useMemo } from "react";
import { truncate } from "../agents/util";
import { AGENT_COLOR } from "./theme";
import { selectVisibleWindow } from "./workflow-list-window";
import { BLOCK_LABEL, formatWorkflowAgentTarget } from "./workflow-spec-ui";
import {
  type PhaseState,
  type StepState,
  type WorkflowState,
  flattenSteps,
} from "./workflow-state";

interface WorkflowViewProps {
  state: WorkflowState;
  width: number;
  height: number;
  /** Index into the flattened step list, for drill-in detail. */
  selectedIndex: number;
  elapsedMs: number;
}

type WorkflowRow =
  | { kind: "phase"; phase: PhaseState }
  | { kind: "step"; phase: PhaseState; step: StepState; flatIndex: number };

const STEP_GLYPH: Record<StepState["status"], { symbol: string; color: string }> = {
  pending: { symbol: "·", color: "gray" },
  running: { symbol: "⟳", color: "yellow" },
  done: { symbol: "✓", color: "green" },
  error: { symbol: "✗", color: "red" },
};

/**
 * The live phase → step tree. Phases stack vertically; the selected step's
 * accumulated output is shown in a detail panel below (↑/↓ to drill in).
 */
export function WorkflowView({
  state,
  width,
  height,
  selectedIndex,
  elapsedMs,
}: WorkflowViewProps) {
  const innerWidth = Math.max(20, width - 4);
  const flat = useMemo(() => flattenSteps(state), [state]);
  const clampedIndex = Math.min(selectedIndex, Math.max(0, flat.length - 1));
  const selected = flat[clampedIndex]?.step;
  const rows = useMemo<WorkflowRow[]>(() => {
    const out: WorkflowRow[] = [];
    let flatIndex = 0;
    for (const phase of state.phases) {
      out.push({ kind: "phase", phase });
      for (const step of phase.steps) {
        out.push({ kind: "step", phase, step, flatIndex });
        flatIndex += 1;
      }
    }
    return out;
  }, [state.phases]);
  const selectedRowIndex = Math.max(
    0,
    rows.findIndex((row) => row.kind === "step" && row.flatIndex === clampedIndex),
  );
  const listBudget = Math.max(1, height - (selected ? 9 : 4));
  const rowWindow = selectVisibleWindow(rows, selectedRowIndex, listBudget);

  const cost = sumCost(state);
  const elapsed = elapsedMs / 1000;
  const doneSteps = flat.filter(
    (f) => f.step.status === "done" || f.step.status === "error",
  ).length;
  const runningSteps = flat.filter((f) => f.step.status === "running").length;
  const failedSteps = flat.filter((f) => f.step.status === "error").length;
  const cachedSteps = flat.filter((f) => f.step.cached).length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={state.done ? (state.ok ? "green" : "red") : "cyan"}
      paddingX={1}
      height={height}
    >
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          workflow{state.name ? ` · ${state.name}` : ""}
        </Text>
        <Text color="gray">
          {doneSteps}/{flat.length} steps · {elapsed.toFixed(1)}s
          {runningSteps > 0 ? ` · ${runningSteps} active` : ""}
          {failedSteps > 0 ? ` · ${failedSteps} failed` : ""}
          {cachedSteps > 0 ? ` · ${cachedSteps} cached` : ""}
          {cost > 0 ? ` · $${cost.toFixed(4)}` : ""}
          {state.done ? (state.ok ? " · done" : " · failed") : " · running"}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {state.phases.length === 0 ? (
          <Text color="gray">starting workflow…</Text>
        ) : (
          <>
            {rowWindow.hiddenBefore > 0 ? (
              <Text color="gray">
                {rowWindow.hiddenBefore} earlier row{rowWindow.hiddenBefore === 1 ? "" : "s"} hidden
                ↑
              </Text>
            ) : null}
            {rowWindow.visible.map((row, offset) =>
              row.kind === "phase" ? (
                <PhaseHeader
                  key={`phase-${row.phase.phaseId}-${row.phase.iteration ?? 1}`}
                  phase={row.phase}
                />
              ) : (
                <StepRow
                  key={`step-${row.phase.phaseId}-${row.phase.iteration ?? 1}-${row.step.stepId}`}
                  step={row.step}
                  width={innerWidth}
                  selected={rowWindow.start + offset === selectedRowIndex}
                />
              ),
            )}
            {rowWindow.hiddenAfter > 0 ? (
              <Text color="gray">
                {rowWindow.hiddenAfter} later row{rowWindow.hiddenAfter === 1 ? "" : "s"} hidden ↓
              </Text>
            ) : null}
          </>
        )}
      </Box>

      {selected ? <Detail step={selected} width={innerWidth} /> : null}
    </Box>
  );
}

function PhaseHeader({ phase }: { phase: PhaseState }) {
  const done = phase.steps.filter((s) => s.status === "done" || s.status === "error").length;
  const color = phase.done ? (phase.ok ? "green" : "red") : "cyan";
  return (
    <Box>
      <Text color={color} bold>
        ─ {phase.title}
      </Text>
      {phase.iteration && phase.iteration > 1 ? (
        <Text color="gray" dimColor>
          {" "}
          · iter {phase.iteration}
        </Text>
      ) : null}
      <Text color="gray">
        {"  "}
        {done}/{phase.stepCount}
      </Text>
    </Box>
  );
}

function StepRow({
  step,
  width,
  selected,
}: {
  step: StepState;
  width: number;
  selected: boolean;
}) {
  const g = STEP_GLYPH[step.status];
  const agentColor = step.agent ? (AGENT_COLOR[step.agent] ?? "white") : "gray";
  const target = step.cwd ? ` @${basename(step.cwd)}` : "";
  const right = stepMeta(step);
  const runner =
    step.agent && step.model
      ? formatWorkflowAgentTarget({ agent: step.agent, model: step.model, effort: step.effort })
      : BLOCK_LABEL[step.blockKind];
  const indent = step.parentStepId ? 3 : 1;
  const item = step.item ? ` item ${step.item.index}: ${truncate(step.item.value, 32)}` : "";
  return (
    <Box paddingLeft={indent}>
      <Text color={selected ? "cyan" : "gray"}>{selected ? "▶ " : "  "}</Text>
      <Text color={g.color}>{g.symbol} </Text>
      <Text color="magenta">{BLOCK_LABEL[step.blockKind]} </Text>
      <Text color="white" bold={selected}>
        {step.stepId}
      </Text>
      <Text color="gray">{"  "}</Text>
      <Text color={agentColor}>{runner}</Text>
      <Text color="gray">
        {target}
        {item}
      </Text>
      {right ? <Text color="gray">{truncate(`  ${right}`, Math.max(8, width - 40))}</Text> : null}
    </Box>
  );
}

function Detail({ step, width }: { step: StepState; width: number }) {
  const body = (step.result?.output ?? step.text).trim();
  const preview = body ? truncate(body, 700) : step.activity || statusWord(step);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan">
        {step.stepId} · {step.blockKind} · {step.status}
        {step.cached ? " (cached)" : ""}
      </Text>
      {step.dependsOn && step.dependsOn.length > 0 ? (
        <Text color="gray">← inputs: {step.dependsOn.join(", ")}</Text>
      ) : null}
      {step.item ? (
        <Text color="gray">
          item {step.item.index} from {step.item.sourceStepId}: {step.item.value}
        </Text>
      ) : null}
      <Box width={width}>
        <Text color={step.status === "error" ? "red" : undefined} wrap="wrap">
          {preview}
        </Text>
      </Box>
    </Box>
  );
}

function stepMeta(step: StepState): string {
  if (step.gate) {
    const gateState = step.gate.passed ? "passed" : "blocked";
    return step.gate.target ? `${gateState} → ${step.gate.target}` : gateState;
  }
  if (step.result) {
    const attempts = step.result.attempts ?? step.attempts;
    const bits = [
      step.cached ? "cached" : `${(step.result.durationMs / 1000).toFixed(1)}s`,
      step.result.costUsd ? `$${step.result.costUsd.toFixed(4)}` : undefined,
      attempts && attempts > 1 ? `${attempts} tries` : undefined,
    ].filter(Boolean);
    return bits.join(" · ");
  }
  if (step.activity) return step.activity;
  return statusWord(step);
}

function statusWord(step: StepState): string {
  switch (step.status) {
    case "running":
      return "running…";
    case "pending":
      return "pending";
    case "done":
      return "done";
    case "error":
      return "error";
  }
}

function sumCost(state: WorkflowState): number {
  let total = 0;
  for (const phase of state.phases) {
    for (const step of phase.steps) {
      if (step.result?.costUsd) total += step.result.costUsd;
    }
  }
  return total;
}
