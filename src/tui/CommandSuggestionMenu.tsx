import { Box, Text } from "ink";
import stringWidth from "string-width";
import { SUGGESTION_MENU_ACTIVE_BG, SUGGESTION_MENU_BG } from "./theme";

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

/** Ink only paints background on character cells — pad each row to the inner width. */
function HiddenRow({ hiddenCount, innerWidth }: { hiddenCount: number; innerWidth: number }) {
  const text = `… ${hiddenCount} more`;
  return (
    <Text backgroundColor={SUGGESTION_MENU_BG}>
      <Text color="gray" backgroundColor={SUGGESTION_MENU_BG}>
        {text}
      </Text>
      {rowPad(text, innerWidth)}
    </Text>
  );
}

function truncateEnd(text: string, max: number): string {
  if (stringWidth(text) <= max) return text;
  if (max <= 1) return text.slice(0, max);
  let out = "";
  for (const ch of text) {
    if (stringWidth(`${out}${ch}…`) > max) break;
    out += ch;
  }
  return `${out}…`;
}

function rowPad(text: string, innerWidth: number): string {
  return " ".repeat(Math.max(0, innerWidth - stringWidth(text)));
}

function SuggestionRow({
  marker,
  suggestion,
  description,
  innerWidth,
  active,
}: {
  marker: string;
  suggestion: string;
  description?: string;
  innerWidth: number;
  active: boolean;
}) {
  const rowBg = active ? SUGGESTION_MENU_ACTIVE_BG : SUGGESTION_MENU_BG;
  const descGap = description ? "  " : "";
  const prefixWidth = stringWidth(marker) + stringWidth(suggestion) + stringWidth(descGap);
  const maxDescLen = Math.max(0, innerWidth - prefixWidth);
  const descText = description ? truncateEnd(description, maxDescLen) : "";
  const descPart = description ? `${descGap}${descText}` : "";
  const visible = `${marker}${suggestion}${descPart}`;

  return (
    <Text backgroundColor={rowBg}>
      <Text color={active ? "cyan" : "gray"} backgroundColor={rowBg}>
        {marker}
      </Text>
      <Text color={active ? "cyan" : "white"} bold={active} backgroundColor={rowBg}>
        {suggestion}
      </Text>
      {description ? (
        <Text color="gray" backgroundColor={rowBg}>
          {descPart}
        </Text>
      ) : null}
      {rowPad(visible, innerWidth)}
    </Text>
  );
}

/** Full-width backdrop rows stacked behind the bordered menu. */
function MenuBackdrop({ width, rows, color }: { width: number; rows: number; color: string }) {
  if (rows <= 0) return null;
  const line = " ".repeat(Math.max(0, width));
  return (
    <Box flexDirection="column" width={width} marginBottom={-rows}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: indices are stable backdrop rows
        <Text key={i} backgroundColor={color}>
          {line}
        </Text>
      ))}
    </Box>
  );
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
  const innerWidth = Math.max(1, width - 4);
  const contentRows = visible.length + (hiddenCount > 0 ? 1 : 0);
  const plateRows = contentRows + 2;

  return (
    <Box width={width} flexDirection="column">
      <MenuBackdrop width={width} rows={plateRows} color={SUGGESTION_MENU_BG} />
      <Box
        width={width}
        flexDirection="column-reverse"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
      >
        {hiddenCount > 0 ? <HiddenRow hiddenCount={hiddenCount} innerWidth={innerWidth} /> : null}
        {visible.map((suggestion, i) => {
          const index = start + i;
          const active = index === selectedIndex;
          return (
            <SuggestionRow
              key={suggestion}
              marker={active ? "▶  " : "   "}
              suggestion={suggestion}
              description={descriptions?.get(suggestion)}
              innerWidth={innerWidth}
              active={active}
            />
          );
        })}
      </Box>
    </Box>
  );
}
