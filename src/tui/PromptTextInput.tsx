import chalk from "chalk";
import { Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { shouldAcceptTextInput } from "./text-input-filter";

interface PromptTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  focus: boolean;
  placeholder?: string;
}

/**
 * Single-line prompt field. Unlike ink-text-input, ignores Option/Alt (meta),
 * Ctrl chords, and unrecognized CSI leftovers so window-switcher shortcuts
 * like Option+` do not dump "[27;3;96~" into the draft.
 */
export function PromptTextInput({
  value: originalValue,
  onChange,
  onSubmit,
  focus,
  placeholder = "",
}: PromptTextInputProps) {
  const [cursorOffset, setCursorOffset] = useState(originalValue.length);

  useEffect(() => {
    if (!focus) return;
    setCursorOffset((prev) => Math.min(prev, originalValue.length));
  }, [originalValue, focus]);

  useInput(
    (input, key) => {
      if (
        key.upArrow ||
        key.downArrow ||
        key.tab ||
        (key.ctrl && input === "c") ||
        (key.shift && key.tab)
      ) {
        return;
      }

      if (key.return) {
        onSubmit(originalValue);
        return;
      }

      let nextCursorOffset = cursorOffset;
      let nextValue = originalValue;

      if (key.leftArrow) {
        nextCursorOffset -= 1;
      } else if (key.rightArrow) {
        nextCursorOffset += 1;
      } else if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          nextValue = originalValue.slice(0, cursorOffset - 1) + originalValue.slice(cursorOffset);
          nextCursorOffset -= 1;
        }
      } else if (shouldAcceptTextInput(input, key)) {
        nextValue =
          originalValue.slice(0, cursorOffset) + input + originalValue.slice(cursorOffset);
        nextCursorOffset += input.length;
      } else {
        return;
      }

      nextCursorOffset = Math.max(0, Math.min(nextCursorOffset, nextValue.length));
      setCursorOffset(nextCursorOffset);
      if (nextValue !== originalValue) onChange(nextValue);
    },
    { isActive: focus },
  );

  let renderedValue = originalValue;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;
  if (focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(" ");
    renderedValue = originalValue.length > 0 ? "" : chalk.inverse(" ");
    let i = 0;
    for (const char of originalValue) {
      renderedValue += i === cursorOffset ? chalk.inverse(char) : char;
      i += 1;
    }
    if (originalValue.length > 0 && cursorOffset === originalValue.length) {
      renderedValue += chalk.inverse(" ");
    }
  }

  return (
    <Text>{placeholder && originalValue.length === 0 ? renderedPlaceholder : renderedValue}</Text>
  );
}
