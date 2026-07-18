import { type Key, useApp, useInput } from "ink";
import { useCallback, useRef } from "react";
import { isSlashCommandInput } from "../commands";
import { ARRIVAL_NEXT_CANDIDATES } from "../workflow";
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
  /** True while the in-place step editor overlay owns the keyboard. */
  stepEditorOpen: boolean;
  /** True while the mid-run (paused) step editor overlay owns the keyboard. */
  runEditorOpen: boolean;
  /** True while the human-input answer box overlay owns the keyboard. */
  answerInputOpen: boolean;
  /** True while the input form overlay owns the keyboard. */
  inputFormPending: boolean;
  /** True while the /help overlay owns the keyboard. */
  helpOpen: boolean;
  closeHelp: () => void;
  openAgentManager: () => void;
  /** Open the mid-run editor for the selected pending step (paused runs). */
  openRunStepEditor: () => void;
  /** Open the answer box for the run's oldest pending human-input request. */
  openAnswerInput: () => void;
  focusCreateWorkflowPrompt: (seed: string) => void;
  switchMode: (next: React.SetStateAction<Mode>) => void;
  /** Drop the Station first-run chrome after the user leaves the platform. */
  clearStationLanding?: () => void;
}

/**
 * Output-pane scroll keys shared by the live drill-in and the history drill-in:
 * PgUp/PgDn page, Shift+↑/↓ move one line (plain ↑/↓ keep switching steps).
 * Returns true when the key was a scroll motion and has been handled.
 */
function handleOutputScrollKeys(
  _input: string,
  key: Key,
  runner: ReturnType<typeof useWorkflowRunner>,
): boolean {
  if (key.pageUp) {
    runner.scrollOutput("page-up");
    return true;
  }
  if (key.pageDown) {
    runner.scrollOutput("page-down");
    return true;
  }
  if (key.shift && key.upArrow) {
    runner.scrollOutput("line-up");
    return true;
  }
  if (key.shift && key.downArrow) {
    runner.scrollOutput("line-down");
    return true;
  }
  return false;
}

export function useKeyboardInput(params: UseKeyboardInputParams) {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  // Arrival-receipt `r` (run again) is a bare letter on a surface that also
  // says "type to edit" — and a fresh run can spend real tokens. Require a
  // second press within this window so a stray first keystroke of a typed
  // word ("refactor …") can't launch a paid run.
  const rerunConfirmAtRef = useRef(0);
  const RERUN_CONFIRM_WINDOW_MS = 3000;

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
        // While the step editor is active, its own useInput handler owns keys.
        if (cur.stepEditorOpen) return;
        // Same for the mid-run (paused) step editor.
        if (cur.runEditorOpen) return;
        // Same for the human-input answer box.
        if (cur.answerInputOpen) return;
        // While the input form is active, its own useInput handler owns keys.
        if (cur.inputFormPending) return;
        // The /help overlay is read-only: any dismiss key closes it, and it
        // swallows everything else so a stray key can't mutate hidden state.
        if (cur.helpOpen) {
          if (key.escape || key.return || input === "q" || input === "h" || input === "?") {
            cur.closeHelp();
          }
          return;
        }
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
          // Worktree lifecycle: apply the run's worktrees to the checkout, or
          // prune (discard) them — `x` double-press confirmed in the hook.
          if (!historyHook.history.detail && input === "a" && historyHook.history.record) {
            historyHook.harvestFromRecord(historyHook.history.record, "apply");
            return;
          }
          if (!historyHook.history.detail && input === "x" && historyHook.history.record) {
            historyHook.harvestFromRecord(historyHook.history.record, "prune");
            return;
          }
          const totalSteps = historyHook.history.recordState
            ? historyHook.history.recordState.phases.reduce((n, p) => n + p.steps.length, 0)
            : 0;
          // Output-pane scrolling inside the drill-in (shares the live pane's
          // scroll state — only one drill-in is ever on screen).
          if (historyHook.history.detail && handleOutputScrollKeys(input, key, runner)) return;
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
              runner.resetRunner();
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
            // In workflow preview mode, toggle step detail panel visibility
            if (cur.mode === "workflow" && picker.wfPreview) {
              runner.setWfShowStepDetail((prev) => !prev);
            } else {
              picker.setWfPreview(null);
              runner.setWfLaunching(false);
              runner.setWfStepDetails(null);
              cur.switchMode((prev) => nextMode(prev, cur.modes));
            }
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
          // With no approval pending, `a` answers the oldest pending
          // human-input request (human step / agent question) instead.
          if (input === "a" && runner.wf.pendingInputs && runner.wf.pendingInputs.length > 0) {
            cur.openAnswerInput();
            return;
          }
        }
        // Mid-run steering: `p` toggles pause/resume on the live run (owned or
        // attached); while paused, `e` edits the selected pending step.
        if (
          cur.mode === "workflow" &&
          runner.running &&
          !menuOpen &&
          !prompt.promptEditing &&
          !key.ctrl &&
          !key.meta
        ) {
          if (input === "p") {
            void runner.togglePauseRun().then((notice) => {
              if (notice) runner.setWfNotice(notice);
            });
            return;
          }
          if (input === "e" && runner.wf.paused) {
            cur.openRunStepEditor();
            return;
          }
        }
        // Arrival Report: r = run again, n = try next workflow, h = history,
        // i = show step details under the Arrival Report. Only while the receipt is up.
        if (
          cur.mode === "workflow" &&
          !runner.running &&
          runner.showWorkflowView &&
          runner.wf.done &&
          runner.showArrival &&
          !menuOpen &&
          !prompt.promptEditing &&
          !key.ctrl &&
          !key.meta
        ) {
          // Consumed hotkey letters still reach the prompt's TextInput (ink
          // has no propagation stop between useInput hooks) — flag the insert
          // as spurious so it doesn't pollute the draft.
          if (input === "i" || input === "h" || input === "r" || input === "n") {
            prompt.swallowNextInsert(input);
          }
          if (input === "i") {
            runner.setShowArrival(false);
            return;
          }
          if (input === "h") {
            historyHook.openHistory();
            return;
          }
          if (input === "r") {
            const name =
              runner.activeWorkflowRef.current ??
              picker.wfPreview?.name ??
              picker.workflowEntries[picker.workflowIndex]?.name;
            const prior = runner.activeWorkflowInputRef.current ?? "";
            if (name) {
              const now = Date.now();
              if (now - rerunConfirmAtRef.current > RERUN_CONFIRM_WINDOW_MS) {
                rerunConfirmAtRef.current = now;
                runner.setWfNotice(`press r again to run '${name}' again (a fresh ride)`);
                return;
              }
              rerunConfirmAtRef.current = 0;
              runner.setWfNotice(null);
              cur.clearStationLanding?.();
              runner.launchWorkflow(name, prior || "all aboard", picker.setWfPreview, {
                fresh: true,
              });
            }
            return;
          }
          if (input === "n") {
            const next = ARRIVAL_NEXT_CANDIDATES.map((name) =>
              picker.workflowEntries.find((e) => e.name === name),
            ).find(Boolean);
            if (!next) {
              runner.setWfNotice("no next workflow available in the catalog");
              return;
            }
            runner.resetRunner();
            cur.clearStationLanding?.();
            picker.setWorkflowIndex(picker.workflowEntries.findIndex((e) => e.name === next.name));
            picker.setWfPreview({ name: next.name, input: "" });
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
          // Full-output scrolling inside the live drill-in.
          if (runner.wfStepDetails === "live" && handleOutputScrollKeys(input, key, runner)) {
            return;
          }
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
              // Manual navigation takes over from selection auto-follow.
              runner.setWfFollowSelection(false);
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
              // Manual navigation takes over from selection auto-follow.
              runner.setWfFollowSelection(false);
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
