import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Orchestrator } from "../orchestrator";
import type {
  StepResult,
  WorkflowSpec,
} from "../workflow";
import {
  WORKFLOW_CACHE_DIR,
  WORKFLOW_HISTORY_DIR,
  RunRecordBuilder,
  createWorkflowCacheStore,
  createWorkflowHistoryStore,
  hashWorkflowSpec,
  persistWorkflowStepDone,
  resolveWorkflowTimeoutSec,
  timeoutMsFromSec,
  workflowCacheKey,
} from "../workflow";
import {
  type WorkflowState,
  flattenSteps,
  initialWorkflowState,
  workflowReducer,
} from "./workflow-state";
import { message } from "./util";

export interface UseWorkflowRunnerParams {
  orchestrator: Orchestrator;
  resolveWorkflowSpec: (name: string) => WorkflowSpec | undefined;
  mountedRef: React.RefObject<boolean>;
}

export function useWorkflowRunner({
  orchestrator,
  resolveWorkflowSpec,
  mountedRef,
}: UseWorkflowRunnerParams) {
  const [running, setRunning] = useState(false);
  const [wf, wfDispatch] = useReducer(workflowReducer, initialWorkflowState);
  const [wfLaunching, setWfLaunching] = useState(false);
  const [wfNow, setWfNow] = useState(() => Date.now());
  const [wfStepDetails, setWfStepDetails] = useState<"preview" | "live" | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [wfCanResume, setWfCanResume] = useState(false);
  const [wfNotice, setWfNotice] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const activeWorkflowRef = useRef<string | undefined>(undefined);
  const activeWorkflowInputRef = useRef<string | undefined>(undefined);
  const workflowCacheRef = useRef<Map<string, StepResult>>(new Map());
  const cacheStoreRef = useRef(createWorkflowCacheStore(join(process.cwd(), WORKFLOW_CACHE_DIR)));
  const historyStoreRef = useRef(
    createWorkflowHistoryStore(join(process.cwd(), WORKFLOW_HISTORY_DIR)),
  );

  const showWorkflowView = wf.started || wfLaunching;
  const liveFlatSteps = useMemo(() => flattenSteps(wf), [wf]);
  const totalWfSteps = liveFlatSteps.length;
  const liveSelectedStep =
    liveFlatSteps.length > 0
      ? liveFlatSteps[Math.min(stepIndex, liveFlatSteps.length - 1)]
      : undefined;
  const wfElapsedMs = wf.startedAt
    ? Math.max(0, (wf.done ? Date.now() : wfNow) - wf.startedAt)
    : 0;

  // Elapsed timer for running workflows.
  useEffect(() => {
    if (!wf.started || wf.done) return;
    setWfNow(Date.now());
    const timer = setInterval(() => setWfNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [wf.started, wf.done]);

  const runWorkflow = useCallback(
    (
      name: string,
      input: string,
      opts?: { reuseMemoryCache?: boolean; fresh?: boolean; seed?: Map<string, StepResult> },
    ): boolean => {
      // Re-entrancy guard: a run is already in flight (its AbortController is
      // live). Starting another would clobber `abortRef` — orphaning the first
      // run's cancellation — and race its cache writes.
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
      const workflowTimeoutMs = timeoutMsFromSec(
        resolveWorkflowTimeoutSec(spec, orchestrator.getConfig()),
      );
      const timeoutTimer =
        workflowTimeoutMs > 0 ? setTimeout(() => ac.abort(), workflowTimeoutMs) : undefined;
      timeoutTimer?.unref?.();

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
          if (timeoutTimer) clearTimeout(timeoutTimer);
          const status = ac.signal.aborted
            ? "canceled"
            : runError || !workflowOk
              ? "error"
              : "done";
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
    [orchestrator, resolveWorkflowSpec, mountedRef],
  );

  const launchWorkflow = useCallback(
    (
      name: string,
      prompt: string,
      setWfPreview: React.Dispatch<React.SetStateAction<{ name: string; input: string } | null>>,
      opts?: { reuseMemoryCache?: boolean; fresh?: boolean },
    ) => {
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

  const handleWorkflowCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    running,
    setRunning,
    wf,
    wfDispatch,
    wfLaunching,
    setWfLaunching,
    wfCanResume,
    setWfCanResume,
    wfNow,
    wfNotice,
    setWfNotice,
    wfStepDetails,
    setWfStepDetails,
    stepIndex,
    setStepIndex,
    abortRef,
    activeWorkflowRef,
    activeWorkflowInputRef,
    workflowCacheRef,
    cacheStoreRef,
    historyStoreRef,
    showWorkflowView,
    liveFlatSteps,
    liveSelectedStep,
    wfElapsedMs,
    totalWfSteps,
    runWorkflow,
    launchWorkflow,
    handleWorkflowCancel,
  };
}
