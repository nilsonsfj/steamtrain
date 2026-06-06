import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onTab?: () => void;
  onSuggestionNavigate?: (direction: "up" | "down") => void;
  focus: boolean;
  running: boolean;
  suggestions?: readonly string[];
  cursorResetKey?: number;
}

/** Bottom prompt box. Slash commands stay available while a task is running. */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  onTab,
  onSuggestionNavigate,
  focus,
  running,
  suggestions,
  cursorResetKey = 0,
}: PromptInputProps) {
  const slashInput = value.trimStart().startsWith("/");
  const menuOpen = (suggestions?.length ?? 0) > 1;

  useInput(
    (_input, key) => {
      if (key.tab && !key.shift && onTab) {
        onTab();
        return;
      }
      if (menuOpen && onSuggestionNavigate) {
        // Index 0 sits nearest the prompt; up moves visually up the list.
        if (key.upArrow) {
          onSuggestionNavigate("down");
          return;
        }
        if (key.downArrow) {
          onSuggestionNavigate("up");
          return;
        }
      }
    },
    { isActive: focus && slashInput && (!!onTab || (menuOpen && !!onSuggestionNavigate)) },
  );

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={focus ? "cyan" : "gray"} paddingX={1}>
        <Text color={running ? "yellow" : "cyan"} bold>
          {running ? "… " : "❯ "}
        </Text>
        <TextInput
          key={cursorResetKey}
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus={focus}
          placeholder={
            running
              ? "/exit to quit · Esc to cancel"
              : "describe the task, or /command (Tab to complete)"
          }
        />
      </Box>
    </Box>
  );
}
