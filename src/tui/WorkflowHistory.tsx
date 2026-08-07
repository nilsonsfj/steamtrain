import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { truncate } from "../agents/util";
import {
  type HistoryBrowserEntry,
  type HistoryStatusFilter,
  type LiveRunMeta,
  type RunRecord,
  type RunRecordSummary,
  buildHistoryBrowserEntries,
  formatRelativeTime,
  formatRunTotals,
  historyStatusLabel,
  recordHasRetryCandidates,
} from "../workflow";
import { selectVisibleWindow } from "./workflow-list-window";

interface WorkflowHistoryProps {
  runs: RunRecordSummary[];
  /** In-flight (queued/running) runs listed above past runs; Enter attaches. */
  liveRuns: LiveRunMeta[];
  /** Selection index across the *filtered* entry list. */
  selectedIndex: number;
  loading: boolean;
  error?: string;
  /** Free-text filter across workflow / input / id / status. */
  query: string;
  /** Whether the filter line is capturing keystrokes. */
  filtering: boolean;
  statusFilter: HistoryStatusFilter;
  width: number;
  height: number;
}

const STATUS_GLYPH: Record<RunRecordSummary["status"], { symbol: string; color: string }> = {
  done: { symbol: "✓", color: "green" },
  error: { symbol: "✗", color: "red" },
  canceled: { symbol: "⊘", color: "yellow" },
  "budget-exceeded": { symbol: "$", color: "yellow" },
};

type RenderRow =
  | { kind: "section"; label: string; count: number }
  | { kind: "entry"; entry: HistoryBrowserEntry; index: number };

/**
 * A browser for workflow runs: in-flight runs (attachable) above recorded
 * history, with search + status chips. ↑/↓ select, Enter attaches (live) or
 * inspects (past), `/` filters, `t` cycles status, Esc closes.
 */
export function WorkflowHistory({
  runs,
  liveRuns,
  selectedIndex,
  loading,
  error,
  query,
  filtering,
  statusFilter,
  width,
  height,
}: WorkflowHistoryProps) {
  const innerWidth = Math.max(20, width - 4);
  const entries = buildHistoryBrowserEntries({ runs, liveRuns, query, statusFilter });
  const clamped = Math.min(selectedIndex, Math.max(0, entries.length - 1));
  const rows = buildRenderRows(entries);
  // Header (title) + filter line + footer hint ≈ 3 rows reserved.
  const listBudget = Math.max(1, height - 4);
  const window = selectVisibleWindow(rows, indexOfSelectedRow(rows, clamped), listBudget);

  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const filterHint =
    statusFilter === "all"
      ? "all"
      : statusFilter === "live"
        ? "live"
        : historyStatusLabel(statusFilter);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} height={height}>
      <Box justifyContent="space-between">
        <Text color="cyan" bold>
          runs
        </Text>
        <Text color="gray">
          {liveRuns.length > 0 ? `${liveRuns.length} active · ` : ""}
          {runs.length} recorded
          {entries.length !== liveRuns.length + runs.length ? ` · ${entries.length} shown` : ""}
          {" · "}
          ↑/↓ · Enter {liveRuns.length > 0 ? "attach/" : ""}inspect · Esc
        </Text>
      </Box>
      <Box>
        <Text color={filtering ? "cyan" : "gray"}>
          {filtering ? "filter › " : "/ filter · t status · "}
        </Text>
        {filtering ? (
          <Text color="white">
            {query}
            <Text color="cyan">█</Text>
          </Text>
        ) : (
          <Text color="gray">
            {query ? `“${truncate(query, Math.max(12, innerWidth - 36))}”` : "type to search"}
            {" · chip: "}
            <Text color="cyan">{filterHint}</Text>
          </Text>
        )}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {loading ? (
          <Text color="gray">loading history…</Text>
        ) : error ? (
          <Text color="red">{error}</Text>
        ) : entries.length === 0 ? (
          <EmptyHistory
            query={query}
            statusFilter={statusFilter}
            hasAny={runs.length + liveRuns.length > 0}
          />
        ) : (
          <>
            {window.hiddenBefore > 0 ? (
              <Text color="gray">{window.hiddenBefore} earlier hidden ↑</Text>
            ) : null}
            {window.visible.map((row) =>
              row.kind === "section" ? (
                <Box key={`section-${row.label}`}>
                  <Text color="gray" dimColor>
                    ── {row.label} ({row.count}){" "}
                    {"─".repeat(Math.max(0, Math.min(24, innerWidth - row.label.length - 10)))}
                  </Text>
                </Box>
              ) : row.entry.kind === "live" && row.entry.live ? (
                <LiveRunRow
                  key={row.entry.id}
                  run={row.entry.live}
                  width={innerWidth}
                  selected={row.index === clamped}
                />
              ) : row.entry.run ? (
                <HistoryRow
                  key={row.entry.id}
                  run={row.entry.run}
                  width={innerWidth}
                  selected={row.index === clamped}
                />
              ) : null,
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

/** Compact status banner shown above the replayed WorkflowView in detail mode. */
export function HistoryDetailBanner({
  record,
  width,
}: {
  record: RunRecord;
  width: number;
}) {
  const g = STATUS_GLYPH[record.status] ?? { symbol: "·", color: "gray" };
  const when = formatRelativeTime(record.startedAt);
  const meta = formatRunTotals(record.totals, { durationMs: record.durationMs, tokens: true });
  const hasWorktrees = record.phases.some((phase) => phase.steps.some((step) => step.worktree));
  const input = truncate(
    record.input.replace(/\s+/g, " ").trim() || "(no input)",
    Math.max(24, width - 8),
  );
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={g.color === "green" ? "green" : g.color === "red" ? "red" : "yellow"}
      paddingX={1}
      marginBottom={0}
    >
      <Box>
        <Text color={g.color}>{g.symbol} </Text>
        <Text bold color="white">
          {record.workflow}
        </Text>
        <Text color="gray">
          {"  "}
          {historyStatusLabel(record.status)} · {when} · {meta}
        </Text>
      </Box>
      <Box>
        <Text color="gray">input </Text>
        <Text color="white">{input}</Text>
      </Box>
      <Box>
        <Text color="gray">
          id {record.id.slice(0, 8)}… · r re-run
          {recordHasRetryCandidates(record) ? " · f retry failed · t retarget" : ""}
          {!record.ok ? " · w why" : ""}
          {hasWorktrees ? " · v diff" : ""}
          {" · d delete · ← back"}
        </Text>
      </Box>
    </Box>
  );
}

function EmptyHistory({
  query,
  statusFilter,
  hasAny,
}: {
  query: string;
  statusFilter: HistoryStatusFilter;
  hasAny: boolean;
}) {
  if (!hasAny) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>
          No runs yet
        </Text>
        <Text color="gray">Launch a workflow and it will show up here - live while it rides,</Text>
        <Text color="gray">then as a recorded arrival you can inspect, re-run, or harvest.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">No runs match this filter.</Text>
      <Text color="gray">
        {query ? `query “${query}”` : "no query"}
        {" · "}
        chip {statusFilter}
        {" · Esc / clear filter to widen"}
      </Text>
    </Box>
  );
}

function buildRenderRows(entries: HistoryBrowserEntry[]): RenderRow[] {
  const rows: RenderRow[] = [];
  let liveCount = 0;
  let recordCount = 0;
  for (const entry of entries) {
    if (entry.kind === "live") liveCount += 1;
    else recordCount += 1;
  }
  let seenLive = false;
  let seenRecord = false;
  let index = 0;
  for (const entry of entries) {
    if (entry.kind === "live" && !seenLive) {
      rows.push({ kind: "section", label: "on the rails", count: liveCount });
      seenLive = true;
    }
    if (entry.kind === "record" && !seenRecord) {
      rows.push({ kind: "section", label: "arrived", count: recordCount });
      seenRecord = true;
    }
    rows.push({ kind: "entry", entry, index });
    index += 1;
  }
  return rows;
}

function indexOfSelectedRow(rows: RenderRow[], selectedIndex: number): number {
  const found = rows.findIndex((row) => row.kind === "entry" && row.index === selectedIndex);
  return found >= 0 ? found : 0;
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
  const when = formatRelativeTime(run.startedAt ?? run.createdAt);
  const badges = [
    run.status,
    run.detached ? "detached" : run.source,
    run.pendingApprovals?.length ? `⏳ approval: ${run.pendingApprovals[0]?.stepId}` : undefined,
    run.pendingInputs?.length ? `✎ input: ${run.pendingInputs[0]?.stepId}` : undefined,
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
          {when} · {badges}
          {selected ? " · Enter attaches" : ""}
        </Text>
      </Box>
      <Box paddingLeft={4}>
        <Text color={selected ? "white" : "gray"} wrap="truncate-end">
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
  const g = STATUS_GLYPH[run.status] ?? { symbol: "·", color: "gray" };
  const when = formatRelativeTime(run.startedAt);
  const meta = formatRunTotals(run.totals, { durationMs: run.durationMs, tokens: true });
  const status = historyStatusLabel(run.status);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={selected ? "cyan" : "gray"}>{selected ? "▶ " : "  "}</Text>
        <Text color={g.color}>{g.symbol} </Text>
        <Text color={selected ? "cyan" : "white"} bold={selected}>
          {run.workflow}
        </Text>
        <Text color={g.color}> {status}</Text>
        <Text color="gray">
          {"  "}
          {when} · {meta}
        </Text>
      </Box>
      <Box paddingLeft={4}>
        <Text color={selected ? "white" : "gray"} wrap="truncate-end">
          {truncate(run.input.replace(/\s+/g, " ").trim() || "(no input)", Math.max(20, width - 6))}
        </Text>
      </Box>
    </Box>
  );
}
