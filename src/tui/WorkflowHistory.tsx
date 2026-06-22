import { Box, Text } from "ink";
import type { RunRecordSummary } from "../workflow";
import { selectVisibleWindow } from "./workflow-list-window";

interface WorkflowHistoryProps {
  runs: RunRecordSummary[];
  selectedIndex: number;
  loading: boolean;
  error?: string;
  width: number;
  height: number;
}

const STATUS_GLYPH: Record<RunRecordSummary["status"], { symbol: string; color: string }> = {
  done: { symbol: "✓", color: "green" },
  error: { symbol: "✗", color: "red" },
  canceled: { symbol: "⊘", color: "yellow" },
};

/** A browser for past workflow runs: ↑/↓ select, Enter to inspect, Esc to close. */
export function WorkflowHistory({
  runs,
  selectedIndex,
  loading,
  error,
  width,
  height,
}: WorkflowHistoryProps) {
  const innerWidth = Math.max(20, width - 4);
  const clamped = Math.min(selectedIndex, Math.max(0, runs.length - 1));
  const listBudget = Math.max(1, height - 3);
  const window = selectVisibleWindow(runs, clamped, listBudget);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} height={height}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          run history
        </Text>
        <Text color="gray">
          {runs.length} run{runs.length === 1 ? "" : "s"} · ↑/↓ select · Enter inspect · Esc back
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {loading ? (
          <Text color="gray">loading history…</Text>
        ) : error ? (
          <Text color="red">{error}</Text>
        ) : runs.length === 0 ? (
          <Text color="gray">No recorded runs yet. Run a workflow to start building history.</Text>
        ) : (
          <>
            {window.hiddenBefore > 0 ? (
              <Text color="gray">{window.hiddenBefore} earlier hidden ↑</Text>
            ) : null}
            {window.visible.map((run, offset) => (
              <HistoryRow
                key={run.id}
                run={run}
                width={innerWidth}
                selected={window.start + offset === clamped}
              />
            ))}
            {window.hiddenAfter > 0 ? (
              <Text color="gray">{window.hiddenAfter} later hidden ↓</Text>
            ) : null}
          </>
        )}
      </Box>
    </Box>
  );
}

function HistoryRow({
  run,
  width,
  selected,
}: {
  run: RunRecordSummary;
  width: number;
  selected: boolean;
}) {
  const g = STATUS_GLYPH[run.status];
  const when = relativeTime(run.startedAt);
  const cost = run.totals.costUsd > 0 ? ` · $${run.totals.costUsd.toFixed(4)}` : "";
  const failed = run.totals.failed > 0 ? ` · ${run.totals.failed} failed` : "";
  const meta = `${run.totals.ok}/${run.totals.steps} ok${failed} · ${(run.durationMs / 1000).toFixed(1)}s${cost}`;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={selected ? "cyan" : "gray"}>{selected ? "▶ " : "  "}</Text>
        <Text color={g.color}>{g.symbol} </Text>
        <Text color={selected ? "cyan" : "white"} bold={selected}>
          {run.workflow}
        </Text>
        <Text color="gray">
          {"  "}
          {when} · {meta}
        </Text>
      </Box>
      <Box paddingLeft={4}>
        <Text color="gray" wrap="truncate-end">
          {truncate(run.input.replace(/\s+/g, " ").trim() || "(no input)", Math.max(20, width - 6))}
        </Text>
      </Box>
    </Box>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}
