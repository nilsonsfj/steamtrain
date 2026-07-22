import { basename } from "node:path";
import { Box, Text } from "ink";
import { useMemo } from "react";
import stringWidth from "string-width";
import { truncate } from "../agents/util";
import {
  type ModelUsage,
  type NarrationLine,
  addTokensInto,
  aggregateLeavesByModel,
  buildArrivalReport,
  emptyTokens,
  formatElapsed,
  formatTokens,
  formatUsd,
  totalTokens,
} from "../workflow";
import { ArrivalReportView } from "./ArrivalReport";
import { wrapOutputLines } from "./output-window";
import {
  MAX_DETAIL_CONTEXT_LINES,
  type RunProgress,
  planViewLayout,
  preferredPreviewLines,
  progressBarSegments,
  runStatus,
  stepWaitKind,
  summarizeRun,
} from "./run-view-model";
import { statusWord } from "./status-word";
import { AGENT_COLOR, BLOCK_COLOR } from "./theme";
import { useSpinner } from "./useSpinner";
import { truncateToWidth } from "./util";
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
import {
  type WorkflowTreeRow,
  buildWorkflowTreeRows,
  findTreeRowIndex,
} from "./workflow-tree-rows";

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
  /** Live conductor narration lines (newest last). */
  narration?: NarrationLine[];
  /** Prefer the Arrival Report surface when the run is done. */
  showArrival?: boolean;
  /** True when this run needed no agent CLI and no LLM API key. */
  credentialFree?: boolean;
}

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
  waiting: { char: "▒", color: "yellow" },
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
  narration = [],
  showArrival = true,
  credentialFree = false,
}: WorkflowViewProps) {
  const innerWidth = Math.max(20, width - 4);
  const flat = useMemo(() => flattenSteps(state), [state]);
  const arrival = useMemo(
    () => (state.done ? buildArrivalReport(state, { elapsedMs, credentialFree }) : null),
    [state, elapsedMs, credentialFree],
  );
  const preferArrival = Boolean(arrival && showArrival);
  const clampedIndex = Math.min(selectedIndex, Math.max(0, flat.length - 1));
  const selected = flat[clampedIndex];
  // Collapse long pending fan-out runs so a 30-way distributor cannot monopolize
  // the viewport; the selected step always stays expanded for ↑/↓ navigation.
  const rows = useMemo<WorkflowTreeRow[]>(
    () => buildWorkflowTreeRows(state.phases, clampedIndex),
    [state.phases, clampedIndex],
  );
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

  // Fixed-height accounting ──────────────────────────────────────────
  const showPaused = !state.done && Boolean(state.paused);
  const showBudget = Boolean(state.budget);
  const roomy = height >= 24;
  let narrationCount =
    !state.done && narration.length > 0 && roomy ? Math.min(3, narration.length) : 0;
  const cardWidth = Math.max(16, innerWidth - 4);
  const approval = state.pendingApprovals?.[0];
  const pendingInput = !approval ? state.pendingInputs?.[0] : undefined;
  const approvalCard = approval ? buildApprovalCard(approval, cardWidth, roomy) : undefined;
  const inputCard = pendingInput ? buildInputCard(pendingInput, cardWidth, roomy) : undefined;

  // Cap context so follow hops between sparse and rich steps cannot change the
  // detail fixed-line count (each ±1 steals a tree row and flickers Ink).
  const detailContext = selected
    ? buildDetailContext(selected.step, innerWidth).slice(0, MAX_DETAIL_CONTEXT_LINES)
    : [];
  // Keep the preview demand stable across auto-follow hops. Shrinking it to the
  // selected step's current output length used to give the tree ±3–5 rows every
  // time follow jumped from a streaming step to a fresh empty one — Ink then
  // full-redraws the frame (looks like flicker that intensifies as steps finish).
  // Empty/short output just under-fills the pinned detail pane.
  const desiredPreview = preferredPreviewLines(height, Boolean(selected));
  // Degradation ladder for very short terminals: an overflowing frame corrupts
  // the whole TUI. Drop the detail panel, then model breakdown, compact paired
  // notices, and finally replace the full attention card with a one-line action
  // hint. If all mandatory controls consume the six-row minimum, the tree is
  // the final section to yield.
  let showModels = byModel.length > 0;
  let showDetail = Boolean(selected);
  let showCard = Boolean(approvalCard ?? inputCard);
  let showCompactAttention = false;
  let combineNotices = false;
  let showTree = true;
  const noticeLines = () =>
    combineNotices && showPaused && showBudget ? 1 : (showPaused ? 1 : 0) + (showBudget ? 1 : 0);
  // Always reserve the max context slots while the detail panel is up so a
  // worktree/item line appearing mid-step cannot rebudget the tree.
  const detailFixedBudget = 1 + MAX_DETAIL_CONTEXT_LINES;
  const plan = () =>
    planViewLayout({
      height,
      fixedLines:
        2 + narrationCount + (showModels ? 1 : 0) + noticeLines() + (showCompactAttention ? 1 : 0),
      minimumListLines: showTree ? 1 : 0,
      cardLines: showCard ? (approvalCard?.lineCount ?? inputCard?.lineCount ?? 0) : 0,
      detailFixedLines: showDetail ? detailFixedBudget : 0,
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
  if (layout.cramped && showPaused && showBudget) {
    combineNotices = true;
    layout = plan();
  }
  if (layout.cramped && showCard) {
    showCard = false;
    showCompactAttention = true;
    layout = plan();
  }
  if (layout.cramped && narrationCount > 0) {
    narrationCount = 0;
    layout = plan();
  }
  if (layout.cramped && showTree) {
    showTree = false;
    layout = plan();
  }

  const selectedRowIndex = Math.max(0, findTreeRowIndex(rows, clampedIndex));
  const rowWindow = selectVisibleWindow(rows, selectedRowIndex, layout.listBudget);
  const detailHeight = showDetail ? detailFixedBudget + layout.previewLines : 0;

  if (preferArrival && arrival) {
    return (
      <ArrivalReportView report={arrival} width={width} height={height} workflowName={state.name} />
    );
  }

  const narrationVisible = narrationCount > 0 ? narration.slice(-narrationCount) : [];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={status.color}
      paddingX={1}
      width={width}
      height={height}
      overflow="hidden"
    >
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color={status.color}>
            {state.done
              ? state.ok
                ? "✓"
                : "✗"
              : showPaused
                ? "="
                : progress.waiting > 0 && progress.running === 0
                  ? "?"
                  : spinner}{" "}
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
      {narrationVisible.map((line) => (
        <Text key={line.id} color="gray" wrap="truncate-end">
          <Text color="cyan">▸</Text> {line.text}
        </Text>
      ))}
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
      {combineNotices && showPaused && state.budget ? (
        <Text color="yellow" wrap="truncate-end">
          paused · {state.budget.scope === "step" ? `step '${state.budget.stepId}'` : "workflow"}{" "}
          budget {formatUsd(state.budget.limitUsd)} reached · raise cap, then p resume
        </Text>
      ) : (
        <>
          {showPaused ? (
            <Text color="yellow" wrap="truncate-end">
              paused{state.pausedBy ? ` by ${state.pausedBy}` : ""}
              {progress.running > 0
                ? ` — ${progress.running} in-flight step${progress.running === 1 ? "" : "s"} finishing`
                : ""}{" "}
              · ↑/↓ select a pending step · e edit · p resume
            </Text>
          ) : null}
          {state.budget ? (
            <Text color="yellow" wrap="truncate-end">
              {state.budget.scope === "step" && state.budget.stepId
                ? `step '${state.budget.stepId}'`
                : "workflow"}{" "}
              cost budget {formatUsd(state.budget.limitUsd)} reached (spent{" "}
              {formatUsd(state.budget.spentUsd)}) — resume after raising the cap
            </Text>
          ) : null}
        </>
      )}

      {showCompactAttention ? (
        <Text color={approvalCard ? "yellow" : "magenta"} wrap="truncate-end">
          {approvalCard
            ? `a approve · r reject · ${approvalCard.title}`
            : `a answer · ✎ ${inputCard?.title ?? "input needed"}`}
          {(state.pendingApprovals?.length ?? 0) + (state.pendingInputs?.length ?? 0) > 1
            ? ` · +${
                (state.pendingApprovals?.length ?? 0) + (state.pendingInputs?.length ?? 0) - 1
              } waiting`
            : ""}
        </Text>
      ) : null}

      {showCard && approvalCard ? (
        <AttentionCard card={approvalCard} borderColor="yellow" width={innerWidth} />
      ) : showCard && inputCard ? (
        <AttentionCard card={inputCard} borderColor="magenta" width={innerWidth} />
      ) : null}

      {showTree ? (
        <Box
          flexDirection="column"
          width={innerWidth}
          height={layout.listBudget}
          flexShrink={0}
          overflow="hidden"
        >
          {rows.length === 0 ? (
            <Text color="gray">{spinner} starting workflow…</Text>
          ) : (
            <>
              {rowWindow.hiddenBefore > 0 ? (
                <Text color="gray" dimColor wrap="truncate-end">
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
                ) : row.kind === "collapsed" ? (
                  <CollapsedFanoutRow
                    key={`collapsed-${row.phase.phaseId}-${row.phase.iteration ?? 1}-${row.parentStepId}-${row.fromFlatIndex}`}
                    row={row}
                    idColWidth={idColWidth}
                    kindColWidth={kindColWidth}
                    width={innerWidth}
                  />
                ) : (
                  <StepRow
                    key={`step-${row.phase.phaseId}-${row.phase.iteration ?? 1}-${row.step.stepId}`}
                    step={row.step}
                    idColWidth={idColWidth}
                    kindColWidth={kindColWidth}
                    width={innerWidth}
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
                <Text color="gray" dimColor wrap="truncate-end">
                  {"  "}↓ {rowWindow.hiddenAfter} later row
                  {rowWindow.hiddenAfter === 1 ? "" : "s"}
                </Text>
              ) : null}
            </>
          )}
        </Box>
      ) : null}

      {showDetail && selected ? (
        <Box
          flexDirection="column"
          width={innerWidth}
          height={detailHeight}
          flexShrink={0}
          overflow="hidden"
        >
          <DetailPanel
            step={selected.step}
            context={detailContext}
            contextSlots={MAX_DETAIL_CONTEXT_LINES}
            previewLines={layout.previewLines}
            width={innerWidth}
            now={now}
          />
        </Box>
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
      {progress.waiting > 0 ? <Text color="yellow"> · {progress.waiting} waiting</Text> : null}
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
    titleGlyph: "?",
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

function AttentionCard({
  card,
  borderColor,
  width,
}: {
  card: AttentionCardModel;
  borderColor: string;
  width: number;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      width={width}
      overflow="hidden"
    >
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
  const waiting = phase.steps.some((s) => stepWaitKind(s) !== undefined);
  const running = phase.steps.some((s) => s.status === "running" && stepWaitKind(s) === undefined);
  const superseded = (phase.iteration ?? 1) < maxIteration;
  const color = superseded
    ? "gray"
    : phase.done
      ? phase.ok
        ? "green"
        : "red"
      : waiting
        ? "yellow"
        : running
          ? "cyan"
          : "gray";
  const glyph = phase.done ? (phase.ok ? "✓" : "✗") : waiting ? "?" : running ? spinner : "·";
  const iter = phase.iteration ?? 1;
  const iterBadge = maxIteration > 1 ? ` · iter ${iter}/${maxIteration}` : "";
  const supersededBadge = superseded ? " · superseded" : "";
  const counts = ` ${done}/${phase.stepCount} ${glyph} `;
  // Fill the rest of the row with a dim rule so phases read as sections.
  // Measure with string-width (Ink's own column count) so a wide title char
  // cannot oversize the fill; outer truncate-end still clips any surplus.
  const printed = stringWidth(`─ ${phase.title}${iterBadge}${supersededBadge} ─${counts}`);
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

function CollapsedFanoutRow({
  row,
  idColWidth,
  kindColWidth,
  width,
}: {
  row: Extract<WorkflowTreeRow, { kind: "collapsed" }>;
  idColWidth: number;
  kindColWidth: number;
  width: number;
}) {
  // Same id/kind column widths as StepRow so the tree stays aligned when a
  // pending fan-out collapses into one summary.
  const id = truncate(`↳ ${row.firstStepId}…${row.lastStepId}`, idColWidth);
  const kindLabel = BLOCK_LABEL.worker;
  const prefix = `   · ${id.padEnd(idColWidth)} ${kindLabel.padEnd(kindColWidth)}`;
  const pending = truncateToWidth(
    `  ${row.count} pending`,
    Math.max(0, width - stringWidth(prefix)),
  );
  return (
    <Text wrap="truncate-end">
      <Text color="gray">{"   "}</Text>
      <Text color="gray" dimColor>
        ·{" "}
      </Text>
      <Text color="gray" dimColor>
        {id.padEnd(idColWidth)}{" "}
      </Text>
      <Text color={BLOCK_COLOR.worker} dimColor>
        {kindLabel.padEnd(kindColWidth)}
      </Text>
      {pending ? (
        <Text color="gray" dimColor>
          {pending}
        </Text>
      ) : null}
    </Text>
  );
}

function StepRow({
  step,
  idColWidth,
  kindColWidth,
  width,
  selected,
  superseded,
  now,
  spinner,
}: {
  step: StepState;
  idColWidth: number;
  kindColWidth: number;
  /** Inner content width of the tree (border/padding already subtracted). */
  width: number;
  selected: boolean;
  superseded: boolean;
  now: number;
  spinner: string;
}) {
  const waitKind = stepWaitKind(step);
  const glyph = waitKind
    ? { symbol: "?", color: "yellow" }
    : step.status === "running"
      ? { symbol: spinner, color: "yellow" }
      : STEP_GLYPH[step.status];
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
  // ASCII worktree marker: ⎇ is ambiguous-width (string-width 1, many terminals
  // draw 2) and tips every worktree row one column past the frame once agents
  // allocate sandboxes — the same ghost "|" wrap as a literal newline.
  const target = step.worktree
    ? ` ~${basename(step.worktree.cwd)}`
    : step.cwd
      ? ` @${basename(step.cwd)}`
      : "";
  const item = step.item ? ` item ${step.item.index}: ${truncate(step.item.value, 24)}` : "";
  const meta = stepMeta(step, now);
  const marker = selected ? " > " : "   ";
  const glyphPart = `${glyph.symbol} `;
  const idPart = `${id.padEnd(idColWidth)} `;
  const kindPart = kindLabel.padEnd(kindColWidth);
  const prefix = `${marker}${glyphPart}${idPart}${kindPart}`;
  // Pre-fit the flexible tail with string-width so each row stays one terminal
  // line. Prefer left content (runner / worktree / item); trail meta into
  // whatever columns remain. Ink truncate-end alone still wraps when Yoga
  // measures unconstrained content width, painting ghost border glyphs
  // between fan-out children and pushing the header off-screen.
  let room = Math.max(0, width - stringWidth(prefix));
  const midRaw = `${runner ? `  ${runner}` : ""}${target}${item}`;
  const midPart = midRaw ? truncateToWidth(midRaw, room) : "";
  room = Math.max(0, room - stringWidth(midPart));
  const metaRaw = meta ? `  ${meta}` : "";
  const metaPart = metaRaw ? truncateToWidth(metaRaw, room) : "";
  return (
    <Text wrap="truncate-end">
      <Text color="cyan">{marker}</Text>
      <Text color={glyph.color} dimColor={superseded}>
        {glyphPart}
      </Text>
      <Text color="white" bold={selected} dimColor={superseded}>
        {idPart}
      </Text>
      <Text color={BLOCK_COLOR[step.blockKind]} dimColor={superseded}>
        {kindPart}
      </Text>
      {midPart ? (
        <Text color={runner ? agentColor : "gray"} dimColor={superseded}>
          {midPart}
        </Text>
      ) : null}
      {metaPart ? (
        <Text color="gray" dimColor={superseded}>
          {metaPart}
        </Text>
      ) : null}
    </Text>
  );
}

/** One line each: worktree/cwd, data flow (inputs/item), error. */
function buildDetailContext(step: StepState, width: number): { text: string; color: string }[] {
  const lines: { text: string; color: string }[] = [];
  if (step.worktree) {
    lines.push({ text: `~ ${step.worktree.branch} · ${step.worktree.cwd}`, color: "yellow" });
  } else if (step.cwd) {
    lines.push({ text: `@ ${step.cwd}`, color: "gray" });
  }
  const flow: string[] = [];
  if (step.dependsOn && step.dependsOn.length > 0)
    flow.push(`inputs: ${step.dependsOn.join(", ")}`);
  if (step.item) {
    // Flatten newlines before width-fit: character truncate alone still lets a
    // multiline item value soft-wrap and overflow the pinned detail budget.
    const itemValue = truncateToWidth(
      step.item.value.replace(/[\r\n\t]+/g, " "),
      Math.max(16, width - 40),
    );
    flow.push(`item ${step.item.index} from ${step.item.sourceStepId}: ${itemValue}`);
  }
  if (flow.length > 0) lines.push({ text: `← ${flow.join(" · ")}`, color: "gray" });
  if (step.status === "error" && step.result?.error) {
    lines.push({ text: `✗ ${step.result.error}`, color: "red" });
  }
  return lines.map((line) => ({
    ...line,
    text: truncateToWidth(line.text, width),
  }));
}

/**
 * Bottom detail panel for the selected step: a rule header with identity +
 * timing + spend, bounded context lines, and the newest `previewLines` of the
 * step's output. Full output lives in the drill-in (→ / Enter).
 */
function DetailPanel({
  step,
  context,
  contextSlots,
  previewLines,
  width,
  now,
}: {
  step: StepState;
  context: { text: string; color: string }[];
  /** Reserved context rows (pads when the step has fewer). */
  contextSlots: number;
  previewLines: number;
  width: number;
  now: number;
}) {
  const body = (step.result?.output ?? step.text).trim();
  const wrapped = useMemo(() => wrapOutputLines(body, width), [body, width]);
  const visible = previewLines > 0 ? wrapped.slice(-previewLines) : [];
  const waitKind = stepWaitKind(step);
  const displayStatus =
    waitKind === "approval"
      ? "waiting for approval"
      : waitKind === "input"
        ? "waiting for input"
        : statusWord(step.status);
  const liveElapsed =
    step.status === "running" && !waitKind && step.startedAt && now > 0
      ? formatElapsed(now - step.startedAt)
      : undefined;
  const statusColor = waitKind
    ? "yellow"
    : step.status === "done"
      ? "green"
      : step.status === "error"
        ? "red"
        : step.status === "running"
          ? "yellow"
          : "gray";
  // Trailing rule fill uses string-width so a wide step id cannot oversize
  // the dash run; outer truncate-end still clips any surplus.
  const bits = [
    displayStatus,
    step.cached ? "cached" : undefined,
    liveElapsed,
    step.result && !step.cached ? formatElapsed(step.result.durationMs) : undefined,
    step.result?.costUsd ? formatUsd(step.result.costUsd) : undefined,
    wrapped.length > previewLines && previewLines > 0 ? `${wrapped.length} lines` : undefined,
  ].filter((bit): bit is string => Boolean(bit));
  const label = ` ${step.stepId} · ${BLOCK_LABEL[step.blockKind]} · ${bits.join(" · ")} `;
  const fill = Math.max(0, width - stringWidth(label) - 2);
  const emptyPreview = truncateToWidth(sanitizeActivity(step.activity) ?? displayStatus, width);
  // Parent pins height to 1 + contextSlots + previewLines; under-fill is fine
  // (overflow:hidden absorbs slack). Do not invent pad rows — they reintroduce
  // layout churn and trip noArrayIndexKey for no benefit.
  return (
    <Box flexDirection="column" height={1 + contextSlots + previewLines} overflow="hidden">
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
            {emptyPreview}
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
      step.edited ? "edited" : undefined,
      step.cached ? "cached" : formatElapsed(step.result.durationMs),
      step.result.costUsd ? formatUsd(step.result.costUsd) : undefined,
      total > 0 ? `${formatTokens(total)}t` : undefined,
      attempts && attempts > 1 ? `${attempts} tries` : undefined,
    ].filter(Boolean);
    return bits.join(" · ");
  }
  if (step.status === "pending" && step.edited) return "edited · pending";
  const waitKind = stepWaitKind(step);
  if (waitKind === "approval") return "waiting for approval";
  if (waitKind === "input") return "waiting for input";
  if (step.status === "running") {
    // ASCII elapsed prefix: ⏱ is double-width in many terminals and would wrap
    // the row past the fixed viewport (Ink then corrupts the frame).
    const elapsed =
      step.startedAt && now > 0 ? `${formatElapsed(now - step.startedAt)}` : undefined;
    const bits = [elapsed, sanitizeActivity(step.activity)].filter(Boolean);
    if (bits.length > 0) return bits.join(" · ");
  }
  if (step.activity) return sanitizeActivity(step.activity) ?? statusWord(step.status);
  return statusWord(step.status);
}

/** Flatten activity for a single-height tree row: strip wide glyphs + newlines. */
function sanitizeActivity(activity: string | undefined): string | undefined {
  if (!activity) return undefined;
  return activity
    .replace(/[\r\n\t]+/g, " ")
    .replaceAll("⚙", "*")
    .replaceAll("⏳", "...")
    .replace(/\s+/g, " ")
    .trim();
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
