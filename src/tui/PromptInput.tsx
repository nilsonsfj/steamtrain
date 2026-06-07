import { Box, Text, useInput } from "ink";
import { useRef } from "react";
import TextInput from "ink-text-input";

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onTab?: () => void;
  onCtrlR?: () => void;
  onSuggestionNavigate?: (direction: "up" | "down") => void;
  onHistoryNavigate?: (direction: "up" | "down") => boolean;
  focus: boolean;
  /** Bright border while the prompt owns ↑/↓ (history); dim while a list above does. */
  editing?: boolean;
  /** Tab completion and slash-menu arrows while the prompt owns keyboard focus. */
  promptEditing?: boolean;
  running: boolean;
  suggestions?: readonly string[];
  cursorResetKey?: number;
}

/** ink-text-input still emits the letter on Ctrl+R; drop that lone insert. */
function isSpuriousCtrlRInsert(prev: string, next: string): boolean {
  if (next.length !== prev.length + 1) return false;
  let i = 0;
  while (i < prev.length && prev[i] === next[i]) i += 1;
  if (next[i] !== "r") return false;
  return prev.slice(i) === next.slice(i + 1);
}

/** Bottom prompt box. Slash commands stay available while a task is running. */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  onTab,
  onCtrlR,
  onSuggestionNavigate,
  onHistoryNavigate,
  focus,
  editing = true,
  promptEditing = true,
  running,
  suggestions,
  cursorResetKey = 0,
}: PromptInputProps) {
  const slashInput = value.trimStart().startsWith("/");
  const menuOpen = (suggestions?.length ?? 0) > 1;
  const swallowNextCharRef = useRef(false);

  const handleChange = (next: string) => {
    if (swallowNextCharRef.current && isSpuriousCtrlRInsert(value, next)) {
      swallowNextCharRef.current = false;
      return;
    }
    swallowNextCharRef.current = false;
    onChange(next);
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "r" && onCtrlR) {
        swallowNextCharRef.current = true;
        onCtrlR();
      }
    },
    { isActive: focus && !!onCtrlR && !running },
  );

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
    { isActive: focus && promptEditing && slashInput && (!!onTab || (menuOpen && !!onSuggestionNavigate)) },
  );

  useInput(
    (_input, key) => {
      if (!onHistoryNavigate) return;
      if (key.upArrow && onHistoryNavigate("up")) return;
      if (key.downArrow && onHistoryNavigate("down")) return;
    },
    { isActive: focus && !menuOpen && !!onHistoryNavigate },
  );

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={focus && editing ? "cyan" : "gray"} paddingX={1}>
        <Text color={running ? "yellow" : "cyan"} bold>
          {running ? "… " : "❯ "}
        </Text>
        <TextInput
          key={cursorResetKey}
          value={value}
          onChange={handleChange}
          onSubmit={onSubmit}
          focus={focus}
          placeholder={
            running
              ? "/exit to quit · Esc to cancel"
              : editing
                ? "describe the task, or /command (Tab to complete)"
                : "type to edit · describe the task, or /command"
          }
        />
      </Box>
    </Box>
  );
}
