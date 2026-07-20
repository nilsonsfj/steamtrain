import type { RunRecordStatus, RunRecordSummary } from "./history";
import type { LiveRunMeta } from "./live-run-store";

/**
 * Shared history-browser helpers used by the TUI list and (mirrored in the
 * web client) the History modal. Keeping filter / relative-time / id
 * normalization here means both surfaces stay honest about the same rules.
 */

/** Status chip filter for the runs browser (includes the live-only chip). */
export type HistoryStatusFilter = "all" | "live" | RunRecordStatus;

export const HISTORY_STATUS_FILTERS: readonly HistoryStatusFilter[] = [
  "all",
  "live",
  "done",
  "error",
  "canceled",
  "budget-exceeded",
] as const;

/** Only a non-empty string is a deep-link / detail run id (never a DOM Event). */
export function normalizeHistoryRunId(runId: unknown): string | undefined {
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

/** Cycle the status filter chip (all → live → done → … → all). */
export function nextHistoryStatusFilter(current: HistoryStatusFilter): HistoryStatusFilter {
  const idx = HISTORY_STATUS_FILTERS.indexOf(current);
  return HISTORY_STATUS_FILTERS[(idx + 1) % HISTORY_STATUS_FILTERS.length]!;
}

/** Compact relative time for list rows ("12s ago", "3h ago", "2026-07-18"). */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const diff = Math.max(0, now - ts);
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

/** Human label for a recorded-run status. */
export function historyStatusLabel(status: RunRecordStatus | string): string {
  switch (status) {
    case "done":
      return "done";
    case "error":
      return "failed";
    case "canceled":
      return "canceled";
    case "budget-exceeded":
      return "budget";
    default:
      return String(status);
  }
}

/** Case-insensitive substring match across the fields a user actually looks at. */
export function matchesHistoryQuery(
  query: string,
  fields: { workflow?: string; input?: string; id?: string; status?: string },
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [fields.workflow, fields.input, fields.id, fields.status]
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join("\n")
    .toLowerCase();
  return haystack.includes(q);
}

export interface HistoryBrowserEntry {
  kind: "live" | "record";
  id: string;
  workflow: string;
  input: string;
  status: string;
  startedAt: number;
  live?: LiveRunMeta;
  run?: RunRecordSummary;
}

/**
 * Build the unified, filtered entry list for the history browser: live runs
 * first (attachable), then recorded runs (newest first already from the store).
 */
export function buildHistoryBrowserEntries(opts: {
  runs: readonly RunRecordSummary[];
  liveRuns: readonly LiveRunMeta[];
  query?: string;
  statusFilter?: HistoryStatusFilter;
}): HistoryBrowserEntry[] {
  const query = opts.query ?? "";
  const statusFilter = opts.statusFilter ?? "all";
  const live: HistoryBrowserEntry[] = [];
  const recorded: HistoryBrowserEntry[] = [];

  if (statusFilter === "all" || statusFilter === "live") {
    for (const run of opts.liveRuns) {
      if (
        !matchesHistoryQuery(query, {
          workflow: run.workflow,
          input: run.input,
          id: run.id,
          status: run.status,
        })
      ) {
        continue;
      }
      live.push({
        kind: "live",
        id: run.id,
        workflow: run.workflow,
        input: run.input,
        status: run.status,
        startedAt: run.startedAt ?? run.createdAt,
        live: run,
      });
    }
  }

  if (statusFilter !== "live") {
    for (const run of opts.runs) {
      if (statusFilter !== "all" && run.status !== statusFilter) continue;
      if (
        !matchesHistoryQuery(query, {
          workflow: run.workflow,
          input: run.input,
          id: run.id,
          status: run.status,
        })
      ) {
        continue;
      }
      recorded.push({
        kind: "record",
        id: run.id,
        workflow: run.workflow,
        input: run.input,
        status: run.status,
        startedAt: run.startedAt,
        run,
      });
    }
  }

  return [...live, ...recorded];
}

/** Count how many recorded runs match each status chip (for filter badges). */
export function countHistoryByStatus(
  runs: readonly RunRecordSummary[],
): Record<RunRecordStatus, number> & { total: number } {
  const counts = {
    total: runs.length,
    done: 0,
    error: 0,
    canceled: 0,
    "budget-exceeded": 0,
  };
  for (const run of runs) {
    if (run.status in counts) counts[run.status] += 1;
  }
  return counts;
}
