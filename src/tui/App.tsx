import { join } from "node:path";
import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { SteamtrainConfig } from "../config";
import { type DoctorResult, runDoctor } from "../doctor";
import { Orchestrator } from "../orchestrator";
import {
  type StepResult,
  WORKFLOW_CACHE_DIR,
  createWorkflowCacheStore,
  persistWorkflowStepDone,
  workflowCacheKey,
} from "../workflow";
import type { WorkspaceConfig, WorkspaceEntry } from "../workspace";
import { workspaceById, workspaceLabel } from "../workspace";
import { EventStream } from "./EventStream";
import { PromptInput } from "./PromptInput";
import { StatusBar } from "./StatusBar";
import { TaskSelector } from "./TaskSelector";
import { WorkflowPicker } from "./WorkflowPicker";
import { WorkflowView } from "./WorkflowView";
import { Banner } from "./banner";
import { type Mode, buildModes, nextMode } from "./modes";
import { initialTranscript, transcriptReducer } from "./transcript";
import { useTerminalSize } from "./useTerminalSize";
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
  const [value, setValue] = useState("");
  const [running, setRunning] = useState(false);
  const [transcript, dispatch] = useReducer(transcriptReducer, initialTranscript);

  // Workflow mode state.
  const [wf, wfDispatch] = useReducer(workflowReducer, initialWorkflowState);
  const [workflowIndex, setWorkflowIndex] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [wfNotice, setWfNotice] = useState<string | null>(null);
  const activeWorkflowRef = useRef<string | undefined>(undefined);
  const activeWorkflowInputRef = useRef<string | undefined>(undefined);
  const workflowCacheRef = useRef<Map<string, StepResult>>(new Map());
  const cacheStoreRef = useRef(createWorkflowCacheStore(join(process.cwd(), WORKFLOW_CACHE_DIR)));

  const modes = useMemo(() => buildModes(workspaces), [workspaces]);
  const workspaceMap = useMemo(() => workspaceById(workspaces), [workspaces]);

  const orchestrator = useMemo(
    () => new Orchestrator(config, workspaces, doctor ?? []),
    [config, workspaces, doctor],
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

  const runWorkflow = useCallback(
    (name: string, input: string, opts?: { reuseMemoryCache?: boolean }) => {
      const check = orchestrator.canDispatchWorkflow(name);
      if (!check.ok) {
        setWfNotice(`cannot run '${name}': ${check.reason}`);
        return;
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
          if (mountedRef.current) setRunning(false);
          abortRef.current = null;
        }
      })();
    },
    [orchestrator],
  );

  const handleSubmit = useCallback(
    (raw: string) => {
      const prompt = raw.trim();
      if (running || prompt.length === 0) return;

      if (mode === "workflow") {
        // Resume the active run if one exists; otherwise start the picked one fresh.
        if (wf.started && activeWorkflowRef.current) {
          if (activeWorkflowInputRef.current !== prompt) {
            wfDispatch({ type: "reset" });
            setStepIndex(0);
            runWorkflow(activeWorkflowRef.current, prompt);
            return;
          }
          runWorkflow(activeWorkflowRef.current, prompt, { reuseMemoryCache: true });
          return;
        }
        const entry = workflowEntries[workflowIndex];
        if (!entry) return;
        wfDispatch({ type: "reset" });
        setStepIndex(0);
        runWorkflow(entry.name, prompt);
        return;
      }

      // Workspace mode — `mode` is a workspace id here.
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
          if (mountedRef.current) setRunning(false);
          abortRef.current = null;
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
      runWorkflow,
      workspaceMap,
    ],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      abortRef.current?.abort();
      exit();
      return;
    }
    if (key.escape) {
      if (running) {
        abortRef.current?.abort();
        return;
      }
      // Not running: in workflow mode, back out of a finished run to the picker.
      if (mode === "workflow" && wf.started) {
        wfDispatch({ type: "reset" });
        setStepIndex(0);
        activeWorkflowRef.current = undefined;
        activeWorkflowInputRef.current = undefined;
        workflowCacheRef.current = new Map();
        setWfNotice(null);
      }
      return;
    }
    if (key.tab && !running) {
      setMode((prev) => nextMode(prev, modes));
      return;
    }
    if (mode === "workflow") {
      if (key.upArrow) {
        if (wf.started) setStepIndex((i) => Math.max(0, i - 1));
        else setWorkflowIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        if (wf.started) setStepIndex((i) => Math.min(Math.max(0, totalWfSteps - 1), i + 1));
        else setWorkflowIndex((i) => Math.min(workflowEntries.length - 1, i + 1));
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

  return (
    <Box flexDirection="column" width={columns}>
      <StatusBar
        doctor={doctor}
        configSource={configSource}
        workspaceSource={workspaceSource}
        running={running}
      />
      {isWorkflow ? (
        wf.started ? (
          <WorkflowView
            state={wf}
            height={streamHeight}
            width={columns}
            selectedIndex={stepIndex}
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
        workspaces={workspaces}
        active={mode}
        workflowName={isWorkflow ? workflowEntries[workflowIndex]?.name : undefined}
      />
      {wfNotice && isWorkflow ? (
        <Box paddingX={1}>
          <Text color="red">{wfNotice}</Text>
        </Box>
      ) : null}
      <PromptInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        focus={!running}
        running={running}
      />
      <Box paddingX={1}>
        <Text color="gray">{hint(mode, wf.started, running)}</Text>
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

function hint(mode: Mode, wfStarted: boolean, running: boolean): string {
  if (running) return "Esc cancel · Ctrl+C quit";
  if (mode === "workflow") {
    return wfStarted
      ? "↑/↓ step · Enter resume · Esc back · Tab switch mode · Ctrl+C quit"
      : "↑/↓ pick · Enter run (resumes from disk) · Tab switch mode · Ctrl+C quit";
  }
  return "Enter dispatch · Tab switch mode · Esc cancel · Ctrl+C quit";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
