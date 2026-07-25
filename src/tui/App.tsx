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
import {
  agentConfigScope,
  agentScopeLabel,
  formatAgentTarget,
  listModelFamilyMeta,
  modelsForAgent,
  removeAgent,
  resolveAgentInstances,
  upsertAgent,
} from "../agents";
import { refreshAgentCatalogCaches } from "../agents/models";
import { apiConfigScope, apiScopeLabel, removeApi, resolveApiInstances, upsertApi } from "../apis";
import {
  type SlashCommandResult,
  autocompleteSlashCommand,
  executeSlashCommand,
  isRegisteredSlashCommand,
  isSlashCommandInput,
  listSlashCommands,
  parseSlashInput,
  unknownSlashCommand,
} from "../commands";
import type {
  AgentConfigScope,
  ApiConfigScope,
  ConfigScopeKind,
  SteamtrainConfig,
} from "../config";
import {
  configDisplayLabel,
  isAllowedApiBaseUrl,
  isValidApiKeyEnvName,
  loadConfig,
  resolveBinarySync,
  saveUserConfig,
  userConfigPath,
} from "../config";
import { saveProjectConfig } from "../config/project-config";
import type { AgentInstanceConfig, ApiInstanceConfig } from "../config/types";
import type { UserConfigPatch } from "../config/user-config";
import { type ApiDoctorResult, type DoctorResult, runApiDoctor, runDoctor } from "../doctor";
import { Orchestrator } from "../orchestrator";
import type { ProjectIdentity } from "../project";
import { resolveProjectIdentity } from "../project";
import type { SteamtrainSettings } from "../settings";
import {
  type AuthoringHost,
  type LoadedWorkflowCatalog,
  type PlanResult,
  type StepEditPatch,
  TOUR_WORKFLOW_NAME,
  WorkflowAuthor,
  type WorkflowSourceKind,
  type WorkflowStepOverrides,
  addTokensInto,
  emptyTokens,
  isAgentBackedStep,
  isCredentialFreeWorkflow,
  isTerminalLiveRunStatus,
  planHistoryContext,
  planWorkflow,
  shouldOfferStationLanding,
  totalTokens,
  workflowCacheKey,
  workflowStepKind,
} from "../workflow";
import type { WorkspaceConfig, WorkspaceEntry, WorkspaceId, WorkspaceScope } from "../workspace";
import {
  workspaceLabel as formatEntryLabel,
  saveWorkspaceConfig,
  workspaceById,
} from "../workspace";
import type { AgentAddRequest, AgentMutationResult } from "./AgentManager";
import { AgentManager } from "./AgentManager";
import type { ApiAddRequest, ApiMutationResult } from "./ApiManager";
import { ApiManager } from "./ApiManager";
import { CommandSuggestionMenu, suggestionMenuHeight } from "./CommandSuggestionMenu";
import { EventStream } from "./EventStream";
import { HelpPanel } from "./HelpPanel";
import { HistoryDiffPanel } from "./HistoryDiffPanel";
import { PromptInput } from "./PromptInput";
import { StatusBar } from "./StatusBar";
import { TaskSelector } from "./TaskSelector";
import { WorkflowAnswerInput } from "./WorkflowAnswerInput";
import { WorkflowCreate } from "./WorkflowCreate";
import { HistoryDetailBanner, WorkflowHistory } from "./WorkflowHistory";
import { WorkflowInputForm } from "./WorkflowInputForm";
import { WorkflowPicker } from "./WorkflowPicker";
import { WorkflowPreview } from "./WorkflowPreview";
import { type RunStepEditorTarget, WorkflowRunStepEditor } from "./WorkflowRunStepEditor";
import { WorkflowStepDetails } from "./WorkflowStepDetails";
import { WorkflowStepEditor } from "./WorkflowStepEditor";
import { WorkflowView } from "./WorkflowView";
import { Banner } from "./banner";
import { createWorkflowPromptValue } from "./create-workflow-prompt";
import { formatDraftTarget } from "./draft-model";
import { type Mode, isWorkflowPickerActive } from "./modes";
import { type OutputScroll, staticOutputScroll } from "./output-window";
import { workflowListNavigation } from "./prompt-editing";
import { initialPromptHistoryBrowse } from "./prompt-history";
import { initialTranscript, transcriptReducer } from "./transcript";
import { useTerminalSize } from "./useTerminalSize";
import { computeStreamHeight, message } from "./util";
import {
  type InputFormPending,
  resolveInputFormSubmit,
  workflowHasDeclaredInputs,
} from "./workflow-input-pending";
import { type PendingHumanInput, flattenSteps } from "./workflow-state";
import {
  type StepEditorTarget,
  listRetargetableSteps,
  stepEditorTarget,
} from "./workflow-step-editor";

// Custom hooks — each owns a cohesive slice of state.
import { type HistoryUiState, useHistory } from "./useHistory";
import { useKeyboardInput } from "./useKeyboardInput";
import { usePrompt } from "./usePrompt";
import { useSlashContext } from "./useSlashContext";
import {
  migrateSessionOverrides,
  updatePreviewOnRename,
  useWorkflowPicker,
} from "./useWorkflowPicker";
import { useWorkflowRunner } from "./useWorkflowRunner";

// Re-export pure helpers so the existing test import path (`./App`) keeps working.
export { migrateSessionOverrides, updatePreviewOnRename };

interface AppProps {
  config: SteamtrainConfig;
  configSource: string;
  /** Absolute project directory (honors `--project-dir`). */
  cwd: string;
  /** Display identity for the project (name + path). */
  project: ProjectIdentity;
  /** Resolved project `steamtrain.json` path for project-scope authoring. */
  configPath?: string;
  /** `custom` when a `--config` file is loaded alone (no global layer). */
  configKind?: ConfigScopeKind;
  /** Raw agent entries from the global `~/.steamtrain/config.json`. */
  userAgents?: AgentInstanceConfig[];
  /** Raw agent entries from the project config file. */
  projectAgents?: AgentInstanceConfig[];
  /** Raw API entries from the global `~/.steamtrain/config.json`. */
  userApis?: ApiInstanceConfig[];
  /** Raw API entries from the project config file. */
  projectApis?: ApiInstanceConfig[];
  /** Whether `~/.steamtrain/settings.json` exists (feeds the cfg label). */
  hasUserSettings?: boolean;
  configWarning?: string;
  settings: SteamtrainSettings;
  settingsWarning?: string;
  workflowCatalog: LoadedWorkflowCatalog;
  workspaces: WorkspaceConfig;
  workspaceScope: WorkspaceScope;
  workspaceLabel: string;
  workspaceWarning?: string;
  /** Called when quitting with no owned/attached work left to drain. */
  onIdleQuit?: () => void;
}

type Phase = "banner" | "main";
const BANNER_MS = 1100;
const EMPTY_DOCTOR: DoctorResult[] = [];

export function App({
  config,
  configSource,
  cwd,
  project,
  configPath,
  configKind = "project",
  userAgents,
  projectAgents,
  userApis,
  projectApis,
  hasUserSettings,
  configWarning,
  settings,
  settingsWarning,
  workflowCatalog,
  workspaces,
  workspaceScope,
  workspaceLabel,
  workspaceWarning,
  onIdleQuit,
}: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();

  // ── Top-level state ──────────────────────────────────────────────────
  const [phase, setPhase] = useState<Phase>("banner");
  const [doctor, setDoctor] = useState<DoctorResult[] | null>(null);
  const [mode, setMode] = useState<Mode>("workflow");
  const [runtimeWorkspaces, setRuntimeWorkspaces] = useState<WorkspaceConfig>(workspaces);
  const [runtimeCatalog, setRuntimeCatalog] = useState<LoadedWorkflowCatalog>(workflowCatalog);
  const [runtimeConfig, setRuntimeConfig] = useState<SteamtrainConfig>(config);
  const [agentLayers, setAgentLayers] = useState<{
    userAgents?: AgentInstanceConfig[];
    projectAgents?: AgentInstanceConfig[];
  }>({ userAgents, projectAgents });
  const [apiLayers, setApiLayers] = useState<{
    userApis?: ApiInstanceConfig[];
    projectApis?: ApiInstanceConfig[];
  }>({ userApis, projectApis });
  const [agentManagerOpen, setAgentManagerOpen] = useState(false);
  const [apiManagerOpen, setApiManagerOpen] = useState(false);
  const [stepEditorOpen, setStepEditorOpen] = useState(false);
  /** True while the /help overlay (keys + commands) is open. */
  const [helpOpen, setHelpOpen] = useState(false);
  /** Non-null while the mid-run (paused) step editor overlay is open. */
  const [runEditor, setRunEditor] = useState<RunStepEditorTarget | null>(null);
  /** Non-null while the human-input answer box is open (which request it answers). */
  const [answerTarget, setAnswerTarget] = useState<PendingHumanInput | null>(null);
  const [apiDoctor, setApiDoctor] = useState<ApiDoctorResult[] | null>(null);
  const [runtimeConfigSource, setRuntimeConfigSource] = useState(configSource);
  const [activeWorkspaceLabel, setActiveWorkspaceLabel] = useState(workspaceLabel);
  const [runtimeProject, setRuntimeProject] = useState(project);
  const [transcript, dispatch] = useReducer(transcriptReducer, initialTranscript);
  const [agentCatalogTick, setAgentCatalogTick] = useState(0);
  const mountedRef = useRef(true);
  const valueRef = useRef("");
  const [inputFormPending, setInputFormPending] = useState<InputFormPending | null>(null);
  const [planResult, setPlanResult] = useState<PlanResult | null>(null);
  // Guards the asynchronous history lookup so a late answer can never replace
  // a plan for a newer workflow or input.
  const planRequestRef = useRef(0);

  const enabledAgentIds = useMemo(
    () => new Set(resolveAgentInstances(runtimeConfig).map((agent) => agent.id)),
    [runtimeConfig],
  );
  const inputAgentSuggestions = useMemo(
    () => resolveAgentInstances(runtimeConfig).map((agent) => agent.id),
    [runtimeConfig],
  );
  const inputModelSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (value: string | undefined) => {
      if (!value || seen.has(value)) return;
      seen.add(value);
      out.push(value);
    };
    for (const family of listModelFamilyMeta()) {
      add(family.id);
      add(family.name);
      for (const alias of family.aliases.slice(0, 4)) add(alias);
      for (const offering of family.offerings) add(offering.modelId);
    }
    for (const agent of resolveAgentInstances(runtimeConfig)) {
      for (const model of modelsForAgent(agent.id, runtimeConfig)) {
        add(model.id);
      }
    }
    return out;
  }, [runtimeConfig, agentCatalogTick]);
  const visibleWorkspaces = useMemo<WorkspaceConfig>(
    () => ({
      workspaces: runtimeWorkspaces.workspaces.filter((entry) => enabledAgentIds.has(entry.agent)),
    }),
    [runtimeWorkspaces, enabledAgentIds],
  );
  const workspaceMap = useMemo(() => workspaceById(visibleWorkspaces), [visibleWorkspaces]);
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
    () =>
      new Orchestrator(runtimeConfig, visibleWorkspaces, doctor ?? EMPTY_DOCTOR, runtimeCatalog),
    [runtimeConfig, visibleWorkspaces, doctor, runtimeCatalog],
  );

  useEffect(() => {
    if (mode !== "workflow" && !workspaceMap.has(mode)) setMode("workflow");
  }, [mode, workspaceMap]);

  // Re-read the full config stack (defaults → global → project) after a save
  // so the merged view, raw per-scope agent layers, and the status-bar cfg
  // label stay consistent (a first save may create a previously absent file).
  // Always honor `cwd` (from `--project-dir`) so reloads never fall back to
  // the launch directory when the operator is working in another checkout.
  const reloadConfig = useCallback(() => {
    const loaded = loadConfig(
      configKind === "custom" && configPath ? { customPath: configPath, cwd } : { cwd },
    );
    setRuntimeConfig(loaded.config);
    setAgentLayers({ userAgents: loaded.userAgents, projectAgents: loaded.projectAgents });
    setApiLayers({ userApis: loaded.userApis, projectApis: loaded.projectApis });
    setRuntimeConfigSource(
      configDisplayLabel(loaded.scope, {
        hasUserSettings,
        hasUserConfig: loaded.user?.exists,
      }),
    );
    setRuntimeProject(
      resolveProjectIdentity(cwd, { home: homedir(), configName: loaded.config.name }),
    );
  }, [configKind, configPath, cwd, hasUserSettings]);

  const updateConfig = useCallback(
    (patch: Parameters<typeof saveProjectConfig>[0]) => {
      if (!configPath) {
        return { ok: false, error: "no project steamtrain.json path configured" };
      }
      const saved = saveProjectConfig(patch, configPath);
      if (saved.ok) reloadConfig();
      return { ok: saved.ok, error: saved.error };
    },
    [configPath, reloadConfig],
  );

  const updateUserConfig = useCallback(
    (patch: UserConfigPatch) => {
      const saved = saveUserConfig(patch);
      if (saved.ok) reloadConfig();
      return { ok: saved.ok, error: saved.error };
    },
    [reloadConfig],
  );
  // A custom --config file loads alone; there is no global layer to write.
  const canGlobalConfig = configKind !== "custom";

  const agentScopes = useMemo(() => {
    const scopes = new Map<string, AgentConfigScope>();
    for (const agent of agentLayers.userAgents ?? []) scopes.set(agent.id, "user");
    for (const agent of agentLayers.projectAgents ?? []) scopes.set(agent.id, "project");
    return scopes;
  }, [agentLayers]);

  const saveAgentsInScope = useCallback(
    (scope: AgentConfigScope, agents: AgentInstanceConfig[]) =>
      scope === "user" ? updateUserConfig({ agents }) : updateConfig({ agents }),
    [updateUserConfig, updateConfig],
  );

  const handleAgentToggle = useCallback(
    (id: string): AgentMutationResult => {
      const resolved = resolveAgentInstances(runtimeConfig, { includeDisabled: true }).find(
        (agent) => agent.id === id,
      );
      if (!resolved) return { ok: false, error: `unknown agent '${id}'` };
      const scope =
        agentConfigScope(id, agentLayers) ?? (canGlobalConfig ? "user" : ("project" as const));
      const rawList = scope === "user" ? agentLayers.userAgents : agentLayers.projectAgents;
      // Same fallback chain as /agent enable|disable: if the entry lives in
      // the other scope, copy it so its fields survive the scoped write.
      const raw =
        rawList?.find((agent) => agent.id === id) ??
        (scope === "user" ? agentLayers.projectAgents : agentLayers.userAgents)?.find(
          (agent) => agent.id === id,
        ) ??
        runtimeConfig.agents?.find((agent) => agent.id === id);
      const enabled = !resolved.enabled;
      const entry: AgentInstanceConfig = raw
        ? { ...raw, enabled }
        : { id, provider: resolved.provider, enabled };
      const saved = saveAgentsInScope(scope, upsertAgent(rawList, entry));
      if (!saved.ok) return saved;
      return {
        ok: true,
        text: `${id} ${enabled ? "enabled" : "disabled"} (${agentScopeLabel(scope)})`,
      };
    },
    [runtimeConfig, agentLayers, canGlobalConfig, saveAgentsInScope],
  );

  const handleAgentAdd = useCallback(
    (request: AgentAddRequest): AgentMutationResult => {
      const scope = canGlobalConfig ? request.scope : "project";
      const rawList = scope === "user" ? agentLayers.userAgents : agentLayers.projectAgents;
      if (request.binary && !resolveBinarySync(request.binary)) {
        return {
          ok: false,
          error: `binary '${request.binary}' not found or not executable (absolute path or name on PATH)`,
        };
      }
      const entry: AgentInstanceConfig = {
        id: request.id,
        provider: request.provider,
        enabled: true,
        ...(request.binary ? { binary: request.binary } : {}),
      };
      const saved = saveAgentsInScope(scope, upsertAgent(rawList, entry));
      if (!saved.ok) return saved;
      return { ok: true, text: `${request.id} added (${agentScopeLabel(scope)})` };
    },
    [agentLayers, canGlobalConfig, saveAgentsInScope],
  );

  const handleAgentDelete = useCallback(
    (id: string): AgentMutationResult => {
      // If an id is configured in both scopes, this deletes the shadowing
      // project entry first; a second delete then removes the global one.
      const scope = agentConfigScope(id, agentLayers);
      if (!scope) return { ok: false, error: `'${id}' is not configured` };
      const rawList = scope === "user" ? agentLayers.userAgents : agentLayers.projectAgents;
      const saved = saveAgentsInScope(scope, removeAgent(rawList, id));
      if (!saved.ok) return saved;
      return { ok: true, text: `${id} removed (${agentScopeLabel(scope)})` };
    },
    [agentLayers, saveAgentsInScope],
  );

  const openAgentManager = useCallback(() => {
    setAgentManagerOpen(true);
    return { handled: true as const, clearInput: true };
  }, []);

  const openHelp = useCallback(() => {
    setHelpOpen(true);
    return { handled: true as const, clearInput: true };
  }, []);

  // ── API instances (direct-inference llm steps) ───────────────────────
  // Mirrors the agent manager wiring above: same scope model, same fallback
  // chain, writing `apis` entries instead of `agents`.
  const apiScopes = useMemo(() => {
    const scopes = new Map<string, ApiConfigScope>();
    for (const api of apiLayers.userApis ?? []) scopes.set(api.id, "user");
    for (const api of apiLayers.projectApis ?? []) scopes.set(api.id, "project");
    return scopes;
  }, [apiLayers]);

  const saveApisInScope = useCallback(
    (scope: ApiConfigScope, apis: ApiInstanceConfig[]) =>
      scope === "user" ? updateUserConfig({ apis }) : updateConfig({ apis }),
    [updateUserConfig, updateConfig],
  );

  const handleApiToggle = useCallback(
    (id: string): ApiMutationResult => {
      const resolved = resolveApiInstances(runtimeConfig, { includeDisabled: true }).find(
        (api) => api.id === id,
      );
      if (!resolved) return { ok: false, error: `unknown api '${id}'` };
      const scope =
        apiConfigScope(id, apiLayers) ?? (canGlobalConfig ? "user" : ("project" as const));
      const rawList = scope === "user" ? apiLayers.userApis : apiLayers.projectApis;
      // Same fallback chain as the agent toggle: if the entry lives in the
      // other scope, copy it so its fields survive the scoped write.
      const raw =
        rawList?.find((api) => api.id === id) ??
        (scope === "user" ? apiLayers.projectApis : apiLayers.userApis)?.find(
          (api) => api.id === id,
        ) ??
        runtimeConfig.apis?.find((api) => api.id === id);
      const enabled = !resolved.enabled;
      const entry: ApiInstanceConfig = raw
        ? { ...raw, enabled }
        : { id, provider: resolved.provider, enabled };
      const saved = saveApisInScope(scope, upsertApi(rawList, entry));
      if (!saved.ok) return saved;
      return {
        ok: true,
        text: `${id} ${enabled ? "enabled" : "disabled"} (${apiScopeLabel(scope)})`,
      };
    },
    [runtimeConfig, apiLayers, canGlobalConfig, saveApisInScope],
  );

  const handleApiAdd = useCallback(
    (request: ApiAddRequest): ApiMutationResult => {
      const scope = canGlobalConfig ? request.scope : "project";
      const rawList = scope === "user" ? apiLayers.userApis : apiLayers.projectApis;
      if (request.baseUrl && !isAllowedApiBaseUrl(request.baseUrl)) {
        return {
          ok: false,
          error: `baseUrl must be an http or https URL (got '${request.baseUrl}')`,
        };
      }
      if (request.apiKeyEnv && !isValidApiKeyEnvName(request.apiKeyEnv)) {
        return {
          ok: false,
          error: "apiKeyEnv must be an uppercase env var name (e.g. ANTHROPIC_API_KEY)",
        };
      }
      const entry: ApiInstanceConfig = {
        id: request.id,
        provider: request.provider,
        enabled: true,
        ...(request.baseUrl ? { baseUrl: request.baseUrl } : {}),
        ...(request.apiKeyEnv ? { apiKeyEnv: request.apiKeyEnv } : {}),
        ...(request.defaultModel ? { defaultModel: request.defaultModel } : {}),
      };
      const saved = saveApisInScope(scope, upsertApi(rawList, entry));
      if (!saved.ok) return saved;
      return { ok: true, text: `${request.id} added (${apiScopeLabel(scope)})` };
    },
    [apiLayers, canGlobalConfig, saveApisInScope],
  );

  const handleApiDelete = useCallback(
    (id: string): ApiMutationResult => {
      // If an id is configured in both scopes, this deletes the shadowing
      // project entry first; a second delete then removes the global one.
      const scope = apiConfigScope(id, apiLayers);
      if (!scope) return { ok: false, error: `'${id}' is not configured` };
      const rawList = scope === "user" ? apiLayers.userApis : apiLayers.projectApis;
      const saved = saveApisInScope(scope, removeApi(rawList, id));
      if (!saved.ok) return saved;
      return { ok: true, text: `${id} removed (${apiScopeLabel(scope)})` };
    },
    [apiLayers, saveApisInScope],
  );

  const openApiManager = useCallback(() => {
    setApiManagerOpen(true);
    return { handled: true as const, clearInput: true };
  }, []);

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
        config: runtimeConfig,
        home: homedir(),
        cwd,
        projectConfigPath: configPath,
        projectWorkflows: runtimeConfig.workflows,
      }),
    [authoringHost, runtimeConfig, configPath, cwd],
  );

  const [wfStepOverrides, setWfStepOverrides] = useState<Record<string, WorkflowStepOverrides>>({});

  const resolveWorkflowSpec = useCallback(
    (name: string) => author.previewWithOverrides(name, wfStepOverrides[name]),
    [author, wfStepOverrides],
  );

  // Base (catalog) resolver — no session overrides applied. Sub-workflow
  // cascades (`/set-all`, `--all`) resolve children through this and layer the
  // parent call step's own `overrides` themselves, so applying session
  // overrides here would double-count.
  const baseResolveWorkflow = useCallback(
    (name: string) => orchestrator.listWorkflows()[name],
    [orchestrator],
  );

  // ── Workflow Runner hook ─────────────────────────────────────────────
  const runner = useWorkflowRunner({
    orchestrator,
    resolveWorkflowSpec,
    mountedRef,
    cwd,
    // A detached background runner resolves config from `--project-dir` (same
    // user + project layers); only pass an explicit config file when the TUI
    // was launched with a custom one, so the child matches it exactly.
    detachConfigPath: configKind === "custom" ? configPath : undefined,
  });

  // Live cost/token ticker for the status bar, summed from the running tree.
  const { runCostUsd, runTokens } = useMemo(() => {
    let cost = 0;
    const tokens = emptyTokens();
    for (const phase of runner.wf.phases) {
      for (const step of phase.steps) {
        if (step.result?.costUsd) cost += step.result.costUsd;
        addTokensInto(tokens, step.result?.tokens);
      }
    }
    return { runCostUsd: cost, runTokens: totalTokens(tokens) };
  }, [runner.wf]);

  // Station landing must feed pinTourFirst into the picker nav so render and
  // selection share one row order (tour pinned inside bundled).
  const [stationLanding, setStationLanding] = useState(false);

  const picker = useWorkflowPicker({
    mode,
    doctor,
    runtimeCatalog,
    orchestrator,
    author,
    running: runner.running,
    mountedRef,
    dispatch,
    wfStepOverrides,
    setWfStepOverrides,
    resolveWorkflowSpec,
    pinTourFirst: stationLanding,
  });

  // Station landing: on a true first open (no run history), land on the tour
  // and open its preview so the primary CTA is one keystroke away.
  const stationBootstrapped = useRef(false);
  useEffect(() => {
    if (stationBootstrapped.current) return;
    if (picker.workflowEntries.length === 0) return;
    stationBootstrapped.current = true;
    let cancelled = false;
    void (async () => {
      const history = await runner.historyStoreRef.current.list(1).catch(() => []);
      if (cancelled) return;
      if (!shouldOfferStationLanding({ hasRunHistory: history.length > 0 })) return;
      if (!picker.workflowEntries.some((entry) => entry.name === TOUR_WORKFLOW_NAME)) return;
      // Queue the tour by name, then flip Station on so pinTourFirst rebuilds
      // the nav and the pending-select effect lands on the pinned row.
      picker.pendingSelectRef.current = TOUR_WORKFLOW_NAME;
      setStationLanding(true);
      picker.setWfPreview({ name: TOUR_WORKFLOW_NAME, input: "all aboard" });
      runner.setStepIndex(0);
    })();
    return () => {
      cancelled = true;
    };
  }, [picker.workflowEntries]);

  // Drop Station chrome once the user leaves the tour preview / picker.
  useEffect(() => {
    if (!stationLanding) return;
    const onTour =
      picker.wfPreview?.name === TOUR_WORKFLOW_NAME ||
      (!picker.wfPreview && picker.selectedWorkflowName === TOUR_WORKFLOW_NAME);
    if (!onTour || runner.wf.started) setStationLanding(false);
  }, [stationLanding, picker.wfPreview, picker.selectedWorkflowName, runner.wf.started]);

  const previewSelectedStep =
    picker.preview.flatSteps.length > 0
      ? picker.preview.flatSteps[Math.min(runner.stepIndex, picker.preview.flatSteps.length - 1)]
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
      modelClass: step.modelClass,
      prompt: step.prompt,
      effort: step.effort,
      cwd: step.cwd,
      env: step.env,
      extraArgs: step.extraArgs,
      stepTimeoutSec: step.stepTimeoutSec,
    };
  }, [picker.wfPreview, previewSelectedStep]);

  // The step currently editable in place (Ctrl+E). Agent-backed steps expose
  // agent/model/effort/prompt; llm steps expose the prompt. Undefined when the
  // selected step (or block kind) has nothing editable.
  const editorTarget = useMemo<StepEditorTarget | undefined>(() => {
    if (!picker.wfPreview || !previewSelectedStep) return undefined;
    return stepEditorTarget(picker.wfPreview.name, previewSelectedStep.step);
  }, [picker.wfPreview, previewSelectedStep]);

  const openStepEditor = useCallback(() => {
    if (runner.running || mode !== "workflow") return;
    if (!editorTarget) {
      runner.setWfNotice("select an agent-backed or llm step to edit (↑/↓), then Ctrl+E");
      return;
    }
    setStepEditorOpen(true);
  }, [runner.running, runner.setWfNotice, mode, editorTarget]);

  const applyStepEdit = useCallback(
    (patch: Parameters<typeof picker.patchWorkflowStep>[1]) => {
      if (editorTarget) picker.patchWorkflowStep(editorTarget.stepId, patch);
    },
    [editorTarget, picker.patchWorkflowStep],
  );

  const applyStepEditAll = useCallback(
    (patches: Record<string, Parameters<typeof picker.patchWorkflowStep>[1]>, summary: string) => {
      picker.patchWorkflowSteps(patches);
      runner.setWfNotice(`✎ ${summary} · /save-workflows to persist`);
    },
    [picker.patchWorkflowSteps, runner.setWfNotice],
  );

  const editorSiblings = useMemo(() => {
    if (!picker.preview.spec) return [];
    return listRetargetableSteps(picker.preview.spec);
  }, [picker.preview.spec]);

  // Close the editor whenever its target disappears (left preview, switched
  // workflow, or a running launch tore the preview down).
  useEffect(() => {
    if (stepEditorOpen && !editorTarget) setStepEditorOpen(false);
  }, [stepEditorOpen, editorTarget]);

  // ── Mid-run (pause → edit → resume) step editor ──────────────────────
  // `e` on a pending step while the run is paused opens a buffered editor;
  // Enter stages ONE recorded edit through the run's steering control.
  const openRunStepEditor = useCallback(() => {
    if (mode !== "workflow" || !runner.running || !runner.wf.paused) return;
    const selected = runner.liveSelectedStep;
    if (!selected || selected.step.status !== "pending" || selected.step.parentStepId) {
      runner.setWfNotice("select a pending step (↑/↓) to edit while paused");
      return;
    }
    const workflowName = runner.activeWorkflowRef.current;
    const spec = workflowName ? resolveWorkflowSpec(workflowName) : undefined;
    const specStep = spec?.phases
      .flatMap((phase) => phase.steps)
      .find((step) => step.id === selected.step.stepId);
    if (!specStep) {
      runner.setWfNotice(`cannot edit '${selected.step.stepId}': workflow spec not found`);
      return;
    }
    const kind = workflowStepKind(specStep);
    const promptEditable =
      kind === "worker" ||
      kind === "processor" ||
      kind === "llm" ||
      kind === "consolidator" ||
      kind === "approval" ||
      (kind === "distributor" && isAgentBackedStep(specStep));
    const field: "prompt" | "cmd" | undefined =
      kind === "command" ? "cmd" : promptEditable ? "prompt" : undefined;
    if (!field) {
      runner.setWfNotice(`step '${selected.step.stepId}' (${kind}) has no editable prompt/command`);
      return;
    }
    const priorEdit = runner.wf.editedSteps?.[selected.step.stepId];
    const specValue =
      field === "cmd"
        ? ((specStep as { cmd?: string }).cmd ?? "")
        : "prompt" in specStep
          ? (specStep.prompt ?? "")
          : "";
    // Model/effort cycling needs an agent catalog — only agent-backed steps.
    // llm model mid-run remains available via CLI/API.
    if (isAgentBackedStep(specStep)) {
      setRunEditor({
        stepId: selected.step.stepId,
        kindLabel: kind,
        field,
        initial: (field === "cmd" ? priorEdit?.cmd : priorEdit?.prompt) ?? specValue,
        modelEditable: true,
        agent: specStep.agent,
        model: priorEdit?.model ?? specStep.model,
        effort: priorEdit?.effort ?? specStep.effort,
      });
    } else {
      setRunEditor({
        stepId: selected.step.stepId,
        kindLabel: kind,
        field,
        initial: (field === "cmd" ? priorEdit?.cmd : priorEdit?.prompt) ?? specValue,
        modelEditable: false,
      });
    }
  }, [
    mode,
    runner.running,
    runner.wf.paused,
    runner.wf.editedSteps,
    runner.liveSelectedStep,
    runner.activeWorkflowRef,
    runner.setWfNotice,
    resolveWorkflowSpec,
  ]);

  const applyRunStepEdit = useCallback(
    (patch: StepEditPatch) => {
      if (!runEditor) return;
      void runner
        .editRunStep(runEditor.stepId, patch)
        .then((notice) => runner.setWfNotice(notice))
        .catch((err) => runner.setWfNotice(`edit failed: ${message(err)}`));
    },
    [runEditor, runner.editRunStep, runner.setWfNotice],
  );

  // The mid-run editor only makes sense while its run is alive and paused.
  useEffect(() => {
    if (runEditor && (!runner.running || !runner.wf.paused)) setRunEditor(null);
  }, [runEditor, runner.running, runner.wf.paused]);

  // ── Human-input answer box (`a` while a run is waiting on an answer) ──
  const openAnswerInput = useCallback(() => {
    if (mode !== "workflow" || !runner.running) return;
    const pending = runner.wf.pendingInputs?.[0];
    if (!pending) return;
    setAnswerTarget(pending);
  }, [mode, runner.running, runner.wf.pendingInputs]);

  const submitAnswer = useCallback(
    (value: string) => {
      if (!answerTarget) return;
      runner.answerHumanInput(answerTarget.stepId, value, answerTarget.iteration);
    },
    [answerTarget, runner.answerHumanInput],
  );

  // Track the live pending list: when the request resolves (or is superseded
  // by a re-ask with a validation error), refresh or close the box so it never
  // shows a stale ask.
  useEffect(() => {
    if (!answerTarget) return;
    if (!runner.running) {
      setAnswerTarget(null);
      return;
    }
    const current = runner.wf.pendingInputs?.find(
      (p) => p.stepId === answerTarget.stepId && p.iteration === answerTarget.iteration,
    );
    if (!current) setAnswerTarget(null);
    else if (current !== answerTarget) setAnswerTarget(current);
  }, [answerTarget, runner.running, runner.wf.pendingInputs]);

  // ── History hook ─────────────────────────────────────────────────────
  const historyHook = useHistory({
    historyStoreRef: runner.historyStoreRef,
    liveRunStoreRef: runner.liveRunStoreRef,
    mountedRef,
    resolveWorkflowSpec,
    runWorkflow: runner.runWorkflow,
    setWfNotice: runner.setWfNotice,
    cwd,
  });

  // ── Live-run slash-command bridges (/attach, /cancel-run) ────────────
  // Feedback goes through the workflow notice line: transcript notices only
  // render in workspace mode, and these commands live in workflow mode.
  const attachRunCommand = useCallback(
    async (runId?: string): Promise<SlashCommandResult> => {
      const store = runner.liveRunStoreRef.current;
      const active = (await store.list().catch(() => [])).filter(
        (run) => !isTerminalLiveRunStatus(run.status),
      );
      let id = runId;
      if (!id) {
        if (active.length === 0) {
          runner.setWfNotice("no active runs to attach to (see /runs)");
          return { handled: true, clearInput: true };
        }
        if (active.length > 1) {
          runner.setWfNotice(
            `multiple active runs — /attach <runId>: ${active
              .map((run) => `${run.id.slice(0, 8)}… (${run.workflow})`)
              .join(", ")}`,
          );
          return { handled: true, clearInput: true };
        }
        id = active[0]!.id;
      } else {
        // Allow unambiguous id prefixes (run ids are long UUIDs).
        const matches = active.filter((run) => run.id === id || run.id.startsWith(id!));
        if (matches.length === 1) id = matches[0]!.id;
        else if (matches.length > 1) {
          runner.setWfNotice(`'${id}' matches ${matches.length} runs — be more specific`);
          return { handled: true, clearInput: true };
        }
      }
      if (mode !== "workflow") switchMode("workflow");
      picker.setWfPreview(null);
      runner.attachRun(id);
      return { handled: true, clearInput: true };
    },
    [
      runner.liveRunStoreRef,
      runner.attachRun,
      runner.setWfNotice,
      mode,
      switchMode,
      picker.setWfPreview,
    ],
  );

  const cancelLiveRunCommand = useCallback(
    async (runId?: string): Promise<SlashCommandResult> => {
      runner.setWfNotice(await runner.cancelLiveRun(runId));
      return { handled: true, clearInput: true };
    },
    [runner.cancelLiveRun, runner.setWfNotice],
  );

  // ── Slash Context hook ───────────────────────────────────────────────
  // Recompute workflowPickerActive with actual history state.
  const workflowPickerActive = useMemo(
    () =>
      isWorkflowPickerActive({
        mode,
        history: Boolean(historyHook.history),
        wfCreate: Boolean(picker.wfCreate),
        previewing: Boolean(
          picker.wfPreview && picker.preview.spec && picker.preview.dispatchCheck,
        ),
        showWorkflowView: runner.showWorkflowView,
      }),
    [
      mode,
      historyHook.history,
      picker.wfCreate,
      picker.wfPreview,
      picker.preview.spec,
      picker.preview.dispatchCheck,
      runner.showWorkflowView,
    ],
  );

  const slashHook = useSlashContext({
    mode,
    runtimeWorkspaces: visibleWorkspaces,
    workspaceMap,
    updateWorkspace,
    switchMode,
    wfPreview: picker.wfPreview,
    patchWorkflowStep: picker.patchWorkflowStep,
    previewStepSelection,
    workflowSpec: picker.preview.spec,
    resolveWorkflow: baseResolveWorkflow,
    config: runtimeConfig,
    configPath,
    updateConfig,
    userConfigPath: canGlobalConfig ? userConfigPath() : undefined,
    updateUserConfig: canGlobalConfig ? updateUserConfig : undefined,
    userAgents: agentLayers.userAgents,
    projectAgents: agentLayers.projectAgents,
    userApis: apiLayers.userApis,
    projectApis: apiLayers.projectApis,
    openAgentManager,
    openApiManager,
    workflowPickerActive,
    saveWorkflows: picker.saveWorkflows,
    rerouteWorkflow: picker.rerouteWorkflow,
    createWorkflow: picker.createWorkflow,
    cloneWorkflow: picker.cloneWorkflow,
    deleteWorkflow: picker.deleteWorkflow,
    renameWorkflow: picker.renameWorkflow,
    updateWorkflowDescription: picker.updateWorkflowDescription,
    userWorkflowNames: picker.userWorkflowNames,
    openHistory: historyHook.openHistory,
    openHelp,
    attachRun: attachRunCommand,
    cancelLiveRun: cancelLiveRunCommand,
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

    const key = workflowCacheKey(picker.wfPreview.name, trimmed, cwd, spec);
    let active = true;
    void runner.cacheStoreRef.current
      .load(key)
      .then((cache) => {
        if (active) runner.setWfCanResume(cache.size > 0);
      })
      .catch(() => {
        if (active) runner.setWfCanResume(false);
      });
    return () => {
      active = false;
    };
  }, [
    mode,
    runner.running,
    runner.wf.started,
    runner.wfLaunching,
    picker.wfPreview,
    prompt.value,
    resolveWorkflowSpec,
    cwd,
  ]);

  // ── Step index reset effect ──────────────────────────────────────────
  useEffect(() => {
    if (mode === "workflow" && !picker.wfPreview && !runner.showWorkflowView) {
      runner.setStepIndex(0);
      runner.setWfStepDetails(null);
    }
  }, [mode, picker.wfPreview, runner.showWorkflowView]);

  // ── History drill-in scroll reset ────────────────────────────────────
  // The history drill-in shares the live pane's output scroll state; a
  // recorded step starts at the top (nothing is streaming to follow).
  const historyDetailOpen = historyHook.history?.detail ?? false;
  const historyStepIndex = historyHook.history?.stepIndex ?? 0;
  useEffect(() => {
    if (historyDetailOpen) runner.setWfOutputScroll(staticOutputScroll);
  }, [historyDetailOpen, historyStepIndex]);

  // ── Startup effects ──────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      runner.abortRef.current?.abort();
      runner.attachAbortRef.current?.abort();
      picker.createAbortRef.current?.abort();
    };
  }, []);

  const lastConfigWarningRef = useRef(configWarning);
  const lastWorkspaceWarningRef = useRef(workspaceWarning);
  const lastSettingsWarningRef = useRef(settingsWarning);

  useEffect(() => {
    if (configWarning && configWarning !== lastConfigWarningRef.current) {
      dispatch({ type: "notice", level: "warn", text: configWarning });
      lastConfigWarningRef.current = configWarning;
    }
  }, [configWarning]);
  useEffect(() => {
    if (workspaceWarning && workspaceWarning !== lastWorkspaceWarningRef.current) {
      dispatch({ type: "notice", level: "warn", text: workspaceWarning });
      lastWorkspaceWarningRef.current = workspaceWarning;
    }
  }, [workspaceWarning]);
  useEffect(() => {
    if (settingsWarning && settingsWarning !== lastSettingsWarningRef.current) {
      dispatch({ type: "notice", level: "warn", text: settingsWarning });
      lastSettingsWarningRef.current = settingsWarning;
    }
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
    runDoctor(runtimeConfig)
      .then((results) => {
        if (!active) return;
        setDoctor(results);
        void refreshAgentCatalogCaches(runtimeConfig, results).then((ok) => {
          if (ok && active) setAgentCatalogTick((n) => n + 1);
        });
      })
      .catch((err) => {
        if (!active) return;
        dispatch({ type: "notice", level: "error", text: `preflight failed: ${message(err)}` });
      });
    // API readiness probes run independently of the agent doctor so a slow
    // agent binary never delays the API chips (and vice versa).
    runApiDoctor(runtimeConfig)
      .then((results) => {
        if (active) setApiDoctor(results);
      })
      .catch((err) => {
        if (!active) return;
        dispatch({ type: "notice", level: "error", text: `api preflight failed: ${message(err)}` });
      });
    return () => {
      active = false;
    };
  }, [runtimeConfig]);

  // On-demand preflight re-run (the agent/API managers' `r` key): re-resolve
  // every agent binary and re-probe every API so the setup surface reflects a
  // just-installed CLI or a fresh login without restarting steamtrain.
  const recheckDoctor = useCallback(() => {
    runDoctor(runtimeConfig)
      .then((results) => {
        setDoctor(results);
        void refreshAgentCatalogCaches(runtimeConfig, results).then((ok) => {
          if (ok) setAgentCatalogTick((n) => n + 1);
        });
      })
      .catch((err) => {
        dispatch({ type: "notice", level: "error", text: `preflight failed: ${message(err)}` });
      });
    runApiDoctor(runtimeConfig)
      .then(setApiDoctor)
      .catch((err) => {
        dispatch({ type: "notice", level: "error", text: `api preflight failed: ${message(err)}` });
      });
  }, [runtimeConfig]);

  // ── Cross-cutting callbacks ──────────────────────────────────────────
  const focusCreateWorkflowPrompt = useCallback(
    (seed = "") => {
      if (runner.running) return;
      const nextValue = createWorkflowPromptValue(seed);
      prompt.updatePromptDraft({
        value: nextValue,
        promptEditing: true,
        historyBrowse: initialPromptHistoryBrowse,
      });
      prompt.setCommandSuggestions([]);
      prompt.setSuggestionIndex(0);
      prompt.bumpCursorToEnd();
    },
    [
      runner.running,
      prompt.updatePromptDraft,
      prompt.bumpCursorToEnd,
      prompt.setCommandSuggestions,
      prompt.setSuggestionIndex,
    ],
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
        // For fresh re-runs on workflows with inputs, show the input form first.
        {
          const spec = resolveWorkflowSpec(runner.activeWorkflowRef.current);
          if (spec && workflowHasDeclaredInputs(spec)) {
            setInputFormPending({
              name: runner.activeWorkflowRef.current,
              prompt: promptText,
              fresh: true,
              action: "run",
            });
            return true;
          }
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
        // For fresh runs on workflows with inputs, show the input form first.
        if (fresh) {
          const spec = resolveWorkflowSpec(picker.wfPreview.name);
          if (spec && workflowHasDeclaredInputs(spec)) {
            setInputFormPending({
              name: picker.wfPreview.name,
              prompt: promptText,
              fresh: true,
              action: "run",
            });
            return true;
          }
        }
        runner.launchWorkflow(
          picker.wfPreview.name,
          promptText,
          picker.setWfPreview,
          fresh ? { fresh: true } : undefined,
        );
        return true;
      }

      const entry = picker.selectedWorkflowEntry;
      if (!entry) return false;
      if (promptText.length === 0) {
        runner.setWfNotice("type input in the prompt before running");
        return false;
      }
      // For fresh runs on workflows with inputs, show the input form first.
      {
        const spec = resolveWorkflowSpec(entry.name);
        if (spec && workflowHasDeclaredInputs(spec)) {
          setInputFormPending({
            name: entry.name,
            prompt: promptText,
            fresh: true,
            action: "run",
          });
          return true;
        }
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
      picker.selectedWorkflowEntry,
      runner.launchWorkflow,
      picker.wfCreate,
      picker.setWfPreview,
      resolveWorkflowSpec,
    ],
  );

  const handleSubmit = useCallback(
    (raw: string) => {
      prompt.setCommandSuggestions([]);
      prompt.setSuggestionIndex(0);

      const promptText = raw.trim();

      if (isRegisteredSlashCommand(promptText)) {
        let resultOrPromise: SlashCommandResult | Promise<SlashCommandResult>;
        try {
          resultOrPromise = executeSlashCommand(promptText, slashHook.slashCtx);
        } catch (err) {
          dispatch({
            type: "notice",
            level: "error",
            text: err instanceof Error ? err.message : String(err),
          });
          return;
        }

        const handleResult = (result: SlashCommandResult) => {
          if (result.handled) {
            prompt.updatePromptDraft(
              result.clearInput ? { value: "", promptEditing: false } : { promptEditing: false },
            );
            prompt.setCommandSuggestions([]);
            for (const notice of result.notices ?? []) {
              dispatch({ type: "notice", level: notice.level, text: notice.text });
            }
            if (result.exit) {
              // Same confirm gate as Ctrl+C: an owned run must be confirmed twice.
              if (!runner.requestQuit()) return;
              if (
                !runner.abortRef.current &&
                !runner.attachAbortRef.current &&
                !picker.createAbortRef.current
              ) {
                onIdleQuit?.();
              }
              runner.abortRef.current?.abort();
              runner.attachAbortRef.current?.abort();
              picker.createAbortRef.current?.abort();
              exit();
            }
          }
        };

        if (resultOrPromise instanceof Promise) {
          void resultOrPromise.then(handleResult).catch((err) => {
            dispatch({ type: "notice", level: "error", text: message(err) });
          });
        } else {
          handleResult(resultOrPromise);
        }
        return;
      }

      // A typo'd /command must never fall through and dispatch as a prompt —
      // that would silently launch a run. Surface it on the visible notice
      // line (workflow mode) or the stream (workspace modes) instead. The
      // input clears like any handled command (↑ recalls it for correction).
      const unknown = unknownSlashCommand(promptText);
      if (unknown) {
        const text = `unknown command /${unknown.name}${
          unknown.suggestion ? ` — did you mean /${unknown.suggestion}?` : ""
        } · /help lists commands`;
        if (mode === "workflow") runner.setWfNotice(text);
        else dispatch({ type: "notice", level: "error", text });
        prompt.updatePromptDraft({ value: "", promptEditing: false });
        prompt.setCommandSuggestions([]);
        return;
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
          // Enter on a running/completed workflow step opens the step details
          if (!runner.wfStepDetails) {
            runner.setWfStepDetails("live");
            prompt.updatePromptDraft({ promptEditing: false });
            return;
          }
          const ran = handleWorkflowRun(promptText, false);
          if (ran) prompt.updatePromptDraft({ promptEditing: false });
          return;
        }
        if (picker.wfPreview) {
          // Enter on a preview workflow step opens the step details
          if (!runner.wfStepDetails) {
            runner.setWfStepDetails("preview");
            prompt.updatePromptDraft({ promptEditing: false });
            return;
          }
          const ran = handleWorkflowRun(promptText, false);
          if (ran) prompt.updatePromptDraft({ promptEditing: false });
          return;
        }
        if (picker.onCreateRow) {
          focusCreateWorkflowPrompt(promptText);
          return;
        }
        if (picker.onHeaderRow) {
          picker.toggleSelectedFolder();
          return;
        }
        const entry = picker.selectedWorkflowEntry;
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
      // Workspace agent sessions stream into the transcript only — they do not
      // write RunRecord history (that model is workflow-shaped: phases, harvest,
      // interventions). Persistence here would need a separate session log.
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
      picker.selectedWorkflowEntry,
      picker.onCreateRow,
      picker.onHeaderRow,
      picker.toggleSelectedFolder,
      handleWorkflowRun,
      prompt.updatePromptDraft,
      focusCreateWorkflowPrompt,
      picker.wfPreview,
      picker.wfCreate,
      workspaceMap,
      slashHook.slashCtx,
      exit,
      onIdleQuit,
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

  // A plan is useful immediately, so render static topology synchronously and
  // enrich it with locally observed history when that lightweight read settles.
  // The request id prevents an old lookup from replacing a newer preview.
  const showPlan = useCallback(
    (name: string, plan: PlanResult) => {
      const requestId = ++planRequestRef.current;
      setPlanResult(plan);
      runner.setWfShowPlanResult(true);
      void runner.historyStoreRef.current
        .list()
        .then((summaries) => {
          if (!mountedRef.current || requestId !== planRequestRef.current) return;
          const history = planHistoryContext(summaries, name);
          if (history) setPlanResult({ ...plan, history });
        })
        .catch(() => {
          // The static plan remains trustworthy if history is unavailable.
        });
    },
    [runner.historyStoreRef, runner.setWfShowPlanResult],
  );

  const handlePlan = useCallback(() => {
    if (runner.running || mode !== "workflow") return;
    const promptText = valueRef.current.trim();
    if (!promptText) {
      runner.setWfNotice("type input in the prompt before planning");
      return;
    }
    // If plan result is already visible, toggle it off
    if (planResult && runner.wfShowPlanResult) {
      runner.setWfShowPlanResult(false);
      return;
    }
    // Determine which workflow to plan.
    let name: string | undefined;
    if (picker.wfPreview) {
      name = picker.wfPreview.name;
    } else {
      name = picker.selectedWorkflowName;
    }
    if (!name) return;
    const spec = resolveWorkflowSpec(name);
    if (!spec) return;
    // For workflows with inputs, show the input form first (mirrors fresh runs).
    if (workflowHasDeclaredInputs(spec)) {
      setInputFormPending({ name, prompt: promptText, action: "plan" });
      return;
    }
    const plan = planWorkflow(spec, promptText);
    showPlan(name, plan);
  }, [
    runner.running,
    mode,
    picker.wfPreview,
    picker.selectedWorkflowName,
    resolveWorkflowSpec,
    planResult,
    runner.wfShowPlanResult,
    runner.setWfShowPlanResult,
    showPlan,
  ]);

  // Clear plan result when workflow selection changes.
  // wfShowPlanResult in the runner hook is intentionally NOT reset here:
  // the toggle guard checks `planResult && runner.wfShowPlanResult`, so a
  // null planResult prevents the toggle from firing regardless.
  useEffect(() => {
    planRequestRef.current += 1;
    setPlanResult(null);
  }, [picker.wfPreview?.name, picker.workflowIndex]);

  const handleInputFormSubmit = useCallback(
    (params: Record<string, string | number | boolean>) => {
      const pending = inputFormPending;
      if (!pending) return;
      setInputFormPending(null);
      const outcome = resolveInputFormSubmit(pending, resolveWorkflowSpec(pending.name), params);
      if (outcome.action === "missing-spec") return;
      if (outcome.action === "plan") {
        showPlan(pending.name, outcome.plan);
        return;
      }
      prompt.updatePromptDraft({ value: "", promptEditing: false });
      runner.launchWorkflow(outcome.name, outcome.prompt, picker.setWfPreview, {
        fresh: outcome.fresh,
        params: outcome.params,
      });
    },
    [
      inputFormPending,
      resolveWorkflowSpec,
      runner.launchWorkflow,
      picker.setWfPreview,
      prompt.updatePromptDraft,
      showPlan,
    ],
  );

  const handleInputFormCancel = useCallback(() => {
    if (inputFormPending) {
      prompt.updatePromptDraft({ value: inputFormPending.prompt, promptEditing: false });
    }
    setInputFormPending(null);
  }, [inputFormPending, prompt.updatePromptDraft]);

  // ── Keyboard input hook ──────────────────────────────────────────────
  useKeyboardInput({
    mode,
    modes: slashHook.modes,
    prompt,
    picker,
    runner,
    historyHook,
    workflowPickerActive,
    agentManagerOpen,
    apiManagerOpen,
    stepEditorOpen,
    runEditorOpen: runEditor !== null,
    answerInputOpen: answerTarget !== null,
    inputFormPending: inputFormPending !== null,
    helpOpen,
    closeHelp: () => setHelpOpen(false),
    openAgentManager: () => {
      openAgentManager();
    },
    openRunStepEditor,
    openAnswerInput,
    focusCreateWorkflowPrompt,
    switchMode: (next) => {
      setMode(next);
      prompt.setCommandSuggestions([]);
      prompt.setSuggestionIndex(0);
      prompt.bumpCursorToEnd();
    },
    clearStationLanding: () => setStationLanding(false),
    onIdleQuit,
  });

  // ── Render ───────────────────────────────────────────────────────────
  if (phase === "banner") {
    return (
      <Box flexDirection="column">
        <Banner project={runtimeProject} />
        <Text color="gray"> starting up — running preflight checks…</Text>
      </Box>
    );
  }

  const isWorkflow = mode === "workflow";
  const streamHeight = computeStreamHeight({
    rows,
    columns,
    promptValueLength: prompt.value.length,
    // The red notice line only renders in workflow mode; reserve its height so
    // the frame never overflows the terminal (which flickers on every keypress).
    notice: runner.wfNotice && isWorkflow ? runner.wfNotice : null,
    // The status bar gains a second line once any API instance is shown; that
    // extra row must be reserved too, or the frame overflows and flickers.
    statusApiLine: doctor !== null && (apiDoctor?.length ?? 0) > 0,
  });

  const menuOverlayRows = prompt.suggestionMenuOpen
    ? suggestionMenuHeight(prompt.commandSuggestions.length, prompt.suggestionIndex)
    : 0;
  const activeWorkflowName = isWorkflow
    ? (runner.activeWorkflowRef.current ?? picker.wfPreview?.name ?? picker.selectedWorkflowName)
    : undefined;
  const activeWorkflowSource: WorkflowSourceKind | undefined = activeWorkflowName
    ? (picker.workflowEntries.find((entry) => entry.name === activeWorkflowName)?.source ??
      orchestrator.workflowSource(activeWorkflowName))
    : undefined;
  const activeWorkflowSpec = activeWorkflowName
    ? resolveWorkflowSpec(activeWorkflowName)
    : undefined;
  const softHealth = Boolean(activeWorkflowSpec && isCredentialFreeWorkflow(activeWorkflowSpec));

  const attachedRun = runner.attachedRunIdRef.current !== null;

  return (
    <Box flexDirection="column" width={columns}>
      <StatusBar
        doctor={doctor}
        apiDoctor={apiDoctor}
        project={runtimeProject}
        configSource={runtimeConfigSource}
        workspaceLabel={activeWorkspaceLabel}
        running={runner.running}
        runCostUsd={runCostUsd}
        runTokens={runTokens}
        softHealth={softHealth}
      />
      {agentManagerOpen ? (
        <AgentManager
          agents={resolveAgentInstances(runtimeConfig, { includeDisabled: true })}
          scopes={agentScopes}
          canGlobal={canGlobalConfig}
          doctor={doctor}
          width={columns}
          height={streamHeight}
          onToggle={handleAgentToggle}
          onAdd={handleAgentAdd}
          onDelete={handleAgentDelete}
          onRecheck={recheckDoctor}
          onClose={() => setAgentManagerOpen(false)}
        />
      ) : apiManagerOpen ? (
        <ApiManager
          apis={resolveApiInstances(runtimeConfig, { includeDisabled: true })}
          scopes={apiScopes}
          canGlobal={canGlobalConfig}
          apiDoctor={apiDoctor}
          width={columns}
          height={streamHeight}
          onToggle={handleApiToggle}
          onAdd={handleApiAdd}
          onDelete={handleApiDelete}
          onRecheck={recheckDoctor}
          onClose={() => setApiManagerOpen(false)}
        />
      ) : stepEditorOpen && editorTarget ? (
        <WorkflowStepEditor
          target={editorTarget}
          config={runtimeConfig}
          width={columns}
          height={streamHeight}
          siblings={editorSiblings}
          onApply={applyStepEdit}
          onApplyAll={applyStepEditAll}
          onClose={() => setStepEditorOpen(false)}
        />
      ) : runEditor ? (
        <WorkflowRunStepEditor
          target={runEditor}
          config={runtimeConfig}
          width={columns}
          height={streamHeight}
          onApply={applyRunStepEdit}
          onClose={() => setRunEditor(null)}
        />
      ) : answerTarget ? (
        <WorkflowAnswerInput
          pending={answerTarget}
          width={columns}
          height={streamHeight}
          onAnswer={submitAnswer}
          onClose={() => setAnswerTarget(null)}
        />
      ) : helpOpen ? (
        <HelpPanel width={columns} height={streamHeight} />
      ) : inputFormPending ? (
        (() => {
          const inputSpec = resolveWorkflowSpec(inputFormPending.name);
          return inputSpec ? (
            <WorkflowInputForm
              spec={inputSpec}
              width={columns}
              height={streamHeight}
              modelSuggestions={inputModelSuggestions}
              agentSuggestions={inputAgentSuggestions}
              onSubmit={handleInputFormSubmit}
              onCancel={handleInputFormCancel}
            />
          ) : null;
        })()
      ) : historyHook.history?.diffView ? (
        <HistoryDiffPanel
          workflow={historyHook.history.diffView.workflow}
          recordId={historyHook.history.diffView.recordId}
          loading={historyHook.history.diffView.loading}
          steps={historyHook.history.diffView.steps}
          scroll={historyHook.history.diffView.scroll}
          width={columns}
          height={streamHeight}
          onMetrics={historyHook.reportDiffMetrics}
        />
      ) : historyHook.history ? (
        <HistoryPanel
          history={historyHook.history}
          width={columns}
          height={streamHeight}
          scroll={runner.wfOutputScroll}
          onOutputMetrics={runner.reportOutputMetrics}
        />
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
            now={runner.wfNow}
            scroll={runner.wfOutputScroll}
            onOutputMetrics={runner.reportOutputMetrics}
          />
        ) : runner.wfStepDetails === "preview" &&
          picker.wfPreview &&
          picker.preview.spec &&
          picker.preview.dispatchCheck ? (
          <WorkflowStepDetails
            kind="preview"
            spec={picker.preview.spec}
            source={activeWorkflowSource ?? "bundled"}
            input={prompt.value.trim() || picker.wfPreview.input}
            height={streamHeight}
            width={columns}
            entry={previewSelectedStep}
            selectedIndex={runner.stepIndex}
            totalSteps={picker.preview.stepCount}
            dispatchOk={picker.preview.dispatchCheck.ok}
            dispatchReason={
              picker.preview.dispatchCheck.ok ? undefined : picker.preview.dispatchCheck.reason
            }
            canResume={runner.wfCanResume}
          />
        ) : runner.showWorkflowView ? (
          <WorkflowView
            state={runner.wf}
            height={streamHeight}
            width={columns}
            selectedIndex={runner.stepIndex}
            elapsedMs={runner.wfElapsedMs}
            now={runner.wfNow}
            narration={runner.narration}
            showArrival={runner.showArrival}
            credentialFree={softHealth}
          />
        ) : picker.wfPreview && !picker.preview.spec ? (
          <Box justifyContent="center" alignItems="center" height={streamHeight}>
            <Text color="gray">loading workflow…</Text>
          </Box>
        ) : picker.wfPreview && picker.preview.spec && picker.preview.dispatchCheck ? (
          <WorkflowPreview
            spec={picker.preview.spec}
            source={activeWorkflowSource ?? "bundled"}
            width={columns}
            height={streamHeight}
            selectedIndex={runner.stepIndex}
            dispatchCheck={picker.preview.dispatchCheck}
            reroutePlan={picker.preview.reroutePlan}
            canResume={runner.wfCanResume}
            promptEditing={prompt.promptEditing}
            input={prompt.value.trim() || picker.wfPreview.input}
            planResult={planResult}
            showStepDetail={runner.wfShowStepDetail}
            showPlanResult={runner.wfShowPlanResult}
            resolveWorkflow={resolveWorkflowSpec}
          />
        ) : (
          <WorkflowPicker
            workflows={picker.workflowEntries}
            nav={picker.pickerNav}
            selectedIndex={picker.workflowIndex}
            height={streamHeight}
            stationLanding={stationLanding}
            draftLabel={
              picker.draftResolution.target
                ? `${formatDraftTarget(picker.draftResolution.target, config)}${
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
          onCtrlD={mode === "workflow" && !runner.running ? handlePlan : undefined}
          onCtrlE={
            mode === "workflow" && !runner.running && picker.wfPreview ? openStepEditor : undefined
          }
          onCtrlQ={mode === "workflow" && runner.running ? runner.handleWorkflowCancel : undefined}
          onSuggestionNavigate={prompt.handleSuggestionNavigate}
          onHistoryNavigate={prompt.promptHistoryArrows ? prompt.handleHistoryNavigate : undefined}
          focus={
            !historyHook.history &&
            !agentManagerOpen &&
            !apiManagerOpen &&
            !stepEditorOpen &&
            !runEditor &&
            !inputFormPending &&
            !helpOpen
          }
          editing={
            !historyHook.history &&
            !agentManagerOpen &&
            !apiManagerOpen &&
            !stepEditorOpen &&
            !runEditor &&
            !inputFormPending &&
            !helpOpen &&
            (!workflowListNavigation(mode) || prompt.promptEditing)
          }
          promptEditing={prompt.promptEditing}
          running={runner.running}
          cancelKeyHint={mode === "workflow" ? "Ctrl+Q" : "Esc"}
          suggestions={prompt.commandSuggestions}
          cursorResetKey={prompt.cursorResetKey}
        />
        <Box paddingX={1}>
          <Text color="gray">
            {agentManagerOpen
              ? "agent manager · ↑/↓ select · Enter/Space toggle · a add · d delete · Esc close · Ctrl+C quit"
              : apiManagerOpen
                ? "api manager · ↑/↓ select · Enter/Space toggle · a add · d delete · Esc close · Ctrl+C quit"
                : stepEditorOpen
                  ? "step editor · ↑/↓ field · ←/→ change · Enter edit prompt · Esc close · Ctrl+C quit"
                  : runEditor
                    ? "edit paused step · type to edit · Enter apply · Esc cancel · Ctrl+C quit"
                    : helpOpen
                      ? "help · Esc/q close · Ctrl+C quit"
                      : historyHook.history
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
                            attachedRun,
                            Boolean(runner.wf.paused),
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
  attachedRun = false,
  wfPaused = false,
): string {
  const completeHint = suggestionMenuOpen ? " · ↑/↓ complete · Tab/Enter pick · Esc cancel" : "";
  const historyHint = " · ↑/↓ history";
  const resumeHint = canResume ? " · Enter resume" : "";
  if (running) {
    // An attached run is owned elsewhere: Ctrl+Q only detaches the view.
    // Owned runs require a second Ctrl+Q / Ctrl+C|/exit to confirm cancel/quit.
    const stopHint = attachedRun
      ? "Ctrl+Q detach · /cancel-run cancel"
      : "Ctrl+Q cancel (confirm) · Ctrl+C|/exit quit (confirm)";
    const pauseHint = wfPaused ? "p resume · ↑/↓ step · e edit pending step" : "p pause";
    // Own in-process runs can be handed off to a background process with `d`.
    const detachHint = attachedRun ? "" : " · d detach";
    if (mode === "workflow" && wfStepDetails) {
      return `↑/↓ step · PgUp/PgDn scroll · ←/Esc back · ${pauseHint} · ${stopHint}${detachHint}`;
    }
    return mode === "workflow"
      ? `↑/↓ step · ${pauseHint} · ${stopHint}${detachHint}`
      : "Esc cancel · /exit quit (confirm) · Ctrl+C quit (confirm)";
  }
  if (mode === "workflow") {
    if (wfStepDetails) {
      return `↑/↓ step · PgUp/PgDn scroll · ←/Esc back${resumeHint} · Ctrl+E edit · Ctrl+R run · type to edit · /help · Ctrl+C quit${completeHint}`;
    }
    if (promptEditing) {
      const tabHint = slashInput ? " · Esc unfocus" : " · Esc list";
      const editingHint = `↑/↓ history${resumeHint}${tabHint} · Ctrl+R run · /help · Ctrl+C quit${completeHint}`;
      if (wfStarted || wfLaunching || wfPreviewing) return editingHint;
      return `↑/↓ history · Enter preview${tabHint} · Ctrl+R run · /help · Ctrl+C quit${completeHint}`;
    }
    if (wfStarted || wfLaunching) {
      return `↑/↓ step · Enter details · type to edit · Ctrl+R run · Ctrl+Q cancel · Esc back · Tab switch mode · /help · Ctrl+C quit${completeHint}`;
    }
    if (wfPreviewing) {
      return `↑/↓ step · Enter details${resumeHint} · Ctrl+E edit step · /set-all retarget · Ctrl+R run · Esc back · Tab detail · /help · Ctrl+C quit${completeHint}`;
    }
    return `↑/↓ pick · ←/→ folders · PgUp/PgDn · Ctrl+N new · type to edit · Enter open · Ctrl+R run · Ctrl+J history · Tab switch mode · /help · Ctrl+C quit${completeHint}`;
  }
  return promptEditing && slashInput
    ? `Enter dispatch${historyHint} · Esc unfocus · /help · Ctrl+C quit${completeHint}`
    : `Enter dispatch${historyHint} · Tab switch mode · /help · Ctrl+C quit${completeHint}`;
}

function historyHintText(history: HistoryUiState): string {
  if (history.diffView) {
    return "run diff · ↑/↓ scroll · PgUp/PgDn page · g/G top/bottom · v/Esc close · Ctrl+C quit";
  }
  if (history.view === "detail") {
    if (history.detail) return "↑/↓ step · PgUp/PgDn scroll · ←/Esc back · Ctrl+C quit";
    const retryHint = (history.record?.totals?.failed ?? 0) > 0 ? " · f retry failed" : "";
    const hasWorktrees = history.record?.phases.some((phase) =>
      phase.steps.some((step) => step.worktree),
    );
    const worktreeHint = hasWorktrees ? " · a apply · x prune · v diff" : "";
    return `↑/↓ step · → details · r re-run${retryHint}${worktreeHint} · d delete · ←/Esc back to list · Ctrl+C quit`;
  }
  if (history.filtering) {
    return "filter mode · type to search · Enter/Esc done · ↑/↓ select · Ctrl+C quit";
  }
  return "↑/↓ select · Enter inspect · / filter · t status · d delete · Esc close · Ctrl+C quit";
}

/**
 * Renders the past-run history: a list of recorded runs, or a selected run's
 * phase -> step tree (reusing the live `WorkflowView` / `WorkflowStepDetails`).
 */
function HistoryPanel({
  history,
  width,
  height,
  scroll,
  onOutputMetrics,
}: {
  history: HistoryUiState;
  width: number;
  height: number;
  scroll: OutputScroll;
  onOutputMetrics: (metrics: { total: number; budget: number }) => void;
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
          scroll={scroll}
          onOutputMetrics={onOutputMetrics}
        />
      );
    }
    const bannerHeight = 5;
    const viewHeight = Math.max(6, height - bannerHeight);
    return (
      <Box flexDirection="column" height={height}>
        {history.record ? <HistoryDetailBanner record={history.record} width={width} /> : null}
        <WorkflowView
          state={state}
          height={viewHeight}
          width={width}
          selectedIndex={clamped}
          elapsedMs={elapsed}
        />
      </Box>
    );
  }
  return (
    <WorkflowHistory
      runs={history.runs}
      liveRuns={history.liveRuns}
      selectedIndex={history.index}
      loading={history.loading}
      error={history.error}
      query={history.query}
      filtering={history.filtering}
      statusFilter={history.statusFilter}
      width={width}
      height={height}
    />
  );
}
