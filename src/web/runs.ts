import { randomUUID } from "node:crypto";
import type { SteamtrainConfig } from "../config";
import {
  type ApprovalDecision,
  type ApprovalProvider,
  type LiveRunPublisher,
  type LiveRunStore,
  type RerunMode,
  type RerunPlan,
  type RunRecord,
  RunRecordBuilder,
  type RunRecordStatus,
  type StepEditPatch,
  type StepEditResult,
  type StepResult,
  type WorkflowCacheStore,
  type WorkflowEvent,
  type WorkflowHistoryStore,
  type WorkflowRunControl,
  type WorkflowSpec,
  acquireRunSlot,
  createLiveRunPublisher,
  createWorkflowRunControl,
  hashWorkflowSpec,
  isRerunError,
  matchApprovalKey,
  newLiveRunMeta,
  persistWorkflowStepDone,
  planRerun,
  resolveMaxParallelRuns,
  resolveWorkflowTimeoutSec,
  timeoutMsFromSec,
  watchRunCancel,
  watchRunControl,
  withStoreApprovals,
  workflowCacheKey,
} from "../workflow";

const MAX_FRAMES_PER_RUN = 5000;

/**
 * The slice of the {@link Orchestrator} the web layer depends on. Declaring it
 * as an interface keeps the server testable with a lightweight fake and avoids
 * a hard dependency on the full orchestrator in unit tests.
 */
export interface WorkflowHost {
  listWorkflows(): Record<string, WorkflowSpec>;
  canDispatchWorkflowSpec(spec: WorkflowSpec): { ok: true } | { ok: false; reason: string };
  runWorkflow(
    name: string,
    input: string,
    signal?: AbortSignal,
    cache?: Map<string, StepResult>,
    cwd?: string,
    specOverride?: WorkflowSpec,
    inputs?: Record<string, string | number | boolean>,
    approval?: ApprovalProvider,
    control?: WorkflowRunControl,
  ): AsyncIterable<WorkflowEvent>;
}

export type RunStatus = "running" | "done" | "error" | "canceled" | "budget-exceeded";

export class TooManyRuns extends Error {
  constructor(max: number) {
    super(`too many concurrent runs (max ${max})`);
    this.name = "TooManyRuns";
  }
}

/** One serialized server-sent frame, retained so late subscribers can replay. */
interface RunFrame {
  payload: string;
  terminal: boolean;
}

/** A frame listener; `terminal` marks the final status frame (end of stream). */
export type RunListener = (payload: string, terminal: boolean) => void;

interface Run {
  id: string;
  workflow: string;
  input: string;
  params?: Record<string, string | number | boolean>;
  status: RunStatus;
  /** True while the run is waiting for a shared queue slot (status stays "running"). */
  queued: boolean;
  ok?: boolean;
  error?: string;
  startedAt: number;
  endedAt?: number;
  frames: RunFrame[];
  /** The terminal status frame has been emitted; set in lockstep with that emit. */
  terminal: boolean;
  /**
   * The run's outcome is resolved and it can no longer be canceled. Set
   * synchronously when the run settles, *before* the async history write, so
   * `cancel()` doesn't briefly report an already-finished run as cancelable
   * while history is still being persisted (`terminal` is deferred so a late
   * subscriber can still register for the terminal frame).
   */
  settled: boolean;
  listeners: Set<RunListener>;
  controller: AbortController;
  /** Mid-run steering handle (pause / edit pending steps / resume). */
  control: WorkflowRunControl;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  /**
   * Live approval checkpoints keyed by `<stepId>:<iteration>`. The engine's
   * injected provider registers a resolver here and blocks; a
   * `POST /api/runs/:id/approval` calls {@link WorkflowRunManager.resolveApproval}
   * to settle it. Cleared as decisions arrive and when the run ends.
   */
  pendingApprovals: Map<string, (decision: ApprovalDecision) => void>;
}

export interface RunSummary {
  id: string;
  workflow: string;
  input: string;
  status: RunStatus;
  /** True while the run waits for a shared queue slot. */
  queued?: boolean;
  /** True while a pause is requested for the run (mid-run steering). */
  paused?: boolean;
  ok?: boolean;
  error?: string;
  startedAt: number;
  endedAt?: number;
  /** Human-approval checkpoints currently awaiting a decision. */
  pendingApprovals?: { stepId: string; iteration: number }[];
}

export interface StartRunResult {
  ok: boolean;
  runId?: string;
  error?: string;
}

export interface RunManagerOptions {
  host: WorkflowHost;
  cacheStore: WorkflowCacheStore;
  cwd: string;
  /** Optional: persist each completed run to on-disk history. */
  historyStore?: WorkflowHistoryStore;
  /** Keep finished runs around this long (ms) so a reload can still replay. */
  retainMs?: number;
  /** Maximum concurrent running workflows. Exceeding returns 503-style error. 0 = unlimited. */
  maxConcurrent?: number;
  /** Project config — used to resolve per-run workflow wall-clock limits. */
  config: SteamtrainConfig;
  /**
   * Optional shared live-run registry. When set, web runs are mirrored into
   * `.steamtrain/runs/` (so the TUI/CLI can attach), honor the cross-process
   * run queue (`maxParallelRuns`), and accept cross-process cancel/approval.
   */
  liveRuns?: LiveRunStore;
}

const DEFAULT_RETAIN_MS = 5 * 60_000;

/**
 * Drives workflow runs for the web UI: starts them against the orchestrator,
 * buffers their `WorkflowEvent` stream as SSE frames, fans frames out to live
 * subscribers, persists step results to the on-disk cache (so the web run
 * resumes exactly like the TUI/CLI), and supports cancellation.
 */
export class WorkflowRunManager {
  private readonly runs = new Map<string, Run>();
  private readonly host: WorkflowHost;
  private readonly cacheStore: WorkflowCacheStore;
  private readonly cwd: string;
  private readonly historyStore?: WorkflowHistoryStore;
  private readonly retainMs: number;
  private readonly maxConcurrent: number;
  private readonly config: SteamtrainConfig;
  private readonly liveRuns?: LiveRunStore;
  private runningCount = 0;

  constructor(options: RunManagerOptions) {
    this.host = options.host;
    this.cacheStore = options.cacheStore;
    this.cwd = options.cwd;
    this.historyStore = options.historyStore;
    this.retainMs = options.retainMs ?? DEFAULT_RETAIN_MS;
    this.maxConcurrent = options.maxConcurrent ?? 0;
    this.config = options.config;
    this.liveRuns = options.liveRuns;
  }

  /** Validate and launch a run; the event loop runs detached in the background. */
  start(
    workflow: string,
    input: string,
    opts?: {
      fresh?: boolean;
      seed?: Map<string, StepResult>;
      specOverride?: WorkflowSpec;
      params?: Record<string, string | number | boolean>;
    },
  ): StartRunResult {
    const text = input.trim();
    if (!text) return { ok: false, error: "input is required" };

    if (this.maxConcurrent > 0 && this.runningCount >= this.maxConcurrent) {
      throw new TooManyRuns(this.maxConcurrent);
    }

    const baseSpec = this.host.listWorkflows()[workflow];
    if (!baseSpec) return { ok: false, error: `unknown workflow '${workflow}'` };

    const spec = opts?.specOverride ?? baseSpec;

    const check = this.host.canDispatchWorkflowSpec(spec);
    if (!check.ok) return { ok: false, error: check.reason };

    const run: Run = {
      id: randomUUID(),
      workflow,
      input: text,
      params: opts?.params,
      status: "running",
      queued: Boolean(this.liveRuns),
      startedAt: Date.now(),
      frames: [],
      terminal: false,
      settled: false,
      listeners: new Set(),
      controller: new AbortController(),
      control: createWorkflowRunControl(),
      pendingApprovals: new Map(),
    };
    // The whole-workflow wall-clock timer is armed in drive() once the run
    // leaves the queue, so time spent waiting for a slot doesn't count.
    this.runs.set(run.id, run);
    this.runningCount += 1;
    void this.drive(run, spec, opts?.fresh ?? false, opts?.seed);
    return { ok: true, runId: run.id };
  }

  /**
   * Launch a re-run / retry-failed of a saved record. The plan (workflow,
   * input, seed cache, drift downgrade) is resolved here so the route stays
   * thin; a drift-downgraded retry falls back to a full re-run.
   */
  rerunFromRecord(
    record: RunRecord,
    mode: RerunMode,
  ): StartRunResult & { downgraded?: RerunPlan["downgraded"] } {
    const spec = this.host.listWorkflows()[record.workflow];
    const plan = planRerun(record, mode, spec, { cwd: this.cwd });
    if (isRerunError(plan)) return { ok: false, error: plan.error };
    const started = this.start(plan.workflow, plan.input, {
      fresh: mode === "rerun" || Boolean(plan.downgraded),
      seed: plan.seedCache,
      params: plan.params,
    });
    return started.ok ? { ...started, downgraded: plan.downgraded } : started;
  }

  /**
   * Replay buffered frames to a listener, then keep it subscribed for live
   * frames until the run ends. Returns an unsubscribe fn, or `null` if the run
   * is unknown. If the run already finished, all frames (including the terminal
   * one) are replayed and `null`-equivalent cleanup is returned.
   */
  subscribe(runId: string, listener: RunListener): (() => void) | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    for (const frame of run.frames) listener(frame.payload, frame.terminal);
    if (run.terminal) return () => {};
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.settled) return false;
    run.controller.abort();
    return true;
  }

  /**
   * Request pause/resume for a manager-owned run. When the run is mirrored
   * into the shared live-run store, the desired state is written there FIRST
   * (the file is the cross-surface source of truth — the owner-side watcher
   * applies it and any attached CLI/TUI sees it), then applied directly so the
   * local run reacts without waiting a poll interval. Returns false when the
   * run is unknown or already settled.
   */
  async setRunPaused(runId: string, paused: boolean, by?: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.settled) return false;
    if (this.liveRuns) {
      await this.liveRuns.writePauseState(runId, { paused, by }).catch(() => {});
    }
    if (paused) run.control.pause(by);
    else run.control.resume(by);
    return true;
  }

  /**
   * Stage a mid-run step edit on a manager-owned run (validated synchronously
   * by the engine via the run's control). Returns undefined when the run is
   * unknown or settled — the caller may then try the cross-process path.
   */
  editRunStep(
    runId: string,
    stepId: string,
    patch: StepEditPatch,
    by?: string,
  ): StepEditResult | undefined {
    const run = this.runs.get(runId);
    if (!run || run.settled) return undefined;
    return run.control.editStep(stepId, patch, by);
  }

  /**
   * Build the run's approval provider: each pending checkpoint registers a
   * resolver keyed by `<stepId>:<iteration>` and blocks until a
   * `POST /api/runs/:id/approval` calls {@link resolveApproval} — or the run's
   * abort signal fires, which settles it as canceled so the engine unblocks.
   */
  private buildApprovalProvider(run: Run): ApprovalProvider {
    return (request, signal) =>
      new Promise<ApprovalDecision>((resolve) => {
        const key = `${request.stepId}:${request.iteration}`;
        const settle = (decision: ApprovalDecision): void => {
          if (!run.pendingApprovals.has(key)) return;
          run.pendingApprovals.delete(key);
          signal?.removeEventListener("abort", onAbort);
          resolve(decision);
        };
        const onAbort = (): void =>
          settle({ approved: false, by: "auto:canceled", note: "run canceled before a decision" });
        run.pendingApprovals.set(key, settle);
        if (signal) {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        }
      });
  }

  /**
   * Settle a pending approval checkpoint from an HTTP request. `iteration`
   * targets a specific pass; omitted resolves the single pending checkpoint for
   * `stepId`. That fallback is unambiguous: the engine awaits each checkpoint's
   * decision before the loop advances, so at most one checkpoint per `stepId`
   * is ever pending at once — {@link matchApprovalKey}'s first match is the
   * intended one even when `iteration` is absent. Returns false when the run or
   * checkpoint is unknown.
   */
  resolveApproval(
    runId: string,
    stepId: string,
    decision: ApprovalDecision,
    iteration?: number,
  ): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    const key = matchApprovalKey(run.pendingApprovals.keys(), stepId, iteration);
    if (!key) return false;
    const settle = run.pendingApprovals.get(key);
    if (!settle) return false;
    settle(decision);
    return true;
  }

  get(runId: string): RunSummary | undefined {
    const run = this.runs.get(runId);
    return run ? toSummary(run) : undefined;
  }

  list(): RunSummary[] {
    return [...this.runs.values()].map(toSummary).sort((a, b) => b.startedAt - a.startedAt);
  }

  private emit(run: Run, payload: string, terminal: boolean): void {
    if (run.frames.length < MAX_FRAMES_PER_RUN || terminal) {
      run.frames.push({ payload, terminal });
    }
    for (const listener of run.listeners) listener(payload, terminal);
  }

  private async drive(
    run: Run,
    spec: WorkflowSpec,
    fresh: boolean,
    seed?: Map<string, StepResult>,
  ): Promise<void> {
    const key = workflowCacheKey(run.workflow, run.input, this.cwd, spec, run.params);
    const recorder = new RunRecordBuilder(
      {
        id: run.id,
        workflow: run.workflow,
        input: run.input,
        cwd: this.cwd,
        specHash: hashWorkflowSpec(spec),
        params: run.params,
      },
      run.startedAt,
    );
    let ok: boolean | undefined;
    let budgetExceeded = false;
    let publisher: LiveRunPublisher | undefined;
    let disposeCancelWatch: (() => void) | undefined;
    let disposeControlWatch: (() => void) | undefined;
    try {
      // Mirror the run into the shared live-run registry (cross-UI attach) and
      // wait for a queue slot so parallel runs don't collide over the cache
      // and worktrees. Queue progress is surfaced as non-terminal frames.
      if (this.liveRuns) {
        await this.liveRuns.create(
          newLiveRunMeta({
            id: run.id,
            workflow: run.workflow,
            input: run.input,
            params: run.params,
            cwd: this.cwd,
            source: "web",
          }),
        );
        disposeCancelWatch = watchRunCancel(this.liveRuns, run.id, () => run.controller.abort());
        // Cross-process steering: apply pause/edit/resume requests written into
        // the store by the CLI or another UI to this run's control.
        disposeControlWatch = watchRunControl(this.liveRuns, run.id, run.control);
        let lastPosition = -1;
        const slot = await acquireRunSlot(
          this.liveRuns,
          run.id,
          resolveMaxParallelRuns(this.config),
          {
            signal: run.controller.signal,
            onQueued: (position, running, limit) => {
              if (position === lastPosition) return;
              lastPosition = position;
              this.emit(run, JSON.stringify({ type: "queued", position, running, limit }), false);
            },
          },
        );
        run.queued = false;
        if (!slot.ok) {
          run.status = "canceled";
          return;
        }
        publisher = createLiveRunPublisher(this.liveRuns, run.id);
      }
      run.queued = false;

      // Arm the whole-workflow wall-clock timer now that the run is executing.
      const workflowTimeoutMs = timeoutMsFromSec(resolveWorkflowTimeoutSec(spec, this.config));
      if (workflowTimeoutMs > 0) {
        run.timeoutTimer = setTimeout(() => run.controller.abort(), workflowTimeoutMs);
        run.timeoutTimer.unref?.();
      }

      let cache: Map<string, StepResult>;
      if (fresh) {
        await this.cacheStore.clear(key);
        cache = new Map();
      } else {
        cache = await this.cacheStore.load(key);
      }
      if (seed && seed.size > 0) {
        // Seed already-succeeded steps and make them the resume baseline.
        for (const [stepId, result] of seed) cache.set(stepId, result);
        await this.cacheStore.save(key, cache);
      }
      const approval = this.liveRuns
        ? withStoreApprovals(this.liveRuns, run.id, this.buildApprovalProvider(run))
        : this.buildApprovalProvider(run);
      for await (const event of this.host.runWorkflow(
        run.workflow,
        run.input,
        run.controller.signal,
        cache,
        this.cwd,
        spec,
        run.params,
        approval,
        run.control,
      )) {
        recorder.handle(event);
        publisher?.event(event);
        this.emit(run, JSON.stringify({ type: "event", event }), false);
        if (event.kind === "step_done") {
          await persistWorkflowStepDone(
            this.cacheStore,
            key,
            cache,
            event.stepId,
            event.result,
            event.cached,
          );
        }
        if (event.kind === "step_edited") {
          // The engine dropped the edited step's stale entry from the shared
          // cache map; persist the deletion so a canceled-then-resumed run
          // can't replay the pre-edit result from disk.
          await this.cacheStore.save(key, cache);
        }
        if (event.kind === "workflow_done") {
          ok = event.ok;
          if (event.budgetExceeded) budgetExceeded = true;
        }
      }
      // The engine exits gracefully on abort (it yields a final workflow_done
      // with ok:false and returns — it does not throw), so a real cancel
      // completes the loop without entering the catch. Check the abort signal
      // first, otherwise a canceled run would be mislabeled "error".
      if (run.controller.signal.aborted) {
        run.status = "canceled";
      } else if (budgetExceeded) {
        run.status = "budget-exceeded";
        run.ok = false;
      } else {
        run.status = ok === false ? "error" : "done";
        run.ok = ok ?? true;
      }
    } catch (err) {
      if (run.controller.signal.aborted) {
        run.status = "canceled";
      } else {
        run.status = "error";
        run.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
      run.queued = false;
      run.pendingApprovals.clear();
      disposeCancelWatch?.();
      disposeControlWatch?.();
      this.runningCount = Math.max(0, this.runningCount - 1);
      run.endedAt = Date.now();
      // The outcome is resolved now; lock out cancellation synchronously before
      // any async persistence below, so a cancel arriving mid-persist can't
      // report an already-finished run as cancelable.
      run.settled = true;
      // Settle the live-run mirror (flushes buffered events, then writes the
      // terminal meta) before the terminal SSE frame, so cross-UI tailers see
      // the complete stream. Best-effort — never let it break the run.
      if (this.liveRuns) {
        const status: RunRecordStatus = run.status === "running" ? "done" : run.status;
        try {
          if (publisher) {
            await publisher.finish(status, { ok: run.ok, error: run.error });
          } else {
            await this.liveRuns.update(run.id, {
              status,
              ok: run.ok,
              error: run.error,
              endedAt: run.endedAt,
              pendingApprovals: [],
            });
          }
        } catch {
          // Mirroring is best-effort.
        }
      }
      // Persist before marking terminal: a subscriber that connects during this
      // await must still be registered to receive the terminal status frame.
      await this.persistHistory(run, recorder);
      run.terminal = true;
      this.emit(
        run,
        JSON.stringify({
          type: "status",
          status: run.status,
          ok: run.ok,
          error: run.error,
        }),
        true,
      );
      run.listeners.clear();
      this.scheduleGc(run.id);
    }
  }

  /** Save the completed run to history; never let a write failure break the run. */
  private async persistHistory(run: Run, recorder: RunRecordBuilder): Promise<void> {
    if (!this.historyStore) return;
    const status = run.status === "running" ? "done" : run.status;
    try {
      await this.historyStore.save(
        recorder.build({ status, error: run.error, endedAt: run.endedAt }),
      );
    } catch {
      // History is best-effort; a failed write must not surface to the run.
    }
  }

  private scheduleGc(runId: string): void {
    const timer = setTimeout(() => this.runs.delete(runId), this.retainMs);
    // Don't let a pending GC timer keep the process alive.
    if (typeof timer.unref === "function") timer.unref();
  }
}

function toSummary(run: Run): RunSummary {
  const pendingApprovals = [...run.pendingApprovals.keys()].map((key) => {
    const sep = key.lastIndexOf(":");
    return { stepId: key.slice(0, sep), iteration: Number(key.slice(sep + 1)) || 1 };
  });
  return {
    id: run.id,
    workflow: run.workflow,
    input: run.input,
    status: run.status,
    queued: run.queued || undefined,
    paused: run.control.isPauseRequested() || undefined,
    ok: run.ok,
    error: run.error,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    pendingApprovals: pendingApprovals.length > 0 ? pendingApprovals : undefined,
  };
}
