import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  focus: boolean;
  running: boolean;
}

/** Bottom prompt box. Disabled (and hinted) while a task is running. */
export function PromptInput({ value, onChange, onSubmit, focus, running }: PromptInputProps) {
  return (
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
          placeholder="describe the task, then Enter to dispatch"
        />
      )}
    </Box>
  );
}
