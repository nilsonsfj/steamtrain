import { Box, Text } from "ink";
import { formatModelDisplay } from "../agents";
import type { WorkspaceEntry } from "../workspace";
import { workspaceLabel } from "../workspace";
import { EventRow } from "./EventRow";
import { type Mode, isWorkspaceMode } from "./modes";
import { TAB_LABEL_COLOR } from "./theme";
import type { DisplayItem } from "./transcript";

interface EventStreamProps {
  items: DisplayItem[];
  height: number;
  width: number;
  mode: Mode;
  workspaceMap: Map<string, WorkspaceEntry>;
}

/**
 * Renders the tail of the transcript that fits in `height` rows. Heights are
 * estimated per item (text wraps) and accumulated from the newest backwards, so
 * the latest activity always stays visible without overflowing the layout.
 */
export function EventStream({ items, height, width, mode, workspaceMap }: EventStreamProps) {
  const innerWidth = Math.max(20, width - 4);
  const bodyHeight = Math.max(3, height - 2);
  const { visible, hiddenCount } = selectVisible(items, bodyHeight, innerWidth);
  const eventSuffix = ` · ${items.length} event${items.length === 1 ? "" : "s"}${
    hiddenCount > 0 ? `  (${hiddenCount} earlier hidden ↑)` : ""
  }`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} height={height}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          event stream
        </Text>
        <Text wrap="truncate-end">
          <StreamContextLabel mode={mode} workspaceMap={workspaceMap} />
          <Text color="gray">{eventSuffix}</Text>
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {visible.length === 0 ? (
          <Text color="gray">
            No events yet. Pick a task type and enter a prompt below to dispatch.
          </Text>
        ) : (
          visible.map((item) => <EventRow key={item.id} item={item} width={innerWidth} />)
        )}
      </Box>
    </Box>
  );
}

function StreamContextLabel({
  mode,
  workspaceMap,
}: {
  mode: Mode;
  workspaceMap: Map<string, WorkspaceEntry>;
}) {
  if (!isWorkspaceMode(mode)) {
    return <Text color="gray">{mode}</Text>;
  }

  const entry = workspaceMap.get(mode);
  if (!entry) {
    return <Text color="gray">{mode}</Text>;
  }

  const tabName = workspaceLabel(entry);
  const modelPart = formatModelDisplay(entry);

  return (
    <>
      <Text bold color={TAB_LABEL_COLOR}>
        {tabName}
      </Text>
      <Text color="gray"> · </Text>
      <Text bold color="white">
        {entry.agent}
      </Text>
      <Text color="gray"> · {modelPart}</Text>
    </>
  );
}

function selectVisible(
  items: DisplayItem[],
  budget: number,
  width: number,
): { visible: DisplayItem[]; hiddenCount: number } {
  const visible: DisplayItem[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    const rows = estimateRows(item, width);
    if (used + rows > budget && visible.length > 0) break;
    visible.unshift(item);
    used += rows;
  }
  return { visible, hiddenCount: items.length - visible.length };
}

function estimateRows(item: DisplayItem, width: number): number {
  const wrap = (len: number, cap: number): number =>
    Math.min(cap, Math.max(1, Math.ceil(len / Math.max(1, width))));
  switch (item.kind) {
    case "text":
      return wrap(item.text.length, 24);
    case "result":
      return 1 + (item.text ? wrap(Math.min(item.text.length, 600), 12) : 0);
    default:
      return 1;
  }
}
