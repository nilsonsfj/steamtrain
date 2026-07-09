import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { truncate } from "../agents/util";
import { type LiveRunMeta, type RunRecordSummary, formatRunTotals } from "../workflow";
import { selectVisibleWindow } from "./workflow-list-window";

interface WorkflowHistoryProps {
  runs: RunRecordSummary[];
  /** In-flight (queued/running) runs listed above past runs; Enter attaches. */
  liveRuns: LiveRunMeta[];
  /** Selection index across live runs first, then past runs. */
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
  "budget-exceeded": { symbol: "$", color: "yellow" },
};

/** One selectable row in the browser: a live run or a recorded one. */
type HistoryEntry = { kind: "live"; live: LiveRunMeta } | { kind: "record"; run: RunRecordSummary };

/**
 * A browser for workflow runs: in-flight runs (attachable) above recorded
 * history. ↑/↓ select, Enter attaches (live) or inspects (past), Esc closes.
 */
export function WorkflowHistory({
  runs,
  liveRuns,
  selectedIndex,
  loading,
  error,
  width,
  height,
}: WorkflowHistoryProps) {
  const innerWidth = Math.max(20, width - 4);
  const entries: HistoryEntry[] = [
    ...liveRuns.map((live): HistoryEntry => ({ kind: "live", live })),
    ...runs.map((run): HistoryEntry => ({ kind: "record", run })),
  ];
  const clamped = Math.min(selectedIndex, Math.max(0, entries.length - 1));
  const listBudget = Math.max(1, height - 3);
  const window = selectVisibleWindow(entries, clamped, listBudget);

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} height={height}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          runs
        </Text>
        <Text color="gray">
          {liveRuns.length > 0 ? `${liveRuns.length} active · ` : ""}
          {runs.length} recorded · ↑/↓ select · Enter {liveRuns.length > 0 ? "attach/" : ""}inspect
          · Esc back
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {loading ? (
          <Text color="gray">loading history…</Text>
        ) : error ? (
          <Text color="red">{error}</Text>
        ) : entries.length === 0 ? (
          <Text color="gray">No recorded runs yet. Run a workflow to start building history.</Text>
        ) : (
          <>
            {window.hiddenBefore > 0 ? (
              <Text color="gray">{window.hiddenBefore} earlier hidden ↑</Text>
            ) : null}
            {window.visible.map((entry, offset) =>
              entry.kind === "live" ? (
                <LiveRunRow
                  key={entry.live.id}
                  run={entry.live}
                  width={innerWidth}
                  selected={window.start + offset === clamped}
                />
              ) : (
                <HistoryRow
                  key={entry.run.id}
                  run={entry.run}
                  width={innerWidth}
                  selected={window.start + offset === clamped}
                />
              ),
            )}
            {window.hiddenAfter > 0 ? (
              <Text color="gray">{window.hiddenAfter} later hidden ↓</Text>
            ) : null}
          </>
        )}
      </Box>
    </Box>
  );
}

function LiveRunRow({
  run,
  width,
  selected,
}: {
  run: LiveRunMeta;
  width: number;
  selected: boolean;
}) {
  const glyph = run.status === "queued" ? "⧗" : "▶";
  const when = relativeTime(run.startedAt ?? run.createdAt);
  const badges = [
    run.status,
    run.detached ? "detached" : run.source,
    run.pendingApprovals?.length ? `⏳ approval: ${run.pendingApprovals[0]?.stepId}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={selected ? "cyan" : "gray"}>{selected ? "▶ " : "  "}</Text>
        <Text color={run.status === "queued" ? "yellow" : "green"}>{glyph} </Text>
        <Text color={selected ? "cyan" : "white"} bold={selected}>
          {run.workflow}
        </Text>
        <Text color="gray">
          {"  "}
          {when} · {badges} · Enter attaches
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
  const meta = formatRunTotals(run.totals, { durationMs: run.durationMs, tokens: true });
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
