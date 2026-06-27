import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
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
  type AuthoringHost,
  type LoadedWorkflowCatalog,
  type RerunMode,
  type RunRecord,
  RunRecordBuilder,
  type RunRecordSummary,
  type StepResult,
  WORKFLOW_CACHE_DIR,
  WORKFLOW_HISTORY_DIR,
  WorkflowAuthor,
  type WorkflowCatalogEntry,
  type WorkflowScope,
  type WorkflowSourceKind,
  type WorkflowSpec,
  type WorkflowStepOverrides,
  createWorkflowCacheStore,
  createWorkflowHistoryStore,
  hashWorkflowSpec,
  isAgentBackedStep,
  isRerunError,
  persistWorkflowStepDone,
  planRerun,
  rerunDowngradeMessage,
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
import { WorkflowCreate, type WorkflowCreateState } from "./WorkflowCreate";
import { WorkflowHistory } from "./WorkflowHistory";
import { WorkflowPicker } from "./WorkflowPicker";
import { WorkflowPreview } from "./WorkflowPreview";
import { WorkflowStepDetails } from "./WorkflowStepDetails";
import { WorkflowView } from "./WorkflowView";
import { Banner } from "./banner";
import { createWorkflowPromptValue } from "./create-workflow-prompt";
import {
  type DraftTarget,
  formatDraftTarget,
  healthyAgentSet,
  resolveDraftTarget,
} from "./draft-model";
import { type Mode, buildModes, isWorkflowPickerActive, isWorkspaceMode, nextMode } from "./modes";
import {
  type PromptDraftByMode,
  getPromptDraft,
  initialPromptTabState,
  patchPromptDraft,
} from "./prompt-draft";
import { workflowListNavigation } from "./prompt-editing";
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
import {
  type WorkflowState,
  flattenSteps,
  initialWorkflowState,
  workflowReducer,
  workflowStateFromRecord,
} from "./workflow-state";

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

/** State for the past-run history browser (opened with `/history`). */
interface HistoryUiState {
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
  const [wfStepOverrides, setWfStepOverrides] = useState<Record<string, WorkflowStepOverrides>>({});
  const [wfLaunching, setWfLaunching] = useState(false);
  const [wfNotice, setWfNotice] = useState<string | null>(null);
  const [wfCanResume, setWfCanResume] = useState(false);
  const [wfStepDetails, setWfStepDetails] = useState<"preview" | "live" | null>(null);
  const [wfNow, setWfNow] = useState(() => Date.now());
  const [wfCreate, setWfCreate] = useState<WorkflowCreateState | null>(null);
  const [draftOverride, setDraftOverride] = useState<DraftTarget | null>(null);
  const [history, setHistory] = useState<HistoryUiState | null>(null);
  const createAbortRef = useRef<AbortController | null>(null);
  const activeWorkflowRef = useRef<string | undefined>(undefined);
  const activeWorkflowInputRef = useRef<string | undefined>(undefined);
  const workflowCacheRef = useRef<Map<string, StepResult>>(new Map());
  const cacheStoreRef = useRef(createWorkflowCacheStore(join(process.cwd(), WORKFLOW_CACHE_DIR)));
  const historyStoreRef = useRef(
    createWorkflowHistoryStore(join(process.cwd(), WORKFLOW_HISTORY_DIR)),
  );
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

  // Shared authoring core: the TUI drives the same `WorkflowAuthor` the web
  // server uses, bridging its catalog reloads back into React state.
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

  const resolveWorkflowSpec = useCallback(
    (name: string) => author.previewWithOverrides(name, wfStepOverrides[name]),
    [author, wfStepOverrides],
  );

  const workflowEntries = useMemo<WorkflowCatalogEntry[]>(
    () => workflowCatalogEntries(runtimeCatalog),
    [runtimeCatalog],
  );

  // The picker's last selectable row is a synthetic "create" action (index ===
  // entry count), not a real workflow — so nothing is "selected" for
  // preview/clone/run while it is highlighted.
  const onCreateRow = workflowIndex >= workflowEntries.length;
  const selectedWorkflowName = onCreateRow
    ? undefined
    : workflowEntries[Math.min(workflowIndex, Math.max(0, workflowEntries.length - 1))]?.name;
  const userWorkflowNames = useMemo(
    () =>
      workflowEntries
        .filter((entry) => entry.source === "user" || entry.source === "project")
        .map((entry) => entry.name),
    [workflowEntries],
  );
  const pendingSelectRef = useRef<string | null>(null);

  // Keep the picker selection in range and honor a queued post-write selection
  // (e.g. jump to a freshly cloned workflow once the catalog reloads).
  useEffect(() => {
    const pending = pendingSelectRef.current;
    if (pending) {
      const idx = workflowEntries.findIndex((entry) => entry.name === pending);
      if (idx >= 0) {
        pendingSelectRef.current = null;
        setWorkflowIndex(idx);
        return;
      }
    }
    // Allow `length` as a valid index: the create row sits one past the last
    // workflow and must stay reachable (and is the only row when empty).
    setWorkflowIndex((i) => Math.min(i, workflowEntries.length));
  }, [workflowEntries]);

  const cloneWorkflow = useCallback(
    (newName: string, scope: WorkflowScope = "user") => {
      // Prefer the previewed workflow (stable across catalog re-sorts) over the
      // picker index, which can drift to another row when the catalog reloads.
      const source = wfPreview?.name ?? selectedWorkflowName;
      if (!source) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [{ level: "warn" as const, text: "no workflow selected to clone" }],
        };
      }
      const result = author.clone(source, newName, scope);
      if (!result.ok) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [
            { level: "error" as const, text: `could not clone '${source}': ${result.error}` },
          ],
        };
      }
      pendingSelectRef.current = result.name ?? null;
      const where = scope === "project" ? " (project)" : "";
      return {
        handled: true as const,
        clearInput: true,
        notices: [
          { level: "info" as const, text: `cloned '${source}' → '${result.name}'${where}` },
        ],
      };
    },
    [author, selectedWorkflowName, wfPreview],
  );

  const deleteWorkflow = useCallback(
    (name: string) => {
      const result = author.remove(name);
      if (!result.ok) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [
            { level: "error" as const, text: `could not delete '${name}': ${result.error}` },
          ],
        };
      }
      setWfStepOverrides((prev) => {
        if (!prev[name]) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      });
      setWfPreview((prev) => (prev?.name === name ? null : prev));
      return {
        handled: true as const,
        clearInput: true,
        notices: [{ level: "info" as const, text: `deleted workflow '${name}'` }],
      };
    },
    [author],
  );

  const renameWorkflow = useCallback(
    (oldName: string, newName: string) => {
      if (running) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [{ level: "warn" as const, text: "cannot rename while a workflow is running" }],
        };
      }

      const source = oldName.trim() || wfPreview?.name || selectedWorkflowName;
      if (!source) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [{ level: "warn" as const, text: "no workflow selected to rename" }],
        };
      }

      const result = author.rename(source, newName);
      if (!result.ok) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [
            { level: "error" as const, text: `could not rename '${source}': ${result.error}` },
          ],
        };
      }

      const targetSlug = result.name;
      if (!targetSlug) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [
            { level: "error" as const, text: `could not rename '${source}': missing target name` },
          ],
        };
      }

      // Migrate session overrides if any (M4)
      setWfStepOverrides((prev) => migrateSessionOverrides(prev, source, targetSlug));

      // Update preview if renaming the previewed workflow (M4)
      setWfPreview((prev) => updatePreviewOnRename(prev, source, targetSlug));
      pendingSelectRef.current = targetSlug;

      return {
        handled: true as const,
        clearInput: true,
        notices: [
          { level: "info" as const, text: `renamed workflow '${source}' → '${targetSlug}'` },
        ],
      };
    },
    [author, selectedWorkflowName, wfPreview, running],
  );

  const saveWorkflows = useCallback(() => {
    const home = homedir();
    // The session flushes overrides and reloads the catalog into React state
    // (via the authoring host's setCatalog) when anything is written.
    const result = author.flushSessionOverrides(wfStepOverrides);

    if (result.saved.length === 0) {
      const notices: Array<{ level: "info" | "warn"; text: string }> = [
        { level: "info", text: "no workflow changes to save" },
      ];
      for (const entry of result.skipped) {
        notices.push({ level: "warn", text: `skipped '${entry.name}': ${entry.reason}` });
      }
      return { handled: true as const, clearInput: true, notices };
    }

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
  }, [author, wfStepOverrides]);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  // Drafting target for /createworkflow: a user override (via /model on the
  // picker) when its agent is healthy, else an auto pick. Shared by the create
  // action and the picker's status line.
  const healthyAgents = useMemo(() => healthyAgentSet(doctor), [doctor]);
  const draftResolution = useMemo(
    () => resolveDraftTarget(healthyAgents, draftOverride),
    [healthyAgents, draftOverride],
  );

  const createWorkflow = useCallback(
    (description: string, scope: WorkflowScope = "user") => {
      if (running) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [
            {
              level: "warn" as const,
              text: "finish or cancel the current run before creating a workflow",
            },
          ],
        };
      }
      const target = draftResolution.target;
      if (!target) {
        return {
          handled: true as const,
          clearInput: true,
          notices: [
            {
              level: "error" as const,
              text: "no healthy agent available to draft a workflow (check the doctor panel)",
            },
          ],
        };
      }

      createAbortRef.current?.abort();
      const ac = new AbortController();
      createAbortRef.current = ac;
      setWfCreate({
        status: "generating",
        description,
        agent: target.agent,
        model: target.model,
        text: "",
      });

      void (async () => {
        // Draft + validate + persist + reload through the shared authoring core
        // (the same path the web server uses); we only own the live preview.
        const result = await author.generate(
          { description, agent: target.agent, model: target.model, scope },
          (text) => {
            setWfCreate((prev) =>
              prev && prev.status === "generating" ? { ...prev, text: prev.text + text } : prev,
            );
          },
          ac.signal,
          // Auto-repair retry: clear the live buffer so a rejected draft and its
          // repair don't concatenate into one garbled blob. Only on retries, so
          // we never wipe any text seeded before the first run.
          (attempt) => {
            if (attempt <= 1) return;
            setWfCreate((prev) =>
              prev && prev.status === "generating" ? { ...prev, text: "" } : prev,
            );
          },
        );
        if (!mountedRef.current || ac.signal.aborted) return;

        if (!result.ok || !result.spec) {
          setWfCreate((prev) =>
            prev
              ? { ...prev, status: "error", error: result.error, text: result.raw || prev.text }
              : prev,
          );
          dispatch({
            type: "notice",
            level: "error",
            text: `workflow creation failed: ${result.error ?? "unknown error"}`,
          });
          return;
        }

        const spec = result.spec;
        pendingSelectRef.current = spec.name;
        setWfCreate((prev) =>
          prev
            ? { ...prev, status: "done", spec, savedPath: result.savedPath, error: undefined }
            : prev,
        );
        dispatch({
          type: "notice",
          level: "info",
          text: `created workflow '${spec.name}' (${result.replaced ? "updated" : "saved"}${
            scope === "project" ? ", project" : ""
          })`,
        });
      })();

      return {
        handled: true as const,
        clearInput: true,
        notices: [
          {
            level: "info" as const,
            text: `drafting workflow with ${target.agent} (${target.model})…`,
          },
        ],
      };
    },
    [running, draftResolution, author],
  );

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
        const runs = await historyStoreRef.current.list();
        if (!mountedRef.current) return;
        setHistory((prev) => (prev ? { ...prev, runs, loading: false } : prev));
      } catch (err) {
        if (!mountedRef.current) return;
        setHistory((prev) => (prev ? { ...prev, loading: false, error: message(err) } : prev));
      }
    })();
    return { handled: true as const, clearInput: true };
  }, []);

  const openHistoryRecord = useCallback((id: string) => {
    void (async () => {
      try {
        const record = await historyStoreRef.current.get(id);
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
  }, []);

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

  const showWorkflowView = wf.started || wfLaunching;
  const liveFlatSteps = useMemo(() => flattenSteps(wf), [wf]);
  const totalWfSteps = liveFlatSteps.length;
  const liveSelectedStep =
    liveFlatSteps.length > 0
      ? liveFlatSteps[Math.min(stepIndex, liveFlatSteps.length - 1)]
      : undefined;
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
  const previewDispatchCheck = previewSpec
    ? orchestrator.canDispatchWorkflowSpec(previewSpec)
    : null;
  // The workflow picker is the visible screen (not previewing, running,
  // drafting, or browsing history — all states where `mode` stays "workflow").
  // Shared by the `/model` draft gate, the Ctrl+N create shortcut, and the
  // selectable "create" row. `previewing` mirrors the render tree: a preview
  // only occupies the screen once its spec (and dispatch check) resolve.
  const workflowPickerActive = useMemo(
    () =>
      isWorkflowPickerActive({
        mode,
        history: Boolean(history),
        wfCreate: Boolean(wfCreate),
        previewing: Boolean(wfPreview && previewSpec && previewDispatchCheck),
        showWorkflowView,
      }),
    [mode, history, wfCreate, wfPreview, previewSpec, previewDispatchCheck, showWorkflowView],
  );
  const wfElapsedMs = wf.startedAt ? Math.max(0, (wf.done ? Date.now() : wfNow) - wf.startedAt) : 0;

  useEffect(() => {
    if (!wf.started || wf.done) return;
    setWfNow(Date.now());
    const timer = setInterval(() => setWfNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [wf.started, wf.done]);

  useEffect(() => {
    if (mode === "workflow" && !wfPreview && !showWorkflowView) {
      setStepIndex(0);
      setWfStepDetails(null);
    }
  }, [mode, wfPreview, showWorkflowView]);

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
      createWorkflow,
      cloneWorkflow,
      deleteWorkflow,
      renameWorkflow,
      userWorkflowNames,
      openHistory,
      // `/model` sets the draft model only on the bare picker (see
      // `workflowPickerActive`); elsewhere it keeps its legacy "select a step"
      // warning.
      draftModel: workflowPickerActive
        ? {
            current: draftResolution.target,
            usingOverride: draftResolution.usingOverride,
            healthyAgents: [...healthyAgents],
            set: setDraftOverride,
          }
        : undefined,
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
      workflowPickerActive,
      saveWorkflows,
      createWorkflow,
      cloneWorkflow,
      deleteWorkflow,
      renameWorkflow,
      userWorkflowNames,
      openHistory,
      draftResolution,
      healthyAgents,
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
  }, [mode, running, wf.started, wfLaunching, wfPreview, value, resolveWorkflowSpec]);

  const runWorkflow = useCallback(
    (
      name: string,
      input: string,
      opts?: { reuseMemoryCache?: boolean; fresh?: boolean; seed?: Map<string, StepResult> },
    ): boolean => {
      // Re-entrancy guard: a run is already in flight (its AbortController is
      // live). Starting another would clobber `abortRef` — orphaning the first
      // run's cancellation — and race its cache writes. This can be reached by
      // opening `/history` mid-run and pressing `r`/`f`.
      if (abortRef.current) {
        setWfNotice("a run is already in progress");
        return false;
      }
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
        const recorder = new RunRecordBuilder({
          id: randomUUID(),
          workflow: name,
          input,
          cwd,
          specHash: hashWorkflowSpec(spec),
        });
        let runError: string | undefined;
        let workflowOk = true;
        try {
          if (opts?.fresh) {
            await store.clear(key);
            workflowCacheRef.current = new Map();
          } else if (!opts?.reuseMemoryCache) {
            workflowCacheRef.current = await store.load(key);
          }
          const cache = workflowCacheRef.current;
          if (opts?.seed && opts.seed.size > 0) {
            // Seed already-succeeded steps and make them the resume baseline.
            for (const [stepId, result] of opts.seed) cache.set(stepId, result);
            await store.save(key, cache);
          }
          for await (const event of orchestrator.runWorkflow(
            name,
            input,
            ac.signal,
            cache,
            cwd,
            spec,
          )) {
            recorder.handle(event);
            if (event.kind === "workflow_done") workflowOk = event.ok;
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
          runError = message(err);
          if (mountedRef.current) setWfNotice(`run failed: ${runError}`);
        } finally {
          // Best-effort: record the run to history regardless of UI mount state.
          const status = ac.signal.aborted
            ? "canceled"
            : runError || !workflowOk
              ? "error"
              : "done";
          // Persist before flipping `running` back off: doing so re-enables
          // `/history`, and a user who opens it immediately must see the run
          // that just finished. Await the write so the record exists first
          // (mirrors the web driver, which persists before signaling terminal).
          try {
            await historyStoreRef.current.save(recorder.build({ status, error: runError }));
          } catch {
            // History is best-effort; a failed write must not break the run.
          }
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

  // Re-run / retry-failed a saved record: resolve the plan, close the history
  // overlay, then launch through the normal run loop with the seeded cache.
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
    [resolveWorkflowSpec, runWorkflow],
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

  // Discoverable entry to workflow creation: prefill the prompt with
  // `/createworkflow ` (carrying any text the user already typed) and focus it,
  // so the create row and Ctrl+N teach the command instead of requiring it to be
  // known up front. A confirming Enter then runs the registered slash command.
  const focusCreateWorkflowPrompt = useCallback(
    (seed = "") => {
      if (running) return;
      const nextValue = createWorkflowPromptValue(seed);
      updatePromptDraft({
        value: nextValue,
        promptEditing: true,
        historyBrowse: initialPromptHistoryBrowse,
      });
      setCommandSuggestions([]);
      setSuggestionIndex(0);
      bumpCursorToEnd();
    },
    [running, updatePromptDraft, bumpCursorToEnd],
  );

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
    [
      promptHistoryByMode,
      mode,
      value,
      historyBrowse,
      promptArrowCtx,
      updatePromptDraft,
      bumpCursorToEnd,
    ],
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
      setWfStepDetails(null);
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
      if (wfCreate?.status === "generating") return false;

      if (wf.started && activeWorkflowRef.current) {
        if (prompt.length === 0) return false;
        if (!fresh) {
          if (activeWorkflowInputRef.current !== prompt) return false;
          if (workflowCacheRef.current.size === 0) return false;
          launchWorkflow(activeWorkflowRef.current, prompt, { reuseMemoryCache: true });
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
      wfCreate,
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

      if (wfCreate && wfCreate.status === "done" && wfCreate.spec) {
        const specName = wfCreate.spec.name;
        setWfCreate(null);
        setWfPreview({ name: specName, input: prompt });
        setStepIndex(0);
        setWfNotice(null);
        updatePromptDraft({ promptEditing: false });
        return;
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
        if (workflowIndex >= workflowEntries.length) {
          // The selectable "create" row at the end of the picker.
          focusCreateWorkflowPrompt(prompt);
          return;
        }
        const entry = workflowEntries[workflowIndex];
        if (!entry) return;
        setWfNotice(null);
        setStepIndex(0);
        setWfPreview({ name: entry.name, input: prompt });
        setWfStepDetails(null);
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
      updatePromptDraft,
      focusCreateWorkflowPrompt,
      wfPreview,
      wfCreate,
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

  const handleWorkflowCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

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
      // Detail view: re-run / retry-failed (only in the step list, matching the
      // footer hint — not while the per-step drill-in panel is open), navigate
      // steps, toggle drill-in.
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
      shouldPromptHistoryCaptureUp(promptHistoryByMode, mode, value, historyBrowse, promptArrowCtx);
    const historyDown =
      !menuOpen && shouldPromptHistoryCaptureDown(historyBrowse, promptArrowCtx, value);
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

  const menuOverlayRows = suggestionMenuOpen
    ? suggestionMenuHeight(commandSuggestions.length, suggestionIndex)
    : 0;
  const activeWorkflowName = isWorkflow
    ? (activeWorkflowRef.current ?? wfPreview?.name ?? workflowEntries[workflowIndex]?.name)
    : undefined;
  const activeWorkflowSource: WorkflowSourceKind | undefined = activeWorkflowName
    ? (workflowEntries.find((entry) => entry.name === activeWorkflowName)?.source ??
      orchestrator.workflowSource(activeWorkflowName))
    : undefined;

  return (
    <Box flexDirection="column" width={columns}>
      <StatusBar
        doctor={doctor}
        configSource={configSource}
        workspaceLabel={activeWorkspaceLabel}
        running={running}
      />
      {history ? (
        <HistoryPanel history={history} width={columns} height={streamHeight} />
      ) : isWorkflow ? (
        wfCreate ? (
          <WorkflowCreate state={wfCreate} width={columns} height={streamHeight} />
        ) : wfStepDetails === "live" && showWorkflowView ? (
          <WorkflowStepDetails
            kind="live"
            state={wf}
            entry={liveSelectedStep}
            height={streamHeight}
            width={columns}
            selectedIndex={stepIndex}
            totalSteps={totalWfSteps}
            elapsedMs={wfElapsedMs}
          />
        ) : wfStepDetails === "preview" && wfPreview && previewSpec && previewDispatchCheck ? (
          <WorkflowStepDetails
            kind="preview"
            spec={previewSpec}
            source={orchestrator.workflowSource(wfPreview.name) ?? "bundled"}
            input={value.trim() || wfPreview.input}
            height={streamHeight}
            width={columns}
            entry={previewSelectedStep}
            selectedIndex={stepIndex}
            totalSteps={previewStepCount}
            dispatchOk={previewDispatchCheck.ok}
            dispatchReason={previewDispatchCheck.ok ? undefined : previewDispatchCheck.reason}
            canResume={wfCanResume}
          />
        ) : showWorkflowView ? (
          <WorkflowView
            state={wf}
            height={streamHeight}
            width={columns}
            selectedIndex={stepIndex}
            elapsedMs={wfElapsedMs}
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
            draftLabel={
              draftResolution.target
                ? `${formatDraftTarget(draftResolution.target)}${
                    draftResolution.usingOverride ? "" : " (auto)"
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
        modes={modes}
        workspaceMap={workspaceMap}
        active={mode}
        workflowName={activeWorkflowName}
        workflowSource={activeWorkflowSource}
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
          onCtrlQ={mode === "workflow" && running ? handleWorkflowCancel : undefined}
          onSuggestionNavigate={handleSuggestionNavigate}
          onHistoryNavigate={promptHistoryArrows ? handleHistoryNavigate : undefined}
          focus={!history}
          editing={!history && (!workflowListNavigation(mode) || promptEditing)}
          promptEditing={promptEditing}
          running={running}
          cancelKeyHint={mode === "workflow" ? "Ctrl+Q" : "Esc"}
          suggestions={commandSuggestions}
          cursorResetKey={cursorResetKey}
        />
        <Box paddingX={1}>
          <Text color="gray">
            {history
              ? historyHint(history)
              : hint(
                  mode,
                  wf.started,
                  wfLaunching,
                  !!wfPreview,
                  running,
                  suggestionMenuOpen,
                  wfCanResume,
                  promptEditing,
                  isSlashCommandInput(value),
                  !!wfStepDetails,
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

function historyHint(history: HistoryUiState): string {
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

/**
 * Migrate session overrides from an old workflow name to a new one.
 *
 * NOTE: Returning `prev` by reference when no migration is needed is an intentional
 * React state updater optimization to prevent unnecessary component re-renders.
 */
export function migrateSessionOverrides(
  prev: Record<string, WorkflowStepOverrides>,
  source: string,
  targetSlug: string,
): Record<string, WorkflowStepOverrides> {
  if (!prev[source]) return prev;
  const next = { ...prev };
  next[targetSlug] = next[source]!;
  delete next[source];
  return next;
}

/**
 * Update the preview state if the renamed workflow was being previewed.
 */
export function updatePreviewOnRename(
  prev: { name: string; input: string } | null,
  source: string,
  targetSlug: string,
): { name: string; input: string } | null {
  return prev?.name === source ? { name: targetSlug, input: prev.input } : prev;
}
