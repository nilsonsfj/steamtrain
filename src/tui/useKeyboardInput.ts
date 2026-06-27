import { useApp, useInput } from "ink";
import type { WorkflowCreateState } from "./WorkflowCreate";
import type { Mode } from "./modes";
import type { HistoryUiState } from "./useHistory";
import type { WorkflowSpec } from "../workflow";
import {
  isSlashCommandInput,
} from "../commands";
import {
  shouldDismissSuggestionMenu,
  shouldSuppressWorkflowNavigation,
} from "./slash-completion";
import {
  shouldPromptHistoryCaptureDown,
  shouldPromptHistoryCaptureUp,
} from "./prompt-history";
import type { PromptArrowContext, PromptHistoryByMode } from "./prompt-history";
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
  promptHistoryByMode: unknown;
  historyBrowse: unknown;
  promptArrowCtx: PromptArrowContext;
}

export function useKeyboardInput(params: UseKeyboardInputParams) {
  const {
    mode,
    modes,
    running,
    promptEditing,
    value,
    commandSuggestions,
    history,
    setHistory,
    openHistoryRecord,
    rerunFromRecord,
    wfPreview,
    setWfPreview,
    wfCreate,
    setWfCreate,
    createAbortRef,
    wfStepDetails,
    setWfStepDetails,
    showWorkflowView,
    previewSpec,
    previewStepCount,
    stepIndex,
    setStepIndex,
    workflowIndex,
    setWorkflowIndex,
    workflowEntries,
    totalWfSteps,
    wf,
    wfLaunching,
    wfDispatch,
    activeWorkflowRef,
    activeWorkflowInputRef,
    workflowCacheRef,
    setWfNotice,
    setWfLaunching,
    abortRef,
    workflowPickerActive,
    focusCreateWorkflowPrompt,
    exitPromptEditing,
    switchMode,
    setCommandSuggestions,
    setSuggestionIndex,
    promptHistoryByMode,
    historyBrowse,
    promptArrowCtx,
  } = params;

  const { exit } = useApp();

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      abortRef.current?.abort();
      exit();
      return;
    }
    // The history browser is a modal overlay: while open it owns all keys.
    if (history) {
      if (key.escape || (key.leftArrow && history.view === "list")) {
        if (history.view === "detail") {
          if (history.detail) setHistory({ ...history, detail: false });
          else setHistory({ ...history, view: "list", record: undefined, recordState: undefined });
        } else {
          setHistory(null);
        }
        return;
      }
      if (history.view === "list") {
        if (key.upArrow) {
          setHistory({ ...history, index: Math.max(0, history.index - 1) });
        } else if (key.downArrow) {
          setHistory({
            ...history,
            index: Math.min(Math.max(0, history.runs.length - 1), history.index + 1),
          });
        } else if (key.return) {
          const run = history.runs[history.index];
          if (run) openHistoryRecord(run.id);
        }
        return;
      }
      // Detail view: re-run / retry-failed, navigate steps, toggle drill-in.
      if (!history.detail && input === "r" && history.record) {
        rerunFromRecord(history.record, "rerun");
        return;
      }
      if (
        !history.detail &&
        input === "f" &&
        history.record &&
        (history.record.totals?.failed ?? 0) > 0
      ) {
        rerunFromRecord(history.record, "retry-failed");
        return;
      }
      const totalSteps = history.recordState
        ? history.recordState.phases.reduce((n, p) => n + p.steps.length, 0)
        : 0;
      if (key.leftArrow && history.detail) {
        setHistory({ ...history, detail: false });
      } else if (key.rightArrow && !history.detail && totalSteps > 0) {
        setHistory({ ...history, detail: true });
      } else if (key.upArrow) {
        setHistory({ ...history, stepIndex: Math.max(0, history.stepIndex - 1) });
      } else if (key.downArrow) {
        setHistory({
          ...history,
          stepIndex: Math.min(Math.max(0, totalSteps - 1), history.stepIndex + 1),
        });
      }
      return;
    }
    if (key.escape) {
      if (shouldDismissSuggestionMenu(commandSuggestions, value)) {
        setCommandSuggestions([]);
        setSuggestionIndex(0);
        return;
      }
      if (wfStepDetails) {
        setWfStepDetails(null);
        return;
      }
      if (wfCreate) {
        createAbortRef.current?.abort();
        setWfCreate(null);
        return;
      }
      if (running) {
        if (mode !== "workflow") {
          abortRef.current?.abort();
        }
        return;
      }
      if (promptEditing) {
        exitPromptEditing();
        return;
      }
      // Not running: preview → picker, or finished run → picker.
      if (mode === "workflow") {
        if (wfPreview) {
          setWfPreview(null);
          setStepIndex(0);
          setWfNotice(null);
          return;
        }
        if (wf.started || wfLaunching) {
          wfDispatch({ type: "reset" });
          setStepIndex(0);
          setWfLaunching(false);
          activeWorkflowRef.current = undefined;
          activeWorkflowInputRef.current = undefined;
          workflowCacheRef.current = new Map();
          setWfNotice(null);
        }
      }
      return;
    }
    // Ctrl+N: jump straight into workflow creation from the picker.
    if (key.ctrl && input === "n" && !running && workflowPickerActive) {
      focusCreateWorkflowPrompt(value);
      return;
    }
    if (key.tab && !key.shift && !running) {
      const promptInputHandlesTab = isSlashCommandInput(value) && promptEditing;
      if (!promptInputHandlesTab) {
        setWfPreview(null);
        setWfLaunching(false);
        setWfStepDetails(null);
        switchMode((prev) => nextMode(prev, modes));
      }
      return;
    }
    const menuOpen = shouldSuppressWorkflowNavigation(commandSuggestions, value);
    const historyUp =
      !menuOpen &&
      shouldPromptHistoryCaptureUp(
        promptHistoryByMode as any,
        mode,
        value,
        historyBrowse as any,
        promptArrowCtx,
      );
    const historyDown =
      !menuOpen && shouldPromptHistoryCaptureDown(historyBrowse as any, promptArrowCtx, value);
    if (mode === "workflow" && !menuOpen && !historyUp && !historyDown) {
      if (key.leftArrow && wfStepDetails) {
        setWfStepDetails(null);
        return;
      }
      if (key.rightArrow && !promptEditing && !wfStepDetails) {
        if (showWorkflowView) {
          setWfStepDetails("live");
          return;
        }
        if (wfPreview && previewSpec) {
          setWfStepDetails("preview");
          return;
        }
      }
      if (key.upArrow) {
        if (wf.started || wfLaunching) setStepIndex((i) => Math.max(0, i - 1));
        else if (wfPreview) setStepIndex((i) => Math.max(0, i - 1));
        else {
          const next = Math.max(0, workflowIndex - 1);
          if (next !== workflowIndex) {
            setStepIndex(0);
            setWfStepDetails(null);
          }
          setWorkflowIndex(next);
        }
        return;
      }
      if (key.downArrow) {
        if (wf.started || wfLaunching) {
          setStepIndex((i) => Math.min(Math.max(0, totalWfSteps - 1), i + 1));
        } else if (wfPreview) {
          setStepIndex((i) => Math.min(Math.max(0, previewStepCount - 1), i + 1));
        } else {
          const next = Math.min(workflowEntries.length, workflowIndex + 1);
          if (next !== workflowIndex) {
            setStepIndex(0);
            setWfStepDetails(null);
          }
          setWorkflowIndex(next);
        }
        return;
      }
    }
  });
}
