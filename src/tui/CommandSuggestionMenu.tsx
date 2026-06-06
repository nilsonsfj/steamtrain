import { Box, Text } from "ink";

export const MAX_VISIBLE_SUGGESTIONS = 8;

interface CommandSuggestionMenuProps {
  suggestions: readonly string[];
  selectedIndex: number;
  width: number;
  /** Optional map of suggestion label → description (e.g. slash command descriptions). */
  descriptions?: ReadonlyMap<string, string>;
}

/** Slice bounds for a scrolling suggestion window. */
export function visibleSuggestionWindow(
  suggestionCount: number,
  selectedIndex: number,
  maxVisible = MAX_VISIBLE_SUGGESTIONS,
): { start: number; count: number } {
  const count = Math.min(suggestionCount, maxVisible);
  const start = Math.max(0, Math.min(selectedIndex - count + 1, suggestionCount - count));
  return { start, count };
}

/** Approximate rendered height in terminal rows (for upward overlay offset). */
export function suggestionMenuHeight(
  suggestionCount: number,
  selectedIndex = 0,
  maxVisible = MAX_VISIBLE_SUGGESTIONS,
): number {
  if (suggestionCount <= 1) return 0;
  const { count } = visibleSuggestionWindow(suggestionCount, selectedIndex, maxVisible);
  const hiddenRow = suggestionCount > maxVisible ? 1 : 0;
  return count + hiddenRow + 2;
}

/** Upward-growing completion menu above the prompt, overlaying content via negative margin. */
export function CommandSuggestionMenu({
  suggestions,
  selectedIndex,
  width,
  descriptions,
}: CommandSuggestionMenuProps) {
  if (suggestions.length <= 1) return null;

  const { start, count } = visibleSuggestionWindow(suggestions.length, selectedIndex);
  const visible = suggestions.slice(start, start + count);
  const hiddenCount = suggestions.length - visible.length;

  return (
    <Box
      width={width}
      flexDirection="column-reverse"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      {hiddenCount > 0 ? (
        <Box>
          <Text color="gray">… {hiddenCount} more</Text>
        </Box>
      ) : null}
      {visible.map((suggestion, i) => {
        const index = start + i;
        const active = index === selectedIndex;
        const description = descriptions?.get(suggestion);
        return (
          <Box key={`${suggestion}-${index}`}>
            <Text color={active ? "cyan" : "gray"}>{active ? "▶ " : "  "}</Text>
            <Text color={active ? "cyan" : "white"} bold={active}>
              {suggestion}
            </Text>
            {description ? (
              <Text color="gray" wrap="truncate-end">
                {"  "}
                {description}
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
