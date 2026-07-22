import { type Key, useApp, useInput } from "ink";
import { useCallback, useRef } from "react";
import { isSlashCommandInput } from "../commands";
import { ARRIVAL_NEXT_CANDIDATES } from "../workflow";
import type { Mode } from "./modes";
import { nextMode } from "./modes";
import { shouldPromptHistoryCaptureDown, shouldPromptHistoryCaptureUp } from "./prompt-history";
import { shouldDismissSuggestionMenu, shouldSuppressWorkflowNavigation } from "./slash-completion";
import { shouldAcceptTextInput } from "./text-input-filter";

import { buildHistoryBrowserEntries } from "../workflow";
import type { useHistory } from "./useHistory";
import { applyHistoryQuery, applyHistoryStatusCycle } from "./useHistory";
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
  /** Mark a controller-free quit so the CLI may terminate stray background handles. */
  onIdleQuit?: () => void;
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
          // Ink is rendered with exitOnCtrlC: false so this handler owns quit.
          // An owned (non-detached) run needs a second press / /exit to confirm.
          if (!runner.requestQuit()) return;
          runner.abortRef.current?.abort();
          // An /attach tail holds a ref'd polling timer; without aborting it the
          // process would outlive the unmounted UI until the attached run ends.
          if (
            !runner.abortRef.current &&
            !runner.attachAbortRef.current &&
            !picker.createAbortRef.current
          ) {
            cur.onIdleQuit?.();
          }
          runner.attachAbortRef.current?.abort();
          picker.createAbortRef.current?.abort();
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
          const hist = historyHook.history;

          // Filter mode: capture printable keys into the query.
          if (hist.view === "list" && hist.filtering) {
            if (key.escape || key.return) {
              historyHook.setHistory({ ...hist, filtering: false });
              return;
            }
            if (key.backspace || key.delete) {
              historyHook.setHistory(
                applyHistoryQuery(hist, hist.query.slice(0, Math.max(0, hist.query.length - 1))),
              );
              return;
            }
            if (
              shouldAcceptTextInput(input, key) &&
              input !== "\t" &&
              !key.upArrow &&
              !key.downArrow
            ) {
              historyHook.setHistory(applyHistoryQuery(hist, hist.query + input));
              return;
            }
            // ↑/↓ still navigate while filtering.
          }

          if (key.escape || (key.leftArrow && hist.view === "list" && !hist.filtering)) {
            if (hist.view === "detail") {
              if (hist.detail) {
                historyHook.setHistory({ ...hist, detail: false });
              } else {
                historyHook.setHistory({
                  ...hist,
                  view: "list",
                  record: undefined,
                  recordState: undefined,
                });
              }
            } else if (hist.filtering || hist.query) {
              historyHook.setHistory({
                ...applyHistoryQuery(hist, ""),
                filtering: false,
              });
            } else {
              historyHook.setHistory(null);
            }
            return;
          }

          if (hist.view === "list") {
            if (!hist.filtering && input === "/") {
              historyHook.setHistory({ ...hist, filtering: true });
              return;
            }
            if (!hist.filtering && input === "t") {
              historyHook.setHistory(applyHistoryStatusCycle(hist));
              return;
            }
            if (!hist.filtering && input === "d") {
              const entries = buildHistoryBrowserEntries({
                runs: hist.runs,
                liveRuns: hist.liveRuns,
                query: hist.query,
                statusFilter: hist.statusFilter,
              });
              const selected = entries[hist.index];
              if (selected?.kind === "record" && selected.run) {
                historyHook.deleteHistoryRecord(selected.run);
              }
              return;
            }

            const entries = buildHistoryBrowserEntries({
              runs: hist.runs,
              liveRuns: hist.liveRuns,
              query: hist.query,
              statusFilter: hist.statusFilter,
            });
            const total = entries.length;
            if (key.upArrow) {
              historyHook.setHistory({
                ...hist,
                index: Math.max(0, hist.index - 1),
              });
            } else if (key.downArrow) {
              historyHook.setHistory({
                ...hist,
                index: Math.min(Math.max(0, total - 1), hist.index + 1),
              });
            } else if (key.return) {
              const selected = entries[hist.index];
              if (!selected) return;
              if (selected.kind === "live" && selected.live) {
                historyHook.setHistory(null);
                runner.attachRun(selected.live.id);
              } else if (selected.kind === "record") {
                historyHook.openHistoryRecord(selected.id);
              }
            }
            return;
          }

          // Detail view: re-run / retry-failed, navigate steps, toggle drill-in.
          if (!hist.detail && input === "r" && hist.record) {
            historyHook.rerunFromRecord(hist.record, "rerun");
            return;
          }
          if (
            !hist.detail &&
            input === "f" &&
            hist.record &&
            (hist.record.totals?.failed ?? 0) > 0
          ) {
            historyHook.rerunFromRecord(hist.record, "retry-failed");
            return;
          }
          if (!hist.detail && input === "d" && hist.record) {
            historyHook.deleteHistoryRecord(hist.record);
            return;
          }
          // Worktree lifecycle: apply the run's worktrees to the checkout, or
          // prune (discard) them — `x` double-press confirmed in the hook.
          if (!hist.detail && input === "a" && hist.record) {
            historyHook.harvestFromRecord(hist.record, "apply");
            return;
          }
          if (!hist.detail && input === "x" && hist.record) {
            historyHook.harvestFromRecord(hist.record, "prune");
            return;
          }
          const totalSteps = hist.recordState
            ? hist.recordState.phases.reduce((n, p) => n + p.steps.length, 0)
            : 0;
          // Output-pane scrolling inside the drill-in (shares the live pane's
          // scroll state — only one drill-in is ever on screen).
          if (hist.detail && handleOutputScrollKeys(input, key, runner)) return;
          if (key.leftArrow && hist.detail) {
            historyHook.setHistory({ ...hist, detail: false });
          } else if (key.rightArrow && !hist.detail && totalSteps > 0) {
            historyHook.setHistory({ ...hist, detail: true });
          } else if (key.upArrow) {
            historyHook.setHistory({
              ...hist,
              stepIndex: Math.max(0, hist.stepIndex - 1),
            });
          } else if (key.downArrow) {
            historyHook.setHistory({
              ...hist,
              stepIndex: Math.min(Math.max(0, totalSteps - 1), hist.stepIndex + 1),
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
          // `d` detaches an owned in-process run into a background process so the
          // TUI can be closed (or relaunched) without stopping it. detachRun
          // reports back when the run is already independent (attached).
          if (input === "d") {
            void runner.detachRun().then((notice) => {
              if (notice) runner.setWfNotice(notice);
            });
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
              picker.selectedWorkflowName;
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
            const current =
              picker.wfPreview?.name ??
              (runner.wf.started ? runner.wf.name : undefined) ??
              picker.selectedWorkflowName;
            const next = ARRIVAL_NEXT_CANDIDATES.map((name) =>
              picker.workflowEntries.find((e) => e.name === name && e.name !== current),
            ).find(Boolean);
            if (!next) {
              runner.setWfNotice("no next workflow available in the catalog");
              return;
            }
            runner.resetRunner();
            cur.clearStationLanding?.();
            const nextIdx = picker.pickerNav.findIndex(
              (row) => row.kind === "workflow" && row.entry.name === next.name,
            );
            if (nextIdx >= 0) picker.setWorkflowIndex(nextIdx);
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
              const next = Math.min(
                Math.max(0, picker.pickerNav.length - 1),
                picker.workflowIndex + 1,
              );
              if (next !== picker.workflowIndex) {
                runner.setStepIndex(0);
                runner.setWfStepDetails(null);
              }
              picker.setWorkflowIndex(next);
            }
            return;
          }
          // Folder collapse/expand on the picker (← collapses, → expands, mirrors
          // the folder chevron). Enter also toggles via the submit handler.
          if (
            (key.leftArrow || key.rightArrow) &&
            !runner.wf.started &&
            !runner.wfLaunching &&
            !picker.wfPreview &&
            !runner.wfStepDetails &&
            !prompt.promptEditing &&
            picker.onHeaderRow
          ) {
            const row = picker.pickerNav[picker.workflowIndex];
            if (row?.kind === "header") {
              if (key.leftArrow) picker.setFolderCollapsed(row.source, true);
              else picker.setFolderCollapsed(row.source, false);
            }
            return;
          }
          // Page the live step list when the drill-in is closed (PgUp/PgDn inside
          // the drill-in already scroll output via handleOutputScrollKeys above).
          if (
            (key.pageUp || key.pageDown) &&
            (runner.wf.started || runner.wfLaunching) &&
            !runner.wfStepDetails
          ) {
            const page = 10;
            runner.setWfFollowSelection(false);
            runner.setStepIndex((i) =>
              key.pageUp
                ? Math.max(0, i - page)
                : Math.min(Math.max(0, runner.totalWfSteps - 1), i + page),
            );
            return;
          }
          // Page the workflow picker list when idle.
          if (
            (key.pageUp || key.pageDown) &&
            !runner.wf.started &&
            !runner.wfLaunching &&
            !picker.wfPreview &&
            !runner.wfStepDetails
          ) {
            const page = Math.max(3, Math.min(8, picker.pickerNav.length - 1));
            const next = key.pageUp
              ? Math.max(0, picker.workflowIndex - page)
              : Math.min(Math.max(0, picker.pickerNav.length - 1), picker.workflowIndex + page);
            if (next !== picker.workflowIndex) {
              runner.setStepIndex(0);
              runner.setWfStepDetails(null);
            }
            picker.setWorkflowIndex(next);
            return;
          }
        }
      },
      [exit],
    ),
  );
}
