import { useCallback, useRef, useState } from "react";
import type { RunRecord, RerunMode, RunRecordSummary, StepResult } from "../workflow";
import {
  createWorkflowHistoryStore,
  isRerunError,
  planRerun,
  rerunDowngradeMessage,
} from "../workflow";
import type { WorkflowState } from "./workflow-state";
import { workflowStateFromRecord } from "./workflow-state";

/** State for the past-run history browser (opened with `/history`). */
export interface HistoryUiState {
  view: "list" | "detail";
  runs: RunRecordSummary[];
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
  mountedRef: React.RefObject<boolean>;
  resolveWorkflowSpec: (name: string) => import("../workflow").WorkflowSpec | undefined;
  runWorkflow: (
    name: string,
    input: string,
    opts?: { reuseMemoryCache?: boolean; fresh?: boolean; seed?: Map<string, StepResult> },
  ) => boolean;
  setWfNotice: (notice: string | null) => void;
}

export interface UseHistoryReturn {
  history: HistoryUiState | null;
  setHistory: React.Dispatch<React.SetStateAction<HistoryUiState | null>>;
  openHistory: () => { handled: true; clearInput: true };
  openHistoryRecord: (id: string) => void;
  rerunFromRecord: (record: RunRecord, mode: RerunMode) => void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useHistory({
  historyStoreRef,
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
      index: 0,
      loading: true,
      stepIndex: 0,
      detail: false,
    });
    void (async () => {
      try {
        const runs = await historyStoreRef.current!.list();
        if (!mountedRef.current) return;
        setHistory((prev) => (prev ? { ...prev, runs, loading: false } : prev));
      } catch (err) {
        if (!mountedRef.current) return;
        setHistory((prev) => (prev ? { ...prev, loading: false, error: message(err) } : prev));
      }
    })();
    return { handled: true as const, clearInput: true as const };
  }, [historyStoreRef, mountedRef]);

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
      setHistory(null);
      if (plan.downgraded) {
        setWfNotice(rerunDowngradeMessage(plan.downgraded));
      }
      runWorkflow(plan.workflow, plan.input, {
        fresh: mode === "rerun" || Boolean(plan.downgraded),
        seed: plan.seedCache,
      });
    },
    [resolveWorkflowSpec, runWorkflow, setWfNotice],
  );

  return { history, setHistory, openHistory, openHistoryRecord, rerunFromRecord };
}
