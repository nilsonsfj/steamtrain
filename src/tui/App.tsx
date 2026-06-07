import { join } from "node:path";
import { homedir } from "node:os";
import { Box, Text, useApp, useInput } from "ink";
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { formatAgentTarget, modelsForAgent } from "../agents";
import { refreshAgentCatalogCaches } from "../agents/models";
import {
  type SlashCommandContext,
  applySlashSuggestion,
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
import { homeRelativePath } from "../paths";
import { DEFAULT_PROMPT_HISTORY_LIMIT, type SteamtrainSettings } from "../settings";
import { STEAMTRAIN_VERSION } from "../version";
import {
  type LoadedWorkflowCatalog,
  type StepResult,
  type WorkflowCatalogEntry,
  type WorkflowStepOverrides,
  WORKFLOW_CACHE_DIR,
  applyWorkflowStepOverrides,
  createWorkflowCacheStore,
  isAgentBackedStep,
  loadWorkflowCatalog,
  persistWorkflowStepDone,
  saveSessionWorkflowsToUser,
  workflowCacheKey,
  workflowCatalogEntries,
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
import { WorkflowPicker } from "./WorkflowPicker";
import { WorkflowPreview } from "./WorkflowPreview";
import { WorkflowView } from "./WorkflowView";
import { Banner } from "./banner";
import { type Mode, buildModes, isWorkspaceMode, nextMode } from "./modes";
import { workflowListNavigation } from "./prompt-editing";
import {
  type PromptDraftByMode,
  getPromptDraft,
  initialPromptTabState,
  patchPromptDraft,
} from "./prompt-draft";
import {
  type PromptArrowContext,
  type PromptHistoryBrowse,
  type PromptHistoryByMode,
  initialPromptHistoryBrowse,
  navigatePromptHistory,
  pushPromptHistory,
  shouldPromptHistoryArrows,
  shouldPromptHistoryCaptureDown,
  shouldPromptHistoryCaptureUp,
} from "./prompt-history";
import {
  shouldApplySuggestionOnSubmit,
  shouldDismissSuggestionMenu,
  shouldSuppressWorkflowNavigation,
} from "./slash-completion";
import { initialTranscript, transcriptReducer } from "./transcript";
import { useTerminalSize } from "./useTerminalSize";
import { flattenSpecSteps } from "./workflow-spec-ui";
import { initialWorkflowState, workflowReducer } from "./workflow-state";

interface AppProps {
  config: SteamtrainConfig;
  configSource: string;
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

export function App({
  config,
  configSource,
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

  const [phase, setPhase] = useState<Phase>("banner");
  const [doctor, setDoctor] = useState<DoctorResult[] | null>(null);
  const [mode, setMode] = useState<Mode>("workflow");
  const [runtimeWorkspaces, setRuntimeWorkspaces] = useState<WorkspaceConfig>(workspaces);
  const [runtimeCatalog, setRuntimeCatalog] = useState<LoadedWorkflowCatalog>(workflowCatalog);
  const [activeWorkspaceLabel, setActiveWorkspaceLabel] = useState(workspaceLabel);
  const [draftByMode, setDraftByMode] = useState<PromptDraftByMode>(() => new Map());
  const activeDraft = getPromptDraft(draftByMode, mode);
  const value = activeDraft.value;
  const historyBrowse = activeDraft.historyBrowse;
  const promptEditing = activeDraft.promptEditing;
  const [commandSuggestions, setCommandSuggestions] = useState<readonly string[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [cursorResetKey, setCursorResetKey] = useState(0);
  const [running, setRunning] = useState(false);
  const [transcript, dispatch] = useReducer(transcriptReducer, initialTranscript);
  const [promptHistoryByMode, setPromptHistoryByMode] = useState<PromptHistoryByMode>(
    () => new Map(),
  );
  const promptHistoryLimit = settings.promptHistoryLimit ?? DEFAULT_PROMPT_HISTORY_LIMIT;
  const [agentCatalogTick, setAgentCatalogTick] = useState(0);

  // Workflow mode state.
  const [wf, wfDispatch] = useReducer(workflowReducer, initialWorkflowState);
  const [workflowIndex, setWorkflowIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [wfPreview, setWfPreview] = useState<{ name: string; input: string } | null>(null);
  const [wfStepOverrides, setWfStepOverrides] = useState<Record<string, WorkflowStepOverrides>>(
    {},
  );
  const [wfLaunching, setWfLaunching] = useState(false);
  const [wfNotice, setWfNotice] = useState<string | null>(null);
  const [wfCanResume, setWfCanResume] = useState(false);
  const activeWorkflowRef = useRef<string | undefined>(undefined);
  const activeWorkflowInputRef = useRef<string | undefined>(undefined);
  const workflowCacheRef = useRef<Map<string, StepResult>>(new Map());
  const cacheStoreRef = useRef(createWorkflowCacheStore(join(process.cwd(), WORKFLOW_CACHE_DIR)));
  const runtimeWorkspacesRef = useRef(runtimeWorkspaces);
  runtimeWorkspacesRef.current = runtimeWorkspaces;

  const modes = useMemo(() => buildModes(runtimeWorkspaces), [runtimeWorkspaces]);
  const workspaceMap = useMemo(() => workspaceById(runtimeWorkspaces), [runtimeWorkspaces]);

  const updatePromptDraft = useCallback(
    (patch: Partial<typeof initialPromptTabState>) => {
      setDraftByMode((prev) => patchPromptDraft(prev, mode, patch));
    },
    [mode],
  );

  const switchMode = useCallback((next: SetStateAction<Mode>) => {
    setMode(next);
    setCommandSuggestions([]);
    setSuggestionIndex(0);
    setCursorResetKey((k) => k + 1);
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

  const patchWorkflowStep = useCallback(
    (stepId: string, patch: Partial<Pick<WorkspaceEntry, "agent" | "model" | "effort">>) => {
      if (!wfPreview) return;
      setWfStepOverrides((prev) => ({
        ...prev,
        [wfPreview.name]: {
          ...(prev[wfPreview.name] ?? {}),
          [stepId]: { ...(prev[wfPreview.name]?.[stepId] ?? {}), ...patch },
        },
      }));
    },
    [wfPreview],
  );

  const orchestrator = useMemo(
    () => new Orchestrator(config, runtimeWorkspaces, doctor ?? [], runtimeCatalog),
    [config, runtimeWorkspaces, doctor, runtimeCatalog],
  );

  const resolveWorkflowSpec = useCallback(
    (name: string) => {
      const base = orchestrator.listWorkflows()[name];
      if (!base) return undefined;
      return applyWorkflowStepOverrides(base, wfStepOverrides[name]);
    },
    [orchestrator, wfStepOverrides],
  );

  const workflowEntries = useMemo<WorkflowCatalogEntry[]>(
    () => workflowCatalogEntries(runtimeCatalog),
    [runtimeCatalog],
  );

  const saveWorkflows = useCallback(() => {
    const home = homedir();
    const result = saveSessionWorkflowsToUser({
      catalog: runtimeCatalog,
      sessionOverrides: wfStepOverrides,
      home,
    });

    if (result.saved.length === 0) {
      const notices: Array<{ level: "info" | "warn"; text: string }> = [
        { level: "info", text: "no workflow changes to save" },
      ];
      for (const entry of result.skipped) {
        notices.push({ level: "warn", text: `skipped '${entry.name}': ${entry.reason}` });
      }
      return { handled: true as const, clearInput: true, notices };
    }

    setRuntimeCatalog(loadWorkflowCatalog({ home, projectWorkflows: config.workflows }));
    setWfStepOverrides((prev) => {
      const next = { ...prev };
      for (const name of result.saved) delete next[name];
      return next;
    });

    const notices: Array<{ level: "info" | "warn"; text: string }> = [
      {
        level: "info",
        text: `saved ${result.saved.join(", ")} to ${homeRelativePath(result.path!, home)}`,
      },
    ];
    for (const entry of result.skipped) {
      notices.push({ level: "warn", text: `skipped '${entry.name}': ${entry.reason}` });
    }
    return { handled: true as const, clearInput: true, notices };
  }, [runtimeCatalog, wfStepOverrides, config.workflows]);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Surface config-load warnings (kept defaults) once.
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

  // Show the banner briefly, then hand over to the main UI.
  useEffect(() => {
    const t = setTimeout(() => setPhase("main"), BANNER_MS);
    return () => clearTimeout(t);
  }, []);

  // Preflight doctor runs at startup, before any dispatch is allowed.
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

  const totalWfSteps = wf.phases.reduce((n, p) => n + p.steps.length, 0);
  const previewSpec = wfPreview ? resolveWorkflowSpec(wfPreview.name) : undefined;
  const previewFlatSteps = useMemo(
    () => (previewSpec ? flattenSpecSteps(previewSpec) : []),
    [previewSpec],
  );
  const previewStepCount = previewFlatSteps.length;
  const previewSelectedStep =
    previewFlatSteps.length > 0
      ? previewFlatSteps[Math.min(stepIndex, previewFlatSteps.length - 1)]
      : undefined;
  const previewStepSelection = useMemo(() => {
    if (!wfPreview || !previewSelectedStep) return undefined;
    const step = previewSelectedStep.step;
    if (!isAgentBackedStep(step)) return undefined;
    return {
      workflowName: wfPreview.name,
      stepId: step.id,
      agent: step.agent,
      model: step.model,
      effort: step.effort,
    };
  }, [wfPreview, previewSelectedStep]);
  const previewDispatchCheck =
    previewSpec ? orchestrator.canDispatchWorkflowSpec(previewSpec) : null;

  const slashCtx = useMemo<SlashCommandContext>(
    () => ({
      mode,
      modes,
      workspaces: runtimeWorkspaces,
      workspaceMap,
      updateWorkspace,
      setMode: switchMode,
      version: STEAMTRAIN_VERSION,
      workflowStep: previewStepSelection,
      updateWorkflowStep: wfPreview ? patchWorkflowStep : undefined,
      saveWorkflows,
    }),
    [
      mode,
      modes,
      runtimeWorkspaces,
      workspaceMap,
      updateWorkspace,
      switchMode,
      wfPreview,
      patchWorkflowStep,
      previewStepSelection,
      saveWorkflows,
    ],
  );

  // Refresh an open /model completion menu once the live OpenCode catalog loads.
  useEffect(() => {
    if (agentCatalogTick === 0) return;
    if (!isSlashCommandInput(value)) return;
    const parsed = parseSlashInput(value);
    if (parsed?.command !== "model") return;
    const result = autocompleteSlashCommand(value, listSlashCommands(), slashCtx);
    if (!result || result.suggestions.length <= 1) return;
    setCommandSuggestions(result.suggestions);
    setSuggestionIndex((i) => Math.min(i, result.suggestions.length - 1));
  }, [agentCatalogTick, value, slashCtx]);

  useEffect(() => {
    if (mode !== "workflow" || running) {
      setWfCanResume(false);
      return;
    }

    const prompt = value.trim();
    if (prompt.length === 0) {
      setWfCanResume(false);
      return;
    }

    if (wf.started || wfLaunching) {
      setWfCanResume(
        activeWorkflowRef.current !== undefined &&
          activeWorkflowInputRef.current === prompt &&
          workflowCacheRef.current.size > 0,
      );
      return;
    }

    if (!wfPreview) {
      setWfCanResume(false);
      return;
    }

    const spec = resolveWorkflowSpec(wfPreview.name);
    if (!spec) {
      setWfCanResume(false);
      return;
    }

    const key = workflowCacheKey(wfPreview.name, prompt, process.cwd(), spec);
    let active = true;
    void cacheStoreRef.current.load(key).then((cache) => {
      if (active) setWfCanResume(cache.size > 0);
    });
    return () => {
      active = false;
    };
  }, [mode, running, wf.started, wfLaunching, wfPreview, value, orchestrator, resolveWorkflowSpec]);

  const runWorkflow = useCallback(
    (
      name: string,
      input: string,
      opts?: { reuseMemoryCache?: boolean; fresh?: boolean },
    ): boolean => {
      const spec = resolveWorkflowSpec(name);
      if (!spec) {
        setWfNotice(`unknown workflow '${name}'`);
        return false;
      }
      const check = orchestrator.canDispatchWorkflowSpec(spec);
      if (!check.ok) {
        setWfNotice(`cannot run '${name}': ${check.reason}`);
        return false;
      }
      setWfNotice(null);
      activeWorkflowRef.current = name;
      activeWorkflowInputRef.current = input;
      setRunning(true);
      const ac = new AbortController();
      abortRef.current = ac;

      void (async () => {
        const store = cacheStoreRef.current;
        const cwd = process.cwd();
        const key = workflowCacheKey(name, input, cwd, spec);
        try {
          if (opts?.fresh) {
            await store.clear(key);
            workflowCacheRef.current = new Map();
          } else if (!opts?.reuseMemoryCache) {
            workflowCacheRef.current = await store.load(key);
          }
          const cache = workflowCacheRef.current;
          for await (const event of orchestrator.runWorkflow(
            name,
            input,
            ac.signal,
            cache,
            cwd,
            spec,
          )) {
            if (!mountedRef.current) return;
            wfDispatch({ type: "event", event });
            if (event.kind === "step_done") {
              await persistWorkflowStepDone(
                store,
                key,
                cache,
                event.stepId,
                event.result,
                event.cached,
              );
            }
          }
        } catch (err) {
          if (mountedRef.current) setWfNotice(`run failed: ${message(err)}`);
        } finally {
          if (mountedRef.current) {
            setRunning(false);
            setWfLaunching(false);
            abortRef.current = null;
          }
        }
      })();
      return true;
    },
    [orchestrator, resolveWorkflowSpec],
  );

  const bumpCursorToEnd = useCallback(() => {
    setCursorResetKey((k) => k + 1);
  }, []);

  const exitPromptEditing = useCallback(() => {
    const patch: Partial<typeof initialPromptTabState> = {
      historyBrowse: initialPromptHistoryBrowse,
      promptEditing: false,
    };
    if (historyBrowse.browseIndex !== null) patch.value = historyBrowse.draft;
    updatePromptDraft(patch);
    setCommandSuggestions([]);
    setSuggestionIndex(0);
    bumpCursorToEnd();
  }, [historyBrowse, updatePromptDraft, bumpCursorToEnd]);

  const promptArrowCtx = useMemo<PromptArrowContext>(
    () => ({
      deferToListNavigation: workflowListNavigation(mode),
      promptEditing,
    }),
    [mode, promptEditing],
  );

  const handleValueChange = useCallback(
    (next: string) => {
      updatePromptDraft({
        value: next,
        promptEditing: true,
        historyBrowse: initialPromptHistoryBrowse,
      });
      setCommandSuggestions([]);
      setSuggestionIndex(0);
    },
    [updatePromptDraft],
  );

  const recordPromptHistory = useCallback(
    (raw: string) => {
      setPromptHistoryByMode((prev) => pushPromptHistory(prev, mode, raw, promptHistoryLimit));
      updatePromptDraft({ historyBrowse: initialPromptHistoryBrowse });
    },
    [mode, promptHistoryLimit, updatePromptDraft],
  );

  const handleHistoryNavigate = useCallback(
    (direction: "up" | "down"): boolean => {
      if (direction === "up") {
        if (
          !shouldPromptHistoryCaptureUp(
            promptHistoryByMode,
            mode,
            value,
            historyBrowse,
            promptArrowCtx,
          )
        ) {
          return false;
        }
      } else if (!shouldPromptHistoryCaptureDown(historyBrowse, promptArrowCtx, value)) {
        return false;
      }

      const result = navigatePromptHistory(
        promptHistoryByMode,
        historyBrowse,
        mode,
        value,
        direction,
      );
      if (!result) return false;
      updatePromptDraft({
        value: result.value,
        historyBrowse: { browseIndex: result.browseIndex, draft: result.draft },
      });
      bumpCursorToEnd();
      return true;
    },
    [promptHistoryByMode, mode, value, historyBrowse, promptArrowCtx, updatePromptDraft, bumpCursorToEnd],
  );

  const promptHistoryArrows = shouldPromptHistoryArrows(promptArrowCtx, value, historyBrowse);

  const handleTab = useCallback(() => {
    if (!isSlashCommandInput(value)) return;
    const commands = listSlashCommands();

    if (commandSuggestions.length > 1) {
      const pick = commandSuggestions[suggestionIndex];
      if (!pick) return;
      const nextValue = applySlashSuggestion(value, pick, commands, slashCtx);
      if (nextValue !== value) {
        updatePromptDraft({ value: nextValue, promptEditing: true });
        bumpCursorToEnd();
      }
      const result = autocompleteSlashCommand(nextValue, commands, slashCtx);
      if (!result) {
        setCommandSuggestions([]);
        setSuggestionIndex(0);
        return;
      }
      setCommandSuggestions(result.suggestions);
      setSuggestionIndex(0);
      return;
    }

    const result = autocompleteSlashCommand(value, commands, slashCtx);
    if (!result) {
      setCommandSuggestions([]);
      setSuggestionIndex(0);
      return;
    }
    if (result.value !== value) {
      updatePromptDraft({ value: result.value, promptEditing: true });
      bumpCursorToEnd();
    }
    setCommandSuggestions(result.suggestions);
    setSuggestionIndex(0);
  }, [value, slashCtx, commandSuggestions, suggestionIndex, updatePromptDraft, bumpCursorToEnd]);

  const handleSuggestionNavigate = useCallback(
    (direction: "up" | "down") => {
      if (commandSuggestions.length <= 1) return;
      setSuggestionIndex((i) => {
        if (direction === "down") {
          return Math.min(commandSuggestions.length - 1, i + 1);
        }
        return Math.max(0, i - 1);
      });
    },
    [commandSuggestions.length],
  );

  const suggestionMenuOpen = commandSuggestions.length > 1 && isSlashCommandInput(value);

  const suggestionDescriptions = useMemo(() => {
    if (!suggestionMenuOpen) return undefined;
    const parsed = parseSlashInput(value);
    if (!parsed) return undefined;

    if (parsed.command === "model") {
      if (isWorkspaceMode(mode)) {
        const entry = workspaceMap.get(mode);
        if (!entry) return undefined;
        void agentCatalogTick;
        const map = new Map<string, string>();
        for (const model of modelsForAgent(entry.agent)) {
          if (model.name !== model.id) map.set(model.id, model.name);
        }
        return map.size > 0 ? map : undefined;
      }
      if (previewStepSelection) {
        void agentCatalogTick;
        const map = new Map<string, string>();
        for (const model of modelsForAgent(previewStepSelection.agent)) {
          if (model.name !== model.id) map.set(model.id, model.name);
        }
        return map.size > 0 ? map : undefined;
      }
    }

    const body = value.trimStart().slice(1);
    const hasArgumentTokens = body.includes(" ");
    if (hasArgumentTokens && parsed.command.length > 0) return undefined;
    const map = new Map<string, string>();
    for (const c of listSlashCommands()) {
      map.set(c.name, c.description);
    }
    return map;
  }, [value, suggestionMenuOpen, mode, workspaceMap, agentCatalogTick, previewStepSelection]);

  const launchWorkflow = useCallback(
    (name: string, prompt: string, opts?: { reuseMemoryCache?: boolean; fresh?: boolean }) => {
      setWfLaunching(true);
      wfDispatch({ type: "reset" });
      setStepIndex(0);
      setWfPreview(null);
      if (!runWorkflow(name, prompt, opts)) {
        setWfLaunching(false);
        setWfPreview({ name, input: prompt });
      }
    },
    [runWorkflow],
  );

  const handleWorkflowRun = useCallback(
    (prompt: string, fresh: boolean): boolean => {
      if (running || mode !== "workflow") return false;

      if (wf.started && activeWorkflowRef.current) {
        if (prompt.length === 0) return false;
        if (!fresh) {
          if (activeWorkflowInputRef.current !== prompt) return false;
          if (workflowCacheRef.current.size === 0) return false;
          runWorkflow(activeWorkflowRef.current, prompt, { reuseMemoryCache: true });
          return true;
        }
        launchWorkflow(activeWorkflowRef.current, prompt, { fresh: true });
        return true;
      }

      if (wfPreview) {
        if (prompt.length === 0) {
          setWfNotice("type input in the prompt before running");
          return false;
        }
        if (!fresh && !wfCanResume) return false;
        launchWorkflow(wfPreview.name, prompt, fresh ? { fresh: true } : undefined);
        return true;
      }

      const entry = workflowEntries[workflowIndex];
      if (!entry) return false;
      if (prompt.length === 0) {
        setWfNotice("type input in the prompt before running");
        return false;
      }
      launchWorkflow(entry.name, prompt, { fresh: true });
      return true;
    },
    [
      running,
      mode,
      wf.started,
      wfPreview,
      wfCanResume,
      workflowEntries,
      workflowIndex,
      launchWorkflow,
      runWorkflow,
    ],
  );

  const handleSubmit = useCallback(
    (raw: string) => {
      setCommandSuggestions([]);
      setSuggestionIndex(0);

      const prompt = raw.trim();

      if (isRegisteredSlashCommand(prompt)) {
        const result = executeSlashCommand(prompt, slashCtx);
        if (result.handled) {
          updatePromptDraft(
            result.clearInput ? { value: "", promptEditing: false } : { promptEditing: false },
          );
          setCommandSuggestions([]);
          for (const notice of result.notices ?? []) {
            dispatch({ type: "notice", level: notice.level, text: notice.text });
          }
          if (result.exit) exit();
          return;
        }
      }

      if (running) return;

      if (mode === "workflow") {
        if (wf.started && activeWorkflowRef.current) {
          const ran = handleWorkflowRun(prompt, false);
          if (ran) updatePromptDraft({ promptEditing: false });
          return;
        }
        if (wfPreview) {
          const ran = handleWorkflowRun(prompt, false);
          if (ran) updatePromptDraft({ promptEditing: false });
          return;
        }
        const entry = workflowEntries[workflowIndex];
        if (!entry) return;
        setWfNotice(null);
        setStepIndex(0);
        setWfPreview({ name: entry.name, input: prompt });
        updatePromptDraft({ promptEditing: false });
        return;
      }

      // Workspace mode — `mode` is a workspace id here.
      if (prompt.length === 0) return;
      updatePromptDraft({ value: "", promptEditing: false });
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
      setRunning(true);
      const ac = new AbortController();
      abortRef.current = ac;

      void (async () => {
        try {
          for await (const event of orchestrator.run(mode, prompt, ac.signal)) {
            if (!mountedRef.current) return;
            dispatch({ type: "event", event });
          }
        } catch (err) {
          if (mountedRef.current) {
            dispatch({ type: "notice", level: "error", text: `run failed: ${message(err)}` });
          }
        } finally {
          if (mountedRef.current) {
            setRunning(false);
            abortRef.current = null;
          }
        }
      })();
    },
    [
      orchestrator,
      running,
      mode,
      wf.started,
      workflowEntries,
      workflowIndex,
      handleWorkflowRun,
      workspaceMap,
      slashCtx,
      exit,
    ],
  );

  const handlePromptSubmit = useCallback(
    (raw: string) => {
      if (shouldApplySuggestionOnSubmit(commandSuggestions, raw)) {
        handleTab();
        return;
      }
      recordPromptHistory(raw);
      handleSubmit(raw);
    },
    [commandSuggestions, handleTab, handleSubmit, recordPromptHistory],
  );

  const handleWorkflowFreshRun = useCallback(() => {
    const prompt = value.trim();
    recordPromptHistory(value);
    if (handleWorkflowRun(prompt, true)) updatePromptDraft({ value: "", promptEditing: false });
  }, [value, recordPromptHistory, handleWorkflowRun, updatePromptDraft]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      abortRef.current?.abort();
      exit();
      return;
    }
    if (key.ctrl && input === "q" && running && mode === "workflow") {
      abortRef.current?.abort();
      return;
    }
    if (key.escape) {
      if (shouldDismissSuggestionMenu(commandSuggestions, value)) {
        setCommandSuggestions([]);
        setSuggestionIndex(0);
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
    if (key.tab && !key.shift && !running) {
      const promptInputHandlesTab = isSlashCommandInput(value) && promptEditing;
      if (!promptInputHandlesTab) {
        setWfPreview(null);
        setWfLaunching(false);
        switchMode((prev) => nextMode(prev, modes));
      }
      return;
    }
    const menuOpen = shouldSuppressWorkflowNavigation(commandSuggestions, value);
    const historyUp =
      !menuOpen &&
      shouldPromptHistoryCaptureUp(
        promptHistoryByMode,
        mode,
        value,
        historyBrowse,
        promptArrowCtx,
      );
    const historyDown =
      !menuOpen && shouldPromptHistoryCaptureDown(historyBrowse, promptArrowCtx, value);
    if (mode === "workflow" && !menuOpen && !historyUp && !historyDown) {
      if (key.upArrow) {
        if (wf.started || wfLaunching) setStepIndex((i) => Math.max(0, i - 1));
        else if (wfPreview) setStepIndex((i) => Math.max(0, i - 1));
        else setWorkflowIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        if (wf.started || wfLaunching) {
          setStepIndex((i) => Math.min(Math.max(0, totalWfSteps - 1), i + 1));
        } else if (wfPreview) {
          setStepIndex((i) => Math.min(Math.max(0, previewStepCount - 1), i + 1));
        } else setWorkflowIndex((i) => Math.min(workflowEntries.length - 1, i + 1));
        return;
      }
    }
  });

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
  const showWorkflowView = wf.started || wfLaunching;

  const menuOverlayRows = suggestionMenuOpen
    ? suggestionMenuHeight(commandSuggestions.length, suggestionIndex)
    : 0;

  return (
    <Box flexDirection="column" width={columns}>
      <StatusBar
        doctor={doctor}
        configSource={configSource}
        workspaceLabel={activeWorkspaceLabel}
        running={running}
      />
      {isWorkflow ? (
        showWorkflowView ? (
          <WorkflowView
            state={wf}
            height={streamHeight}
            width={columns}
            selectedIndex={stepIndex}
          />
        ) : wfPreview && previewSpec && previewDispatchCheck ? (
          <WorkflowPreview
            spec={previewSpec}
            source={orchestrator.workflowSource(wfPreview.name) ?? "bundled"}
            input={value.trim() || wfPreview.input}
            width={columns}
            height={streamHeight}
            selectedIndex={stepIndex}
            dispatchCheck={previewDispatchCheck}
            canResume={wfCanResume}
            promptEditing={promptEditing}
          />
        ) : (
          <WorkflowPicker
            workflows={workflowEntries}
            selectedIndex={workflowIndex}
            height={streamHeight}
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
        modes={modes}
        workspaceMap={workspaceMap}
        active={mode}
        workflowName={isWorkflow ? workflowEntries[workflowIndex]?.name : undefined}
        workflowSource={isWorkflow ? workflowEntries[workflowIndex]?.source : undefined}
      />
      {wfNotice && isWorkflow ? (
        <Box paddingX={1}>
          <Text color="red">{wfNotice}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column">
        {suggestionMenuOpen ? (
          <Box marginTop={-menuOverlayRows}>
            <CommandSuggestionMenu
              suggestions={commandSuggestions}
              selectedIndex={suggestionIndex}
              width={columns}
              descriptions={suggestionDescriptions}
            />
          </Box>
        ) : null}
        <PromptInput
          value={value}
          onChange={handleValueChange}
          onSubmit={handlePromptSubmit}
          onTab={handleTab}
          onCtrlR={mode === "workflow" && !running ? handleWorkflowFreshRun : undefined}
          onSuggestionNavigate={handleSuggestionNavigate}
          onHistoryNavigate={promptHistoryArrows ? handleHistoryNavigate : undefined}
          focus
          editing={!workflowListNavigation(mode) || promptEditing}
          promptEditing={promptEditing}
          running={running}
          cancelKeyHint={mode === "workflow" ? "Ctrl+Q" : "Esc"}
          suggestions={commandSuggestions}
          cursorResetKey={cursorResetKey}
        />
        <Box paddingX={1}>
          <Text color="gray">
            {hint(
              mode,
              wf.started,
              wfLaunching,
              !!wfPreview,
              running,
              suggestionMenuOpen,
              wfCanResume,
              promptEditing,
              isSlashCommandInput(value),
            )}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

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
): string {
  const completeHint = suggestionMenuOpen ? " · ↑/↓ complete · Tab/Enter pick · Esc cancel" : "";
  const historyHint = " · ↑/↓ history";
  const resumeHint = canResume ? " · Enter resume" : "";
  if (running) {
    return mode === "workflow"
      ? "Ctrl+Q cancel · /exit quit · Ctrl+C quit"
      : "Esc cancel · /exit quit · Ctrl+C quit";
  }
  if (mode === "workflow") {
    if (promptEditing) {
      const tabHint = slashInput ? " · Esc unfocus" : " · Esc list";
      const editingHint = `↑/↓ history${resumeHint}${tabHint} · Ctrl+R run · /commands · Ctrl+C quit${completeHint}`;
      if (wfStarted || wfLaunching || wfPreviewing) return editingHint;
      return `↑/↓ history · Enter preview${tabHint} · Ctrl+R run · /commands · Ctrl+C quit${completeHint}`;
    }
    if (wfStarted || wfLaunching) {
      return `↑/↓ step · type to edit · Ctrl+R run · Ctrl+Q cancel · Esc back · Tab switch mode · /commands · Ctrl+C quit${completeHint}`;
    }
    if (wfPreviewing) {
      return `↑/↓ step · type to edit · Enter preview · Ctrl+R run · Esc back · Tab switch mode · /commands · Ctrl+C quit${completeHint}`;
    }
    return `↑/↓ pick · type to edit · Enter preview · Ctrl+R run · Tab switch mode · /commands · Ctrl+C quit${completeHint}`;
  }
  return promptEditing && slashInput
    ? `Enter dispatch${historyHint} · Esc unfocus · /commands (Tab complete) · Ctrl+C quit${completeHint}`
    : `Enter dispatch${historyHint} · Tab switch mode · /commands (Tab complete) · Ctrl+C quit${completeHint}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
