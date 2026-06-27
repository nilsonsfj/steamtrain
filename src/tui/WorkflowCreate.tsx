import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { truncate } from "../agents/util";
import type { AgentId } from "../types/events";
import type { WorkflowSpec } from "../workflow";
import { AGENT_COLOR, SPINNER_FRAMES } from "./theme";
import { blockSummary } from "./workflow-spec-ui";

export interface WorkflowCreateState {
  status: "generating" | "done" | "error";
  description: string;
  agent: AgentId;
  model: string;
  /** Streamed model output (tail shown live). */
  text: string;
  error?: string;
  spec?: WorkflowSpec;
  savedPath?: string;
}

export function WorkflowCreate({
  state,
  width,
  height,
}: {
  state: WorkflowCreateState;
  width: number;
  height: number;
}) {
  const innerWidth = Math.max(20, width - 4);
  const agentColor = AGENT_COLOR[state.agent] ?? "white";
  const borderColor = state.status === "done" ? "green" : state.status === "error" ? "red" : "cyan";
  const tail = lastLines(state.text, Math.max(3, height - 9));

  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (state.status !== "generating") {
      setElapsedSeconds(0);
      setSpinnerFrame(0);
      return;
    }

    const spinnerInterval = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);

    const startTime = Date.now();
    const timerInterval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
    }, 200);

    return () => {
      clearInterval(spinnerInterval);
      clearInterval(timerInterval);
    };
  }, [state.status]);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      height={height}
    >
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          create workflow
        </Text>
        <Text color={agentColor}>
          {state.agent} · {state.model}
        </Text>
      </Box>
      <Text color="gray">“{truncate(state.description, innerWidth - 2)}”</Text>

      {state.status === "generating" ? (
        <Text color="yellow">
          {SPINNER_FRAMES[spinnerFrame]} drafting workflow… ({elapsedSeconds}s)
        </Text>
      ) : null}

      {state.status === "done" && state.spec ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">
            ✓ created “{state.spec.name}” · {blockSummary(state.spec)}
          </Text>
          {state.spec.description ? (
            <Text color="gray">{truncate(state.spec.description, innerWidth)}</Text>
          ) : null}
          {state.savedPath ? <Text color="gray">saved → {state.savedPath}</Text> : null}
          <Text color="gray">Enter to view/run the workflow · Esc to return to the picker</Text>
        </Box>
      ) : null}

      {state.status === "error" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red" wrap="wrap">
            ✗ {state.error ?? "generation failed"}
          </Text>
          <Text color="gray">Esc to dismiss</Text>
        </Box>
      ) : null}

      {tail ? (
        <Box flexDirection="column" marginTop={1} flexGrow={1}>
          <Text color="gray">model output</Text>
          <Box width={innerWidth}>
            <Text color="gray" wrap="wrap">
              {tail}
            </Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

function lastLines(text: string, n: number): string {
  const trimmed = text.trimEnd();
  if (!trimmed) return "";
  const lines = trimmed.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}
