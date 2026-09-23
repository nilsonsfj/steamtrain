import { randomUUID } from "node:crypto";
import type { SteamtrainConfig } from "../config";
import {
  type ApprovalDecision,
  type ApprovalProvider,
  type DetachedRunnerIo,
  type HumanInputProvider,
  type HumanInputResponse,
  type LiveRunLaunch,
  type LiveRunPendingInput,
  type LiveRunPublisher,
  type LiveRunStore,
  type Notifier,
  type NotifyConfig,
  type PlanRerouteOptions,
  type PlanRerouteResult,
  type PlanRetryRetargetResult,
  type RerunMode,
  type RerunPlan,
  type RetryRetargetOptions,
  type RunRecord,
  RunRecordBuilder,
  type RunRecordStatus,
  type StepEditPatch,
  type StepEditResult,
  type StepKillResult,
  type StepResult,
  type WorkflowCacheStore,
  type WorkflowEvent,
  type WorkflowHistoryStore,
  type WorkflowRunControl,
  type WorkflowSpec,
  acquireRunSlot,
  applyRetryStepFilter,
  applyWorkflowStepOverrides,
  completeHandoff,
  createLiveRunPublisher,
  createNotifier,
  createWorkflowRunControl,
  dropsCacheEntries,
  finalRunWorktrees,
  hashWorkflowSpec,
  isRerunError,
  matchApprovalKey,
  newLiveRunMeta,
  notifyWorkflowEvent,
  persistWorkflowStepDone,
  planRerun,
  planRetryRetarget,
  pruneRunWorktrees,
  resolveMaxParallelRuns,
  resolveWorkflowTimeoutSec,
  timeoutMsFromSec,
  watchRunCancel,
  watchRunControl,
  withStoreApprovals,
  withStoreHumanInputs,
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
  /**
   * Per-step dispatch readiness (steps whose runner is unavailable or whose
   * llm API key is missing) — the launch sheet's launch predictions. Optional:
   * hosts without doctor state report nothing and the sheet predicts nothing.
   */
  stepDispatchIssues?(spec: WorkflowSpec): Array<{ stepId: string; issue: string }>;
  /** Plan a per-run re-route of blocked agent steps onto a ready agent (see Orchestrator). */
  planWorkflowReroute?(spec: WorkflowSpec, options?: PlanRerouteOptions): PlanRerouteResult;
  /** Plan a retry-failed retarget onto a ready agent (see Orchestrator). */
  planWorkflowRetryRetarget?(
    spec: WorkflowSpec,
    record: RunRecord,
    options: RetryRetargetOptions,
  ): PlanRetryRetargetResult;
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
    humanInput?: HumanInputProvider,
    /** Per-run cap on parallel steps ("Max parallel runners"); config default when omitted. */
    maxConcurrency?: number,
  ): AsyncIterable<WorkflowEvent>;
}

/** Optional body for POST /api/history/:id/retry. */
export interface RetryRetargetRequest {
  retargetAgent?: string;
  retargetModel?: string;
  steps?: string[];
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
  /** The whole-workflow timeout fired: the canceled run was stopped by it. */
  timedOut?: boolean;
  /**
   * Live approval checkpoints keyed by `<stepId>:<iteration>`. The engine's
   * injected provider registers a resolver here and blocks; a
   * `POST /api/runs/:id/approval` calls {@link WorkflowRunManager.resolveApproval}
   * to settle it. Cleared as decisions arrive and when the run ends.
   */
  pendingApprovals: Map<string, (decision: ApprovalDecision) => void>;
  /**
   * Live human-input requests keyed by `<stepId>:<iteration>` — the same
   * resolver pattern as approvals, settled by `POST /api/runs/:id/input` via
   * {@link WorkflowRunManager.resolveHumanInput}. A re-ask (rejected answer)
   * re-registers under the same key, superseding the old resolver.
   */
  pendingInputs: Map<string, PendingInputRegistration>;
  /**
   * The exact spec this run is executing (session overrides / reroute applied),
   * so a mid-run detach can carry it to the background process and keep the
   * cache key aligned. Set once the run leaves the queue.
   */
  spec?: WorkflowSpec;
  /**
   * Set when a mid-run detach has been requested: the run is being handed off to
   * a background process under the same id. `launch` is what the detached runner
   * replays the remaining steps from.
   */
  handoff?: { launch: LiveRunLaunch };
  /**
   * Latched before the engine is aborted specifically for handoff — the signal
   * `drive()`'s finally uses to spawn the detached runner instead of recording
   * a terminal outcome.
   */
  handoffCommitted?: boolean;
}

interface PendingInputRegistration {
  summary: LiveRunPendingInput;
  settle: (response: HumanInputResponse) => void;
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
  /** Human-input requests currently awaiting an answer. */
  pendingInputs?: LiveRunPendingInput[];
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
  /** Run-notification channels (`notify` config); omitted ⇒ no notifications. */
  notify?: NotifyConfig;
  /**
   * Base URL for notification deep links to run pages (e.g. `http://localhost:4600`).
   * Callers that bind an ephemeral port (`--port 0`) leave this unset here and
   * call {@link WorkflowRunManager.setPublicBaseUrl} once the real port is known.
   */
  publicBaseUrl?: string;
  /**
   * How to point a detached background runner (mid-run detach) at the same
   * project/config this server runs against. `projectDir` defaults to `cwd`.
   */
  detachIo?: DetachedRunnerIo;
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
  private readonly notifier: Notifier;
  private publicBaseUrl?: string;
  private readonly detachIo?: DetachedRunnerIo;
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
    this.notifier = createNotifier(options.notify ?? options.config.notify);
    this.publicBaseUrl = options.publicBaseUrl;
    this.detachIo = options.detachIo;
  }

  /**
   * Point notification deep links at this server's real address.
   *
   * The manager is constructed before `listen()`, so a caller binding an
   * ephemeral port (`--port 0`) does not know its address yet — deep links
   * would otherwise be built from the *requested* port and read
   * `http://127.0.0.1:0/#run-…`. The value is only read when a run finishes,
   * so assigning it right after the bind is safe.
   */
  setPublicBaseUrl(url: string): void {
    this.publicBaseUrl = url;
  }

  /** The base URL notification deep links are currently built from. */
  getPublicBaseUrl(): string | undefined {
    return this.publicBaseUrl;
  }

  /** Validate and launch a run; the event loop runs detached in the background. */
  start(
    workflow: string,
    input: string,
    opts?: {
      /** Ignore (and clear) the step cache for this run — the launch sheet's "Reuse cache" off. */
      freshCache?: boolean;
      /** Discard the previous run's retained worktrees before starting (launch sheet's "Fresh worktrees"). */
      freshWorktrees?: boolean;
      /** Per-run cap on parallel steps; config default when omitted. */
      maxParallel?: number;
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
      pendingInputs: new Map(),
    };
    // The whole-workflow wall-clock timer is armed in drive() once the run
    // leaves the queue, so time spent waiting for a slot doesn't count.
    this.runs.set(run.id, run);
    // Count against maxConcurrent only while executing. Queued runs (waiting
    // on the shared live-run slot) must not shrink the effective limit.
    if (!run.queued) {
      this.runningCount += 1;
    }
    void this.drive(run, spec, {
      freshCache: opts?.freshCache ?? false,
      freshWorktrees: opts?.freshWorktrees ?? false,
      maxParallel: opts?.maxParallel,
      seed: opts?.seed,
    });
    return { ok: true, runId: run.id };
  }

  /**
   * Step ids with a cached result for this exact launch shape (workflow,
   * input, spec, params) — the launch sheet's "N steps would be reused, not
   * re-run" prediction. Independent of the reuse toggle: it reports the raw
   * cache contents; the sheet decides what the run will do with them.
   */
  async cachedStepIds(
    workflow: string,
    input: string,
    spec: WorkflowSpec,
    params?: Record<string, string | number | boolean>,
  ): Promise<string[]> {
    const key = workflowCacheKey(workflow, input.trim(), this.cwd, spec, params);
    const cache = await this.cacheStore.load(key);
    return [...cache.keys()];
  }

  /**
   * The newest run of `workflow` that still retains unpruned step worktrees,
   * with the record — shared search for {@link lastKeptWorktrees} (the hint)
   * and {@link pruneLastKeptWorktrees} (the prune), so the prune path doesn't
   * re-fetch the record the search just loaded. `null` when nothing is
   * retained (or history is off).
   */
  private async findKeptWorktreeRecord(
    workflow: string,
  ): Promise<{ record: RunRecord; count: number } | null> {
    if (!this.historyStore) return null;
    // list() is newest-first: the first unpruned run with trees is the target.
    const summaries = await this.historyStore.list();
    for (const summary of summaries) {
      if (summary.workflow !== workflow || summary.harvest?.prunedAt) continue;
      const record = await this.historyStore.get(summary.id);
      if (!record) continue;
      const count = finalRunWorktrees(record).length;
      if (count > 0) return { record, count };
    }
    return null;
  }

  /**
   * The newest run of `workflow` that still retains unpruned step worktrees,
   * and how many — the "discard the N trees from run XXXXX" hint under the
   * launch sheet's Fresh-worktrees toggle.
   */
  async lastKeptWorktrees(workflow: string): Promise<{ runId: string; count: number } | null> {
    const found = await this.findKeptWorktreeRecord(workflow);
    return found ? { runId: found.record.id, count: found.count } : null;
  }

  /**
   * Discard the previous run's retained worktrees (the Fresh-worktrees
   * toggle). Best effort: a prune failure (trees already gone, record
   * unreadable) must never block the run that asked for it.
   */
  private async pruneLastKeptWorktrees(workflow: string): Promise<void> {
    if (!this.historyStore) return;
    try {
      const found = await this.findKeptWorktreeRecord(workflow);
      if (!found) return;
      await pruneRunWorktrees(this.historyStore, found.record);
    } catch {
      // deliberate: launch goes ahead even if the trees could not be discarded
    }
  }

  /**
   * Launch a re-run / retry-failed of a saved record. The plan (workflow,
   * input, seed cache, drift downgrade) is resolved here so the route stays
   * thin; a drift-downgraded retry falls back to a full re-run unless a
   * retarget/step filter is requested (those refuse on downgrade).
   */
  rerunFromRecord(
    record: RunRecord,
    mode: RerunMode,
    retarget?: RetryRetargetRequest,
  ): StartRunResult & { downgraded?: RerunPlan["downgraded"] } {
    const baseSpec = this.host.listWorkflows()[record.workflow];
    const plan = planRerun(record, mode, baseSpec, { cwd: this.cwd });
    if (isRerunError(plan)) return { ok: false, error: plan.error };

    const wantsRetarget = Boolean(retarget?.retargetAgent || retarget?.retargetModel);
    const stepIds = retarget?.steps?.filter((s) => typeof s === "string" && s.length > 0);
    const wantsStepFilter = Boolean(stepIds && stepIds.length > 0);
    if ((wantsRetarget || wantsStepFilter) && mode !== "retry-failed") {
      return { ok: false, error: "retarget/step filter only applies to retry-failed" };
    }
    if (retarget?.retargetModel && !retarget.retargetAgent) {
      return { ok: false, error: "retargetModel requires retargetAgent" };
    }
    if (plan.downgraded && (wantsRetarget || wantsStepFilter)) {
      return {
        ok: false,
        error: `cannot retarget/narrow retry: ${plan.downgraded} — use a normal run with Configure instead`,
      };
    }

    let seed = plan.seedCache;
    let specOverride: WorkflowSpec | undefined;
    if (!plan.downgraded && mode === "retry-failed" && baseSpec) {
      if (wantsStepFilter) {
        try {
          seed = applyRetryStepFilter(record, seed, stepIds, baseSpec);
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      if (retarget?.retargetAgent) {
        const planFn =
          this.host.planWorkflowRetryRetarget ??
          ((spec, rec, options) => planRetryRetarget(spec, rec, this.config, () => true, options));
        const planned = planFn(baseSpec, record, {
          agent: retarget.retargetAgent,
          model: retarget.retargetModel,
          stepIds: wantsStepFilter ? stepIds : undefined,
        });
        if (!planned.ok) return { ok: false, error: planned.error };
        specOverride = applyWorkflowStepOverrides(baseSpec, planned.overrides);
      }
    }

    const started = this.start(plan.workflow, plan.input, {
      freshCache: mode === "rerun" || Boolean(plan.downgraded),
      seed,
      params: plan.params,
      specOverride,
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
   * Detach a manager-owned run into a fresh background process under the same
   * id, so the browser (or the whole web server) can close without stopping the
   * workflow — the mid-run analog of launching with `--detach`. Ownership is
   * committed synchronously and the local engine is aborted immediately;
   * completed steps stay cached and an interrupted step is replayed by the
   * detached owner. `drive()`'s finally spawns the detached runner. Subscribers
   * learn of the switch through a `detached` SSE frame and reconnect to the
   * now-external run.
   *
   * Returns `{ ok:false, error }` when the run can't be handed off (unknown,
   * finished, still queued, or no shared registry); a re-issued detach on an
   * already-detaching run is a no-op success.
   */
  detach(runId: string): { ok: boolean; error?: string } {
    if (!this.liveRuns) {
      return { ok: false, error: "detach needs the shared live-run registry" };
    }
    const run = this.runs.get(runId);
    if (!run || run.settled) return { ok: false, error: "no active run to detach" };
    if (run.queued) {
      return { ok: false, error: "the run is still queued — cancel it or wait for it to start" };
    }
    if (run.handoff) return { ok: true };
    run.handoff = {
      launch: {
        workflow: run.workflow,
        input: run.input,
        params: run.params,
        fresh: false,
      },
    };
    this.emit(run, JSON.stringify({ type: "detaching" }), false);
    // Commit before aborting so a final event or abort-time exception cannot
    // race the run into its normal terminal path.
    run.handoffCommitted = true;
    run.controller.abort();
    return { ok: true };
  }

  /**
   * Spawn the detached runner for a committed, handed-off run and tell
   * subscribers to reconnect to it. Returns true when the run is now an
   * independent background process (the manager drops it); false when the spawn
   * failed and the caller should record a normal terminal outcome.
   */
  private async finishHandoff(run: Run, publisher?: LiveRunPublisher): Promise<boolean> {
    if (!this.liveRuns || !run.handoff) return false;
    const spawned = await completeHandoff({
      publisher,
      store: this.liveRuns,
      runId: run.id,
      cwd: this.cwd,
      projectDir: this.detachIo?.projectDir ?? this.cwd,
      configPath: this.detachIo?.configPath,
      workspacePath: this.detachIo?.workspacePath,
      // Carry the exact running spec so the background process continues with
      // the same overrides and reuses the cached completed steps.
      launch: { ...run.handoff.launch, spec: run.spec },
    }).catch((err) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }));
    if (!spawned.ok) {
      run.status = "error";
      run.error = `detach failed: ${spawned.error}`;
      return false;
    }
    // The run is now owned by an independent process. A terminal `detached`
    // frame tells subscribers to reconnect (the stream route tails the external
    // run once it's gone from the manager).
    run.terminal = true;
    this.emit(run, JSON.stringify({ type: "detached", runId: run.id, pid: spawned.pid }), true);
    run.listeners.clear();
    this.runs.delete(run.id);
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
   * Kill one in-flight step of a manager-owned run; the run keeps going.
   * Returns undefined when the run is unknown or settled, the same "not mine"
   * signal {@link editRunStep} gives.
   */
  killRunStep(runId: string, stepId: string, by?: string): StepKillResult | undefined {
    const run = this.runs.get(runId);
    if (!run || run.settled) return undefined;
    return run.control.killStep(stepId, by);
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

  /**
   * Build the run's human-input provider: each pending request registers a
   * resolver keyed by `<stepId>:<iteration>` and blocks until a
   * `POST /api/runs/:id/input` calls {@link resolveHumanInput} — or the run's
   * abort signal fires. A re-ask after a rejected answer re-registers under
   * the same key (the old resolver was already consumed by the first answer).
   */
  private buildHumanInputProvider(run: Run): HumanInputProvider {
    return (request, signal) =>
      new Promise<HumanInputResponse>((resolve) => {
        const key = `${request.stepId}:${request.iteration}`;
        const settle = (response: HumanInputResponse): void => {
          if (run.pendingInputs.get(key)?.settle !== settle) return;
          run.pendingInputs.delete(key);
          signal?.removeEventListener("abort", onAbort);
          resolve(response);
        };
        const onAbort = (): void =>
          settle({ canceled: true, by: "auto:canceled", reason: "run canceled before an answer" });
        run.pendingInputs.set(key, {
          summary: {
            stepId: request.stepId,
            iteration: request.iteration,
            attempt: request.attempt,
            origin: request.origin,
            prompt:
              request.prompt.length > 200 ? `${request.prompt.slice(0, 200)}…` : request.prompt,
            choices: request.choices,
          },
          settle,
        });
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
   * Settle a pending human-input request from an HTTP request. `iteration`
   * targets a specific pass; omitted resolves the single pending request for
   * `stepId` (at most one per step is ever pending, as with approvals).
   * Returns false when the run or request is unknown.
   */
  resolveHumanInput(
    runId: string,
    stepId: string,
    response: HumanInputResponse,
    iteration?: number,
  ): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    const key = matchApprovalKey(run.pendingInputs.keys(), stepId, iteration);
    if (!key) return false;
    const pending = run.pendingInputs.get(key);
    if (!pending) return false;
    pending.settle(response);
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
    opts: {
      freshCache: boolean;
      freshWorktrees: boolean;
      maxParallel?: number;
      seed?: Map<string, StepResult>;
    },
  ): Promise<void> {
    // Remember the exact spec (session overrides applied) so a mid-run detach
    // carries it to the background process and the cache key stays aligned.
    run.spec = spec;
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
    // Three states, distinguished in the finally: `undefined` means no
    // workflow_done was consumed — the engine was aborted mid-flight to hand
    // the run off (its terminal event is skipped once handoffCommitted); a
    // boolean means the run reached workflow_done (true done, false error/
    // budget). The handoff path keys off `ok === undefined`.
    let ok: boolean | undefined;
    let budgetExceeded = false;
    let publisher: LiveRunPublisher | undefined;
    let disposeCancelWatch: (() => void) | undefined;
    let disposeControlWatch: (() => void) | undefined;
    // True once this run holds a runningCount slot (executing, not merely queued).
    // Without liveRuns, start() already counted us (queued starts false) so this
    // begins true; with liveRuns we count only after acquireRunSlot succeeds.
    let holdsRunningSlot = !run.queued;
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
        // Now executing — count against maxConcurrent.
        this.runningCount += 1;
        holdsRunningSlot = true;
        publisher = createLiveRunPublisher(this.liveRuns, run.id);
      }
      run.queued = false;

      // Arm the whole-workflow wall-clock timer now that the run is executing.
      const workflowTimeoutMs = timeoutMsFromSec(resolveWorkflowTimeoutSec(spec, this.config));
      if (workflowTimeoutMs > 0) {
        run.timeoutTimer = setTimeout(() => {
          run.timedOut = true;
          run.controller.abort();
        }, workflowTimeoutMs);
        run.timeoutTimer.unref?.();
      }

      // "Fresh worktrees": discard the previous run's retained step worktrees
      // now that this run is committed to executing (past the queue, un-aborted).
      // Best effort — a prune failure never blocks the run.
      if (opts.freshWorktrees && !run.controller.signal.aborted) {
        await this.pruneLastKeptWorktrees(run.workflow);
      }

      let cache: Map<string, StepResult>;
      if (opts.freshCache) {
        await this.cacheStore.clear(key);
        cache = new Map();
      } else {
        cache = await this.cacheStore.load(key);
      }
      if (opts.seed && opts.seed.size > 0) {
        // Seed already-succeeded steps and make them the resume baseline.
        for (const [stepId, result] of opts.seed) cache.set(stepId, result);
        await this.cacheStore.save(key, cache);
      }
      const approval = this.liveRuns
        ? withStoreApprovals(this.liveRuns, run.id, this.buildApprovalProvider(run))
        : this.buildApprovalProvider(run);
      const humanInput = this.liveRuns
        ? withStoreHumanInputs(this.liveRuns, run.id, this.buildHumanInputProvider(run))
        : this.buildHumanInputProvider(run);
      const notifyMeta = {
        workflow: run.workflow,
        runId: run.id,
        url: this.publicBaseUrl ? `${this.publicBaseUrl}/#run-${run.id}` : undefined,
      };
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
        humanInput,
        opts.maxParallel,
      )) {
        // Mid-run detach committed: stop recording, mirroring, and emitting
        // events — the detached child owns the run's record and stream from
        // here. Draining the iterator lets the aborted engine unwind cleanly.
        if (run.handoffCommitted) continue;
        recorder.handle(event);
        publisher?.event(event);
        notifyWorkflowEvent(this.notifier, notifyMeta, event);
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
        if (dropsCacheEntries(event)) await this.cacheStore.save(key, cache);
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
      run.pendingInputs.clear();
      disposeCancelWatch?.();
      disposeControlWatch?.();
      if (holdsRunningSlot) {
        this.runningCount = Math.max(0, this.runningCount - 1);
      }
      run.endedAt = Date.now();
      // The outcome is resolved now; lock out cancellation synchronously before
      // any async persistence below, so a cancel arriving mid-persist can't
      // report an already-finished run as cancelable.
      run.settled = true;

      // Mid-run detach: hand the committed run off to a background process under
      // the same id instead of ending it. Events after the commit were skipped,
      // so `ok` remains undefined even when abort makes the engine emit a final
      // workflow_done. On success the manager drops the run and subscribers
      // reconnect; on failure fall through to a normal (error) terminal.
      const handedOff =
        Boolean(run.handoff && run.handoffCommitted && ok === undefined) &&
        (await this.finishHandoff(run, publisher));
      // Settle the live-run mirror (flushes buffered events, then writes the
      // terminal meta) before the terminal SSE frame, so cross-UI tailers see
      // the complete stream. Best-effort — never let it break the run.
      if (!handedOff && this.liveRuns) {
        const status: RunRecordStatus = run.status === "running" ? "done" : run.status;
        try {
          if (publisher) {
            await publisher.finish(status, {
              ok: run.ok,
              error: run.error,
              timedOut: run.timedOut,
            });
          } else {
            await this.liveRuns.update(run.id, {
              status,
              ok: run.ok,
              error: run.error,
              timedOut: run.timedOut || undefined,
              endedAt: run.endedAt,
              pendingApprovals: [],
              pendingInputs: [],
            });
          }
        } catch {
          // Mirroring is best-effort.
        }
      }
      // A handed-off run is now owned by the detached child (finishHandoff
      // already told subscribers to reconnect and dropped it from the manager),
      // so skip the terminal history + status frame for it.
      if (!handedOff) {
        // Persist before marking terminal: a subscriber that connects during
        // this await must still be registered to receive the terminal status
        // frame.
        await this.persistHistory(run, recorder);
        run.terminal = true;
        this.emit(
          run,
          JSON.stringify({
            type: "status",
            status: run.status,
            ok: run.ok,
            error: run.error,
            timedOut: run.timedOut,
          }),
          true,
        );
        run.listeners.clear();
        this.scheduleGc(run.id);
      }
    }
  }

  /** Save the completed run to history; never let a write failure break the run. */
  private async persistHistory(run: Run, recorder: RunRecordBuilder): Promise<void> {
    if (!this.historyStore) return;
    const status = run.status === "running" ? "done" : run.status;
    try {
      await this.historyStore.save(
        recorder.build({ status, error: run.error, endedAt: run.endedAt, timedOut: run.timedOut }),
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
  const splitKey = (key: string): { stepId: string; iteration: number } => {
    const sep = key.lastIndexOf(":");
    return { stepId: key.slice(0, sep), iteration: Number(key.slice(sep + 1)) || 1 };
  };
  const pendingApprovals = [...run.pendingApprovals.keys()].map(splitKey);
  const pendingInputs = [...run.pendingInputs.values()].map(({ summary }) => ({ ...summary }));
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
    pendingInputs: pendingInputs.length > 0 ? pendingInputs : undefined,
  };
}
