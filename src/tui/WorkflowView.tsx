import { Box, Text } from "ink";
import { truncate } from "../agents/util";
import { AGENT_COLOR } from "./theme";
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
}

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
export function WorkflowView({ state, width, height, selectedIndex }: WorkflowViewProps) {
  const innerWidth = Math.max(20, width - 4);
  const flat = flattenSteps(state);
  const selected = flat[Math.min(selectedIndex, Math.max(0, flat.length - 1))]?.step;

  const cost = sumCost(state);
  const elapsed = state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
  const doneSteps = flat.filter(
    (f) => f.step.status === "done" || f.step.status === "error",
  ).length;

  let flatIdx = -1;

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
          {cost > 0 ? ` · $${cost.toFixed(4)}` : ""}
          {state.done ? (state.ok ? " · done" : " · failed") : " · running"}
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {state.phases.length === 0 ? (
          <Text color="gray">starting workflow…</Text>
        ) : (
          state.phases.map((phase) => (
            <Box key={phase.phaseId} flexDirection="column">
              <PhaseHeader phase={phase} />
              {phase.steps.map((step) => {
                flatIdx += 1;
                return (
                  <StepRow
                    key={step.stepId}
                    step={step}
                    width={innerWidth}
                    selected={flatIdx === selectedIndex}
                  />
                );
              })}
            </Box>
          ))
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
  const agentColor = AGENT_COLOR[step.agent] ?? "white";
  const target = step.cwd ? ` @${basename(step.cwd)}` : "";
  const right = stepMeta(step);
  return (
    <Box paddingLeft={1}>
      <Text color={selected ? "cyan" : "gray"}>{selected ? "▶ " : "  "}</Text>
      <Text color={g.color}>{g.symbol} </Text>
      <Text color="white" bold={selected}>
        {step.stepId}
      </Text>
      <Text color="gray">{"  "}</Text>
      <Text color={agentColor}>{step.agent}</Text>
      <Text color="gray">
        /{step.model}
        {target}
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
        {step.stepId} · {step.status}
        {step.cached ? " (cached)" : ""}
      </Text>
      <Box width={width}>
        <Text color={step.status === "error" ? "red" : undefined} wrap="wrap">
          {preview}
        </Text>
      </Box>
    </Box>
  );
}

function stepMeta(step: StepState): string {
  if (step.result) {
    const bits = [
      step.cached ? "cached" : `${(step.result.durationMs / 1000).toFixed(1)}s`,
      step.result.costUsd ? `$${step.result.costUsd.toFixed(4)}` : undefined,
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

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
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
