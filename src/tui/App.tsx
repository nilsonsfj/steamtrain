import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type SteamtrainConfig, TASK_TYPES, type TaskType } from "../config";
import { type DoctorResult, runDoctor } from "../doctor";
import { Orchestrator } from "../orchestrator";
import { EventStream } from "./EventStream";
import { PromptInput } from "./PromptInput";
import { StatusBar } from "./StatusBar";
import { TaskSelector } from "./TaskSelector";
import { Banner } from "./banner";
import { initialTranscript, transcriptReducer } from "./transcript";
import { useTerminalSize } from "./useTerminalSize";

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
  const [taskType, setTaskType] = useState<TaskType>("plan");
  const [value, setValue] = useState("");
  const [running, setRunning] = useState(false);
  const [transcript, dispatch] = useReducer(transcriptReducer, initialTranscript);

  const orchestratorRef = useRef<Orchestrator | null>(null);
  if (!orchestratorRef.current) orchestratorRef.current = new Orchestrator(config, []);
  const orchestrator = orchestratorRef.current;

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

  const handleSubmit = useCallback(
    (raw: string) => {
      const prompt = raw.trim();
      if (running || prompt.length === 0) return;
      setValue("");

      const tc = config.tasks[taskType];
      const check = orchestrator.canDispatch(taskType);
      if (!check.ok) {
        dispatch({
          type: "notice",
          level: "error",
          text: `cannot dispatch '${taskType}': ${check.reason}`,
        });
        return;
      }

      dispatch({
        type: "notice",
        level: "info",
        text: `dispatch '${taskType}' → ${tc.agent} / ${tc.model}`,
      });
      setRunning(true);
      const ac = new AbortController();
      abortRef.current = ac;

      void (async () => {
        try {
          for await (const event of orchestrator.run(taskType, prompt, ac.signal)) {
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
    [config, orchestrator, running, taskType],
  );

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      abortRef.current?.abort();
      exit();
      return;
    }
    if (key.escape && running) {
      abortRef.current?.abort();
      return;
    }
    if (key.tab && !running) {
      setTaskType((prev) => nextTaskType(prev));
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

  const tc = config.tasks[taskType];
  const streamHeight = Math.max(6, rows - 9);

  return (
    <Box flexDirection="column" width={columns}>
      <StatusBar doctor={doctor} configSource={configSource} running={running} />
      <EventStream
        items={transcript.items}
        height={streamHeight}
        width={columns}
        taskLabel={`${taskType} · ${tc.agent}/${tc.model}`}
      />
      <TaskSelector config={config} active={taskType} />
      <PromptInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        focus={!running}
        running={running}
      />
      <Box paddingX={1}>
        <Text color="gray">Enter dispatch · Tab switch task · Esc cancel · Ctrl+C quit</Text>
      </Box>
    </Box>
  );
}

function nextTaskType(current: TaskType): TaskType {
  const idx = TASK_TYPES.indexOf(current);
  return TASK_TYPES[(idx + 1) % TASK_TYPES.length] ?? current;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
