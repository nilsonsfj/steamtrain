import { basename } from "node:path";
import { Box, Text } from "ink";
import { useMemo } from "react";
import { truncate } from "../agents/util";
import {
  type ModelUsage,
  addTokensInto,
  aggregateLeavesByModel,
  emptyTokens,
  formatTokenSummary,
  formatTokens,
  formatUsd,
  totalTokens,
} from "../workflow";
import { statusWord } from "./status-word";
import { AGENT_COLOR } from "./theme";
import { selectVisibleWindow } from "./workflow-list-window";
import { BLOCK_LABEL, formatWorkflowAgentTarget } from "./workflow-spec-ui";
import {
  type PendingApproval,
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
  // Highest iteration seen per phase id, so PhaseHeader can badge the FIRST
  // instance of a multi-iteration phase too (iter 1/N) instead of only
  // labelling iteration >= 2 — readers can then see at a glance how many passes
  // ran, not just that "some later pass existed".
  const maxIterByPhase = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of state.phases) {
      const it = p.iteration ?? 1;
      if (!m.has(p.phaseId) || it > (m.get(p.phaseId) ?? 0)) m.set(p.phaseId, it);
    }
    return m;
  }, [state.phases]);
  const foundIndex = rows.findIndex((row) => row.kind === "step" && row.flatIndex === clampedIndex);
  const selectedRowIndex = foundIndex >= 0 ? foundIndex : 0;
  const listBudget = Math.max(1, height - (selected ? 9 : 4));
  const rowWindow = selectVisibleWindow(rows, selectedRowIndex, listBudget);

  const cost = sumCost(state);
  const tokens = sumTokens(state);
  const byModel = modelBreakdown(state);
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
          {totalTokens(tokens) > 0 ? ` · ${formatTokens(totalTokens(tokens))} tok` : ""}
          {state.budget
            ? " · budget-exceeded"
            : state.done
              ? state.ok
                ? " · done"
                : " · failed"
              : " · running"}
        </Text>
      </Box>
      {state.budget ? (
        <Text color="yellow">
          ⚠{" "}
          {state.budget.scope === "step" && state.budget.stepId
            ? `step '${state.budget.stepId}'`
            : "workflow"}{" "}
          cost budget {formatUsd(state.budget.limitUsd)} reached (spent{" "}
          {formatUsd(state.budget.spentUsd)}) — resume after raising the cap
        </Text>
      ) : null}
      {byModel.length > 0 ? (
        <Text color="gray">
          {byModel
            .slice(0, 4)
            .map(
              (m) => `${m.model}: ${formatUsd(m.costUsd)}/${formatTokens(totalTokens(m.tokens))}t`,
            )
            .join("  ")}
        </Text>
      ) : null}

      {state.pendingApprovals && state.pendingApprovals.length > 0 ? (
        <ApprovalPrompt approval={state.pendingApprovals[0]!} width={innerWidth} />
      ) : null}

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
                  maxIteration={maxIterByPhase.get(row.phase.phaseId) ?? 1}
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

/** Prominent, interactive prompt for the checkpoint the run is paused on. */
function ApprovalPrompt({ approval, width }: { approval: PendingApproval; width: number }) {
  const disposition =
    approval.onReject === "fail"
      ? "fail the run"
      : approval.onReject === "stop"
        ? "stop the run"
        : "continue";
  const preview = approval.output ? truncate(approval.output.trim(), 500) : undefined;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        ⏳ approval required · {approval.stepId}
        {approval.reviewStepId ? ` (reviewing ${approval.reviewStepId})` : ""}
      </Text>
      {approval.message ? (
        <Box width={width}>
          <Text wrap="wrap">{approval.message}</Text>
        </Box>
      ) : null}
      {approval.diff && approval.diff.files.length > 0 ? (
        <Text color="gray">
          {approval.diff.files.length} file{approval.diff.files.length === 1 ? "" : "s"} · +
          {approval.diff.additions} -{approval.diff.deletions}
        </Text>
      ) : null}
      {preview ? (
        <Box width={width}>
          <Text color="gray" wrap="wrap">
            {preview}
          </Text>
        </Box>
      ) : null}
      <Text color="cyan">
        press <Text bold>a</Text> to approve · <Text bold>r</Text> to reject (rejection will{" "}
        {disposition})
      </Text>
    </Box>
  );
}

function PhaseHeader({ phase, maxIteration }: { phase: PhaseState; maxIteration: number }) {
  const done = phase.steps.filter((s) => s.status === "done" || s.status === "error").length;
  const color = phase.done ? (phase.ok ? "green" : "red") : "cyan";
  const iter = phase.iteration ?? 1;
  // Show an iteration badge whenever the phase ran more than once. The first
  // pass gets "iter 1/N" (not omitted), so the total pass count is visible on
  // the first instance instead of only becoming apparent at iteration >= 2.
  const showIter = maxIteration > 1;
  return (
    <Box>
      <Text color={color} bold>
        ─ {phase.title}
      </Text>
      {showIter ? (
        <Text color="gray" dimColor>
          {" "}
          · iter {iter}/{maxIteration}
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
      : step.blockKind === "llm" && (step.api || step.model)
        ? [step.api, step.model].filter(Boolean).join("/")
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
      <Text color={agentColor}>{truncate(runner, width - 30)}</Text>
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
  const preview = body ? truncate(body, 700) : step.activity || statusWord(step.status);
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
  if (step.result?.skipped) return "skipped";
  if (step.gate) {
    const gateState = step.gate.passed ? "passed" : "blocked";
    return step.gate.target ? `${gateState} → ${step.gate.target}` : gateState;
  }
  if (step.result) {
    const attempts = step.result.attempts ?? step.attempts;
    const tokenLine = formatTokenSummary(step.result.tokens);
    const bits = [
      step.cached ? "cached" : `${(step.result.durationMs / 1000).toFixed(1)}s`,
      step.result.costUsd ? `$${step.result.costUsd.toFixed(4)}` : undefined,
      tokenLine || undefined,
      attempts && attempts > 1 ? `${attempts} tries` : undefined,
    ].filter(Boolean);
    return bits.join(" · ");
  }
  if (step.activity) return step.activity;
  return statusWord(step.status);
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

/**
 * Sum leaf token usage across the live tree. Fan-out parents carry no tokens of
 * their own (their children are separate steps), so summing every step's result
 * tokens counts each leaf exactly once.
 */
function sumTokens(state: WorkflowState): ReturnType<typeof emptyTokens> {
  const total = emptyTokens();
  for (const { step } of flattenSteps(state)) addTokensInto(total, step.result?.tokens);
  return total;
}

/** Per-model cost/token breakdown from the live tree, biggest spender first. */
function modelBreakdown(state: WorkflowState): ModelUsage[] {
  const leaves = flattenSteps(state)
    .filter((f) => f.step.result && !f.step.result.childResults?.length)
    .map((f) => ({
      agent: f.step.agent,
      api: f.step.api,
      model: f.step.model,
      costUsd: f.step.result?.costUsd,
      tokens: f.step.result?.tokens,
    }));
  return aggregateLeavesByModel(leaves).filter((m) => m.costUsd > 0 || totalTokens(m.tokens) > 0);
}
