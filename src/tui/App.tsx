import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { SteamtrainConfig } from "../config";
import { type DoctorResult, runDoctor } from "../doctor";
import { Orchestrator } from "../orchestrator";
import type { StepResult } from "../workflow";
import { EventStream } from "./EventStream";
import { PromptInput } from "./PromptInput";
import { StatusBar } from "./StatusBar";
import { TaskSelector } from "./TaskSelector";
import { WorkflowPicker } from "./WorkflowPicker";
import { WorkflowView } from "./WorkflowView";
import { Banner } from "./banner";
import { type Mode, nextMode } from "./modes";
import { initialTranscript, transcriptReducer } from "./transcript";
import { useTerminalSize } from "./useTerminalSize";
import { initialWorkflowState, workflowReducer } from "./workflow-state";

interface AppProps {
  config: SteamtrainConfig;
  configSource: string;
  configWarning?: string;
}

type Phase = "banner" | "main";
const BANNER_MS = 1100;

export function App({ config, configSource, configWarning }: AppProps) {
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
  const workflowCacheRef = useRef<Map<string, StepResult>>(new Map());

  const orchestratorRef = useRef<Orchestrator | null>(null);
  if (!orchestratorRef.current) orchestratorRef.current = new Orchestrator(config, []);
  const orchestrator = orchestratorRef.current;

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

  // Surface a config-load warning (kept defaults) once.
  useEffect(() => {
    if (configWarning) dispatch({ type: "notice", level: "warn", text: configWarning });
  }, [configWarning]);

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
        orchestrator.setDoctor(results);
        setDoctor(results);
      })
      .catch((err) => {
        if (!active) return;
        dispatch({ type: "notice", level: "error", text: `preflight failed: ${message(err)}` });
      });
    return () => {
      active = false;
    };
  }, [config, orchestrator]);

  const totalWfSteps = wf.phases.reduce((n, p) => n + p.steps.length, 0);

  const runWorkflow = useCallback(
    (name: string, input: string) => {
      const check = orchestrator.canDispatchWorkflow(name);
      if (!check.ok) {
        setWfNotice(`cannot run '${name}': ${check.reason}`);
        return;
      }
      setWfNotice(null);
      activeWorkflowRef.current = name;
      setRunning(true);
      const ac = new AbortController();
      abortRef.current = ac;

      void (async () => {
        try {
          for await (const event of orchestrator.runWorkflow(
            name,
            input,
            ac.signal,
            workflowCacheRef.current,
          )) {
            if (!mountedRef.current) return;
            wfDispatch({ type: "event", event });
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
          runWorkflow(activeWorkflowRef.current, prompt);
          return;
        }
        const entry = workflowEntries[workflowIndex];
        if (!entry) return;
        workflowCacheRef.current = new Map();
        wfDispatch({ type: "reset" });
        setStepIndex(0);
        runWorkflow(entry.name, prompt);
        return;
      }

      // Task mode — `mode` is a TaskType here.
      setValue("");
      const tc = config.tasks[mode];
      const check = orchestrator.canDispatch(mode);
      if (!check.ok) {
        dispatch({
          type: "notice",
          level: "error",
          text: `cannot dispatch '${mode}': ${check.reason}`,
        });
        return;
      }

      dispatch({
        type: "notice",
        level: "info",
        text: `dispatch '${mode}' → ${tc.agent} / ${tc.model}`,
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
    [config, orchestrator, running, mode, wf.started, workflowEntries, workflowIndex, runWorkflow],
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
        workflowCacheRef.current = new Map();
        setWfNotice(null);
      }
      return;
    }
    if (key.tab && !running) {
      setMode((prev) => nextMode(prev));
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
      <StatusBar doctor={doctor} configSource={configSource} running={running} />
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
          taskLabel={taskLabel(config, mode)}
        />
      )}
      <TaskSelector
        config={config}
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

function taskLabel(config: SteamtrainConfig, mode: Mode): string {
  if (mode === "workflow") return "workflow";
  const tc = config.tasks[mode];
  return `${mode} · ${tc.agent}/${tc.model}`;
}

function hint(mode: Mode, wfStarted: boolean, running: boolean): string {
  if (running) return "Esc cancel · Ctrl+C quit";
  if (mode === "workflow") {
    return wfStarted
      ? "↑/↓ step · Enter resume · Esc back · Tab switch mode · Ctrl+C quit"
      : "↑/↓ pick · Enter run · Tab switch mode · Ctrl+C quit";
  }
  return "Enter dispatch · Tab switch mode · Esc cancel · Ctrl+C quit";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
