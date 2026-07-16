import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { PendingHumanInput } from "../workflow";

interface WorkflowAnswerInputProps {
  pending: PendingHumanInput;
  width: number;
  height: number;
  /** Submit the answer to the run (owned resolver or shared registry). */
  onAnswer: (value: string) => void;
  onClose: () => void;
}

/**
 * The answer box for a pending human-input request (a `human` step or an
 * agent's clarifying question), reached with `a` while a run is waiting.
 * Free-form asks buffer typed text and submit on Enter; pick-one asks submit
 * instantly on the choice's number key (1–9), with typed text still accepted
 * for exotic cases. Esc closes without answering (the run keeps waiting —
 * closing the box is not a decision).
 */
export function WorkflowAnswerInput({
  pending,
  width,
  height,
  onAnswer,
  onClose,
}: WorkflowAnswerInputProps) {
  const [value, setValue] = useState("");
  const choices = pending.choices ?? [];
  const hasChoices = choices.length > 0;

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      if (value.trim()) {
        onAnswer(value);
        onClose();
      }
      return;
    }
    // A bare number key picks that choice immediately — but only while the
    // buffer is empty, so an answer that legitimately starts with a digit can
    // still be typed out in full.
    if (hasChoices && value === "" && /^[1-9]$/.test(input)) {
      const index = Number(input);
      if (index <= choices.length) {
        onAnswer(choices[index - 1] as string);
        onClose();
        return;
      }
    }
    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue((prev) => prev + input);
    }
  });

  const innerWidth = Math.max(20, width - 6);
  const originLabel = pending.origin === "agent-question" ? "agent question" : "human input";
  // Enough prompt to decide, without letting a huge ask evict the input line.
  const promptBudget = Math.max(3, height - (hasChoices ? choices.length : 0) - 7);
  const promptLines = pending.prompt.split("\n").slice(0, promptBudget);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      height={height}
    >
      <Box justifyContent="space-between">
        <Text color="magenta" bold>
          ✎ {originLabel} · {pending.stepId}
          {pending.attempt > 1 ? <Text color="yellow"> (attempt {pending.attempt})</Text> : null}
        </Text>
        <Text color="gray">{hasChoices ? "1-9 picks · " : ""}type · Enter answer · Esc close</Text>
      </Box>
      {pending.retryError ? (
        <Text color="red" wrap="wrap">
          previous answer rejected: {pending.retryError}
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {promptLines.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static prompt lines never reorder
          <Text key={i} wrap="wrap">
            {line}
          </Text>
        ))}
      </Box>
      {hasChoices ? (
        <Box flexDirection="column" marginTop={1}>
          {choices.map((choice, i) => (
            <Text key={choice}>
              <Text color="cyan">{i + 1})</Text> {choice}
            </Text>
          ))}
        </Box>
      ) : null}
      {pending.outputSchema ? (
        <Text color="gray">this step expects JSON matching its output schema</Text>
      ) : null}
      <Box marginTop={1} width={innerWidth}>
        <Text color="cyan">› </Text>
        <Text wrap="wrap">
          {value}
          <Text color="magenta">▌</Text>
        </Text>
      </Box>
    </Box>
  );
}
