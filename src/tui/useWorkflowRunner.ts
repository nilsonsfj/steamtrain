import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Orchestrator } from "../orchestrator";
import type {
  ApprovalDecision,
  ApprovalProvider,
  HumanInputProvider,
  HumanInputResponse,
  LiveRunPublisher,
  NarrationLine,
  StepEditPatch,
  StepResult,
  WorkflowRunControl,
  WorkflowSpec,
} from "../workflow";
import { appendNarration, matchApprovalKey, matchPendingInput } from "../workflow";
import {
  RunRecordBuilder,
  WORKFLOW_CACHE_DIR,
  WORKFLOW_HISTORY_DIR,
  WORKFLOW_RUNS_DIR,
  acquireRunSlot,
  createLiveRunPublisher,
  createLiveRunStore,
  createNotifier,
  createWorkflowCacheStore,
  createWorkflowHistoryStore,
  createWorkflowRunControl,
  hashWorkflowSpec,
  isTerminalLiveRunStatus,
  newLiveRunMeta,
  notifyWorkflowEvent,
  persistWorkflowStepDone,
  resolveMaxParallelRuns,
  resolveWorkflowTimeoutSec,
  timeoutMsFromSec,
  watchRunCancel,
  watchRunControl,
  withStoreApprovals,
  withStoreHumanInputs,
  workflowCacheKey,
} from "../workflow";
import { type OutputScroll, initialOutputScroll, scrollOutputBy } from "./output-window";
import { pickFollowIndex } from "./run-view-model";
import { message } from "./util";
import {
  type WorkflowState,
  flattenSteps,
  initialWorkflowState,
  workflowReducer,
} from "./workflow-state";

/** Semantic scroll motions for the drill-in output pane. */
export type OutputScrollMotion =
  | "line-up"
  | "line-down"
  | "page-up"
  | "page-down"
  | "top"
  | "bottom";

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
  /** Live conductor narration — pure projection of WorkflowEvents. */
  const [narration, setNarration] = useState<NarrationLine[]>([]);
  /** After arrival, prefer the receipt surface until the user inspects cars. */
  const [showArrival, setShowArrival] = useState(true);
  // Selection auto-follow: while a run streams, keep the selected step (and
  // its detail pane) on the live action. Any manual ↑/↓ hands control to the
  // user; a new launch/attach re-engages following.
  const [wfFollowSelection, setWfFollowSelection] = useState(true);
  // Scroll state for the drill-in output pane (live run AND history replay —
  // only one drill-in is ever on screen). Follows the stream until the reader
  // scrolls up; scrolling back to the bottom re-engages following.
  const [wfOutputScroll, setWfOutputScroll] = useState<OutputScroll>(initialOutputScroll);
  // The pane reports its wrapped-line total + visible budget after each render,
  // so keyboard motions can clamp without the handler re-measuring the text.
  const outputMetricsRef = useRef({ total: 0, budget: 1 });

  const abortRef = useRef<AbortController | null>(null);
  const activeWorkflowRef = useRef<string | undefined>(undefined);
  const activeWorkflowInputRef = useRef<string | undefined>(undefined);
  const workflowCacheRef = useRef<Map<string, StepResult>>(new Map());
  // Live approval checkpoints keyed by `<stepId>:<iteration>`: the injected
  // provider registers a resolver here and blocks until a keypress resolves it.
  const approvalResolversRef = useRef<Map<string, (decision: ApprovalDecision) => void>>(new Map());
  // Live human-input requests keyed the same way; the answer box resolves them.
  const humanInputResolversRef = useRef<Map<string, (response: HumanInputResponse) => void>>(
    new Map(),
  );
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
  /** The live-run id of the run THIS process owns, while one is executing. */
  const ownRunIdRef = useRef<string | null>(null);
  /** The owned run's steering control (pause / edit pending steps / resume). */
  const runControlRef = useRef<WorkflowRunControl | null>(null);

  const showWorkflowView = wf.started || wfLaunching;
  const liveFlatSteps = useMemo(() => flattenSteps(wf), [wf]);
  const totalWfSteps = liveFlatSteps.length;
  const liveSelectedStep =
    liveFlatSteps.length > 0
      ? liveFlatSteps[Math.min(stepIndex, liveFlatSteps.length - 1)]
      : undefined;
  // Freeze wall-clock at completion so the Arrival receipt doesn't keep ticking.
  const endedAtRef = useRef<number | null>(null);
  if (wf.done && wf.startedAt && endedAtRef.current === null) {
    endedAtRef.current = Date.now();
  }
  if (!wf.started) endedAtRef.current = null;
  const wfElapsedMs = wf.startedAt
    ? Math.max(0, (wf.done ? (endedAtRef.current ?? Date.now()) : wfNow) - wf.startedAt)
    : 0;

  // Elapsed timer for running workflows.
  useEffect(() => {
    if (!wf.started || wf.done) return;
    setWfNow(Date.now());
    const timer = setInterval(() => setWfNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [wf.started, wf.done]);

  // A different step (or a fresh drill-in) starts back in follow mode.
  useEffect(() => {
    setWfOutputScroll(initialOutputScroll);
  }, [stepIndex, wfStepDetails]);

  // Selection auto-follow: as events stream in, keep the selection on the
  // first running step (else the newest finished one) until the user takes
  // over with ↑/↓.
  useEffect(() => {
    if (!wfFollowSelection || !running || liveFlatSteps.length === 0) return;
    setStepIndex((current) => pickFollowIndex(liveFlatSteps, current));
  }, [wfFollowSelection, running, liveFlatSteps]);

  /** Reported by the drill-in output pane after each render (see outputMetricsRef). */
  const reportOutputMetrics = useCallback((metrics: { total: number; budget: number }): void => {
    outputMetricsRef.current = metrics;
  }, []);

  /** Move the drill-in output window (PgUp/PgDn/Shift+arrows). */
  const scrollOutput = useCallback((motion: OutputScrollMotion): void => {
    const { total, budget } = outputMetricsRef.current;
    const page = Math.max(1, budget - 1);
    const delta =
      motion === "page-up"
        ? -page
        : motion === "page-down"
          ? page
          : motion === "line-up"
            ? -1
            : motion === "line-down"
              ? 1
              : motion;
    setWfOutputScroll((s) => scrollOutputBy(s, delta, total, budget));
  }, []);

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
        const reroute = orchestrator.planWorkflowReroute(spec);
        setWfNotice(
          `cannot run '${name}': ${check.reason}${
            reroute.ok ? ` · /reroute runs it with ${reroute.plan.target} instead` : ""
          }`,
        );
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
        let disposeControlWatch: (() => void) | undefined;
        const control = createWorkflowRunControl();
        runControlRef.current = control;
        ownRunIdRef.current = runId;
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
          // Cross-process steering: pause/edit/resume requests written into the
          // store by the CLI or the web UI apply to this run's control too.
          disposeControlWatch = watchRunControl(liveStore, runId, control);
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
          const humanInputProvider: HumanInputProvider = (request, signal) =>
            new Promise<HumanInputResponse>((resolve) => {
              const mapKey = `${request.stepId}:${request.iteration}`;
              const settle = (response: HumanInputResponse): void => {
                if (humanInputResolversRef.current.get(mapKey) !== settle) return;
                humanInputResolversRef.current.delete(mapKey);
                signal?.removeEventListener("abort", onAbort);
                resolve(response);
              };
              const onAbort = (): void =>
                settle({ canceled: true, by: "auto:canceled", reason: "run canceled" });
              // A re-ask (rejected answer) re-registers under the same key; the
              // old resolver was already consumed by the first answer.
              humanInputResolversRef.current.set(mapKey, settle);
              if (signal) {
                if (signal.aborted) {
                  onAbort();
                  return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
              }
            });
          // Run notifications (bell / desktop / webhook) — this process owns
          // the run, so it is the one that pings.
          const notifier = createNotifier(orchestrator.getConfig().notify);
          const notifyMeta = { workflow: name, runId };
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
            control,
            withStoreHumanInputs(liveStore, runId, humanInputProvider),
          )) {
            recorder.handle(event);
            publisher.event(event);
            notifyWorkflowEvent(notifier, notifyMeta, event);
            if (event.kind === "workflow_done") workflowOk = event.ok;
            if (event.kind === "step_edited") {
              // The engine dropped the edited step's stale entry from the
              // shared cache map; persist the deletion so a canceled-then-
              // resumed run can't replay the pre-edit result from disk.
              await store.save(key, cache);
            }
            if (!mountedRef.current) return;
            wfDispatch({ type: "event", event });
            setNarration((prev) => appendNarration(prev, event));
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
          humanInputResolversRef.current.clear();
          disposeCancelWatch?.();
          disposeControlWatch?.();
          runControlRef.current = null;
          ownRunIdRef.current = null;
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
      // Seed the tree from the spec so not-yet-started steps render as pending
      // rows (matching the web client) — mid-run editing targets exactly those
      // steps, so they must be selectable before they start.
      const seedSpec = resolveWorkflowSpec(name);
      if (seedSpec) wfDispatch({ type: "seed", spec: seedSpec });
      else wfDispatch({ type: "reset" });
      setNarration([]);
      setShowArrival(true);
      setStepIndex(0);
      setWfFollowSelection(true);
      setWfPreview(null);
      setWfStepDetails(null);
      if (!runWorkflow(name, prompt, opts)) {
        setWfLaunching(false);
        setWfPreview({ name, input: prompt });
      }
    },
    [runWorkflow, resolveWorkflowSpec],
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
      setNarration([]);
      setShowArrival(true);
      setStepIndex(0);
      setWfFollowSelection(true);
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
          // Seed pending rows from the local catalog's spec when the workflow
          // is known, so a paused attached run's pending steps are selectable
          // (the replayed events update the seeded rows in place).
          const attachSpec = resolveWorkflowSpec(meta.workflow);
          if (attachSpec && mountedRef.current) wfDispatch({ type: "seed", spec: attachSpec });
          if (mountedRef.current && meta.status === "queued") {
            setWfNotice(`attached to ${shortId} — queued, waiting for a run slot`);
          }
          for await (const event of liveStore.tailEvents(runId, { signal: ac.signal })) {
            if (!mountedRef.current) return;
            wfDispatch({ type: "event", event });
            setNarration((prev) => appendNarration(prev, event));
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
    [mountedRef, resolveWorkflowSpec],
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

  /**
   * Answer the run's pending human-input request (invoked when the answer box
   * submits). Owned runs settle the registered resolver directly; attached
   * (externally-owned) runs write the answer into the shared registry, keyed
   * to the pending request's attempt so a re-ask can't consume a stale answer.
   */
  const answerHumanInput = useCallback(
    (stepId: string, value: string, iteration?: number): void => {
      if (attachedRunIdRef.current) {
        const runId = attachedRunIdRef.current;
        void liveRunStoreRef.current
          .get(runId)
          .then((meta) => {
            const target = matchPendingInput(meta?.pendingInputs ?? [], stepId, iteration);
            if (!target) return;
            return liveRunStoreRef.current.writeHumanInputResponse(
              runId,
              target.stepId,
              target.iteration,
              target.attempt,
              { value, by: "human:tui" },
            );
          })
          .catch(() => {});
        return;
      }
      const resolvers = humanInputResolversRef.current;
      const mapKey = matchApprovalKey(resolvers.keys(), stepId, iteration);
      if (!mapKey) return;
      const settle = resolvers.get(mapKey);
      if (!settle) return;
      settle({ value, by: "human:tui" });
    },
    [],
  );

  /**
   * Toggle mid-run pause/resume for the current run (owned or attached).
   * The desired state is written to the shared live-run store FIRST (the file
   * is the cross-surface source of truth), then applied directly to an owned
   * run's control so the pause takes effect without waiting a poll interval.
   * Returns a notice string, or null when no run is active.
   */
  const togglePauseRun = useCallback(async (): Promise<string | null> => {
    const runId = attachedRunIdRef.current ?? ownRunIdRef.current;
    if (!runId) return null;
    const desired = !(runControlRef.current?.isPauseRequested() ?? wf.paused ?? false);
    await liveRunStoreRef.current
      .writePauseState(runId, { paused: desired, by: "human:tui" })
      .catch(() => {});
    if (!attachedRunIdRef.current && runControlRef.current) {
      if (desired) runControlRef.current.pause("human:tui");
      else runControlRef.current.resume("human:tui");
    }
    return desired
      ? "pause requested — in-flight steps finish, nothing new starts (e edits a pending step, p resumes)"
      : "resume requested";
  }, [wf.paused]);

  /**
   * Stage a mid-run edit for a not-yet-started step of the paused run. Owned
   * runs validate synchronously through the control; attached runs drop a
   * request into the store and wait briefly for the owner's verdict. Returns
   * a notice string describing the outcome.
   */
  const editRunStep = useCallback(async (stepId: string, patch: StepEditPatch): Promise<string> => {
    if (runControlRef.current && !attachedRunIdRef.current) {
      const result = runControlRef.current.editStep(stepId, patch, "human:tui");
      return result.ok
        ? `✎ step '${stepId}' edited — applies when it runs (p resumes)`
        : `edit rejected: ${result.error}`;
    }
    const runId = attachedRunIdRef.current;
    if (!runId) return "no active run to edit";
    const store = liveRunStoreRef.current;
    const editId = await store
      .requestStepEdit(runId, { stepId, patch, by: "human:tui" })
      .catch(() => undefined);
    if (!editId) return "could not request the edit (run gone?)";
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await store.readStepEditResult(runId, editId).catch(() => undefined);
      if (result) {
        return result.ok
          ? `✎ step '${stepId}' edited — applies when it runs (p resumes)`
          : `edit rejected: ${result.error}`;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return "edit requested — no response from the owning process yet";
  }, []);

  const resetRunner = useCallback(() => {
    wfDispatch({ type: "reset" });
    setNarration([]);
    setShowArrival(true);
    setStepIndex(0);
    setWfFollowSelection(true);
    setWfLaunching(false);
    setWfNotice(null);
    setWfStepDetails(null);
    activeWorkflowRef.current = undefined;
    activeWorkflowInputRef.current = undefined;
    workflowCacheRef.current = new Map();
  }, []);

  return {
    running,
    setRunning,
    wf,
    wfDispatch,
    resetRunner,
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
    narration,
    showArrival,
    setShowArrival,
    wfFollowSelection,
    setWfFollowSelection,
    wfOutputScroll,
    setWfOutputScroll,
    reportOutputMetrics,
    scrollOutput,
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
    answerHumanInput,
    attachRun,
    cancelLiveRun,
    togglePauseRun,
    editRunStep,
    liveRunStoreRef,
    attachedRunIdRef,
    attachAbortRef,
  };
}
