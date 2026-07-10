import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Orchestrator } from "../orchestrator";
import type {
  ApprovalDecision,
  ApprovalProvider,
  LiveRunPublisher,
  StepResult,
  WorkflowSpec,
} from "../workflow";
import { matchApprovalKey } from "../workflow";
import {
  RunRecordBuilder,
  WORKFLOW_CACHE_DIR,
  WORKFLOW_HISTORY_DIR,
  WORKFLOW_RUNS_DIR,
  acquireRunSlot,
  createLiveRunPublisher,
  createLiveRunStore,
  createWorkflowCacheStore,
  createWorkflowHistoryStore,
  hashWorkflowSpec,
  isTerminalLiveRunStatus,
  newLiveRunMeta,
  persistWorkflowStepDone,
  resolveMaxParallelRuns,
  resolveWorkflowTimeoutSec,
  timeoutMsFromSec,
  watchRunCancel,
  withStoreApprovals,
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
  const [wfShowStepDetail, setWfShowStepDetail] = useState(true);
  const [wfShowPlanResult, setWfShowPlanResult] = useState(true);

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
  // Shared live-run registry: TUI runs are mirrored here (so the CLI/web can
  // attach, cancel, and approve them), honor the cross-process run queue, and
  // /attach tails runs owned by other processes from it.
  const liveRunStoreRef = useRef(
    createLiveRunStore(join(process.cwd(), WORKFLOW_RUNS_DIR), {
      historyStore: historyStoreRef.current,
    }),
  );
  /** Non-null while /attach is tailing an externally-owned run; aborting detaches. */
  const attachAbortRef = useRef<AbortController | null>(null);
  const attachedRunIdRef = useRef<string | null>(null);

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
      // live) or an /attach tail is active. Starting another would clobber
      // `abortRef` — orphaning the first run's cancellation — and race its
      // cache writes.
      if (abortRef.current || attachAbortRef.current) {
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
        const liveStore = liveRunStoreRef.current;
        const cwd = process.cwd();
        const key = workflowCacheKey(name, input, cwd, spec, opts?.params);
        const runId = randomUUID();
        const recorder = new RunRecordBuilder({
          id: runId,
          workflow: name,
          input,
          cwd,
          specHash: hashWorkflowSpec(spec),
          params: opts?.params,
        });
        let runError: string | undefined;
        let workflowOk = true;
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
        let publisher: LiveRunPublisher | undefined;
        let disposeCancelWatch: (() => void) | undefined;
        try {
          // Register in the shared live-run registry (cross-UI attach/cancel/
          // approve) and wait for a queue slot so parallel runs never collide
          // over the step cache and git worktrees.
          await liveStore.create(
            newLiveRunMeta({
              id: runId,
              workflow: name,
              input,
              params: opts?.params,
              cwd,
              source: "tui",
            }),
          );
          disposeCancelWatch = watchRunCancel(liveStore, runId, () => ac.abort());
          let lastQueuePosition = -1;
          const slot = await acquireRunSlot(
            liveStore,
            runId,
            resolveMaxParallelRuns(orchestrator.getConfig()),
            {
              signal: ac.signal,
              onQueued: (position, running, limit) => {
                if (position === lastQueuePosition || !mountedRef.current) return;
                lastQueuePosition = position;
                setWfNotice(
                  `queued — ${running}/${limit} run slots busy, position ${position} (Ctrl+Q cancels)`,
                );
              },
            },
          );
          if (!slot.ok) {
            // Make sure the finally-block records this as canceled even when
            // the cancel came from the marker file rather than the signal.
            ac.abort();
            await liveStore.update(runId, { status: "canceled", ok: false, endedAt: Date.now() });
            if (mountedRef.current) setWfNotice("run canceled while queued");
            return;
          }
          if (lastQueuePosition !== -1 && mountedRef.current) setWfNotice(null);
          publisher = createLiveRunPublisher(liveStore, runId);

          // Arm the whole-workflow wall-clock timer once the run is executing.
          const workflowTimeoutMs = timeoutMsFromSec(
            resolveWorkflowTimeoutSec(spec, orchestrator.getConfig()),
          );
          timeoutTimer =
            workflowTimeoutMs > 0 ? setTimeout(() => ac.abort(), workflowTimeoutMs) : undefined;
          timeoutTimer?.unref?.();

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
            // Decisions written into the live-run store by another attached UI
            // (CLI approve / web) settle the checkpoint too — first one wins.
            withStoreApprovals(liveStore, runId, approvalProvider),
          )) {
            recorder.handle(event);
            publisher.event(event);
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
          disposeCancelWatch?.();
          const status = ac.signal.aborted
            ? "canceled"
            : runError || !workflowOk
              ? "error"
              : "done";
          // Settle the live-run mirror (flush events, then terminal meta) so
          // cross-UI tailers see the complete stream. Best-effort.
          try {
            await publisher?.finish(status, { ok: status === "done", error: runError });
          } catch {
            // Mirroring is best-effort.
          }
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

  /**
   * Attach to a run owned by another process (or a queued/just-finished one):
   * replay its recorded events into the live view, then tail until it settles.
   * Ctrl+Q / cancel detaches — the run itself keeps going.
   */
  const attachRun = useCallback(
    (runId: string): boolean => {
      if (abortRef.current || attachAbortRef.current) {
        setWfNotice("a run is already in progress");
        return false;
      }
      setWfNotice(null);
      setRunning(true);
      setWfLaunching(true);
      wfDispatch({ type: "reset" });
      setStepIndex(0);
      setWfStepDetails(null);
      const ac = new AbortController();
      attachAbortRef.current = ac;
      attachedRunIdRef.current = runId;
      const shortId = `${runId.slice(0, 8)}…`;

      void (async () => {
        const liveStore = liveRunStoreRef.current;
        try {
          const meta = await liveStore.get(runId);
          if (!meta) {
            if (mountedRef.current) {
              setWfNotice(`unknown run '${runId}' (see /runs or 'steamtrain workflow runs')`);
            }
            return;
          }
          activeWorkflowRef.current = meta.workflow;
          activeWorkflowInputRef.current = meta.input;
          if (mountedRef.current && meta.status === "queued") {
            setWfNotice(`attached to ${shortId} — queued, waiting for a run slot`);
          }
          for await (const event of liveStore.tailEvents(runId, { signal: ac.signal })) {
            if (!mountedRef.current) return;
            wfDispatch({ type: "event", event });
          }
          if (!mountedRef.current) return;
          if (ac.signal.aborted) {
            setWfNotice(`detached from ${shortId} — the run keeps going (/attach to re-attach)`);
          } else {
            const final = await liveStore.get(runId);
            if (final && final.status !== "done") {
              setWfNotice(`run ${final.status}${final.error ? `: ${final.error}` : ""}`);
            }
          }
        } catch (err) {
          if (mountedRef.current) setWfNotice(`attach failed: ${message(err)}`);
        } finally {
          attachAbortRef.current = null;
          attachedRunIdRef.current = null;
          if (mountedRef.current) {
            setRunning(false);
            setWfLaunching(false);
          }
        }
      })();
      return true;
    },
    [mountedRef],
  );

  /** Ctrl+Q: cancel an owned run, or detach from an attached one (it keeps going). */
  const handleWorkflowCancel = useCallback(() => {
    if (attachAbortRef.current) {
      attachAbortRef.current.abort();
      return;
    }
    abortRef.current?.abort();
  }, []);

  /**
   * Request cancellation of a live run by id (default: the currently attached
   * run) via the shared registry — the owning process picks the marker up.
   */
  const cancelLiveRun = useCallback(async (runId?: string): Promise<string> => {
    const id = runId ?? attachedRunIdRef.current;
    if (!id) return "no run id given and no run attached (usage: /cancel-run [runId])";
    const requested = await liveRunStoreRef.current.requestCancel(id);
    return requested
      ? `cancel requested for run ${id.slice(0, 8)}… — its owner stops it shortly`
      : `no active run '${id}' to cancel (see /runs)`;
  }, []);

  /**
   * Resolve the run's pending approval checkpoint (invoked by the `a`/`r`
   * keypress handler). `iteration` targets a specific pass; omitted resolves the
   * single pending checkpoint for `stepId`.
   */
  const resolveApproval = useCallback(
    (stepId: string, approved: boolean, iteration?: number): void => {
      // Attached (externally-owned) run: write the decision into the shared
      // registry; the owning process's approval provider polls it.
      if (attachedRunIdRef.current) {
        void liveRunStoreRef.current
          .writeApprovalDecision(attachedRunIdRef.current, stepId, iteration ?? 1, {
            approved,
            by: "human:tui",
          })
          .catch(() => {});
        return;
      }
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
    wfShowStepDetail,
    setWfShowStepDetail,
    wfShowPlanResult,
    setWfShowPlanResult,
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
    attachRun,
    cancelLiveRun,
    liveRunStoreRef,
    attachedRunIdRef,
    attachAbortRef,
  };
}
