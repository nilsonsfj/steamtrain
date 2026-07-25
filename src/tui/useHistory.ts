import { useCallback, useEffect, useRef, useState } from "react";
import type {
  HistoryStatusFilter,
  LiveRunMeta,
  LiveRunStore,
  RerunMode,
  RunRecord,
  RunRecordSummary,
  StepResult,
} from "../workflow";
import {
  MergeConflictError,
  buildHistoryBrowserEntries,
  createWorkflowHistoryStore,
  finalRunWorktrees,
  harvestRunWorktrees,
  isRerunError,
  isTerminalLiveRunStatus,
  mergeConflictGuidance,
  nextHistoryStatusFilter,
  planRerun,
  pruneRunWorktrees,
  rerunDowngradeMessage,
} from "../workflow";
import type { HistoryDiffStep } from "./history-diff";
import { loadRunDiff } from "./history-diff";
import { message } from "./util";
import type { WorkflowState } from "./workflow-state";
import { workflowStateFromRecord } from "./workflow-state";

/** State for the past-run history browser (opened with `/history`). */
export interface HistoryUiState {
  view: "list" | "detail";
  runs: RunRecordSummary[];
  /** In-flight (queued/running) runs from the live registry, listed above past runs. */
  liveRuns: LiveRunMeta[];
  /** Selection index across the *filtered* entry list. */
  index: number;
  loading: boolean;
  error?: string;
  record?: RunRecord;
  recordState?: WorkflowState;
  stepIndex: number;
  /** Whether the per-step drill-in panel is open in the detail view. */
  detail: boolean;
  /** Free-text filter across workflow / input / id / status. */
  query: string;
  /** True while `/` filter mode is capturing printable keys. */
  filtering: boolean;
  statusFilter: HistoryStatusFilter;
  /** Full-screen run-diff overlay (opened from the detail view with `v`). */
  diffView?: HistoryDiffViewState;
}

/** State of the full-screen run-diff overlay. */
export interface HistoryDiffViewState {
  recordId: string;
  workflow: string;
  loading: boolean;
  steps: HistoryDiffStep[];
  /** First visible composed line. */
  scroll: number;
}

export interface UseHistoryParams {
  historyStoreRef: React.RefObject<ReturnType<typeof createWorkflowHistoryStore>>;
  /** Live-run registry, for the in-flight section of the browser. */
  liveRunStoreRef: React.RefObject<LiveRunStore>;
  mountedRef: React.RefObject<boolean>;
  resolveWorkflowSpec: (name: string) => import("../workflow").WorkflowSpec | undefined;
  runWorkflow: (
    name: string,
    input: string,
    opts?: {
      reuseMemoryCache?: boolean;
      fresh?: boolean;
      seed?: Map<string, StepResult>;
      params?: Record<string, string | number | boolean>;
    },
  ) => boolean;
  setWfNotice: (notice: string | null) => void;
  /** Absolute project directory (honors `--project-dir`). */
  cwd: string;
}

export interface UseHistoryReturn {
  history: HistoryUiState | null;
  setHistory: React.Dispatch<React.SetStateAction<HistoryUiState | null>>;
  openHistory: () => { handled: true; clearInput: true };
  openHistoryRecord: (id: string) => void;
  rerunFromRecord: (record: RunRecord, mode: RerunMode) => void;
  /**
   * Post-run worktree lifecycle from the history detail view: `apply` merges
   * the run's worktrees into the checkout (uncommitted); `prune` discards
   * them (double-press to confirm — it deletes unapplied work).
   */
  harvestFromRecord: (record: RunRecord, action: "apply" | "prune") => void;
  /** Delete one recorded run (double-press to confirm). */
  deleteHistoryRecord: (record: { id: string }) => void;
  /** Refresh list contents without leaving the browser. */
  refreshHistoryList: () => void;
  /** Open the full-screen diff overlay for a recorded run (from detail view). */
  openDiffView: (record: RunRecord) => void;
  closeDiffView: () => void;
  /** Scroll the diff overlay; page motions use the last reported viewport. */
  scrollDiffBy: (delta: number | "page-up" | "page-down") => void;
  scrollDiffTo: (position: "top" | "bottom") => void;
  /** Reported by the diff panel after each render, for scroll clamping. */
  reportDiffMetrics: (metrics: { totalLines: number; viewport: number }) => void;
}

const emptyHistory = (): HistoryUiState => ({
  view: "list",
  runs: [],
  liveRuns: [],
  index: 0,
  loading: true,
  stepIndex: 0,
  detail: false,
  query: "",
  filtering: false,
  statusFilter: "all",
});

export function useHistory({
  historyStoreRef,
  liveRunStoreRef,
  mountedRef,
  resolveWorkflowSpec,
  runWorkflow,
  setWfNotice,
  cwd,
}: UseHistoryParams): UseHistoryReturn {
  const [history, setHistory] = useState<HistoryUiState | null>(null);

  const loadList = useCallback(
    async (opts?: { silent?: boolean }) => {
      try {
        if (!opts?.silent) {
          setHistory((prev) => (prev ? { ...prev, loading: true, error: undefined } : prev));
        }
        const [runs, allLive] = await Promise.all([
          historyStoreRef.current!.list(),
          liveRunStoreRef.current!.list().catch(() => []),
        ]);
        const liveRuns = allLive.filter((run) => !isTerminalLiveRunStatus(run.status));
        if (!mountedRef.current) return;
        setHistory((prev) => {
          if (!prev) return prev;
          const entries = buildHistoryBrowserEntries({
            runs,
            liveRuns,
            query: prev.query,
            statusFilter: prev.statusFilter,
          });
          return {
            ...prev,
            runs,
            liveRuns,
            loading: false,
            error: undefined,
            index: Math.min(prev.index, Math.max(0, entries.length - 1)),
          };
        });
      } catch (err) {
        if (!mountedRef.current) return;
        setHistory((prev) => (prev ? { ...prev, loading: false, error: message(err) } : prev));
      }
    },
    [historyStoreRef, liveRunStoreRef, mountedRef],
  );

  const openHistory = useCallback(() => {
    setHistory(emptyHistory());
    void loadList();
    return { handled: true as const, clearInput: true as const };
  }, [loadList]);

  const refreshHistoryList = useCallback(() => {
    void loadList({ silent: true });
  }, [loadList]);

  // Keep the live section fresh while the list is open (new attaches, settles).
  const listOpen = history !== null && history.view === "list";
  useEffect(() => {
    if (!listOpen) return;
    const id = setInterval(() => {
      void loadList({ silent: true });
    }, 2_500);
    return () => clearInterval(id);
  }, [listOpen, loadList]);

  const openHistoryRecord = useCallback(
    (id: string) => {
      void (async () => {
        try {
          const record = await historyStoreRef.current!.get(id);
          if (!mountedRef.current) return;
          if (!record) {
            setWfNotice(`history record '${id}' is missing or corrupt`);
            void loadList({ silent: true });
            return;
          }
          setHistory((prev) =>
            prev
              ? {
                  ...prev,
                  view: "detail",
                  filtering: false,
                  record,
                  recordState: workflowStateFromRecord(record),
                  stepIndex: 0,
                  detail: false,
                }
              : prev,
          );
        } catch (err) {
          if (mountedRef.current) {
            setWfNotice(`could not open history record: ${message(err)}`);
          }
        }
      })();
    },
    [historyStoreRef, loadList, mountedRef, setWfNotice],
  );

  const rerunFromRecord = useCallback(
    (record: RunRecord, mode: RerunMode) => {
      const plan = planRerun(record, mode, resolveWorkflowSpec(record.workflow), {
        cwd,
      });
      if (isRerunError(plan)) {
        setWfNotice(plan.error);
        return;
      }
      if (plan.downgraded) {
        setWfNotice(rerunDowngradeMessage(plan.downgraded));
      }
      const started = runWorkflow(plan.workflow, plan.input, {
        fresh: mode === "rerun" || Boolean(plan.downgraded),
        seed: plan.seedCache,
        params: plan.params,
      });
      // Only leave the history browser once the run actually launched; a
      // refused launch (re-entrancy guard, unknown workflow) keeps the view.
      if (started) setHistory(null);
    },
    [resolveWorkflowSpec, runWorkflow, setWfNotice, cwd],
  );

  // Prune / delete require a second press on the same record within a few seconds.
  const pruneConfirmRef = useRef<{ id: string; at: number } | null>(null);
  const deleteConfirmRef = useRef<{ id: string; at: number } | null>(null);
  const harvestBusyRef = useRef(false);
  // Diff overlay: latest viewport metrics (for clamping) and a load token so a
  // stale async load can't populate a panel that was closed or re-targeted.
  const diffMetricsRef = useRef({ totalLines: 0, viewport: 1 });
  const diffLoadRef = useRef(0);

  const harvestFromRecord = useCallback(
    (record: RunRecord, action: "apply" | "prune") => {
      if (harvestBusyRef.current) return;
      if (finalRunWorktrees(record).length === 0) {
        setWfNotice(`run '${record.id}' has no step worktrees`);
        return;
      }
      if (action === "prune") {
        const armed = pruneConfirmRef.current;
        if (!armed || armed.id !== record.id || Date.now() - armed.at > 5_000) {
          pruneConfirmRef.current = { id: record.id, at: Date.now() };
          setWfNotice("press x again to discard this run's worktrees (unapplied changes are lost)");
          return;
        }
        pruneConfirmRef.current = null;
      }
      harvestBusyRef.current = true;
      setWfNotice(
        action === "apply" ? "merging worktrees into the checkout…" : "pruning worktrees…",
      );
      void (async () => {
        const store = historyStoreRef.current!;
        try {
          if (action === "apply") {
            const { result } = await harvestRunWorktrees(store, record);
            setWfNotice(
              result.noChanges
                ? "no changes to apply"
                : `applied ${result.mergedSources.join(", ")} (uncommitted): ${result.files.length} file(s) +${result.additions} -${result.deletions}`,
            );
          } else {
            const { pruned, total } = await pruneRunWorktrees(store, record);
            setWfNotice(`pruned ${pruned}/${total} worktree(s)`);
          }
        } catch (err) {
          setWfNotice(
            err instanceof MergeConflictError
              ? `${message(err)} — ${mergeConflictGuidance("history")}`
              : message(err),
          );
        } finally {
          harvestBusyRef.current = false;
        }
      })();
    },
    [historyStoreRef, setWfNotice],
  );

  const openDiffView = useCallback(
    (record: RunRecord) => {
      if (finalRunWorktrees(record).length === 0) {
        setWfNotice(`run '${record.id}' has no step worktrees`);
        return;
      }
      const token = ++diffLoadRef.current;
      diffMetricsRef.current = { totalLines: 0, viewport: 1 };
      setHistory((prev) =>
        prev
          ? {
              ...prev,
              diffView: {
                recordId: record.id,
                workflow: record.workflow,
                loading: true,
                steps: [],
                scroll: 0,
              },
            }
          : prev,
      );
      void (async () => {
        try {
          const steps = await loadRunDiff(record);
          if (!mountedRef.current) return;
          setHistory((prev) => {
            // The panel was closed or re-targeted while the diff loaded.
            if (!prev?.diffView || prev.diffView.recordId !== record.id) return prev;
            if (token !== diffLoadRef.current) return prev;
            return { ...prev, diffView: { ...prev.diffView, loading: false, steps } };
          });
        } catch (err) {
          if (mountedRef.current) setWfNotice(`could not compute run diff: ${message(err)}`);
        }
      })();
    },
    [mountedRef, setWfNotice],
  );

  const closeDiffView = useCallback(() => {
    diffLoadRef.current += 1; // cancel any in-flight load
    setHistory((prev) => (prev?.diffView ? { ...prev, diffView: undefined } : prev));
  }, []);

  const reportDiffMetrics = useCallback((metrics: { totalLines: number; viewport: number }) => {
    diffMetricsRef.current = metrics;
  }, []);

  const scrollDiffBy = useCallback((delta: number | "page-up" | "page-down") => {
    setHistory((prev) => {
      if (!prev?.diffView) return prev;
      const { totalLines, viewport } = diffMetricsRef.current;
      const maxScroll = Math.max(0, totalLines - viewport);
      const page = Math.max(1, viewport - 1);
      const amount = delta === "page-up" ? -page : delta === "page-down" ? page : delta;
      const scroll = Math.min(Math.max(0, prev.diffView.scroll + amount), maxScroll);
      return { ...prev, diffView: { ...prev.diffView, scroll } };
    });
  }, []);

  const scrollDiffTo = useCallback((position: "top" | "bottom") => {
    setHistory((prev) => {
      if (!prev?.diffView) return prev;
      const { totalLines, viewport } = diffMetricsRef.current;
      const scroll = position === "top" ? 0 : Math.max(0, totalLines - viewport);
      return { ...prev, diffView: { ...prev.diffView, scroll } };
    });
  }, []);

  const deleteHistoryRecord = useCallback(
    (record: { id: string }) => {
      const armed = deleteConfirmRef.current;
      if (!armed || armed.id !== record.id || Date.now() - armed.at > 5_000) {
        deleteConfirmRef.current = { id: record.id, at: Date.now() };
        setWfNotice("press d again to delete this recorded run from history");
        return;
      }
      deleteConfirmRef.current = null;
      void (async () => {
        try {
          await historyStoreRef.current!.remove(record.id);
          if (!mountedRef.current) return;
          setWfNotice(`deleted run ${record.id.slice(0, 8)}…`);
          setHistory((prev) => {
            if (!prev) return prev;
            const runs = prev.runs.filter((run) => run.id !== record.id);
            const entries = buildHistoryBrowserEntries({
              runs,
              liveRuns: prev.liveRuns,
              query: prev.query,
              statusFilter: prev.statusFilter,
            });
            return {
              ...prev,
              view: "list",
              runs,
              record: undefined,
              recordState: undefined,
              detail: false,
              stepIndex: 0,
              index: Math.min(prev.index, Math.max(0, entries.length - 1)),
            };
          });
          void loadList({ silent: true });
        } catch (err) {
          if (mountedRef.current) setWfNotice(`could not delete run: ${message(err)}`);
        }
      })();
    },
    [historyStoreRef, loadList, mountedRef, setWfNotice],
  );

  return {
    history,
    setHistory,
    openHistory,
    openHistoryRecord,
    rerunFromRecord,
    harvestFromRecord,
    deleteHistoryRecord,
    refreshHistoryList,
    openDiffView,
    closeDiffView,
    scrollDiffBy,
    scrollDiffTo,
    reportDiffMetrics,
  };
}

/** Cycle the status chip and clamp the selection into the new filtered list. */
export function applyHistoryStatusCycle(prev: HistoryUiState): HistoryUiState {
  const statusFilter = nextHistoryStatusFilter(prev.statusFilter);
  const entries = buildHistoryBrowserEntries({
    runs: prev.runs,
    liveRuns: prev.liveRuns,
    query: prev.query,
    statusFilter,
  });
  return {
    ...prev,
    statusFilter,
    index: Math.min(prev.index, Math.max(0, entries.length - 1)),
  };
}

/** Update the free-text query and keep selection on a valid filtered row. */
export function applyHistoryQuery(prev: HistoryUiState, query: string): HistoryUiState {
  const entries = buildHistoryBrowserEntries({
    runs: prev.runs,
    liveRuns: prev.liveRuns,
    query,
    statusFilter: prev.statusFilter,
  });
  return {
    ...prev,
    query,
    index: Math.min(prev.index, Math.max(0, entries.length - 1)),
  };
}
