import { useCallback, useRef, useState } from "react";
import type {
  LiveRunMeta,
  LiveRunStore,
  RerunMode,
  RunRecord,
  RunRecordSummary,
  StepResult,
} from "../workflow";
import {
  MergeConflictError,
  createWorkflowHistoryStore,
  finalRunWorktrees,
  harvestRunWorktrees,
  isRerunError,
  isTerminalLiveRunStatus,
  mergeConflictGuidance,
  planRerun,
  pruneRunWorktrees,
  rerunDowngradeMessage,
} from "../workflow";
import { message } from "./util";
import type { WorkflowState } from "./workflow-state";
import { workflowStateFromRecord } from "./workflow-state";

/** State for the past-run history browser (opened with `/history`). */
export interface HistoryUiState {
  view: "list" | "detail";
  runs: RunRecordSummary[];
  /** In-flight (queued/running) runs from the live registry, listed above past runs. */
  liveRuns: LiveRunMeta[];
  index: number;
  loading: boolean;
  error?: string;
  record?: RunRecord;
  recordState?: WorkflowState;
  stepIndex: number;
  /** Whether the per-step drill-in panel is open in the detail view. */
  detail: boolean;
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
}

export function useHistory({
  historyStoreRef,
  liveRunStoreRef,
  mountedRef,
  resolveWorkflowSpec,
  runWorkflow,
  setWfNotice,
}: UseHistoryParams): UseHistoryReturn {
  const [history, setHistory] = useState<HistoryUiState | null>(null);

  const openHistory = useCallback(() => {
    setHistory({
      view: "list",
      runs: [],
      liveRuns: [],
      index: 0,
      loading: true,
      stepIndex: 0,
      detail: false,
    });
    void (async () => {
      try {
        // In-flight runs (queued/running) render above the recorded history;
        // Enter on one attaches instead of opening a record.
        const [runs, allLive] = await Promise.all([
          historyStoreRef.current!.list(),
          liveRunStoreRef.current!.list().catch(() => []),
        ]);
        const liveRuns = allLive.filter((run) => !isTerminalLiveRunStatus(run.status));
        if (!mountedRef.current) return;
        setHistory((prev) => (prev ? { ...prev, runs, liveRuns, loading: false } : prev));
      } catch (err) {
        if (!mountedRef.current) return;
        setHistory((prev) => (prev ? { ...prev, loading: false, error: message(err) } : prev));
      }
    })();
    return { handled: true as const, clearInput: true as const };
  }, [historyStoreRef, liveRunStoreRef, mountedRef]);

  const openHistoryRecord = useCallback(
    (id: string) => {
      void (async () => {
        try {
          const record = await historyStoreRef.current!.get(id);
          if (!mountedRef.current || !record) return;
          setHistory((prev) =>
            prev
              ? {
                  ...prev,
                  view: "detail",
                  record,
                  recordState: workflowStateFromRecord(record),
                  stepIndex: 0,
                  detail: false,
                }
              : prev,
          );
        } catch {
          // A missing/corrupt record just leaves the list view in place.
        }
      })();
    },
    [historyStoreRef, mountedRef],
  );

  const rerunFromRecord = useCallback(
    (record: RunRecord, mode: RerunMode) => {
      const plan = planRerun(record, mode, resolveWorkflowSpec(record.workflow), {
        cwd: process.cwd(),
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
    [resolveWorkflowSpec, runWorkflow, setWfNotice],
  );

  // Prune deletes unapplied work, so it requires a second press on the same
  // record within a few seconds; any other action clears the armed state.
  const pruneConfirmRef = useRef<{ id: string; at: number } | null>(null);
  const harvestBusyRef = useRef(false);

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

  return {
    history,
    setHistory,
    openHistory,
    openHistoryRecord,
    rerunFromRecord,
    harvestFromRecord,
  };
}
