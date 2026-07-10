import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useRef } from "react";

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onTab?: () => void;
  onCtrlR?: () => void;
  /** Ctrl+D handler — plan/dry-run the current workflow. */
  onCtrlD?: () => void;
  /** Ctrl+E handler — open the in-place step editor for the selected step. */
  onCtrlE?: () => void;
  onCtrlQ?: () => void;
  onSuggestionNavigate?: (direction: "up" | "down") => void;
  onHistoryNavigate?: (direction: "up" | "down") => boolean;
  focus: boolean;
  /** Bright border while the prompt owns ↑/↓ (history); dim while a list above does. */
  editing?: boolean;
  /** Tab completion and slash-menu arrows while the prompt owns keyboard focus. */
  promptEditing?: boolean;
  running: boolean;
  /** Shown in the running placeholder, e.g. Esc or Ctrl+Q. */
  cancelKeyHint?: string;
  suggestions?: readonly string[];
  cursorResetKey?: number;
}

/** ink-text-input still emits the letter on Ctrl+R / Ctrl+Q; drop that lone insert. */
function isSpuriousCtrlLetterInsert(prev: string, next: string, letter: string): boolean {
  if (next.length !== prev.length + 1) return false;
  let i = 0;
  while (i < prev.length && prev[i] === next[i]) i += 1;
  if (next[i]?.toLowerCase() !== letter.toLowerCase()) return false;
  return prev.slice(i) === next.slice(i + 1);
}

/** Bottom prompt box. Slash commands stay available while a task is running. */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  onTab,
  onCtrlR,
  onCtrlD,
  onCtrlE,
  onCtrlQ,
  onSuggestionNavigate,
  onHistoryNavigate,
  focus,
  editing = true,
  promptEditing = true,
  running,
  cancelKeyHint = "Esc",
  suggestions,
  cursorResetKey = 0,
}: PromptInputProps) {
  const slashInput = value.trimStart().startsWith("/");
  const menuOpen = (suggestions?.length ?? 0) > 1;
  const swallowNextCharRef = useRef(false);
  const swallowLetterRef = useRef<string | null>(null);

  const handleChange = (next: string) => {
    const letter = swallowLetterRef.current;
    if (swallowNextCharRef.current && letter && isSpuriousCtrlLetterInsert(value, next, letter)) {
      swallowNextCharRef.current = false;
      swallowLetterRef.current = null;
      return;
    }
    swallowNextCharRef.current = false;
    swallowLetterRef.current = null;
    onChange(next);
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "r" && onCtrlR) {
        swallowNextCharRef.current = true;
        swallowLetterRef.current = "r";
        onCtrlR();
      }
    },
    { isActive: focus && !!onCtrlR && !running },
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === "d" && onCtrlD) {
        swallowNextCharRef.current = true;
        swallowLetterRef.current = "d";
        onCtrlD();
      }
    },
    { isActive: focus && !!onCtrlD && !running },
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === "e" && onCtrlE) {
        swallowNextCharRef.current = true;
        swallowLetterRef.current = "e";
        onCtrlE();
      }
    },
    { isActive: focus && !!onCtrlE && !running },
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === "q" && onCtrlQ) {
        swallowNextCharRef.current = true;
        swallowLetterRef.current = "q";
        onCtrlQ();
      }
    },
    { isActive: focus && !!onCtrlQ },
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
    {
      isActive:
        focus && promptEditing && slashInput && (!!onTab || (menuOpen && !!onSuggestionNavigate)),
    },
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
              ? `/exit to quit · ${cancelKeyHint} to cancel`
              : editing
                ? "describe the task, or /command (Tab to complete)"
                : "type to edit · describe the task, or /command"
          }
        />
      </Box>
    </Box>
  );
}
