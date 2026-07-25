import { basename } from "node:path";
import { Box, Text } from "ink";
import { useEffect, useMemo } from "react";
import { permissionsBadge } from "../agents/permissions";
import { truncate } from "../agents/util";
import {
  type StepPermissionVerdict,
  type WorkflowSourceKind,
  type WorkflowSpec,
  formatElapsed,
  formatTokenSummary,
  formatUsd,
  isAgentBackedStep,
  workflowStepKind,
} from "../workflow";
import {
  type OutputScroll,
  selectOutputWindow,
  staticOutputScroll,
  wrapOutputLines,
} from "./output-window";
import { statusWord } from "./status-word";
import { AGENT_COLOR, WORKFLOW_SOURCE_COLOR } from "./theme";
import {
  BLOCK_LABEL,
  type FlatSpecStep,
  type PreviewRenderContext,
  formatLlmTarget,
  formatWorkflowAgentTarget,
  previewInputValues,
  promptForStep,
  specDetailLines,
} from "./workflow-spec-ui";
import type { PhaseState, StepState, WorkflowState } from "./workflow-state";

type DetailLine = {
  text: string;
  color?: string;
};

interface PreviewStepDetailsProps {
  kind: "preview";
  spec: WorkflowSpec;
  source: WorkflowSourceKind;
  input: string;
  entry?: FlatSpecStep;
  width: number;
  height: number;
  selectedIndex: number;
  totalSteps: number;
  dispatchOk: boolean;
  dispatchReason?: string;
  canResume?: boolean;
  /** Per-step permission verdicts (profile + enforcement), keyed by step id. */
  permissionVerdicts?: Record<string, StepPermissionVerdict>;
}

interface LiveStepDetailsProps {
  kind: "live";
  state: WorkflowState;
  entry?: { phase: PhaseState; step: StepState };
  width: number;
  height: number;
  selectedIndex: number;
  totalSteps: number;
  elapsedMs: number;
  /**
   * Current wall clock for live per-step timers; omit (0) for replayed records,
   * where running-step elapsed would be meaningless.
   */
  now?: number;
  /** Output-pane scroll state; defaults to a static top-anchored view. */
  scroll?: OutputScroll;
  /**
   * Reports the output pane's wrapped-line total and visible budget after each
   * render, so the keyboard handler can clamp scroll motions.
   */
  onOutputMetrics?: (metrics: { total: number; budget: number }) => void;
}

type WorkflowStepDetailsProps = PreviewStepDetailsProps | LiveStepDetailsProps;

/** Full-screen drill-in for the selected workflow step. */
export function WorkflowStepDetails(props: WorkflowStepDetailsProps) {
  const innerWidth = Math.max(20, props.width - 4);

  if (props.kind === "preview") {
    return <PreviewStepDetails {...props} innerWidth={innerWidth} />;
  }

  return <LiveStepDetails {...props} innerWidth={innerWidth} />;
}

function PreviewStepDetails({
  spec,
  source,
  input,
  entry,
  height,
  selectedIndex,
  totalSteps,
  dispatchOk,
  dispatchReason,
  canResume = false,
  permissionVerdicts,
  innerWidth,
}: PreviewStepDetailsProps & { innerWidth: number }) {
  const lineBudget = Math.max(4, height - 6);
  const renderCtx = useMemo(
    () => ({ input, inputs: previewInputValues(spec), permissions: permissionVerdicts }),
    [input, spec, permissionVerdicts],
  );
  const lines = entry
    ? previewLines(entry, renderCtx, dispatchOk, dispatchReason, canResume, innerWidth)
    : [{ text: "No step selected.", color: "gray" }];
  const visible = lines.slice(0, lineBudget);
  const hidden = Math.max(0, lines.length - visible.length);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} height={height}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          workflow step · {spec.name} <Text color={WORKFLOW_SOURCE_COLOR[source]}>({source})</Text>
        </Text>
        <Text color="gray">
          {Math.min(selectedIndex + 1, Math.max(1, totalSteps))}/{Math.max(1, totalSteps)} · preview
        </Text>
      </Box>
      <Text color="gray" wrap="truncate-end">
        ←/Esc back · ↑/↓ step · Ctrl+R run · Ctrl+D plan{canResume ? " · Enter resume" : ""}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((line, index) => (
          <Text key={`${line.text}-${index}`} color={line.color ?? "white"} wrap="truncate-end">
            {line.text}
          </Text>
        ))}
        {hidden > 0 ? (
          <Text color="gray">
            … {hidden} more detail line{hidden === 1 ? "" : "s"}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

/**
 * Live drill-in: a compact metadata header (status, runner, worktree, timing,
 * cost) above a scrollable pane showing the step's FULL output. The pane
 * follows the stream while the step runs; PgUp/PgDn (handled by the keyboard
 * layer via `onOutputMetrics`) move the window and re-engage follow at the
 * bottom.
 */
function LiveStepDetails({
  state,
  entry,
  height,
  selectedIndex,
  totalSteps,
  elapsedMs,
  now = 0,
  scroll = staticOutputScroll,
  onOutputMetrics,
  innerWidth,
}: LiveStepDetailsProps & { innerWidth: number }) {
  const step = entry?.step;
  const meta = entry ? liveMetaLines(entry.phase, entry.step, now, innerWidth) : [];
  const body = step ? (step.result?.output ?? step.text).trim() : "";
  const outputLines = useMemo(() => wrapOutputLines(body, innerWidth), [body, innerWidth]);
  // Chrome around the output pane: borders (2), title (1), key hints (1),
  // metadata lines, output header (1).
  const budget = Math.max(3, height - 5 - meta.length);
  const window = selectOutputWindow(outputLines, scroll, budget);
  useEffect(() => {
    onOutputMetrics?.({ total: outputLines.length, budget });
  }, [onOutputMetrics, outputLines.length, budget]);

  const status = state.done ? (state.ok ? "done" : "failed") : "running";
  const stepRunning = step?.status === "running";
  const position = body
    ? `lines ${window.start + 1}–${window.end}/${window.total}`
    : "waiting for output";
  const followBadge = stepRunning ? (scroll.follow ? " · following" : " · paused ↥") : "";

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
          workflow step{state.name ? ` · ${state.name}` : ""}
        </Text>
        <Text color="gray">
          {Math.min(selectedIndex + 1, Math.max(1, totalSteps))}/{Math.max(1, totalSteps)} ·{" "}
          {formatElapsed(elapsedMs)} · {status}
        </Text>
      </Box>
      <Text color="gray" wrap="truncate-end">
        ←/Esc back · ↑/↓ step · PgUp/PgDn scroll output
        {state.done ? " · Enter resume · Ctrl+R run" : " · Ctrl+Q cancel"}
      </Text>
      {entry ? (
        meta.map((line, index) => (
          <Text key={`${line.text}-${index}`} color={line.color ?? "white"} wrap="truncate-end">
            {line.text}
          </Text>
        ))
      ) : (
        <Text color="gray">Waiting for the first workflow step to start.</Text>
      )}
      {entry ? (
        <>
          <Text color="gray" wrap="truncate-end">
            {`── output · ${position}${followBadge} ${"─".repeat(Math.max(0, innerWidth - position.length - followBadge.length - 12))}`}
          </Text>
          <Box flexDirection="column" flexGrow={1}>
            {body ? (
              window.visible.map((line, index) => (
                <Text
                  key={`${window.start + index}-${line.slice(0, 16)}`}
                  color={step?.status === "error" ? "red" : undefined}
                  wrap="truncate-end"
                >
                  {line.length > 0 ? line : " "}
                </Text>
              ))
            ) : (
              <Text color="gray">
                {step ? step.activity || statusWord(step.status) : "no output yet"}
              </Text>
            )}
          </Box>
        </>
      ) : null}
    </Box>
  );
}

function previewLines(
  entry: FlatSpecStep,
  renderCtx: PreviewRenderContext,
  dispatchOk: boolean,
  dispatchReason: string | undefined,
  canResume: boolean,
  width: number,
): DetailLine[] {
  const { phase, step } = entry;
  const kind = workflowStepKind(step);
  const input = renderCtx.input ?? "";
  const lines: DetailLine[] = [
    { text: `step: ${step.id}`, color: "cyan" },
    { text: `phase: ${phase.title} (${phase.id})`, color: "gray" },
    { text: `block: ${BLOCK_LABEL[kind]} (${kind})`, color: "magenta" },
    {
      text: dispatchOk
        ? `workflow: ready${canResume ? " · cache available" : ""}`
        : `workflow: blocked - ${dispatchReason ?? "unknown reason"}`,
      color: dispatchOk ? "green" : "yellow",
    },
    {
      text: `input: ${input.length > 0 ? truncate(input, Math.max(24, width - 8)) : "(none)"}`,
      color: "gray",
    },
  ];

  if (isAgentBackedStep(step)) {
    lines.push({
      text: `runner: ${formatWorkflowAgentTarget(
        {
          agent: step.agent,
          model: step.model,
          modelClass: step.modelClass,
          effort: step.effort,
        },
        renderCtx,
      )}`,
      color: step.agent ? (AGENT_COLOR[step.agent] ?? "white") : "cyan",
    });
  } else if (step.kind === "llm") {
    lines.push({ text: `runner: ${formatLlmTarget(step, renderCtx)}`, color: "cyan" });
  }

  for (const line of specDetailLines(step, renderCtx)) {
    lines.push({ text: line, color: "gray" });
  }

  const prompt = promptForStep(step, renderCtx);
  if (prompt) {
    const promptLines = prompt.split("\n");
    let isFirstPromptLine = true;
    for (const promptLine of promptLines) {
      const trimmedLine = promptLine.trim();
      lines.push({
        text: isFirstPromptLine
          ? `prompt: ${truncate(trimmedLine || "(blank)", Math.max(80, width - 20))}`
          : `  ${truncate(trimmedLine || "(blank)", Math.max(80, width - 20))}`,
      });
      isFirstPromptLine = false;
    }
  }

  return lines;
}

/**
 * The metadata header above the output pane: identity, status, runner,
 * workspace/worktree, live timing, cost/tokens, data flow — one row each, so
 * the remaining height goes to the output itself.
 */
function liveMetaLines(
  phase: PhaseState,
  step: StepState,
  now: number,
  width: number,
): DetailLine[] {
  const runner =
    step.agent && step.model
      ? formatWorkflowAgentTarget({ agent: step.agent, model: step.model, effort: step.effort })
      : step.blockKind === "llm" && (step.api || step.model)
        ? [step.api, step.model].filter(Boolean).join("/")
        : BLOCK_LABEL[step.blockKind];
  const attempts = step.result?.attempts ?? step.attempts;
  const statusBits = [
    step.status,
    step.cached ? "cached" : undefined,
    step.result?.skipped ? "skipped" : undefined,
    attempts && attempts > 1 ? `${attempts} tries` : undefined,
  ].filter(Boolean);
  const iter = phase.iteration && phase.iteration > 1 ? ` · iter ${phase.iteration}` : "";
  const lines: DetailLine[] = [
    {
      text: `step: ${step.stepId} · ${BLOCK_LABEL[step.blockKind]} · ${statusBits.join(" · ")}`,
      color: statusColor(step.status),
    },
    { text: `phase: ${phase.title} (${phase.phaseId})${iter}`, color: "gray" },
    {
      text: `runner: ${runner}`,
      color: step.agent ? (AGENT_COLOR[step.agent] ?? "white") : "gray",
    },
  ];

  // Permissions sit directly under `runner:` — the two facts that together
  // answer "what is this step able to do to my repo right now?".
  const permissions = step.result?.permissions ?? step.permissions;
  if (permissions) {
    const violations = step.result?.permissions?.violations;
    const enforcement =
      step.result?.permissions?.enforcement ??
      (step.permissions?.verify ? "verified after the run" : undefined);
    lines.push({
      text: violations?.length
        ? `permissions: ${permissionsBadge(permissions.profile)} · VIOLATED: ${violations.slice(0, 4).join(", ")}${violations.length > 4 ? `, +${violations.length - 4} more` : ""}`
        : `permissions: ${permissionsBadge(permissions.profile)}${enforcement ? ` · ${enforcement}` : ""}`,
      color: violations?.length ? "red" : "cyan",
    });
  }

  if (step.worktree) {
    lines.push({
      text: `worktree: ⎇ ${step.worktree.branch} · ${step.worktree.cwd}`,
      color: "yellow",
    });
  } else if (step.cwd) {
    lines.push({ text: `cwd: ${step.cwd} (${basename(step.cwd)})`, color: "gray" });
  }

  const timing = timingLine(step, now);
  if (timing) lines.push({ text: timing, color: "gray" });

  const spend = [
    step.result?.costUsd ? `cost ${formatUsd(step.result.costUsd)}` : undefined,
    formatTokenSummary(step.result?.tokens) || undefined,
  ].filter(Boolean);
  if (spend.length > 0) lines.push({ text: spend.join(" · "), color: "gray" });

  if (step.dependsOn && step.dependsOn.length > 0) {
    lines.push({ text: `inputs: ${step.dependsOn.join(", ")}`, color: "gray" });
  }
  if (step.item) {
    lines.push({
      text: `item: ${step.item.index} from ${step.item.sourceStepId} - ${truncate(step.item.value, Math.max(24, width - 18))}`,
      color: "gray",
    });
  }
  if (step.gate) {
    lines.push({
      text: `gate: ${step.gate.passed ? "passed" : "blocked"}${step.gate.target ? ` -> ${step.gate.target}` : ""}${
        step.gate.onFalse ? ` · onFalse=${step.gate.onFalse}` : ""
      }`,
      color: step.gate.passed ? "green" : "yellow",
    });
  }
  if (step.humanInput?.value) {
    const who = step.humanInput.by ? ` by ${step.humanInput.by}` : "";
    lines.push({
      text: `answered${who}: ${truncate(step.humanInput.value, Math.max(24, width - 16))}`,
      color: "magenta",
    });
  }
  for (const qa of step.result?.questions ?? []) {
    lines.push({
      text: `agent asked: ${truncate(qa.question, Math.max(24, width - 16))}`,
      color: "magenta",
    });
    lines.push({
      text: `answer${qa.by ? ` (${qa.by})` : ""}: ${truncate(qa.answer, Math.max(24, width - 16))}`,
      color: "magenta",
    });
  }
  if (step.result?.suppliedBy) {
    lines.push({ text: `supplied by: ${step.result.suppliedBy}`, color: "gray" });
  }
  // Session continuity: this step resumed an earlier step's recorded agent
  // session (`session: "continue:<stepId>"`) — show the lineage.
  if (step.result?.resumedSessionId) {
    lines.push({ text: `continued session: ${step.result.resumedSessionId}`, color: "gray" });
  }
  // Interactive takeover: a finished agent step with a recorded session can be
  // resumed by a human — surface the command right where the step is inspected.
  if (step.agent && step.result?.sessionId && (step.status === "done" || step.status === "error")) {
    lines.push({
      text: `take over (after the run ends): steamtrain workflow takeover <runId> ${step.stepId}`,
      color: "cyan",
    });
  }
  if (step.status === "running" && step.activity) {
    lines.push({ text: `activity: ${step.activity}`, color: "gray" });
  }
  if (step.status === "error" && step.result?.error) {
    lines.push({
      text: `error: ${truncate(step.result.error, Math.max(24, width - 8))}`,
      color: "red",
    });
  }

  return lines;
}

/** "started 14:03:22 · elapsed 12.3s" while running; "took 12.3s" once done. */
function timingLine(step: StepState, now: number): string | undefined {
  const startedAt = step.startedAt;
  const started = startedAt ? new Date(startedAt).toLocaleTimeString() : undefined;
  if (step.status === "running") {
    const elapsed = startedAt && now > 0 ? ` · elapsed ${formatElapsed(now - startedAt)}` : "";
    return started ? `started ${started}${elapsed}` : undefined;
  }
  if (step.result) {
    const took = `took ${formatElapsed(step.result.durationMs)}`;
    return started ? `started ${started} · ${took}` : took;
  }
  return undefined;
}

function statusColor(status: StepState["status"]): string {
  switch (status) {
    case "done":
      return "green";
    case "error":
      return "red";
    case "running":
      return "yellow";
    case "pending":
      return "gray";
  }
}
