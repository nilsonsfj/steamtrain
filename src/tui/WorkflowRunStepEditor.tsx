import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { MAX_PROMPT_CHARS } from "../config";

/** What the mid-run editor is editing: one pending step's prompt or command. */
export interface RunStepEditorTarget {
  stepId: string;
  /** Human label for the step's block kind (worker/llm/command/…). */
  kindLabel: string;
  /** Which field the step carries: prompt (agent/llm/…) or cmd (command). */
  field: "prompt" | "cmd";
  /** Current text: the spec value merged with any already-accepted edit. */
  initial: string;
}

interface WorkflowRunStepEditorProps {
  target: RunStepEditorTarget;
  width: number;
  height: number;
  /** Stage the edit through the run's steering control. */
  onApply: (value: string) => void;
  onClose: () => void;
}

/**
 * Mid-run (pause → edit → resume) editor for a pending step, reached with `e`
 * while a run is paused. Unlike the preview-time `WorkflowStepEditor` (which
 * stages session overrides per keystroke), this buffers locally and submits
 * ONE edit on Enter — each accepted edit is an audited intervention in the run
 * record, so it should be the final text, not a keystroke stream.
 */
export function WorkflowRunStepEditor({
  target,
  width,
  height,
  onApply,
  onClose,
}: WorkflowRunStepEditorProps) {
  const [value, setValue] = useState(target.initial);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      if (value.trim() && value !== target.initial) onApply(value);
      onClose();
      return;
    }
    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue((prev) => (prev.length >= MAX_PROMPT_CHARS ? prev : prev + input));
    }
  });

  const innerWidth = Math.max(20, width - 6);
  const changed = value !== target.initial;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      height={height}
    >
      <Box justifyContent="space-between">
        <Text color="yellow" bold>
          ⏸ edit paused run · {target.stepId} <Text color="magenta">({target.kindLabel})</Text>
        </Text>
        <Text color="gray">type to edit · Enter apply · Esc cancel</Text>
      </Box>
      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        <Text color="gray">
          {target.field === "cmd" ? "command" : "prompt"} (applies when the step runs):
        </Text>
        <Box width={innerWidth}>
          <Text wrap="wrap">
            {value || "(blank)"}
            <Text color="cyan">▋</Text>
          </Text>
        </Box>
      </Box>
      <Box>
        <Text color="gray">
          {changed
            ? "Enter stages the edit as a recorded intervention · Esc discards it"
            : "unchanged — Enter/Esc closes"}
        </Text>
      </Box>
    </Box>
  );
}
