import { basename } from "node:path";
import { Box, Text } from "ink";
import { truncate } from "../agents/util";
import {
  type WorkflowSourceKind,
  type WorkflowSpec,
  formatTokenSummary,
  isAgentBackedStep,
  workflowStepKind,
} from "../workflow";
import { statusWord } from "./status-word";
import { AGENT_COLOR, WORKFLOW_SOURCE_COLOR } from "./theme";
import {
  BLOCK_LABEL,
  type FlatSpecStep,
  formatLlmTarget,
  formatWorkflowAgentTarget,
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
  innerWidth,
}: PreviewStepDetailsProps & { innerWidth: number }) {
  const lineBudget = Math.max(4, height - 6);
  const lines = entry
    ? previewLines(entry, input, dispatchOk, dispatchReason, canResume, innerWidth)
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

function LiveStepDetails({
  state,
  entry,
  height,
  selectedIndex,
  totalSteps,
  elapsedMs,
  innerWidth,
}: LiveStepDetailsProps & { innerWidth: number }) {
  const lineBudget = Math.max(4, height - 6);
  const lines = entry
    ? liveLines(entry.phase, entry.step, innerWidth)
    : [{ text: "Waiting for the first workflow step to start.", color: "gray" }];
  const visible = lines.slice(0, lineBudget);
  const hidden = Math.max(0, lines.length - visible.length);
  const status = state.done ? (state.ok ? "done" : "failed") : "running";

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
          {(elapsedMs / 1000).toFixed(1)}s · {status}
        </Text>
      </Box>
      <Text color="gray" wrap="truncate-end">
        ←/Esc back · ↑/↓ step{state.done ? " · Enter resume · Ctrl+R run" : " · Ctrl+Q cancel"}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {visible.map((line, index) => (
          <Text
            key={`${line.text}-${index}`}
            color={line.color ?? "white"}
            wrap={line.text.length > innerWidth ? "wrap" : "truncate-end"}
          >
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

function previewLines(
  entry: FlatSpecStep,
  input: string,
  dispatchOk: boolean,
  dispatchReason: string | undefined,
  canResume: boolean,
  width: number,
): DetailLine[] {
  const { phase, step } = entry;
  const kind = workflowStepKind(step);
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
      text: `runner: ${formatWorkflowAgentTarget({
        agent: step.agent,
        model: step.model,
        effort: step.effort,
      })}`,
      color: AGENT_COLOR[step.agent] ?? "white",
    });
  } else if (step.kind === "llm") {
    lines.push({ text: `runner: ${formatLlmTarget(step)}`, color: "cyan" });
  }

  for (const line of specDetailLines(step)) {
    lines.push({ text: line, color: "gray" });
  }

  const prompt = promptForStep(step);
  if (prompt) {
    const promptLines = prompt.split("\n");
    let isFirstPromptLine = true;
    for (const promptLine of promptLines) {
      const trimmedLine = promptLine.trim();
      if (trimmedLine) {
        lines.push({
          text: isFirstPromptLine
            ? `prompt: ${truncate(trimmedLine, Math.max(80, width - 20))}`
            : `  ${truncate(trimmedLine, Math.max(80, width - 20))}`,
        });
        isFirstPromptLine = false;
      }
    }
  }

  return lines;
}

function liveLines(phase: PhaseState, step: StepState, width: number): DetailLine[] {
  const runner =
    step.agent && step.model
      ? formatWorkflowAgentTarget({ agent: step.agent, model: step.model, effort: step.effort })
      : step.blockKind === "llm" && (step.api || step.model)
        ? [step.api, step.model].filter(Boolean).join("/")
        : BLOCK_LABEL[step.blockKind];
  const lines: DetailLine[] = [
    { text: `step: ${step.stepId}`, color: "cyan" },
    { text: `phase: ${phase.title} (${phase.phaseId})`, color: "gray" },
    { text: `block: ${BLOCK_LABEL[step.blockKind]} (${step.blockKind})`, color: "magenta" },
    {
      text: `status: ${step.status}${step.cached ? " · cached" : ""}`,
      color: statusColor(step.status),
    },
    {
      text: `runner: ${runner}`,
      color: step.agent ? (AGENT_COLOR[step.agent] ?? "white") : "gray",
    },
  ];

  if (step.cwd) lines.push({ text: `cwd: ${step.cwd} (${basename(step.cwd)})`, color: "gray" });
  if (step.item) {
    lines.push({
      text: `item: ${step.item.index} from ${step.item.sourceStepId} - ${truncate(step.item.value, Math.max(24, width - 18))}`,
      color: "gray",
    });
  }
  if (step.gate) {
    const gateState = step.gate.passed ? "passed" : "blocked";
    lines.push({
      text: `gate: ${gateState}${step.gate.target ? ` -> ${step.gate.target}` : ""}${
        step.gate.onFalse ? ` · onFalse=${step.gate.onFalse}` : ""
      }`,
      color: step.gate.passed ? "green" : "yellow",
    });
  }
  if (step.result) {
    lines.push({
      text: `result: ${step.result.ok ? "ok" : "error"} · ${(step.result.durationMs / 1000).toFixed(1)}s${
        step.result.costUsd ? ` · $${step.result.costUsd.toFixed(4)}` : ""
      }`,
      color: step.result.ok ? "green" : "red",
    });
    const tokenLine = formatTokenSummary(step.result.tokens);
    if (tokenLine) lines.push({ text: `tokens: ${tokenLine}`, color: "gray" });
  }
  if (step.activity) lines.push({ text: `activity: ${step.activity}`, color: "gray" });

  const output = (step.result?.output ?? step.text).trim();
  if (output) {
    const prefix = step.status === "error" ? "error" : "output";
    const outputColor = step.status === "error" ? "red" : "white";
    const outputLines = output.split("\n");
    for (const outputLine of outputLines) {
      const trimmedLine = outputLine.trim();
      if (trimmedLine) {
        const lastLine = lines[lines.length - 1];
        lines.push({
          text:
            !lastLine || lastLine.text.startsWith(prefix)
              ? `${prefix}: ${truncate(trimmedLine, Math.max(160, width * 7))}`
              : `  ${truncate(trimmedLine, Math.max(160, width * 7))}`,
          color: outputColor,
        });
      }
    }
    const lastOutputLine = lines[lines.length - 1];
    if (!lastOutputLine || !lastOutputLine.text.startsWith(prefix)) {
      lines.push({
        text: `${prefix}: (empty)`,
        color: outputColor,
      });
    }
  } else {
    lines.push({ text: `tail: ${step.activity || statusWord(step.status)}`, color: "gray" });
  }

  return lines;
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

function collapseWhitespace(text: string): string {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
