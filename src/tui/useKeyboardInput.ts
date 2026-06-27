import { useCallback, useRef } from "react";
import { useApp, useInput } from "ink";
import type { WorkflowCreateState } from "./WorkflowCreate";
import type { Mode } from "./modes";
import type { HistoryUiState } from "./useHistory";
import type { WorkflowSpec } from "../workflow";
import { isSlashCommandInput } from "../commands";
import {
  shouldDismissSuggestionMenu,
  shouldSuppressWorkflowNavigation,
} from "./slash-completion";
import {
  shouldPromptHistoryCaptureDown,
  shouldPromptHistoryCaptureUp,
} from "./prompt-history";
import type { PromptArrowContext, PromptHistoryByMode, PromptHistoryBrowse } from "./prompt-history";
import { workflowListNavigation } from "./prompt-editing";
import { nextMode } from "./modes";

export interface UseKeyboardInputParams {
  mode: Mode;
  modes: readonly Mode[];
  running: boolean;
  promptEditing: boolean;
  value: string;
  commandSuggestions: readonly string[];
  history: HistoryUiState | null;
  setHistory: React.Dispatch<React.SetStateAction<HistoryUiState | null>>;
  openHistoryRecord: (id: string) => void;
  rerunFromRecord: (record: import("../workflow").RunRecord, mode: import("../workflow").RerunMode) => void;
  wfPreview: { name: string; input: string } | null;
  setWfPreview: React.Dispatch<React.SetStateAction<{ name: string; input: string } | null>>;
  wfCreate: WorkflowCreateState | null;
  setWfCreate: React.Dispatch<React.SetStateAction<WorkflowCreateState | null>>;
  createAbortRef: React.RefObject<AbortController | null>;
  wfStepDetails: "preview" | "live" | null;
  setWfStepDetails: React.Dispatch<React.SetStateAction<"preview" | "live" | null>>;
  showWorkflowView: boolean;
  previewSpec: WorkflowSpec | undefined;
  previewStepCount: number;
  stepIndex: number;
  setStepIndex: React.Dispatch<React.SetStateAction<number>>;
  workflowIndex: number;
  setWorkflowIndex: React.Dispatch<React.SetStateAction<number>>;
  workflowEntries: readonly { name: string }[];
  totalWfSteps: number;
  wf: { started: boolean };
  wfLaunching: boolean;
  wfDispatch: React.Dispatch<{ type: "reset" }>;
  activeWorkflowRef: React.MutableRefObject<string | undefined>;
  activeWorkflowInputRef: React.MutableRefObject<string | undefined>;
  workflowCacheRef: React.MutableRefObject<Map<string, unknown>>;
  setWfNotice: (notice: string | null) => void;
  setWfLaunching: React.Dispatch<React.SetStateAction<boolean>>;
  abortRef: React.MutableRefObject<AbortController | null>;
  workflowPickerActive: boolean;
  focusCreateWorkflowPrompt: (seed: string) => void;
  exitPromptEditing: () => void;
  switchMode: (next: React.SetStateAction<Mode>) => void;
  setCommandSuggestions: React.Dispatch<React.SetStateAction<readonly string[]>>;
  setSuggestionIndex: React.Dispatch<React.SetStateAction<number>>;
  promptHistoryByMode: PromptHistoryByMode;
  historyBrowse: PromptHistoryBrowse;
  promptArrowCtx: PromptArrowContext;
}

export function useKeyboardInput(params: UseKeyboardInputParams) {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const { exit } = useApp();

  useInput(
    useCallback((input, key) => {
      const cur = paramsRef.current;

      if (key.ctrl && input === "c") {
        cur.abortRef.current?.abort();
        exit();
        return;
      }
      // The history browser is a modal overlay: while open it owns all keys.
      if (cur.history) {
        if (key.escape || (key.leftArrow && cur.history.view === "list")) {
          if (cur.history.view === "detail") {
            if (cur.history.detail) {
              cur.setHistory({ ...cur.history, detail: false });
            } else {
              cur.setHistory({ ...cur.history, view: "list", record: undefined, recordState: undefined });
            }
          } else {
            cur.setHistory(null);
          }
          return;
        }
        if (cur.history.view === "list") {
          if (key.upArrow) {
            cur.setHistory({ ...cur.history, index: Math.max(0, cur.history.index - 1) });
          } else if (key.downArrow) {
            cur.setHistory({
              ...cur.history,
              index: Math.min(Math.max(0, cur.history.runs.length - 1), cur.history.index + 1),
            });
          } else if (key.return) {
            const run = cur.history.runs[cur.history.index];
            if (run) cur.openHistoryRecord(run.id);
          }
          return;
        }
        // Detail view: re-run / retry-failed, navigate steps, toggle drill-in.
        if (!cur.history.detail && input === "r" && cur.history.record) {
          cur.rerunFromRecord(cur.history.record, "rerun");
          return;
        }
        if (
          !cur.history.detail &&
          input === "f" &&
          cur.history.record &&
          (cur.history.record.totals?.failed ?? 0) > 0
        ) {
          cur.rerunFromRecord(cur.history.record, "retry-failed");
          return;
        }
        const totalSteps = cur.history.recordState
          ? cur.history.recordState.phases.reduce((n, p) => n + p.steps.length, 0)
          : 0;
        if (key.leftArrow && cur.history.detail) {
          cur.setHistory({ ...cur.history, detail: false });
        } else if (key.rightArrow && !cur.history.detail && totalSteps > 0) {
          cur.setHistory({ ...cur.history, detail: true });
        } else if (key.upArrow) {
          cur.setHistory({ ...cur.history, stepIndex: Math.max(0, cur.history.stepIndex - 1) });
        } else if (key.downArrow) {
          cur.setHistory({
            ...cur.history,
            stepIndex: Math.min(Math.max(0, totalSteps - 1), cur.history.stepIndex + 1),
          });
        }
        return;
      }
      if (key.escape) {
        if (shouldDismissSuggestionMenu(cur.commandSuggestions, cur.value)) {
          cur.setCommandSuggestions([]);
          cur.setSuggestionIndex(0);
          return;
        }
        if (cur.wfStepDetails) {
          cur.setWfStepDetails(null);
          return;
        }
        if (cur.wfCreate) {
          cur.createAbortRef.current?.abort();
          cur.setWfCreate(null);
          return;
        }
        if (cur.running) {
          if (cur.mode !== "workflow") {
            cur.abortRef.current?.abort();
          }
          return;
        }
        if (cur.promptEditing) {
          cur.exitPromptEditing();
          return;
        }
        // Not running: preview → picker, or finished run → picker.
        if (cur.mode === "workflow") {
          if (cur.wfPreview) {
            cur.setWfPreview(null);
            cur.setStepIndex(0);
            cur.setWfNotice(null);
            return;
          }
          if (cur.wf.started || cur.wfLaunching) {
            cur.wfDispatch({ type: "reset" });
            cur.setStepIndex(0);
            cur.setWfLaunching(false);
            cur.activeWorkflowRef.current = undefined;
            cur.activeWorkflowInputRef.current = undefined;
            cur.workflowCacheRef.current = new Map();
            cur.setWfNotice(null);
          }
        }
        return;
      }
      // Ctrl+N: jump straight into workflow creation from the picker.
      if (key.ctrl && input === "n" && !cur.running && cur.workflowPickerActive) {
        cur.focusCreateWorkflowPrompt(cur.value);
        return;
      }
      if (key.tab && !key.shift && !cur.running) {
        const promptInputHandlesTab = isSlashCommandInput(cur.value) && cur.promptEditing;
        if (!promptInputHandlesTab) {
          cur.setWfPreview(null);
          cur.setWfLaunching(false);
          cur.setWfStepDetails(null);
          cur.switchMode((prev) => nextMode(prev, cur.modes));
        }
        return;
      }
      const menuOpen = shouldSuppressWorkflowNavigation(cur.commandSuggestions, cur.value);
      const historyUp =
        !menuOpen &&
        shouldPromptHistoryCaptureUp(
          cur.promptHistoryByMode,
          cur.mode,
          cur.value,
          cur.historyBrowse,
          cur.promptArrowCtx,
        );
      const historyDown =
        !menuOpen && shouldPromptHistoryCaptureDown(cur.historyBrowse, cur.promptArrowCtx, cur.value);
      if (cur.mode === "workflow" && !menuOpen && !historyUp && !historyDown) {
        if (key.leftArrow && cur.wfStepDetails) {
          cur.setWfStepDetails(null);
          return;
        }
        if (key.rightArrow && !cur.promptEditing && !cur.wfStepDetails) {
          if (cur.showWorkflowView) {
            cur.setWfStepDetails("live");
            return;
          }
          if (cur.wfPreview && cur.previewSpec) {
            cur.setWfStepDetails("preview");
            return;
          }
        }
        if (key.upArrow) {
          if (cur.wf.started || cur.wfLaunching) {
            cur.setStepIndex((i) => Math.max(0, i - 1));
          } else if (cur.wfPreview) {
            cur.setStepIndex((i) => Math.max(0, i - 1));
          } else {
            const next = Math.max(0, cur.workflowIndex - 1);
            if (next !== cur.workflowIndex) {
              cur.setStepIndex(0);
              cur.setWfStepDetails(null);
            }
            cur.setWorkflowIndex(next);
          }
          return;
        }
        if (key.downArrow) {
          if (cur.wf.started || cur.wfLaunching) {
            cur.setStepIndex((i) => Math.min(Math.max(0, cur.totalWfSteps - 1), i + 1));
          } else if (cur.wfPreview) {
            cur.setStepIndex((i) => Math.min(Math.max(0, cur.previewStepCount - 1), i + 1));
          } else {
            const next = Math.min(cur.workflowEntries.length, cur.workflowIndex + 1);
            if (next !== cur.workflowIndex) {
              cur.setStepIndex(0);
              cur.setWfStepDetails(null);
            }
            cur.setWorkflowIndex(next);
          }
          return;
        }
      }
    }, [exit]),
  );
}
