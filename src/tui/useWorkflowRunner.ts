import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { checkLlmApiKeys } from "../doctor";
import type { Orchestrator } from "../orchestrator";
import type { ApprovalDecision, ApprovalProvider, StepResult, WorkflowSpec } from "../workflow";
import { matchApprovalKey } from "../workflow";
import {
  RunRecordBuilder,
  WORKFLOW_CACHE_DIR,
  WORKFLOW_HISTORY_DIR,
  createWorkflowCacheStore,
  createWorkflowHistoryStore,
  hashWorkflowSpec,
  persistWorkflowStepDone,
  resolveWorkflowTimeoutSec,
  timeoutMsFromSec,
  workflowCacheKey,
} from "../workflow";
import { message } from "./util";
import {
  type WorkflowState,
  flattenSteps,
  initialWorkflowState,
  workflowReducer,
} from "./workflow-state";

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
  // Live approval checkpoints keyed by `<stepId>:<iteration>`: the injected
  // provider registers a resolver here and blocks until a keypress resolves it.
  const approvalResolversRef = useRef<Map<string, (decision: ApprovalDecision) => void>>(new Map());
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
  const wfElapsedMs = wf.startedAt ? Math.max(0, (wf.done ? Date.now() : wfNow) - wf.startedAt) : 0;

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
      opts?: {
        reuseMemoryCache?: boolean;
        fresh?: boolean;
        seed?: Map<string, StepResult>;
        params?: Record<string, string | number | boolean>;
      },
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
      // Refresh this workflow's llm API-key readiness into the preflight panel
      // (agent health is already cached from startup) before gating the run.
      orchestrator.setLlmDoctor(checkLlmApiKeys(spec));
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
        const key = workflowCacheKey(name, input, cwd, spec, opts?.params);
        const recorder = new RunRecordBuilder({
          id: randomUUID(),
          workflow: name,
          input,
          cwd,
          specHash: hashWorkflowSpec(spec),
          params: opts?.params,
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
          const approvalProvider: ApprovalProvider = (request, signal) =>
            new Promise<ApprovalDecision>((resolve) => {
              const mapKey = `${request.stepId}:${request.iteration}`;
              const settle = (decision: ApprovalDecision): void => {
                if (!approvalResolversRef.current.has(mapKey)) return;
                approvalResolversRef.current.delete(mapKey);
                signal?.removeEventListener("abort", onAbort);
                resolve(decision);
              };
              const onAbort = (): void =>
                settle({ approved: false, by: "auto:canceled", note: "run canceled" });
              // Defensive: if a resolver is already registered for this key
              // (should never happen — one checkpoint per step+iteration), settle
              // the stale one as canceled so its promise can't hang forever.
              approvalResolversRef.current.get(mapKey)?.({
                approved: false,
                by: "auto:canceled",
                note: "superseded by a new checkpoint",
              });
              approvalResolversRef.current.set(mapKey, settle);
              if (signal) {
                if (signal.aborted) {
                  onAbort();
                  return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
              }
            });
          for await (const event of orchestrator.runWorkflow(
            name,
            input,
            ac.signal,
            cache,
            cwd,
            spec,
            opts?.params,
            approvalProvider,
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
          approvalResolversRef.current.clear();
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
      opts?: {
        reuseMemoryCache?: boolean;
        fresh?: boolean;
        params?: Record<string, string | number | boolean>;
      },
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

  /**
   * Resolve the run's pending approval checkpoint (invoked by the `a`/`r`
   * keypress handler). `iteration` targets a specific pass; omitted resolves the
   * single pending checkpoint for `stepId`.
   */
  const resolveApproval = useCallback(
    (stepId: string, approved: boolean, iteration?: number): void => {
      const resolvers = approvalResolversRef.current;
      const mapKey = matchApprovalKey(resolvers.keys(), stepId, iteration);
      if (!mapKey) return;
      const settle = resolvers.get(mapKey);
      if (!settle) return;
      settle({ approved, by: "human:tui" });
    },
    [],
  );

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
    resolveApproval,
  };
}
