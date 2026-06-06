import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onTab?: () => void;
  focus: boolean;
  running: boolean;
  suggestions?: readonly string[];
}

/** Bottom prompt box. Disabled (and hinted) while a task is running. */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  onTab,
  focus,
  running,
  suggestions,
}: PromptInputProps) {
  useInput(
    (_input, key) => {
      if (key.tab && !key.shift && onTab) {
        onTab();
      }
    },
    { isActive: focus && !running && !!onTab },
  );

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={focus ? "cyan" : "gray"} paddingX={1}>
        <Text color={running ? "yellow" : "cyan"} bold>
          {running ? "… " : "❯ "}
        </Text>
        {running ? (
          <Text color="gray">working — Esc to cancel</Text>
        ) : (
          <TextInput
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            focus={focus}
            placeholder="describe the task, or /command (Tab to complete)"
          />
        )}
      </Box>
      {suggestions && suggestions.length > 0 ? (
        <Box paddingX={1}>
          <Text color="gray">complete: {suggestions.join(" · ")}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
