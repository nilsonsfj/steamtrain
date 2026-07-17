import { basename } from "node:path";
import { Box, Text } from "ink";
import { useMemo } from "react";
import { truncate } from "../agents/util";
import {
  type ModelUsage,
  addTokensInto,
  aggregateLeavesByModel,
  emptyTokens,
  formatElapsed,
  formatTokens,
  formatUsd,
  totalTokens,
} from "../workflow";
import { wrapOutputLines } from "./output-window";
import {
  type RunProgress,
  planViewLayout,
  progressBarSegments,
  runStatus,
  summarizeRun,
} from "./run-view-model";
import { statusWord } from "./status-word";
import { AGENT_COLOR, BLOCK_COLOR } from "./theme";
import { useSpinner } from "./useSpinner";
import { selectVisibleWindow } from "./workflow-list-window";
import { BLOCK_LABEL } from "./workflow-spec-ui";
import {
  type PendingApproval,
  type PendingHumanInput,
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
  /**
   * Current wall clock for per-step live timers; omit (0) when rendering a
   * finished record, where a ticking elapsed would be meaningless.
   */
  now?: number;
}

type WorkflowRow =
  | { kind: "phase"; phase: PhaseState }
  | { kind: "step"; phase: PhaseState; step: StepState; flatIndex: number };

const STEP_GLYPH: Record<
  Exclude<StepState["status"], "running">,
  { symbol: string; color: string }
> = {
  pending: { symbol: "·", color: "gray" },
  done: { symbol: "✓", color: "green" },
  error: { symbol: "✗", color: "red" },
};

const BAR_STYLE = {
  done: { char: "█", color: "green" },
  failed: { char: "█", color: "red" },
  running: { char: "▓", color: "yellow" },
  pending: { char: "░", color: "gray" },
} as const;

/**
 * The live phase → step tree: a status header with a segmented progress bar,
 * bounded attention cards for approvals / human input, aligned step rows, and
 * a detail panel for the selected step (↑/↓ to move, →/Enter to drill in).
 *
 * Every section renders a known number of single-height lines (long text is
 * pre-wrapped and sliced), so the component never overflows its fixed height —
 * overflow makes the whole TUI flicker.
 */
export function WorkflowView({
  state,
  width,
  height,
  selectedIndex,
  elapsedMs,
  now = 0,
}: WorkflowViewProps) {
  const innerWidth = Math.max(20, width - 4);
  const flat = useMemo(() => flattenSteps(state), [state]);
  const clampedIndex = Math.min(selectedIndex, Math.max(0, flat.length - 1));
  const selected = flat[clampedIndex];
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
  // Highest iteration seen per phase id: the latest pass renders normally, and
  // earlier passes are dimmed as superseded — the badge on every instance
  // ("iter 1/N") still shows how many passes ran.
  const maxIterByPhase = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of state.phases) {
      const it = p.iteration ?? 1;
      if (!m.has(p.phaseId) || it > (m.get(p.phaseId) ?? 0)) m.set(p.phaseId, it);
    }
    return m;
  }, [state.phases]);

  const progress = summarizeRun(flat);
  const status = runStatus(state, progress.running);
  const spinner = useSpinner(!state.done && progress.running > 0 && now > 0);
  const cost = sumCost(state);
  const tokens = totalTokens(sumTokens(state));
  const byModel = modelBreakdown(state);

  // Aligned columns for the step rows, computed from the whole tree so the
  // layout doesn't shift as the visible window moves.
  const idColWidth = useMemo(() => {
    let w = 4;
    for (const f of flat) {
      const len = f.step.stepId.length + (f.step.parentStepId ? 2 : 0);
      if (len > w) w = len;
    }
    return Math.min(w, 24);
  }, [flat]);
  const kindColWidth = useMemo(() => {
    let w = 0;
    for (const f of flat) {
      const len = BLOCK_LABEL[f.step.blockKind].length;
      if (len > w) w = len;
    }
    return Math.min(w, 12);
  }, [flat]);

  // ── Fixed-height accounting ──────────────────────────────────────────
  const showPaused = !state.done && Boolean(state.paused);
  const showBudget = Boolean(state.budget);
  const roomy = height >= 24;
  const cardWidth = Math.max(16, innerWidth - 4);
  const approval = state.pendingApprovals?.[0];
  const pendingInput = !approval ? state.pendingInputs?.[0] : undefined;
  const approvalCard = approval ? buildApprovalCard(approval, cardWidth, roomy) : undefined;
  const inputCard = pendingInput ? buildInputCard(pendingInput, cardWidth, roomy) : undefined;

  const detailContext = selected ? buildDetailContext(selected.step, innerWidth) : [];
  const desiredPreview = !selected ? 0 : height >= 28 ? 6 : height >= 22 ? 5 : height >= 16 ? 3 : 2;
  // Degradation ladder for very short terminals: an overflowing frame corrupts
  // the whole TUI, so when even the fixed sections don't fit, drop the detail
  // panel, then the model-breakdown line, then the attention card — in that
  // order — until the layout fits.
  let showModels = byModel.length > 0;
  let showDetail = Boolean(selected);
  let showCard = Boolean(approvalCard ?? inputCard);
  const plan = () =>
    planViewLayout({
      height,
      fixedLines: 2 + (showModels ? 1 : 0) + (showPaused ? 1 : 0) + (showBudget ? 1 : 0),
      cardLines: showCard ? (approvalCard?.lineCount ?? inputCard?.lineCount ?? 0) : 0,
      detailFixedLines: showDetail ? 1 + detailContext.length : 0,
      desiredPreviewLines: showDetail ? desiredPreview : 0,
    });
  let layout = plan();
  if (layout.cramped && showDetail) {
    showDetail = false;
    layout = plan();
  }
  if (layout.cramped && showModels) {
    showModels = false;
    layout = plan();
  }
  if (layout.cramped && showCard) {
    showCard = false;
    layout = plan();
  }

  const foundIndex = rows.findIndex((row) => row.kind === "step" && row.flatIndex === clampedIndex);
  const selectedRowIndex = foundIndex >= 0 ? foundIndex : 0;
  const rowWindow = selectVisibleWindow(rows, selectedRowIndex, layout.listBudget);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={status.color}
      paddingX={1}
      width={width}
      height={height}
    >
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color={status.color}>
            {state.done ? (state.ok ? "✓" : "✗") : showPaused ? "⏸" : spinner}{" "}
          </Text>
          <Text color="cyan" bold>
            workflow{state.name ? ` · ${state.name}` : ""}
          </Text>
        </Text>
        <Text wrap="truncate-end">
          <Text color="gray">{formatElapsed(elapsedMs)} · </Text>
          <Text color={status.color} bold>
            {status.word}
          </Text>
        </Text>
      </Box>
      <ProgressLine progress={progress} cost={cost} tokens={tokens} width={innerWidth} />
      {showModels ? (
        <Text color="gray" dimColor wrap="truncate-end">
          {byModel
            .slice(0, 4)
            .map(
              (m) => `${m.model}: ${formatUsd(m.costUsd)}/${formatTokens(totalTokens(m.tokens))}t`,
            )
            .join("  ")}
        </Text>
      ) : null}
      {showPaused ? (
        <Text color="yellow" wrap="truncate-end">
          ⏸ paused{state.pausedBy ? ` by ${state.pausedBy}` : ""}
          {progress.running > 0
            ? ` — ${progress.running} in-flight step${progress.running === 1 ? "" : "s"} finishing`
            : ""}{" "}
          · ↑/↓ select a pending step · e edit · p resume
        </Text>
      ) : null}
      {state.budget ? (
        <Text color="yellow" wrap="truncate-end">
          ⚠{" "}
          {state.budget.scope === "step" && state.budget.stepId
            ? `step '${state.budget.stepId}'`
            : "workflow"}{" "}
          cost budget {formatUsd(state.budget.limitUsd)} reached (spent{" "}
          {formatUsd(state.budget.spentUsd)}) — resume after raising the cap
        </Text>
      ) : null}

      {showCard && approvalCard ? (
        <AttentionCard card={approvalCard} borderColor="yellow" />
      ) : showCard && inputCard ? (
        <AttentionCard card={inputCard} borderColor="magenta" />
      ) : null}

      <Box flexDirection="column" flexGrow={1}>
        {rows.length === 0 ? (
          <Text color="gray">{spinner} starting workflow…</Text>
        ) : (
          <>
            {rowWindow.hiddenBefore > 0 ? (
              <Text color="gray" dimColor>
                {"  "}↑ {rowWindow.hiddenBefore} earlier row
                {rowWindow.hiddenBefore === 1 ? "" : "s"}
              </Text>
            ) : null}
            {rowWindow.visible.map((row, offset) =>
              row.kind === "phase" ? (
                <PhaseHeader
                  key={`phase-${row.phase.phaseId}-${row.phase.iteration ?? 1}`}
                  phase={row.phase}
                  maxIteration={maxIterByPhase.get(row.phase.phaseId) ?? 1}
                  width={innerWidth}
                  spinner={spinner}
                />
              ) : (
                <StepRow
                  key={`step-${row.phase.phaseId}-${row.phase.iteration ?? 1}-${row.step.stepId}`}
                  step={row.step}
                  idColWidth={idColWidth}
                  kindColWidth={kindColWidth}
                  selected={rowWindow.start + offset === selectedRowIndex}
                  superseded={
                    (row.phase.iteration ?? 1) < (maxIterByPhase.get(row.phase.phaseId) ?? 1)
                  }
                  now={now}
                  spinner={spinner}
                />
              ),
            )}
            {rowWindow.hiddenAfter > 0 ? (
              <Text color="gray" dimColor>
                {"  "}↓ {rowWindow.hiddenAfter} later row{rowWindow.hiddenAfter === 1 ? "" : "s"}
              </Text>
            ) : null}
          </>
        )}
      </Box>

      {showDetail && selected ? (
        <DetailPanel
          step={selected.step}
          context={detailContext}
          previewLines={layout.previewLines}
          width={innerWidth}
          now={now}
        />
      ) : null}
    </Box>
  );
}

/** Segmented progress bar + step tallies + spend, on one line. */
function ProgressLine({
  progress,
  cost,
  tokens,
  width,
}: {
  progress: RunProgress;
  cost: number;
  tokens: number;
  width: number;
}) {
  const barWidth = Math.max(10, Math.min(24, Math.floor(width / 4)));
  const segments = progressBarSegments(progress, barWidth);
  const doneSteps = progress.doneOk + progress.failed;
  return (
    <Text wrap="truncate-end">
      {segments.map((segment, i) => {
        const style = BAR_STYLE[segment.kind];
        return (
          <Text
            key={`${segment.kind}-${i}`}
            color={style.color}
            dimColor={segment.kind === "pending"}
          >
            {style.char.repeat(segment.cells)}
          </Text>
        );
      })}
      <Text color="gray">
        {" "}
        {doneSteps}/{progress.total} steps
      </Text>
      {progress.running > 0 ? <Text color="yellow"> · {progress.running} running</Text> : null}
      {progress.failed > 0 ? <Text color="red"> · {progress.failed} failed</Text> : null}
      {progress.cached > 0 ? (
        <Text color="gray" dimColor>
          {" "}
          · {progress.cached} cached
        </Text>
      ) : null}
      {cost > 0 ? <Text color="gray"> · {formatUsd(cost)}</Text> : null}
      {tokens > 0 ? <Text color="gray"> · {formatTokens(tokens)} tok</Text> : null}
    </Text>
  );
}

/** A pre-measured attention card (approval checkpoint / human-input request). */
interface AttentionCardModel {
  title: string;
  titleGlyph: string;
  color: string;
  /** Bounded, pre-wrapped body lines (each renders as exactly one row). */
  body: { text: string; color?: string; dim?: boolean }[];
  hint: { pre: string; key1: string; mid: string; key2?: string; post: string };
  /**
   * Total rows including the card's own border. MUST equal exactly what
   * `AttentionCard` renders — border (2) + title (1) + body + hint (1) — the
   * layout budget trusts this number, and drift overflows the frame.
   */
  lineCount: number;
}

function buildApprovalCard(
  approval: PendingApproval,
  width: number,
  roomy: boolean,
): AttentionCardModel {
  const body: AttentionCardModel["body"] = [];
  if (approval.message) {
    for (const line of wrapOutputLines(approval.message.trim(), width).slice(0, roomy ? 2 : 1)) {
      body.push({ text: line });
    }
  }
  if (approval.diff && approval.diff.files.length > 0) {
    body.push({
      text: `${approval.diff.files.length} file${approval.diff.files.length === 1 ? "" : "s"} · +${approval.diff.additions} -${approval.diff.deletions}`,
      color: "gray",
    });
  }
  if (roomy && approval.output) {
    for (const line of wrapOutputLines(approval.output.trim(), width).slice(-3)) {
      body.push({ text: line, color: "gray", dim: true });
    }
  }
  const disposition =
    approval.onReject === "fail"
      ? "fail the run"
      : approval.onReject === "stop"
        ? "stop the run"
        : "continue";
  return {
    title: `approval required · ${approval.stepId}${
      approval.reviewStepId ? ` (reviewing ${approval.reviewStepId})` : ""
    }`,
    titleGlyph: "⏳",
    color: "yellow",
    body,
    hint: {
      pre: "press ",
      key1: "a",
      mid: " to approve · ",
      key2: "r",
      post: ` to reject (rejection will ${disposition})`,
    },
    lineCount: 2 + 1 + body.length + 1,
  };
}

function buildInputCard(
  pending: PendingHumanInput,
  width: number,
  roomy: boolean,
): AttentionCardModel {
  const body: AttentionCardModel["body"] = [];
  if (pending.retryError) {
    body.push({ text: `previous answer rejected: ${pending.retryError}`, color: "red" });
  }
  for (const line of wrapOutputLines(pending.prompt.trim(), width).slice(0, roomy ? 3 : 2)) {
    body.push({ text: line });
  }
  if (pending.choices && pending.choices.length > 0) {
    body.push({
      text: pending.choices.map((c, i) => `${i + 1}) ${c}`).join("  "),
      color: "gray",
    });
  }
  return {
    title: `${pending.origin === "agent-question" ? "agent question" : "input needed"} · ${
      pending.stepId
    }${pending.attempt > 1 ? ` (attempt ${pending.attempt})` : ""}`,
    titleGlyph: "✎",
    color: "magenta",
    body,
    hint: { pre: "press ", key1: "a", mid: " to answer", post: "" },
    lineCount: 2 + 1 + body.length + 1,
  };
}

function AttentionCard({ card, borderColor }: { card: AttentionCardModel; borderColor: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Text color={card.color} bold wrap="truncate-end">
        {card.titleGlyph} {card.title}
      </Text>
      {card.body.map((line, index) => (
        <Text
          key={`${line.text}-${index}`}
          color={line.color}
          dimColor={line.dim}
          wrap="truncate-end"
        >
          {line.text}
        </Text>
      ))}
      <Text color="cyan" wrap="truncate-end">
        {card.hint.pre}
        <Text bold>{card.hint.key1}</Text>
        {card.hint.mid}
        {card.hint.key2 ? <Text bold>{card.hint.key2}</Text> : null}
        {card.hint.post}
      </Text>
    </Box>
  );
}

function PhaseHeader({
  phase,
  maxIteration,
  width,
  spinner,
}: {
  phase: PhaseState;
  maxIteration: number;
  width: number;
  spinner: string;
}) {
  const done = phase.steps.filter((s) => s.status === "done" || s.status === "error").length;
  const running = phase.steps.some((s) => s.status === "running");
  const superseded = (phase.iteration ?? 1) < maxIteration;
  const color = superseded
    ? "gray"
    : phase.done
      ? phase.ok
        ? "green"
        : "red"
      : running
        ? "cyan"
        : "gray";
  const glyph = phase.done ? (phase.ok ? "✓" : "✗") : running ? spinner : "·";
  const iter = phase.iteration ?? 1;
  const iterBadge = maxIteration > 1 ? ` · iter ${iter}/${maxIteration}` : "";
  const supersededBadge = superseded ? " · superseded" : "";
  const counts = ` ${done}/${phase.stepCount} ${glyph} `;
  // Fill the rest of the row with a dim rule so phases read as sections. Every
  // glyph used here (braille spinner, ✓, ✗, ·) measures one column in
  // string-width — Ink's own measure — so the fill math is exact; if a terminal
  // ever rendered one wide, the outer truncate-end clips the surplus without
  // costing an extra line.
  const printed =
    2 + phase.title.length + iterBadge.length + supersededBadge.length + 2 + counts.length;
  const fill = Math.max(0, width - printed);
  return (
    <Text wrap="truncate-end">
      <Text color="gray" dimColor>
        {"─ "}
      </Text>
      <Text color={color} bold={!superseded} dimColor={superseded}>
        {phase.title}
      </Text>
      <Text color="gray" dimColor>
        {iterBadge}
        {supersededBadge}
        {" ─"}
      </Text>
      <Text color={color}>{counts}</Text>
      <Text color="gray" dimColor>
        {"─".repeat(fill)}
      </Text>
    </Text>
  );
}

function StepRow({
  step,
  idColWidth,
  kindColWidth,
  selected,
  superseded,
  now,
  spinner,
}: {
  step: StepState;
  idColWidth: number;
  kindColWidth: number;
  selected: boolean;
  superseded: boolean;
  now: number;
  spinner: string;
}) {
  const glyph =
    step.status === "running" ? { symbol: spinner, color: "yellow" } : STEP_GLYPH[step.status];
  const agentColor = step.agent ? (AGENT_COLOR[step.agent] ?? "white") : "gray";
  const kindLabel = BLOCK_LABEL[step.blockKind];
  // The compact `agent/model-id · effort` form (matching the web cards) — the
  // drill-in shows the verbose display-name variant; rows need the width for
  // timing and activity.
  const runner =
    step.agent && step.model
      ? `${step.agent}/${step.model}${step.effort ? ` · ${step.effort}` : ""}`
      : step.blockKind === "llm" && (step.api || step.model)
        ? [step.api, step.model].filter(Boolean).join("/")
        : "";
  // Truncate to the column cap so an over-long id can't push its own row's
  // columns out of alignment with the rest of the tree.
  const id = truncate(`${step.parentStepId ? "↳ " : ""}${step.stepId}`, idColWidth);
  const target = step.worktree
    ? ` ⎇ ${basename(step.worktree.cwd)}`
    : step.cwd
      ? ` @${basename(step.cwd)}`
      : "";
  const item = step.item ? ` item ${step.item.index}: ${truncate(step.item.value, 24)}` : "";
  const meta = stepMeta(step, now);
  return (
    <Text wrap="truncate-end">
      <Text color="cyan">{selected ? " ❯ " : "   "}</Text>
      <Text color={glyph.color} dimColor={superseded}>
        {glyph.symbol}{" "}
      </Text>
      <Text color="white" bold={selected} dimColor={superseded}>
        {id.padEnd(idColWidth)}{" "}
      </Text>
      <Text color={BLOCK_COLOR[step.blockKind]} dimColor={superseded}>
        {kindLabel.padEnd(kindColWidth)}
      </Text>
      {runner ? (
        <Text color={agentColor} dimColor={superseded}>
          {"  "}
          {runner}
        </Text>
      ) : null}
      <Text color="gray" dimColor={superseded}>
        {target}
        {item}
      </Text>
      {meta ? (
        <Text color="gray" dimColor={superseded}>
          {"  "}
          {meta}
        </Text>
      ) : null}
    </Text>
  );
}

/** One line each: worktree/cwd, data flow (inputs/item), error. */
function buildDetailContext(step: StepState, width: number): { text: string; color: string }[] {
  const lines: { text: string; color: string }[] = [];
  if (step.worktree) {
    lines.push({ text: `⎇ ${step.worktree.branch} · ${step.worktree.cwd}`, color: "yellow" });
  } else if (step.cwd) {
    lines.push({ text: `@ ${step.cwd}`, color: "gray" });
  }
  const flow: string[] = [];
  if (step.dependsOn && step.dependsOn.length > 0)
    flow.push(`inputs: ${step.dependsOn.join(", ")}`);
  if (step.item) {
    flow.push(
      `item ${step.item.index} from ${step.item.sourceStepId}: ${truncate(step.item.value, Math.max(16, width - 40))}`,
    );
  }
  if (flow.length > 0) lines.push({ text: `← ${flow.join(" · ")}`, color: "gray" });
  if (step.status === "error" && step.result?.error) {
    lines.push({ text: `✗ ${step.result.error}`, color: "red" });
  }
  return lines;
}

/**
 * Bottom detail panel for the selected step: a rule header with identity +
 * timing + spend, bounded context lines, and the newest `previewLines` of the
 * step's output. Full output lives in the drill-in (→ / Enter).
 */
function DetailPanel({
  step,
  context,
  previewLines,
  width,
  now,
}: {
  step: StepState;
  context: { text: string; color: string }[];
  previewLines: number;
  width: number;
  now: number;
}) {
  const body = (step.result?.output ?? step.text).trim();
  const wrapped = useMemo(() => wrapOutputLines(body, width), [body, width]);
  const visible = previewLines > 0 ? wrapped.slice(-previewLines) : [];
  const liveElapsed =
    step.status === "running" && step.startedAt && now > 0
      ? formatElapsed(now - step.startedAt)
      : undefined;
  const statusColor =
    step.status === "done"
      ? "green"
      : step.status === "error"
        ? "red"
        : step.status === "running"
          ? "yellow"
          : "gray";
  // No glyphs here: the trailing rule fill assumes every char is one column
  // wide, and symbols like ⏱ render double-width in many terminals.
  const bits = [
    statusWord(step.status),
    step.cached ? "cached" : undefined,
    liveElapsed,
    step.result && !step.cached ? formatElapsed(step.result.durationMs) : undefined,
    step.result?.costUsd ? formatUsd(step.result.costUsd) : undefined,
    wrapped.length > previewLines && previewLines > 0 ? `${wrapped.length} lines` : undefined,
  ].filter((bit): bit is string => Boolean(bit));
  const label = ` ${step.stepId} · ${BLOCK_LABEL[step.blockKind]} · ${bits.join(" · ")} `;
  const fill = Math.max(0, width - label.length - 2);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text color="gray" dimColor>
          {"──"}
        </Text>
        <Text color="cyan">{` ${step.stepId} `}</Text>
        <Text color="gray">{`· ${BLOCK_LABEL[step.blockKind]} · `}</Text>
        <Text color={statusColor}>{bits.join(" · ")}</Text>
        <Text color="gray" dimColor>
          {" "}
          {"─".repeat(Math.max(0, fill))}
        </Text>
      </Text>
      {context.map((line, index) => (
        <Text key={`${line.text}-${index}`} color={line.color} wrap="truncate-end">
          {line.text}
        </Text>
      ))}
      {previewLines > 0 ? (
        visible.length > 0 ? (
          visible.map((line, index) => (
            <Text
              key={`${index}-${line.slice(0, 16)}`}
              color={step.status === "error" ? "red" : undefined}
              wrap="truncate-end"
            >
              {line.length > 0 ? line : " "}
            </Text>
          ))
        ) : (
          <Text color="gray" dimColor wrap="truncate-end">
            {step.activity || statusWord(step.status)}
          </Text>
        )
      ) : null}
    </Box>
  );
}

function stepMeta(step: StepState, now: number): string {
  if (step.result?.skipped) return "skipped";
  if (step.gate) {
    const gateState = step.gate.passed ? "passed" : "blocked";
    return step.gate.target ? `${gateState} → ${step.gate.target}` : gateState;
  }
  if (step.result) {
    const attempts = step.result.attempts ?? step.attempts;
    const total = totalTokens(step.result.tokens);
    const bits = [
      step.edited ? "✎ edited" : undefined,
      step.cached ? "cached" : formatElapsed(step.result.durationMs),
      step.result.costUsd ? formatUsd(step.result.costUsd) : undefined,
      total > 0 ? `${formatTokens(total)}t` : undefined,
      attempts && attempts > 1 ? `${attempts} tries` : undefined,
    ].filter(Boolean);
    return bits.join(" · ");
  }
  if (step.status === "pending" && step.edited) return "✎ edited · pending";
  if (step.status === "running") {
    // A live ticking clock per running step; the latest tool line rides along.
    const elapsed =
      step.startedAt && now > 0 ? `⏱ ${formatElapsed(now - step.startedAt)}` : undefined;
    const bits = [elapsed, step.activity].filter(Boolean);
    if (bits.length > 0) return bits.join(" · ");
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
