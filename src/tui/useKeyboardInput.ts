import { useApp, useInput } from "ink";
import { useCallback, useRef } from "react";
import { isSlashCommandInput } from "../commands";
import type { Mode } from "./modes";
import { nextMode } from "./modes";
import { shouldPromptHistoryCaptureDown, shouldPromptHistoryCaptureUp } from "./prompt-history";
import { shouldDismissSuggestionMenu, shouldSuppressWorkflowNavigation } from "./slash-completion";

import type { useHistory } from "./useHistory";
// Import hooks to use their ReturnType
import type { usePrompt } from "./usePrompt";
import type { useWorkflowPicker } from "./useWorkflowPicker";
import type { useWorkflowRunner } from "./useWorkflowRunner";

export interface UseKeyboardInputParams {
  mode: Mode;
  modes: readonly Mode[];
  prompt: ReturnType<typeof usePrompt>;
  picker: ReturnType<typeof useWorkflowPicker>;
  runner: ReturnType<typeof useWorkflowRunner>;
  historyHook: ReturnType<typeof useHistory>;
  workflowPickerActive: boolean;
  /** True while the agent manager overlay owns the keyboard. */
  agentManagerOpen: boolean;
  /** True while the API manager overlay owns the keyboard. */
  apiManagerOpen: boolean;
  /** True while the input form overlay owns the keyboard. */
  inputFormPending: boolean;
  openAgentManager: () => void;
  focusCreateWorkflowPrompt: (seed: string) => void;
  switchMode: (next: React.SetStateAction<Mode>) => void;
}

export function useKeyboardInput(params: UseKeyboardInputParams) {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const { exit } = useApp();

  useInput(
    useCallback(
      (input, key) => {
        const cur = paramsRef.current;
        const { prompt, picker, runner, historyHook } = cur;

        if (key.ctrl && input === "c") {
          runner.abortRef.current?.abort();
          // An /attach tail holds a ref'd polling timer; without aborting it the
          // process would outlive the unmounted UI until the attached run ends.
          runner.attachAbortRef.current?.abort();
          exit();
          return;
        }
        // Ctrl+A opens the agent manager from any screen; while a manager
        // overlay (agents via Ctrl+A//agents, APIs via /apis) is open, its own
        // useInput handler owns every other key.
        if (cur.agentManagerOpen || cur.apiManagerOpen) return;
        // While the input form is active, its own useInput handler owns keys.
        if (cur.inputFormPending) return;
        if (key.ctrl && input === "a") {
          cur.openAgentManager();
          return;
        }
        // The history browser is a modal overlay: while open it owns all keys.
        if (historyHook.history) {
          if (key.escape || (key.leftArrow && historyHook.history.view === "list")) {
            if (historyHook.history.view === "detail") {
              if (historyHook.history.detail) {
                historyHook.setHistory({ ...historyHook.history, detail: false });
              } else {
                historyHook.setHistory({
                  ...historyHook.history,
                  view: "list",
                  record: undefined,
                  recordState: undefined,
                });
              }
            } else {
              historyHook.setHistory(null);
            }
            return;
          }
          if (historyHook.history.view === "list") {
            // The list shows in-flight runs first, then recorded history.
            const liveCount = historyHook.history.liveRuns.length;
            const total = liveCount + historyHook.history.runs.length;
            if (key.upArrow) {
              historyHook.setHistory({
                ...historyHook.history,
                index: Math.max(0, historyHook.history.index - 1),
              });
            } else if (key.downArrow) {
              historyHook.setHistory({
                ...historyHook.history,
                index: Math.min(Math.max(0, total - 1), historyHook.history.index + 1),
              });
            } else if (key.return) {
              const index = historyHook.history.index;
              if (index < liveCount) {
                // Enter on an in-flight run attaches to it live.
                const live = historyHook.history.liveRuns[index];
                if (live) {
                  historyHook.setHistory(null);
                  runner.attachRun(live.id);
                }
              } else {
                const run = historyHook.history.runs[index - liveCount];
                if (run) historyHook.openHistoryRecord(run.id);
              }
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
            historyHook.setHistory({
              ...historyHook.history,
              stepIndex: Math.max(0, historyHook.history.stepIndex - 1),
            });
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
        // Ctrl+J: open run history from the workflow picker.
        if (
          key.ctrl &&
          input === "j" &&
          !runner.running &&
          cur.mode === "workflow" &&
          !historyHook.history
        ) {
          historyHook.openHistory();
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
        // Human-approval checkpoint: while a run is paused on one, `a` approves
        // and `r` rejects the oldest pending checkpoint. Handled before prompt
        // history / navigation so the keys aren't swallowed by them.
        if (
          cur.mode === "workflow" &&
          runner.running &&
          !menuOpen &&
          !prompt.promptEditing &&
          (input === "a" || input === "r")
        ) {
          const pending = runner.wf.pendingApprovals;
          if (pending && pending.length > 0) {
            const next = pending[0]!;
            runner.resolveApproval(next.stepId, input === "a", next.iteration);
            return;
          }
        }
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
          !menuOpen &&
          shouldPromptHistoryCaptureDown(prompt.historyBrowse, prompt.promptArrowCtx, prompt.value);
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
              runner.setStepIndex((i) =>
                Math.min(Math.max(0, picker.preview.stepCount - 1), i + 1),
              );
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
      },
      [exit],
    ),
  );
}
