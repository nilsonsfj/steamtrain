import { useCallback, useRef } from "react";
import { useApp, useInput } from "ink";
import type { Mode } from "./modes";
import { isSlashCommandInput } from "../commands";
import {
  shouldDismissSuggestionMenu,
  shouldSuppressWorkflowNavigation,
} from "./slash-completion";
import {
  shouldPromptHistoryCaptureDown,
  shouldPromptHistoryCaptureUp,
} from "./prompt-history";
import { nextMode } from "./modes";

// Import hooks to use their ReturnType
import type { usePrompt } from "./usePrompt";
import type { useWorkflowPicker } from "./useWorkflowPicker";
import type { useWorkflowRunner } from "./useWorkflowRunner";
import type { useHistory } from "./useHistory";

export interface UseKeyboardInputParams {
  mode: Mode;
  modes: readonly Mode[];
  prompt: ReturnType<typeof usePrompt>;
  picker: ReturnType<typeof useWorkflowPicker>;
  runner: ReturnType<typeof useWorkflowRunner>;
  historyHook: ReturnType<typeof useHistory>;
  workflowPickerActive: boolean;
  focusCreateWorkflowPrompt: (seed: string) => void;
  switchMode: (next: React.SetStateAction<Mode>) => void;
}

export function useKeyboardInput(params: UseKeyboardInputParams) {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const { exit } = useApp();

  useInput(
    useCallback((input, key) => {
      const cur = paramsRef.current;
      const { prompt, picker, runner, historyHook } = cur;

      if (key.ctrl && input === "c") {
        runner.abortRef.current?.abort();
        exit();
        return;
      }
      // The history browser is a modal overlay: while open it owns all keys.
      if (historyHook.history) {
        if (key.escape || (key.leftArrow && historyHook.history.view === "list")) {
          if (historyHook.history.view === "detail") {
            if (historyHook.history.detail) {
              historyHook.setHistory({ ...historyHook.history, detail: false });
            } else {
              historyHook.setHistory({ ...historyHook.history, view: "list", record: undefined, recordState: undefined });
            }
          } else {
            historyHook.setHistory(null);
          }
          return;
        }
        if (historyHook.history.view === "list") {
          if (key.upArrow) {
            historyHook.setHistory({ ...historyHook.history, index: Math.max(0, historyHook.history.index - 1) });
          } else if (key.downArrow) {
            historyHook.setHistory({
              ...historyHook.history,
              index: Math.min(Math.max(0, historyHook.history.runs.length - 1), historyHook.history.index + 1),
            });
          } else if (key.return) {
            const run = historyHook.history.runs[historyHook.history.index];
            if (run) historyHook.openHistoryRecord(run.id);
          }
          return;
        }
        // Detail view: re-run / retry-failed, navigate steps, toggle drill-in.
        if (!historyHook.history.detail && input === "r" && historyHook.history.record) {
          historyHook.rerunFromRecord(historyHook.history.record, "rerun");
          return;
        }
        if (
          !historyHook.history.detail &&
          input === "f" &&
          historyHook.history.record &&
          (historyHook.history.record.totals?.failed ?? 0) > 0
        ) {
          historyHook.rerunFromRecord(historyHook.history.record, "retry-failed");
          return;
        }
        const totalSteps = historyHook.history.recordState
          ? historyHook.history.recordState.phases.reduce((n, p) => n + p.steps.length, 0)
          : 0;
        if (key.leftArrow && historyHook.history.detail) {
          historyHook.setHistory({ ...historyHook.history, detail: false });
        } else if (key.rightArrow && !historyHook.history.detail && totalSteps > 0) {
          historyHook.setHistory({ ...historyHook.history, detail: true });
        } else if (key.upArrow) {
          historyHook.setHistory({ ...historyHook.history, stepIndex: Math.max(0, historyHook.history.stepIndex - 1) });
        } else if (key.downArrow) {
          historyHook.setHistory({
            ...historyHook.history,
            stepIndex: Math.min(Math.max(0, totalSteps - 1), historyHook.history.stepIndex + 1),
          });
        }
        return;
      }
      if (key.escape) {
        if (shouldDismissSuggestionMenu(prompt.commandSuggestions, prompt.value)) {
          prompt.setCommandSuggestions([]);
          prompt.setSuggestionIndex(0);
          return;
        }
        if (runner.wfStepDetails) {
          runner.setWfStepDetails(null);
          return;
        }
        if (picker.wfCreate) {
          picker.createAbortRef.current?.abort();
          picker.setWfCreate(null);
          return;
        }
        if (runner.running) {
          if (cur.mode !== "workflow") {
            runner.abortRef.current?.abort();
          }
          return;
        }
        if (prompt.promptEditing) {
          prompt.exitPromptEditing();
          return;
        }
        // Not running: preview → picker, or finished run → picker.
        if (cur.mode === "workflow") {
          if (picker.wfPreview) {
            picker.setWfPreview(null);
            runner.setStepIndex(0);
            runner.setWfNotice(null);
            return;
          }
          if (runner.wf.started || runner.wfLaunching) {
            runner.wfDispatch({ type: "reset" });
            runner.setStepIndex(0);
            runner.setWfLaunching(false);
            runner.activeWorkflowRef.current = undefined;
            runner.activeWorkflowInputRef.current = undefined;
            runner.workflowCacheRef.current = new Map();
            runner.setWfNotice(null);
          }
        }
        return;
      }
      // Ctrl+N: jump straight into workflow creation from the picker.
      if (key.ctrl && input === "n" && !runner.running && cur.workflowPickerActive) {
        cur.focusCreateWorkflowPrompt(prompt.value);
        return;
      }
      if (key.tab && !key.shift && !runner.running) {
        const promptInputHandlesTab = isSlashCommandInput(prompt.value) && prompt.promptEditing;
        if (!promptInputHandlesTab) {
          picker.setWfPreview(null);
          runner.setWfLaunching(false);
          runner.setWfStepDetails(null);
          cur.switchMode((prev) => nextMode(prev, cur.modes));
        }
        return;
      }
      const menuOpen = shouldSuppressWorkflowNavigation(prompt.commandSuggestions, prompt.value);
      const historyUp =
        !menuOpen &&
        shouldPromptHistoryCaptureUp(
          prompt.promptHistoryByMode,
          cur.mode,
          prompt.value,
          prompt.historyBrowse,
          prompt.promptArrowCtx,
        );
      const historyDown =
        !menuOpen && shouldPromptHistoryCaptureDown(prompt.historyBrowse, prompt.promptArrowCtx, prompt.value);
      if (cur.mode === "workflow" && !menuOpen && !historyUp && !historyDown) {
        if (key.leftArrow && runner.wfStepDetails) {
          runner.setWfStepDetails(null);
          return;
        }
        if (key.rightArrow && !prompt.promptEditing && !runner.wfStepDetails) {
          if (runner.showWorkflowView) {
            runner.setWfStepDetails("live");
            return;
          }
          if (picker.wfPreview && picker.preview.spec) {
            runner.setWfStepDetails("preview");
            return;
          }
        }
        if (key.upArrow) {
          if (runner.wf.started || runner.wfLaunching) {
            runner.setStepIndex((i) => Math.max(0, i - 1));
          } else if (picker.wfPreview) {
            runner.setStepIndex((i) => Math.max(0, i - 1));
          } else {
            const next = Math.max(0, picker.workflowIndex - 1);
            if (next !== picker.workflowIndex) {
              runner.setStepIndex(0);
              runner.setWfStepDetails(null);
            }
            picker.setWorkflowIndex(next);
          }
          return;
        }
        if (key.downArrow) {
          if (runner.wf.started || runner.wfLaunching) {
            runner.setStepIndex((i) => Math.min(Math.max(0, runner.totalWfSteps - 1), i + 1));
          } else if (picker.wfPreview) {
            runner.setStepIndex((i) => Math.min(Math.max(0, picker.preview.stepCount - 1), i + 1));
          } else {
            const next = Math.min(picker.workflowEntries.length, picker.workflowIndex + 1);
            if (next !== picker.workflowIndex) {
              runner.setStepIndex(0);
              runner.setWfStepDetails(null);
            }
            picker.setWorkflowIndex(next);
          }
          return;
        }
      }
    }, [exit]),
  );
}
