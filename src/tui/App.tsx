import { join } from "node:path";
import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import { STEAMTRAIN_VERSION } from "../version";
import {
  type StepResult,
  WORKFLOW_CACHE_DIR,
  createWorkflowCacheStore,
  persistWorkflowStepDone,
  workflowCacheKey,
} from "../workflow";
import type { WorkspaceConfig, WorkspaceEntry, WorkspaceId } from "../workspace";
import { saveWorkspaceConfig, workspaceById, workspaceLabel } from "../workspace";
import { CommandSuggestionMenu, suggestionMenuHeight } from "./CommandSuggestionMenu";
import { EventStream } from "./EventStream";
import { PromptInput } from "./PromptInput";
import { StatusBar } from "./StatusBar";
import { TaskSelector } from "./TaskSelector";
import { WorkflowPicker } from "./WorkflowPicker";
import { WorkflowPreview } from "./WorkflowPreview";
import { WorkflowView } from "./WorkflowView";
import { Banner } from "./banner";
import { type Mode, buildModes, nextMode } from "./modes";
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
  workspaces: WorkspaceConfig;
  workspaceSource: string;
  workspaceWarning?: string;
}

type Phase = "banner" | "main";
const BANNER_MS = 1100;

export function App({
  config,
  configSource,
  configWarning,
  workspaces,
  workspaceSource,
  workspaceWarning,
}: AppProps) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();

  const [phase, setPhase] = useState<Phase>("banner");
  const [doctor, setDoctor] = useState<DoctorResult[] | null>(null);
  const [mode, setMode] = useState<Mode>("workflow");
  const [runtimeWorkspaces, setRuntimeWorkspaces] = useState<WorkspaceConfig>(workspaces);
  const [activeWorkspaceSource, setActiveWorkspaceSource] = useState(workspaceSource);
  const [value, setValue] = useState("");
  const [commandSuggestions, setCommandSuggestions] = useState<readonly string[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [cursorResetKey, setCursorResetKey] = useState(0);
  const [running, setRunning] = useState(false);
  const [transcript, dispatch] = useReducer(transcriptReducer, initialTranscript);

  // Workflow mode state.
  const [wf, wfDispatch] = useReducer(workflowReducer, initialWorkflowState);
  const [workflowIndex, setWorkflowIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [wfPreview, setWfPreview] = useState<{ name: string; input: string } | null>(null);
  const [wfLaunching, setWfLaunching] = useState(false);
  const [wfNotice, setWfNotice] = useState<string | null>(null);
  const activeWorkflowRef = useRef<string | undefined>(undefined);
  const activeWorkflowInputRef = useRef<string | undefined>(undefined);
  const workflowCacheRef = useRef<Map<string, StepResult>>(new Map());
  const cacheStoreRef = useRef(createWorkflowCacheStore(join(process.cwd(), WORKFLOW_CACHE_DIR)));
  const runtimeWorkspacesRef = useRef(runtimeWorkspaces);
  runtimeWorkspacesRef.current = runtimeWorkspaces;

  const modes = useMemo(() => buildModes(runtimeWorkspaces), [runtimeWorkspaces]);
  const workspaceMap = useMemo(() => workspaceById(runtimeWorkspaces), [runtimeWorkspaces]);

  const updateWorkspace = useCallback((id: WorkspaceId, patch: Partial<WorkspaceEntry>) => {
    const next: WorkspaceConfig = {
      workspaces: runtimeWorkspacesRef.current.workspaces.map((w) =>
        w.id === id ? { ...w, ...patch } : w,
      ),
    };
    const source = saveWorkspaceConfig(next);
    setActiveWorkspaceSource(source);
    setRuntimeWorkspaces(next);
  }, []);

  const slashCtx = useMemo<SlashCommandContext>(
    () => ({
      mode,
      modes,
      workspaces: runtimeWorkspaces,
      workspaceMap,
      updateWorkspace,
      setMode,
      version: STEAMTRAIN_VERSION,
    }),
    [mode, modes, runtimeWorkspaces, workspaceMap, updateWorkspace],
  );

  const orchestrator = useMemo(
    () => new Orchestrator(config, runtimeWorkspaces, doctor ?? []),
    [config, runtimeWorkspaces, doctor],
  );

  const workflowEntries = useMemo(
    () => Object.entries(orchestrator.listWorkflows()).map(([name, spec]) => ({ name, spec })),
    [orchestrator],
  );

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
  const previewSpec = wfPreview ? orchestrator.listWorkflows()[wfPreview.name] : undefined;
  const previewFlatSteps = useMemo(
    () => (previewSpec ? flattenSpecSteps(previewSpec) : []),
    [previewSpec],
  );
  const previewStepCount = previewFlatSteps.length;
  const previewDispatchCheck = wfPreview ? orchestrator.canDispatchWorkflow(wfPreview.name) : null;

  const runWorkflow = useCallback(
    (name: string, input: string, opts?: { reuseMemoryCache?: boolean }): boolean => {
      const check = orchestrator.canDispatchWorkflow(name);
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
        const spec = orchestrator.listWorkflows()[name];
        if (!spec) {
          setWfNotice(`unknown workflow '${name}'`);
          setRunning(false);
          setWfLaunching(false);
          return;
        }
        const store = cacheStoreRef.current;
        const cwd = process.cwd();
        const key = workflowCacheKey(name, input, cwd, spec);
        try {
          if (!opts?.reuseMemoryCache) {
            workflowCacheRef.current = await store.load(key);
          }
          const cache = workflowCacheRef.current;
          for await (const event of orchestrator.runWorkflow(name, input, ac.signal, cache, cwd)) {
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
    [orchestrator],
  );

  const bumpCursorToEnd = useCallback(() => {
    setCursorResetKey((k) => k + 1);
  }, []);

  const handleValueChange = useCallback((next: string) => {
    setValue(next);
    setCommandSuggestions([]);
    setSuggestionIndex(0);
  }, []);

  const handleTab = useCallback(() => {
    if (!isSlashCommandInput(value)) return;
    const commands = listSlashCommands();

    if (commandSuggestions.length > 1) {
      const pick = commandSuggestions[suggestionIndex];
      if (!pick) return;
      const nextValue = applySlashSuggestion(value, pick, commands, slashCtx);
      if (nextValue !== value) {
        setValue(nextValue);
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
      setValue(result.value);
      bumpCursorToEnd();
    }
    setCommandSuggestions(result.suggestions);
    setSuggestionIndex(0);
  }, [value, slashCtx, commandSuggestions, suggestionIndex, bumpCursorToEnd]);

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
    const body = value.trimStart().slice(1);
    const hasArgumentTokens = body.includes(" ");
    if (hasArgumentTokens && parsed.command.length > 0) return undefined;
    const map = new Map<string, string>();
    for (const c of listSlashCommands()) {
      map.set(c.name, c.description);
    }
    return map;
  }, [value, suggestionMenuOpen]);

  const handleSubmit = useCallback(
    (raw: string) => {
      setCommandSuggestions([]);
      setSuggestionIndex(0);

      const prompt = raw.trim();

      if (isRegisteredSlashCommand(prompt)) {
        const result = executeSlashCommand(prompt, slashCtx);
        if (result.handled) {
          if (result.clearInput) setValue("");
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
        // Resume the active run if one exists; otherwise start the picked one fresh.
        if (wf.started && activeWorkflowRef.current) {
          if (prompt.length === 0) return;
          if (activeWorkflowInputRef.current !== prompt) {
            wfDispatch({ type: "reset" });
            setStepIndex(0);
            setWfLaunching(true);
            runWorkflow(activeWorkflowRef.current, prompt);
            return;
          }
          runWorkflow(activeWorkflowRef.current, prompt, { reuseMemoryCache: true });
          return;
        }
        // Preview screen: Enter dispatches the workflow.
        if (wfPreview) {
          if (prompt.length === 0) {
            setWfNotice("type input in the prompt before running");
            return;
          }
          setWfLaunching(true);
          wfDispatch({ type: "reset" });
          setStepIndex(0);
          const { name, input } = wfPreview;
          setWfPreview(null);
          if (!runWorkflow(name, prompt)) {
            setWfLaunching(false);
            setWfPreview({ name, input: prompt });
          }
          return;
        }
        const entry = workflowEntries[workflowIndex];
        if (!entry) return;
        setWfNotice(null);
        setStepIndex(0);
        setWfPreview({ name: entry.name, input: prompt });
        return;
      }

      // Workspace mode — `mode` is a workspace id here.
      if (prompt.length === 0) return;
      setValue("");
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
          text: `cannot dispatch '${workspaceLabel(entry)}': ${check.reason}`,
        });
        return;
      }

      dispatch({
        type: "notice",
        level: "info",
        text: `dispatch '${workspaceLabel(entry)}' → ${entry.agent} / ${entry.model}`,
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
      wfPreview,
      runWorkflow,
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
      handleSubmit(raw);
    },
    [commandSuggestions, handleTab, handleSubmit],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      abortRef.current?.abort();
      exit();
      return;
    }
    if (key.escape) {
      if (shouldDismissSuggestionMenu(commandSuggestions, value)) {
        setCommandSuggestions([]);
        setSuggestionIndex(0);
        return;
      }
      if (running) {
        abortRef.current?.abort();
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
    if (key.tab && !key.shift && !running && !isSlashCommandInput(value)) {
      setWfPreview(null);
      setWfLaunching(false);
      setMode((prev) => nextMode(prev, modes));
      return;
    }
    const menuOpen = shouldSuppressWorkflowNavigation(commandSuggestions, value);
    if (mode === "workflow" && !menuOpen) {
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
        workspaceSource={activeWorkspaceSource}
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
            input={value.trim() || wfPreview.input}
            width={columns}
            height={streamHeight}
            selectedIndex={stepIndex}
            dispatchCheck={previewDispatchCheck}
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
          taskLabel={workspaceStreamLabel(mode, workspaceMap)}
        />
      )}
      <TaskSelector
        modes={modes}
        workspaceMap={workspaceMap}
        active={mode}
        workflowName={isWorkflow ? workflowEntries[workflowIndex]?.name : undefined}
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
          onSuggestionNavigate={handleSuggestionNavigate}
          focus
          running={running}
          suggestions={commandSuggestions}
          cursorResetKey={cursorResetKey}
        />
        <Box paddingX={1}>
          <Text color="gray">
            {hint(mode, wf.started, wfLaunching, !!wfPreview, running, suggestionMenuOpen)}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

function workspaceStreamLabel(mode: Mode, workspaceMap: Map<string, WorkspaceEntry>): string {
  if (mode === "workflow") return "workflow";
  const entry = workspaceMap.get(mode);
  if (!entry) return mode;
  return `${workspaceLabel(entry)} · ${entry.agent}/${entry.model}`;
}

function hint(
  mode: Mode,
  wfStarted: boolean,
  wfLaunching: boolean,
  wfPreviewing: boolean,
  running: boolean,
  suggestionMenuOpen: boolean,
): string {
  const completeHint = suggestionMenuOpen ? " · ↑/↓ complete · Tab/Enter pick · Esc cancel" : "";
  if (running) return "Esc cancel · /exit quit · Ctrl+C quit";
  if (mode === "workflow") {
    if (wfStarted || wfLaunching) {
      return `↑/↓ step · Enter resume · Esc back · Tab switch mode · /commands · Ctrl+C quit${completeHint}`;
    }
    if (wfPreviewing) {
      return `↑/↓ step · Enter run · Esc back · Tab switch mode · /commands · Ctrl+C quit${completeHint}`;
    }
    return `↑/↓ pick · Enter preview · Tab switch mode · /commands · Ctrl+C quit${completeHint}`;
  }
  return `Enter dispatch · Tab switch mode · /commands (Tab complete) · Ctrl+C quit${completeHint}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
