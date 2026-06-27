import { homedir } from "node:os";
import { Box, Text, useApp } from "ink";
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { formatAgentTarget } from "../agents";
import { refreshAgentCatalogCaches } from "../agents/models";
import {
  autocompleteSlashCommand,
  executeSlashCommand,
  isRegisteredSlashCommand,
  isSlashCommandInput,
  listSlashCommands,
  parseSlashInput,
} from "../commands";
import type { SteamtrainConfig } from "../config";
import { type DoctorResult, runDoctor } from "../doctor";
import { Orchestrator } from "../orchestrator";
import type { SteamtrainSettings } from "../settings";
import {
  type AuthoringHost,
  type LoadedWorkflowCatalog,
  type WorkflowSourceKind,
  WorkflowAuthor,
  isAgentBackedStep,
  workflowCacheKey,
  type WorkflowStepOverrides,
} from "../workflow";
import type { WorkspaceConfig, WorkspaceEntry, WorkspaceId, WorkspaceScope } from "../workspace";
import {
  workspaceLabel as formatEntryLabel,
  saveWorkspaceConfig,
  workspaceById,
} from "../workspace";
import { CommandSuggestionMenu, suggestionMenuHeight } from "./CommandSuggestionMenu";
import { EventStream } from "./EventStream";
import { PromptInput } from "./PromptInput";
import { StatusBar } from "./StatusBar";
import { TaskSelector } from "./TaskSelector";
import { WorkflowCreate } from "./WorkflowCreate";
import { WorkflowHistory } from "./WorkflowHistory";
import { WorkflowPicker } from "./WorkflowPicker";
import { WorkflowPreview } from "./WorkflowPreview";
import { WorkflowStepDetails } from "./WorkflowStepDetails";
import { WorkflowView } from "./WorkflowView";
import { Banner } from "./banner";
import { formatDraftTarget } from "./draft-model";
import { type Mode, isWorkflowPickerActive } from "./modes";
import { workflowListNavigation } from "./prompt-editing";
import { initialTranscript, transcriptReducer } from "./transcript";
import { useTerminalSize } from "./useTerminalSize";
import { flattenSteps } from "./workflow-state";

// Custom hooks — each owns a cohesive slice of state.
import { type HistoryUiState, useHistory } from "./useHistory";
import { usePrompt } from "./usePrompt";
import { useSlashContext } from "./useSlashContext";
import { useWorkflowPicker, migrateSessionOverrides, updatePreviewOnRename } from "./useWorkflowPicker";
import { useWorkflowRunner } from "./useWorkflowRunner";
import { useKeyboardInput } from "./useKeyboardInput";

// Re-export pure helpers so the existing test import path (`./App`) keeps working.
export { migrateSessionOverrides, updatePreviewOnRename };

interface AppProps {
  config: SteamtrainConfig;
  configSource: string;
  /** Resolved project `steamtrain.json` path for project-scope authoring. */
  configPath?: string;
  configWarning?: string;
  settings: SteamtrainSettings;
  settingsWarning?: string;
  workflowCatalog: LoadedWorkflowCatalog;
  workspaces: WorkspaceConfig;
  workspaceScope: WorkspaceScope;
  workspaceLabel: string;
  workspaceWarning?: string;
}

type Phase = "banner" | "main";
const BANNER_MS = 1100;
const EMPTY_DOCTOR: DoctorResult[] = [];

export function App({
  config,
  configSource,
  configPath,
  configWarning,
  settings,
  settingsWarning,
  workflowCatalog,
  workspaces,
  workspaceScope,
  workspaceLabel,
  workspaceWarning,
}: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();

  // ── Top-level state ──────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>("banner");
  const [doctor, setDoctor] = useState<DoctorResult[] | null>(null);
  const [mode, setMode] = useState<Mode>("workflow");
  const [runtimeWorkspaces, setRuntimeWorkspaces] = useState<WorkspaceConfig>(workspaces);
  const [runtimeCatalog, setRuntimeCatalog] = useState<LoadedWorkflowCatalog>(workflowCatalog);
  const [activeWorkspaceLabel, setActiveWorkspaceLabel] = useState(workspaceLabel);
  const [transcript, dispatch] = useReducer(transcriptReducer, initialTranscript);
  const [agentCatalogTick, setAgentCatalogTick] = useState(0);
  const mountedRef = useRef(true);
  const valueRef = useRef("");

  const workspaceMap = useMemo(() => workspaceById(runtimeWorkspaces), [runtimeWorkspaces]);
  const runtimeWorkspacesRef = useRef(runtimeWorkspaces);
  runtimeWorkspacesRef.current = runtimeWorkspaces;

  const switchMode = useCallback((next: SetStateAction<Mode>) => {
    setMode(next);
  }, []);

  const updateWorkspace = useCallback(
    (id: WorkspaceId, patch: Partial<WorkspaceEntry>) => {
      const next: WorkspaceConfig = {
        workspaces: runtimeWorkspacesRef.current.workspaces.map((w) =>
          w.id === id ? { ...w, ...patch } : w,
        ),
      };
      const label = saveWorkspaceConfig(next, workspaceScope);
      setActiveWorkspaceLabel(label);
      setRuntimeWorkspaces(next);
    },
    [workspaceScope],
  );

  // ── Orchestrator & Author ────────────────────────────────────────────
  const orchestrator = useMemo(
    () => new Orchestrator(config, runtimeWorkspaces, doctor ?? EMPTY_DOCTOR, runtimeCatalog),
    [config, runtimeWorkspaces, doctor, runtimeCatalog],
  );

  const authoringHost = useMemo<AuthoringHost>(
    () => ({
      listWorkflows: () => orchestrator.listWorkflows(),
      workflowSource: (name) => orchestrator.workflowSource(name),
      isAgentHealthy: (agent) => orchestrator.isAgentHealthy(agent),
      setCatalog: (catalog) => setRuntimeCatalog(catalog),
    }),
    [orchestrator],
  );
  const author = useMemo(
    () =>
      new WorkflowAuthor({
        host: authoringHost,
        config,
        home: homedir(),
        cwd: process.cwd(),
        projectConfigPath: configPath,
        projectWorkflows: config.workflows,
      }),
    [authoringHost, config, configPath],
  );

  const [wfStepOverrides, setWfStepOverrides] = useState<Record<string, WorkflowStepOverrides>>({});

  const resolveWorkflowSpec = useCallback(
    (name: string) => author.previewWithOverrides(name, wfStepOverrides[name]),
    [author, wfStepOverrides],
  );

  // ── Workflow Runner hook ─────────────────────────────────────────────
  const runner = useWorkflowRunner({
    orchestrator,
    resolveWorkflowSpec,
    mountedRef,
  });

  // ── Workflow Picker hook ─────────────────────────────────────────────
  const picker = useWorkflowPicker({
    config,
    configPath,
    mode,
    doctor,
    runtimeCatalog,
    setRuntimeCatalog,
    orchestrator,
    author,
    running: runner.running,
    showWorkflowView: runner.showWorkflowView,
    history: false, // will be updated below
    wfCreate: null, // managed internally by picker
    mountedRef,
    dispatch,
    wfStepOverrides,
    setWfStepOverrides,
    resolveWorkflowSpec,
  });

  // Preview step selection derivation (used by slash context and prompt).
  const previewSelectedStep =
    picker.previewFlatSteps.length > 0
      ? picker.previewFlatSteps[Math.min(runner.stepIndex, picker.previewFlatSteps.length - 1)]
      : undefined;
  const previewStepSelection = useMemo(() => {
    if (!picker.wfPreview || !previewSelectedStep) return undefined;
    const step = previewSelectedStep.step;
    if (!isAgentBackedStep(step)) return undefined;
    return {
      workflowName: picker.wfPreview.name,
      stepId: step.id,
      agent: step.agent,
      model: step.model,
      effort: step.effort,
    };
  }, [picker.wfPreview, previewSelectedStep]);

  // ── History hook ─────────────────────────────────────────────────────
  const historyHook = useHistory({
    historyStoreRef: runner.historyStoreRef,
    mountedRef,
    resolveWorkflowSpec,
    runWorkflow: runner.runWorkflow,
    setWfNotice: runner.setWfNotice,
  });

  // ── Slash Context hook ───────────────────────────────────────────────
  // Recompute workflowPickerActive with actual history state.
  const workflowPickerActive = useMemo(
    () =>
      isWorkflowPickerActive({
        mode,
        history: Boolean(historyHook.history),
        wfCreate: Boolean(picker.wfCreate),
        previewing: Boolean(picker.wfPreview && picker.previewSpec && picker.previewDispatchCheck),
        showWorkflowView: runner.showWorkflowView,
      }),
    [mode, historyHook.history, picker.wfCreate, picker.wfPreview, picker.previewSpec, picker.previewDispatchCheck, runner.showWorkflowView],
  );

  const slashHook = useSlashContext({
    mode,
    runtimeWorkspaces,
    workspaceMap,
    updateWorkspace,
    switchMode,
    wfPreview: picker.wfPreview,
    patchWorkflowStep: picker.patchWorkflowStep,
    previewStepSelection,
    workflowPickerActive,
    saveWorkflows: picker.saveWorkflows,
    createWorkflow: picker.createWorkflow,
    cloneWorkflow: picker.cloneWorkflow,
    deleteWorkflow: picker.deleteWorkflow,
    renameWorkflow: picker.renameWorkflow,
    userWorkflowNames: picker.userWorkflowNames,
    openHistory: historyHook.openHistory,
    draftResolution: picker.draftResolution,
    healthyAgents: picker.healthyAgents,
    setDraftOverride: picker.setDraftOverride,
  });

  // ── Prompt hook ──────────────────────────────────────────────────────
  const prompt = usePrompt({
    mode,
    settings,
    slashCtx: slashHook.slashCtx,
    agentCatalogTick,
    workspaceMap,
    previewStepSelection,
  });

  // Keep valueRef in sync for handleWorkflowFreshRun.
  valueRef.current = prompt.value;

  // Refresh an open /model completion menu once the live OpenCode catalog loads.
  useEffect(() => {
    if (agentCatalogTick === 0) return;
    if (!isSlashCommandInput(prompt.value)) return;
    const parsed = parseSlashInput(prompt.value);
    if (parsed?.command !== "model") return;
    const result = autocompleteSlashCommand(prompt.value, listSlashCommands(), slashHook.slashCtx);
    if (!result || result.suggestions.length <= 1) return;
    prompt.setCommandSuggestions(result.suggestions);
    prompt.setSuggestionIndex((i) => Math.min(i, result.suggestions.length - 1));
  }, [agentCatalogTick, prompt.value, slashHook.slashCtx]);

  // ── Resume-check effect ──────────────────────────────────────────────
  useEffect(() => {
    if (mode !== "workflow" || runner.running) {
      runner.setWfCanResume(false);
      return;
    }

    const trimmed = prompt.value.trim();
    if (trimmed.length === 0) {
      runner.setWfCanResume(false);
      return;
    }

    if (runner.wf.started || runner.wfLaunching) {
      runner.setWfCanResume(
        runner.activeWorkflowRef.current !== undefined &&
          runner.activeWorkflowInputRef.current === trimmed &&
          runner.workflowCacheRef.current.size > 0,
      );
      return;
    }

    if (!picker.wfPreview) {
      runner.setWfCanResume(false);
      return;
    }

    const spec = resolveWorkflowSpec(picker.wfPreview.name);
    if (!spec) {
      runner.setWfCanResume(false);
      return;
    }

    const key = workflowCacheKey(picker.wfPreview.name, trimmed, process.cwd(), spec);
    let active = true;
    void runner.cacheStoreRef.current.load(key).then((cache) => {
      if (active) runner.setWfCanResume(cache.size > 0);
    });
    return () => {
      active = false;
    };
  }, [mode, runner.running, runner.wf.started, runner.wfLaunching, picker.wfPreview, prompt.value, resolveWorkflowSpec]);

  // ── Step index reset effect ──────────────────────────────────────────
  useEffect(() => {
    if (mode === "workflow" && !picker.wfPreview && !runner.showWorkflowView) {
      runner.setStepIndex(0);
      runner.setWfStepDetails(null);
    }
  }, [mode, picker.wfPreview, runner.showWorkflowView]);

  // ── Startup effects ──────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (configWarning) dispatch({ type: "notice", level: "warn", text: configWarning });
  }, [configWarning]);
  useEffect(() => {
    if (workspaceWarning) dispatch({ type: "notice", level: "warn", text: workspaceWarning });
  }, [workspaceWarning]);
  useEffect(() => {
    if (settingsWarning) dispatch({ type: "notice", level: "warn", text: settingsWarning });
  }, [settingsWarning]);
  useEffect(() => {
    if (runtimeCatalog.warning) {
      dispatch({ type: "notice", level: "warn", text: runtimeCatalog.warning });
    }
  }, [runtimeCatalog.warning]);

  useEffect(() => {
    const t = setTimeout(() => setPhase("main"), BANNER_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let active = true;
    runDoctor(config)
      .then((results) => {
        if (!active) return;
        setDoctor(results);
        void refreshAgentCatalogCaches(config, results).then((ok) => {
          if (ok && active) setAgentCatalogTick((n) => n + 1);
        });
      })
      .catch((err) => {
        if (!active) return;
        dispatch({ type: "notice", level: "error", text: `preflight failed: ${message(err)}` });
      });
    return () => {
      active = false;
    };
  }, [config]);

  // ── Cross-cutting callbacks ──────────────────────────────────────────
  const focusCreateWorkflowPrompt = useCallback(
    (seed = "") => {
      picker.focusCreateWorkflowPrompt(
        seed,
        prompt.updatePromptDraft,
        prompt.bumpCursorToEnd,
        prompt.setCommandSuggestions,
        prompt.setSuggestionIndex,
      );
    },
    [picker.focusCreateWorkflowPrompt, prompt.updatePromptDraft, prompt.bumpCursorToEnd, prompt.setCommandSuggestions, prompt.setSuggestionIndex],
  );

  const handleWorkflowRun = useCallback(
    (promptText: string, fresh: boolean): boolean => {
      if (runner.running || mode !== "workflow") return false;
      if (picker.wfCreate?.status === "generating") return false;

      if (runner.wf.started && runner.activeWorkflowRef.current) {
        if (promptText.length === 0) return false;
        if (!fresh) {
          if (runner.activeWorkflowInputRef.current !== promptText) return false;
          if (runner.workflowCacheRef.current.size === 0) return false;
          runner.launchWorkflow(runner.activeWorkflowRef.current, promptText, picker.setWfPreview, {
            reuseMemoryCache: true,
          });
          return true;
        }
        runner.launchWorkflow(runner.activeWorkflowRef.current, promptText, picker.setWfPreview, {
          fresh: true,
        });
        return true;
      }

      if (picker.wfPreview) {
        if (promptText.length === 0) {
          runner.setWfNotice("type input in the prompt before running");
          return false;
        }
        if (!fresh && !runner.wfCanResume) return false;
        runner.launchWorkflow(
          picker.wfPreview.name,
          promptText,
          picker.setWfPreview,
          fresh ? { fresh: true } : undefined,
        );
        return true;
      }

      const entry = picker.workflowEntries[picker.workflowIndex];
      if (!entry) return false;
      if (promptText.length === 0) {
        runner.setWfNotice("type input in the prompt before running");
        return false;
      }
      runner.launchWorkflow(entry.name, promptText, picker.setWfPreview, { fresh: true });
      return true;
    },
    [
      runner.running,
      mode,
      runner.wf.started,
      picker.wfPreview,
      runner.wfCanResume,
      picker.workflowEntries,
      picker.workflowIndex,
      runner.launchWorkflow,
      picker.wfCreate,
      picker.setWfPreview,
    ],
  );

  const handleSubmit = useCallback(
    (raw: string) => {
      prompt.setCommandSuggestions([]);
      prompt.setSuggestionIndex(0);

      const promptText = raw.trim();

      if (isRegisteredSlashCommand(promptText)) {
        let result;
        try {
          result = executeSlashCommand(promptText, slashHook.slashCtx);
        } catch (err) {
          dispatch({
            type: "notice",
            level: "error",
            text: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        if (result.handled) {
          prompt.updatePromptDraft(
            result.clearInput ? { value: "", promptEditing: false } : { promptEditing: false },
          );
          prompt.setCommandSuggestions([]);
          for (const notice of result.notices ?? []) {
            dispatch({ type: "notice", level: notice.level, text: notice.text });
          }
          if (result.exit) exit();
          return;
        }
      }

      if (picker.wfCreate && picker.wfCreate.status === "done" && picker.wfCreate.spec) {
        const specName = picker.wfCreate.spec.name;
        picker.setWfCreate(null);
        picker.setWfPreview({ name: specName, input: promptText });
        runner.setStepIndex(0);
        runner.setWfNotice(null);
        prompt.updatePromptDraft({ promptEditing: false });
        return;
      }

      if (runner.running) return;

      if (mode === "workflow") {
        if (runner.wf.started && runner.activeWorkflowRef.current) {
          const ran = handleWorkflowRun(promptText, false);
          if (ran) prompt.updatePromptDraft({ promptEditing: false });
          return;
        }
        if (picker.wfPreview) {
          const ran = handleWorkflowRun(promptText, false);
          if (ran) prompt.updatePromptDraft({ promptEditing: false });
          return;
        }
        if (picker.workflowIndex >= picker.workflowEntries.length) {
          focusCreateWorkflowPrompt(promptText);
          return;
        }
        const entry = picker.workflowEntries[picker.workflowIndex];
        if (!entry) return;
        runner.setWfNotice(null);
        runner.setStepIndex(0);
        picker.setWfPreview({ name: entry.name, input: promptText });
        runner.setWfStepDetails(null);
        prompt.updatePromptDraft({ promptEditing: false });
        return;
      }

      // Workspace mode.
      if (promptText.length === 0) return;
      prompt.updatePromptDraft({ value: "", promptEditing: false });
      const entry = workspaceMap.get(mode);
      if (!entry) {
        dispatch({
          type: "notice",
          level: "error",
          text: `unknown workspace '${mode}'`,
        });
        return;
      }
      const check = orchestrator.canDispatch(mode);
      if (!check.ok) {
        dispatch({
          type: "notice",
          level: "error",
          text: `cannot dispatch '${formatEntryLabel(entry)}': ${check.reason}`,
        });
        return;
      }

      dispatch({
        type: "notice",
        level: "info",
        text: `dispatch '${formatEntryLabel(entry)}' → ${formatAgentTarget(entry)}`,
      });
      runner.setRunning(true);
      const ac = new AbortController();
      runner.abortRef.current = ac;

      void (async () => {
        try {
          for await (const event of orchestrator.run(mode, promptText, ac.signal)) {
            if (!mountedRef.current) return;
            dispatch({ type: "event", event });
          }
        } catch (err) {
          if (mountedRef.current) {
            dispatch({ type: "notice", level: "error", text: `run failed: ${message(err)}` });
          }
        } finally {
          if (mountedRef.current) {
            runner.setRunning(false);
            runner.abortRef.current = null;
          }
        }
      })();
    },
    [
      orchestrator,
      runner.running,
      mode,
      runner.wf.started,
      picker.workflowEntries,
      picker.workflowIndex,
      handleWorkflowRun,
      prompt.updatePromptDraft,
      focusCreateWorkflowPrompt,
      picker.wfPreview,
      picker.wfCreate,
      workspaceMap,
      slashHook.slashCtx,
      exit,
    ],
  );

  const handlePromptSubmit = useCallback(
    (raw: string) => {
      prompt.handlePromptSubmit(raw, handleSubmit);
    },
    [prompt.handlePromptSubmit, handleSubmit],
  );

  const handleWorkflowFreshRun = useCallback(() => {
    const promptText = valueRef.current.trim();
    prompt.recordPromptHistory(valueRef.current);
    if (handleWorkflowRun(promptText, true))
      prompt.updatePromptDraft({ value: "", promptEditing: false });
  }, [prompt.recordPromptHistory, handleWorkflowRun, prompt.updatePromptDraft]);

  // ── Keyboard input hook ──────────────────────────────────────────────
  useKeyboardInput({
    mode,
    modes: slashHook.modes,
    running: runner.running,
    promptEditing: prompt.promptEditing,
    value: prompt.value,
    commandSuggestions: prompt.commandSuggestions,
    history: historyHook.history,
    setHistory: historyHook.setHistory,
    openHistoryRecord: historyHook.openHistoryRecord,
    rerunFromRecord: historyHook.rerunFromRecord,
    wfPreview: picker.wfPreview,
    setWfPreview: picker.setWfPreview,
    wfCreate: picker.wfCreate,
    setWfCreate: picker.setWfCreate,
    createAbortRef: picker.createAbortRef,
    wfStepDetails: runner.wfStepDetails,
    setWfStepDetails: runner.setWfStepDetails,
    showWorkflowView: runner.showWorkflowView,
    previewSpec: picker.previewSpec,
    previewStepCount: picker.previewStepCount,
    stepIndex: runner.stepIndex,
    setStepIndex: runner.setStepIndex,
    workflowIndex: picker.workflowIndex,
    setWorkflowIndex: picker.setWorkflowIndex,
    workflowEntries: picker.workflowEntries,
    totalWfSteps: runner.totalWfSteps,
    wf: runner.wf,
    wfLaunching: runner.wfLaunching,
    wfDispatch: runner.wfDispatch,
    activeWorkflowRef: runner.activeWorkflowRef,
    activeWorkflowInputRef: runner.activeWorkflowInputRef,
    workflowCacheRef: runner.workflowCacheRef,
    setWfNotice: runner.setWfNotice,
    setWfLaunching: runner.setWfLaunching,
    abortRef: runner.abortRef,
    workflowPickerActive,
    focusCreateWorkflowPrompt,
    exitPromptEditing: prompt.exitPromptEditing,
    switchMode: (next) => {
      setMode(next);
      prompt.setCommandSuggestions([]);
      prompt.setSuggestionIndex(0);
      prompt.bumpCursorToEnd();
    },
    setCommandSuggestions: prompt.setCommandSuggestions,
    setSuggestionIndex: prompt.setSuggestionIndex,
    promptHistoryByMode: prompt.promptHistoryByMode,
    historyBrowse: prompt.historyBrowse,
    promptArrowCtx: prompt.promptArrowCtx,
  });

  // ── Render ───────────────────────────────────────────────────────────
  if (phase === "banner") {
    return (
      <Box flexDirection="column">
        <Banner />
        <Text color="gray"> starting up — running preflight checks…</Text>
      </Box>
    );
  }

  const isWorkflow = mode === "workflow";
  const streamHeight = Math.max(6, rows - 9);

  const menuOverlayRows = prompt.suggestionMenuOpen
    ? suggestionMenuHeight(prompt.commandSuggestions.length, prompt.suggestionIndex)
    : 0;
  const activeWorkflowName = isWorkflow
    ? (runner.activeWorkflowRef.current ?? picker.wfPreview?.name ?? picker.workflowEntries[picker.workflowIndex]?.name)
    : undefined;
  const activeWorkflowSource: WorkflowSourceKind | undefined = activeWorkflowName
    ? (picker.workflowEntries.find((entry) => entry.name === activeWorkflowName)?.source ??
      orchestrator.workflowSource(activeWorkflowName))
    : undefined;

  return (
    <Box flexDirection="column" width={columns}>
      <StatusBar
        doctor={doctor}
        configSource={configSource}
        workspaceLabel={activeWorkspaceLabel}
        running={runner.running}
      />
      {historyHook.history ? (
        <HistoryPanel history={historyHook.history} width={columns} height={streamHeight} />
      ) : isWorkflow ? (
        picker.wfCreate ? (
          <WorkflowCreate state={picker.wfCreate} width={columns} height={streamHeight} />
        ) : runner.wfStepDetails === "live" && runner.showWorkflowView ? (
          <WorkflowStepDetails
            kind="live"
            state={runner.wf}
            entry={runner.liveSelectedStep}
            height={streamHeight}
            width={columns}
            selectedIndex={runner.stepIndex}
            totalSteps={runner.totalWfSteps}
            elapsedMs={runner.wfElapsedMs}
          />
        ) : runner.wfStepDetails === "preview" && picker.wfPreview && picker.previewSpec && picker.previewDispatchCheck ? (
          <WorkflowStepDetails
            kind="preview"
            spec={picker.previewSpec}
            source={activeWorkflowSource ?? "bundled"}
            input={prompt.value.trim() || picker.wfPreview.input}
            height={streamHeight}
            width={columns}
            entry={previewSelectedStep}
            selectedIndex={runner.stepIndex}
            totalSteps={picker.previewStepCount}
            dispatchOk={picker.previewDispatchCheck.ok}
            dispatchReason={picker.previewDispatchCheck.ok ? undefined : picker.previewDispatchCheck.reason}
            canResume={runner.wfCanResume}
          />
        ) : runner.showWorkflowView ? (
          <WorkflowView
            state={runner.wf}
            height={streamHeight}
            width={columns}
            selectedIndex={runner.stepIndex}
            elapsedMs={runner.wfElapsedMs}
          />
        ) : picker.wfPreview && picker.previewSpec && picker.previewDispatchCheck ? (
          <WorkflowPreview
            spec={picker.previewSpec}
            source={activeWorkflowSource ?? "bundled"}
            input={prompt.value.trim() || picker.wfPreview.input}
            width={columns}
            height={streamHeight}
            selectedIndex={runner.stepIndex}
            dispatchCheck={picker.previewDispatchCheck}
            canResume={runner.wfCanResume}
            promptEditing={prompt.promptEditing}
          />
        ) : (
          <WorkflowPicker
            workflows={picker.workflowEntries}
            selectedIndex={picker.workflowIndex}
            height={streamHeight}
            draftLabel={
              picker.draftResolution.target
                ? `${formatDraftTarget(picker.draftResolution.target)}${
                    picker.draftResolution.usingOverride ? "" : " (auto)"
                  }`
                : undefined
            }
          />
        )
      ) : (
        <EventStream
          items={transcript.items}
          height={streamHeight}
          width={columns}
          mode={mode}
          workspaceMap={workspaceMap}
        />
      )}
      <TaskSelector
        modes={slashHook.modes}
        workspaceMap={workspaceMap}
        active={mode}
        workflowName={activeWorkflowName}
        workflowSource={activeWorkflowSource}
      />
      {runner.wfNotice && isWorkflow ? (
        <Box paddingX={1}>
          <Text color="red">{runner.wfNotice}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column">
        {prompt.suggestionMenuOpen ? (
          <Box marginTop={-menuOverlayRows}>
            <CommandSuggestionMenu
              suggestions={prompt.commandSuggestions}
              selectedIndex={prompt.suggestionIndex}
              width={columns}
              descriptions={prompt.suggestionDescriptions}
            />
          </Box>
        ) : null}
        <PromptInput
          value={prompt.value}
          onChange={prompt.handleValueChange}
          onSubmit={handlePromptSubmit}
          onTab={prompt.handleTab}
          onCtrlR={mode === "workflow" && !runner.running ? handleWorkflowFreshRun : undefined}
          onCtrlQ={mode === "workflow" && runner.running ? runner.handleWorkflowCancel : undefined}
          onSuggestionNavigate={prompt.handleSuggestionNavigate}
          onHistoryNavigate={prompt.promptHistoryArrows ? prompt.handleHistoryNavigate : undefined}
          focus={!historyHook.history}
          editing={!historyHook.history && (!workflowListNavigation(mode) || prompt.promptEditing)}
          promptEditing={prompt.promptEditing}
          running={runner.running}
          cancelKeyHint={mode === "workflow" ? "Ctrl+Q" : "Esc"}
          suggestions={prompt.commandSuggestions}
          cursorResetKey={prompt.cursorResetKey}
        />
        <Box paddingX={1}>
          <Text color="gray">
            {historyHook.history
              ? historyHintText(historyHook.history)
              : hint(
                  mode,
                  runner.wf.started,
                  runner.wfLaunching,
                  !!picker.wfPreview,
                  runner.running,
                  prompt.suggestionMenuOpen,
                  runner.wfCanResume,
                  prompt.promptEditing,
                  isSlashCommandInput(prompt.value),
                  !!runner.wfStepDetails,
                )}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

// ── Pure helper functions ────────────────────────────────────────────────

function hint(
  mode: Mode,
  wfStarted: boolean,
  wfLaunching: boolean,
  wfPreviewing: boolean,
  running: boolean,
  suggestionMenuOpen: boolean,
  canResume: boolean,
  promptEditing: boolean,
  slashInput: boolean,
  wfStepDetails: boolean,
): string {
  const completeHint = suggestionMenuOpen ? " · ↑/↓ complete · Tab/Enter pick · Esc cancel" : "";
  const historyHint = " · ↑/↓ history";
  const resumeHint = canResume ? " · Enter resume" : "";
  if (running) {
    if (mode === "workflow" && wfStepDetails) {
      return "↑/↓ step · ←/Esc back · Ctrl+Q cancel · /exit quit · Ctrl+C quit";
    }
    return mode === "workflow"
      ? "Ctrl+Q cancel · /exit quit · Ctrl+C quit"
      : "Esc cancel · /exit quit · Ctrl+C quit";
  }
  if (mode === "workflow") {
    if (wfStepDetails) {
      return `↑/↓ step · ←/Esc back${resumeHint} · Ctrl+R run · type to edit · /commands · Ctrl+C quit${completeHint}`;
    }
    if (promptEditing) {
      const tabHint = slashInput ? " · Esc unfocus" : " · Esc list";
      const editingHint = `↑/↓ history${resumeHint}${tabHint} · Ctrl+R run · /commands · Ctrl+C quit${completeHint}`;
      if (wfStarted || wfLaunching || wfPreviewing) return editingHint;
      return `↑/↓ history · Enter preview${tabHint} · Ctrl+R run · /commands · Ctrl+C quit${completeHint}`;
    }
    if (wfStarted || wfLaunching) {
      return `↑/↓ step · → details · type to edit · Ctrl+R run · Ctrl+Q cancel · Esc back · Tab switch mode · /commands · Ctrl+C quit${completeHint}`;
    }
    if (wfPreviewing) {
      return `↑/↓ step · → details${resumeHint} · type to edit · Ctrl+R run · Esc back · Tab switch mode · /commands · Ctrl+C quit${completeHint}`;
    }
    return `↑/↓ pick · Ctrl+N new · type to edit · Enter preview · Ctrl+R run · Tab switch mode · /commands · Ctrl+C quit${completeHint}`;
  }
  return promptEditing && slashInput
    ? `Enter dispatch${historyHint} · Esc unfocus · /commands (Tab complete) · Ctrl+C quit${completeHint}`
    : `Enter dispatch${historyHint} · Tab switch mode · /commands (Tab complete) · Ctrl+C quit${completeHint}`;
}

function historyHintText(history: HistoryUiState): string {
  if (history.view === "detail") {
    if (history.detail) return "↑/↓ step · ←/Esc back · Ctrl+C quit";
    const retryHint = (history.record?.totals?.failed ?? 0) > 0 ? " · f retry failed" : "";
    return `↑/↓ step · → details · r re-run${retryHint} · ←/Esc back to list · Ctrl+C quit`;
  }
  return "↑/↓ select · Enter inspect · Esc close · Ctrl+C quit";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Renders the past-run history: a list of recorded runs, or a selected run's
 * phase -> step tree (reusing the live `WorkflowView` / `WorkflowStepDetails`).
 */
function HistoryPanel({
  history,
  width,
  height,
}: {
  history: HistoryUiState;
  width: number;
  height: number;
}) {
  if (history.view === "detail" && history.recordState) {
    const state = history.recordState;
    const flat = flattenSteps(state);
    const total = flat.length;
    const clamped = Math.min(history.stepIndex, Math.max(0, total - 1));
    const elapsed = history.record?.durationMs ?? 0;
    if (history.detail) {
      return (
        <WorkflowStepDetails
          kind="live"
          state={state}
          entry={flat[clamped]}
          height={height}
          width={width}
          selectedIndex={clamped}
          totalSteps={total}
          elapsedMs={elapsed}
        />
      );
    }
    return (
      <WorkflowView
        state={state}
        height={height}
        width={width}
        selectedIndex={clamped}
        elapsedMs={elapsed}
      />
    );
  }
  return (
    <WorkflowHistory
      runs={history.runs}
      selectedIndex={history.index}
      loading={history.loading}
      error={history.error}
      width={width}
      height={height}
    />
  );
}
