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

/** Cursor offsets are code-point indexes so emoji/etc. move as one unit. */
function codePoints(s: string): string[] {
  return [...s];
}

function sliceCodePoints(s: string, start: number, end?: number): string {
  return codePoints(s).slice(start, end).join("");
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
  const valueChars = codePoints(originalValue);
  const [cursorOffset, setCursorOffset] = useState(valueChars.length);

  useEffect(() => {
    if (!focus) return;
    setCursorOffset((prev) => Math.min(prev, codePoints(originalValue).length));
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

      const chars = codePoints(originalValue);
      let nextCursorOffset = cursorOffset;
      let nextValue = originalValue;

      if (key.leftArrow) {
        nextCursorOffset -= 1;
      } else if (key.rightArrow) {
        nextCursorOffset += 1;
      } else if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          nextValue =
            sliceCodePoints(originalValue, 0, cursorOffset - 1) +
            sliceCodePoints(originalValue, cursorOffset);
          nextCursorOffset -= 1;
        }
      } else if (shouldAcceptTextInput(input, key)) {
        const inserted = codePoints(input);
        nextValue =
          sliceCodePoints(originalValue, 0, cursorOffset) +
          input +
          sliceCodePoints(originalValue, cursorOffset);
        nextCursorOffset += inserted.length;
      } else {
        return;
      }

      nextCursorOffset = Math.max(0, Math.min(nextCursorOffset, codePoints(nextValue).length));
      setCursorOffset(nextCursorOffset);
      if (nextValue !== originalValue) onChange(nextValue);
    },
    { isActive: focus },
  );

  let renderedValue = originalValue;
  let renderedPlaceholder = placeholder ? chalk.grey(placeholder) : undefined;
  if (focus) {
    const placeholderChars = codePoints(placeholder);
    renderedPlaceholder =
      placeholderChars.length > 0
        ? chalk.inverse(placeholderChars[0]) + chalk.grey(placeholderChars.slice(1).join(""))
        : chalk.inverse(" ");
    renderedValue = valueChars.length > 0 ? "" : chalk.inverse(" ");
    let i = 0;
    for (const char of valueChars) {
      renderedValue += i === cursorOffset ? chalk.inverse(char) : char;
      i += 1;
    }
    if (valueChars.length > 0 && cursorOffset === valueChars.length) {
      renderedValue += chalk.inverse(" ");
    }
  }

  return (
    <Text>{placeholder && originalValue.length === 0 ? renderedPlaceholder : renderedValue}</Text>
  );
}
