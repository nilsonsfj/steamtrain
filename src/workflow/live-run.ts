import type { SteamtrainConfig } from "../config";
import type { ApprovalDecision, ApprovalProvider } from "./approval";
import type { WorkflowRunControl } from "./control";
import type { WorkflowEvent } from "./events";
import type { RunRecordStatus } from "./history";
import type { HumanInputProvider, HumanInputResponse } from "./human-input";
import {
  DEFAULT_MAX_PARALLEL_RUNS,
  LIVE_RUN_META_VERSION,
  type LiveRunMeta,
  type LiveRunPendingInput,
  type LiveRunStore,
  MAX_STREAM_EVENTS_PER_RUN,
  isLiveRunOwnerAlive,
  isTerminalLiveRunStatus,
  liveRunSleep as sleep,
} from "./live-run-store";

/**
 * Runtime companions to the {@link LiveRunStore}: the event publisher every
 * driver mirrors its run into, the cross-process run queue, the cancel-marker
 * watcher, and approval providers that let *any* attached UI decide a pending
 * human checkpoint.
 */

/** The configured cap on concurrently executing runs (queue slots). */
export function resolveMaxParallelRuns(config?: SteamtrainConfig): number {
  const value = config?.maxParallelRuns;
  return typeof value === "number" && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_MAX_PARALLEL_RUNS;
}

export interface LiveRunPublisher {
  /** Mirror one workflow event into the run's events.ndjson (buffered). */
  event(event: WorkflowEvent): void;
  /**
   * Flush buffered events to disk and wait for the write chain to drain, WITHOUT
   * writing a terminal meta. Used when handing a run off to a detached process:
   * every event recorded so far must land before the new owner starts appending,
   * but the run is not finished.
   */
  flush(): Promise<void>;
  /** Flush buffered events, then write the terminal meta. */
  finish(
    status: RunRecordStatus,
    opts?: { ok?: boolean; error?: string; timedOut?: boolean },
  ): Promise<void>;
}

const PUBLISH_FLUSH_MS = 25;

/**
 * Buffered, best-effort mirror of a run's event stream into the live-run
 * store. Writes are batched (~{@link PUBLISH_FLUSH_MS}) and serialized on one
 * promise chain so append order matches event order. Store write failures are
 * reported on stderr (they used to vanish into an empty catch) but still do
 * not break the run itself — except `finish`, which rethrows if the terminal
 * meta cannot be written. `finish` flushes everything *before* marking the
 * meta terminal, so tailers that see a terminal meta have the full stream.
 */
export function createLiveRunPublisher(store: LiveRunStore, runId: string): LiveRunPublisher {
  let pending: string[] = [];
  let streamEventCount = 0;
  let streamCapNoted = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  const pendingApprovals: { stepId: string; iteration: number }[] = [];
  const pendingInputs: LiveRunPendingInput[] = [];
  let lastHeartbeatAt = 0;
  let finished = false;

  const reportWriteError = (action: string, err: unknown): void => {
    process.stderr.write(
      `[steamtrain] live-run ${runId} ${action} failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  };

  const enqueue = (task: () => Promise<void>): void => {
    chain = chain.then(task).catch((err) => {
      reportWriteError("write", err);
    });
  };

  const touchHeartbeat = async (force = false): Promise<void> => {
    if (finished) return;
    const now = Date.now();
    // Refresh at most every 10s so a chatty stream does not rewrite meta.json
    // on every flush — still well inside LIVE_RUN_HEARTBEAT_STALE_MS.
    if (!force && now - lastHeartbeatAt < 10_000) return;
    lastHeartbeatAt = now;
    await store.update(runId, { heartbeatAt: now });
  };

  // Keep the owner heartbeat fresh while parked on approvals / idle waits —
  // otherwise a silent-but-alive run is swept as orphaned after the stale window.
  const heartbeatTimer = setInterval(() => {
    enqueue(() => touchHeartbeat(true));
  }, 15_000);
  heartbeatTimer.unref?.();

  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (pending.length === 0) return;
    const lines = pending.join("");
    pending = [];
    enqueue(async () => {
      await store.appendEventLines(runId, lines);
      await touchHeartbeat();
    });
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    // Deliberately NOT unref'd: buffered events must land on disk even if the
    // owning process would otherwise be idle (e.g. the engine just parked on
    // an approval and this flush is the only pending work).
    flushTimer = setTimeout(flush, PUBLISH_FLUSH_MS);
  };

  const syncPendingApprovals = (): void => {
    const snapshot = pendingApprovals.map((p) => ({ ...p }));
    enqueue(async () => {
      await store.update(runId, { pendingApprovals: snapshot });
    });
  };

  const syncPendingInputs = (): void => {
    const snapshot = pendingInputs.map((p) => ({ ...p }));
    enqueue(async () => {
      await store.update(runId, { pendingInputs: snapshot });
    });
  };

  return {
    event(event) {
      if (event.kind === "step_event") {
        streamEventCount += 1;
        if (streamEventCount > MAX_STREAM_EVENTS_PER_RUN) {
          if (!streamCapNoted) {
            streamCapNoted = true;
            pending.push(
              `${JSON.stringify({
                kind: "step_event",
                phaseId: event.phaseId,
                stepId: event.stepId,
                iteration: event.iteration,
                event: {
                  kind: "text_delta",
                  text: "\n… [live stream truncated: event cap reached; final outputs still recorded]\n",
                },
                ts: event.ts,
              })}\n`,
            );
            scheduleFlush();
          }
          return;
        }
      }
      if (event.kind === "approval_pending") {
        pendingApprovals.push({ stepId: event.stepId, iteration: event.iteration ?? 1 });
        syncPendingApprovals();
      }
      if (event.kind === "approval_resolved") {
        const iteration = event.iteration ?? 1;
        const idx = pendingApprovals.findIndex(
          (p) => p.stepId === event.stepId && p.iteration === iteration,
        );
        if (idx >= 0) {
          pendingApprovals.splice(idx, 1);
          syncPendingApprovals();
        }
      }
      if (event.kind === "human_input_pending") {
        const iteration = event.iteration ?? 1;
        // A re-ask (attempt > 1) supersedes the same step's previous entry.
        const idx = pendingInputs.findIndex(
          (p) => p.stepId === event.stepId && p.iteration === iteration,
        );
        const entry: LiveRunPendingInput = {
          stepId: event.stepId,
          iteration,
          attempt: event.attempt,
          origin: event.origin,
          prompt: event.prompt.length > 200 ? `${event.prompt.slice(0, 200)}…` : event.prompt,
          choices: event.choices,
        };
        if (idx >= 0) pendingInputs[idx] = entry;
        else pendingInputs.push(entry);
        syncPendingInputs();
      }
      if (event.kind === "human_input_resolved") {
        const iteration = event.iteration ?? 1;
        const idx = pendingInputs.findIndex(
          (p) => p.stepId === event.stepId && p.iteration === iteration,
        );
        if (idx >= 0) {
          pendingInputs.splice(idx, 1);
          syncPendingInputs();
        }
      }
      // Mirror the engine-acknowledged pause state into the meta so run
      // listings (CLI `workflow runs`, the web Active-runs panel) can badge a
      // paused run without tailing its event stream.
      if (event.kind === "run_paused" || event.kind === "run_resumed") {
        const paused = event.kind === "run_paused";
        enqueue(async () => {
          await store.update(runId, { paused });
        });
      }
      pending.push(`${JSON.stringify(event)}\n`);
      scheduleFlush();
    },
    async flush() {
      flush();
      // `chain` serializes every enqueued write — event-line appends AND the
      // meta updates from syncPendingApprovals/syncPendingInputs/pause — so
      // awaiting it drains the whole mirror to disk, not just buffered events.
      await chain;
    },
    async finish(status, opts = {}) {
      finished = true;
      clearInterval(heartbeatTimer);
      flush();
      let finishError: unknown;
      enqueue(async () => {
        try {
          await store.update(runId, {
            status,
            ok: opts.ok,
            error: opts.error,
            timedOut: opts.timedOut || undefined,
            endedAt: Date.now(),
            heartbeatAt: Date.now(),
            pendingApprovals: [],
            pendingInputs: [],
            paused: false,
          });
        } catch (err) {
          finishError = err;
          reportWriteError("finish", err);
          throw err;
        }
      });
      await chain;
      if (finishError) throw finishError;
    },
  };
}

export interface AcquireRunSlotOptions {
  signal?: AbortSignal;
  pollMs?: number;
  /** Progress callback while waiting (1-based queue position). */
  onQueued?: (position: number, running: number, limit: number) => void;
}

export type AcquireRunSlotResult = { ok: true } | { ok: false; reason: "canceled" };

/**
 * Wait for a free execution slot in the cross-process run queue. The caller
 * must have registered the run (status `"queued"`) in the store first.
 *
 * Fairness/coordination is cooperative and file-based: every waiter sorts the
 * queued entries by arrival (`createdAt`, id tiebreak) and promotes itself to
 * `"running"` only when its position fits into the free slots. Promotion runs
 * under the project state lock so two waiters cannot both claim the same slot.
 *
 * Resolves `canceled` when the run's cancel marker appears or `signal` aborts
 * while still queued.
 */
export async function acquireRunSlot(
  store: LiveRunStore,
  runId: string,
  limit: number,
  options: AcquireRunSlotOptions = {},
): Promise<AcquireRunSlotResult> {
  const pollMs = options.pollMs ?? 250;
  // Sweeping on every poll would rescan (and possibly rewrite) the whole
  // registry ~4×/s per waiter; sweep only occasionally — the alive-filter
  // inside tryPromote already keeps dead entries from blocking the queue.
  const SWEEP_EVERY = 20;
  let polls = 0;
  for (;;) {
    if (options.signal?.aborted || (await store.cancelRequested(runId))) {
      return { ok: false, reason: "canceled" };
    }
    if (polls % SWEEP_EVERY === 0) {
      await store.list({ sweep: true });
    }
    polls += 1;
    const result = await store.tryPromote(runId, limit);
    if (result === "promoted") return { ok: true };
    if (result === "missing") return { ok: false, reason: "canceled" };
    // Cheap position estimate for the progress callback (best-effort; the
    // authoritative decision happened under the lock above).
    const runs = await store.list({ sweep: false });
    const alive = runs.filter(
      (run) => !isTerminalLiveRunStatus(run.status) && isLiveRunOwnerAlive(run),
    );
    const running = alive.filter((run) => run.status === "running").length;
    const queued = alive
      .filter((run) => run.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const position = queued.findIndex((run) => run.id === runId);
    options.onQueued?.(Math.max(1, position + 1), running, limit);
    await sleep(pollMs, options.signal);
  }
}

/**
 * Poll the run's cancel marker and invoke `onCancel` (once) when it appears,
 * so `steamtrain workflow cancel <id>` — or the web UI's cancel button on an
 * externally-owned run — reaches the owning process without signals (which
 * would be wrong for the multi-run TUI/web processes and flaky on Windows).
 * Returns a dispose function.
 */
export function watchRunCancel(
  store: LiveRunStore,
  runId: string,
  onCancel: () => void,
  pollMs = 500,
): () => void {
  let disposed = false;
  let fired = false;
  const timer = setInterval(() => {
    void store
      .cancelRequested(runId)
      .then((requested) => {
        if (requested && !fired && !disposed) {
          fired = true;
          clearInterval(timer);
          onCancel();
        }
      })
      .catch(() => {});
  }, pollMs);
  timer.unref?.();
  return () => {
    disposed = true;
    clearInterval(timer);
  };
}

/**
 * Poll the run's control files (`control/pause.json`, `control/edits/*`) and
 * steer the run's {@link WorkflowRunControl} to match — the owner-side half of
 * cross-process pause/edit/resume. Every surface (TUI keypress, web endpoint,
 * `steamtrain workflow pause|resume|edit-step`) writes the same files, so the
 * file is the single source of truth and surfaces can never fight each other.
 * Edit requests are validated by the engine via the control; the outcome is
 * written back so the requesting surface can report accept/reject.
 * Returns a dispose function.
 */
export function watchRunControl(
  store: LiveRunStore,
  runId: string,
  control: WorkflowRunControl,
  pollMs = 400,
): () => void {
  let disposed = false;
  let busy = false;
  const processedEdits = new Set<string>();
  const poll = async (): Promise<void> => {
    const pauseState = await store.readPauseState(runId).catch(() => undefined);
    if (disposed) return;
    if (pauseState && pauseState.paused !== control.isPauseRequested()) {
      if (pauseState.paused) control.pause(pauseState.by);
      else control.resume(pauseState.by);
    }
    // A paused engine only awaits a promise, and every other timer of a run
    // is unref'd — so a CLI or detached runner would drain its event loop and
    // exit mid-pause, leaving the run to the orphan sweep. This poll is what
    // can resume it, so it holds the process open while the run is paused.
    if (control.isPauseRequested()) timer.ref?.();
    else timer.unref?.();
    const edits = await store.listStepEditRequests(runId).catch(() => []);
    for (const edit of edits) {
      if (disposed) return;
      if (processedEdits.has(edit.editId)) continue;
      processedEdits.add(edit.editId);
      // Defensive: a throwing edit (engine hook bug) must fail THIS request
      // with a readable verdict, not kill the poll loop for later requests.
      let result: ReturnType<WorkflowRunControl["editStep"]>;
      try {
        result = control.editStep(edit.stepId, edit.patch, edit.by);
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      await store.writeStepEditResult(runId, edit.editId, result).catch(() => {});
    }
  };
  const timer = setInterval(() => {
    if (busy || disposed) return;
    busy = true;
    void poll()
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, pollMs);
  timer.unref?.();
  return () => {
    disposed = true;
    clearInterval(timer);
  };
}

const APPROVAL_POLL_MS = 500;

/**
 * An approval provider that waits for a decision file in the live-run store —
 * how a *detached* run's human checkpoint gets decided: any attached UI (CLI
 * `workflow approve`, TUI, web) writes the decision; the runner picks it up.
 * Aborting the signal settles as a canceled rejection.
 */
export function storeApprovalProvider(store: LiveRunStore, runId: string): ApprovalProvider {
  return async (request, signal) => {
    const iteration = request.iteration ?? 1;
    for (;;) {
      if (signal?.aborted) {
        return { approved: false, by: "auto:canceled", note: "run canceled before a decision" };
      }
      const decision = await store
        .readApprovalDecision(runId, request.stepId, iteration)
        .catch(() => undefined);
      if (decision) return { ...decision, by: decision.by ?? "human" };
      await sleep(APPROVAL_POLL_MS, signal);
    }
  };
}

/**
 * Wrap a driver's own (interactive) approval provider so a decision written
 * into the live-run store by *another* attached UI also settles the
 * checkpoint — first decision wins. This is what makes an approval on, say,
 * the web view of a TUI-owned run actually unblock the run.
 */
export function withStoreApprovals(
  store: LiveRunStore,
  runId: string,
  inner: ApprovalProvider,
): ApprovalProvider {
  return (request, signal) =>
    new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const settle = (decision: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(decision);
      };
      const onAbort = (): void =>
        settle({ approved: false, by: "auto:canceled", note: "run canceled before a decision" });
      const timer = setInterval(() => {
        void store
          .readApprovalDecision(runId, request.stepId, request.iteration ?? 1)
          .then((decision) => {
            if (decision) settle({ ...decision, by: decision.by ?? "human" });
          })
          .catch(() => {});
      }, APPROVAL_POLL_MS);
      timer.unref?.();
      // A rejecting local provider must not strand the checkpoint (or raise an
      // unhandled rejection): keep polling the store, and settle as canceled
      // if the run aborts first.
      void Promise.resolve(inner(request, signal)).then(settle, () => {});
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
 * A human-input provider that waits for an answer file in the live-run store —
 * how a *detached* run's human step (or agent question) gets answered: any
 * attached UI (`steamtrain workflow answer`, TUI, web) writes the response;
 * the runner picks it up. Answers are attempt-scoped, so a re-ask after a
 * rejected answer waits for a fresh file instead of re-reading the bad one.
 */
export function storeHumanInputProvider(store: LiveRunStore, runId: string): HumanInputProvider {
  return async (request, signal) => {
    for (;;) {
      if (signal?.aborted) {
        return { canceled: true, by: "auto:canceled", reason: "run canceled before an answer" };
      }
      const response = await store
        .readHumanInputResponse(runId, request.stepId, request.iteration, request.attempt)
        .catch(() => undefined);
      if (response) {
        return response.canceled ? response : { ...response, by: response.by ?? "human" };
      }
      await sleep(APPROVAL_POLL_MS, signal);
    }
  };
}

/**
 * Wrap a driver's own (interactive) human-input provider so an answer written
 * into the live-run store by *another* attached UI also settles the request —
 * first answer wins. The input-side analog of {@link withStoreApprovals}.
 */
export function withStoreHumanInputs(
  store: LiveRunStore,
  runId: string,
  inner: HumanInputProvider,
): HumanInputProvider {
  return (request, signal) =>
    new Promise<HumanInputResponse>((resolve) => {
      let settled = false;
      const settle = (response: HumanInputResponse): void => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(response);
      };
      const onAbort = (): void =>
        settle({ canceled: true, by: "auto:canceled", reason: "run canceled before an answer" });
      const timer = setInterval(() => {
        void store
          .readHumanInputResponse(runId, request.stepId, request.iteration, request.attempt)
          .then((response) => {
            if (!response) return;
            settle(response.canceled ? response : { ...response, by: response.by ?? "human" });
          })
          .catch(() => {});
      }, APPROVAL_POLL_MS);
      timer.unref?.();
      // A rejecting local provider must not strand the request: keep polling
      // the store, and settle as canceled if the run aborts first.
      void Promise.resolve(inner(request, signal)).then(settle, () => {});
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
}

/** Meta skeleton shared by every driver registering a run. */
export function newLiveRunMeta(fields: {
  id: string;
  workflow: string;
  input: string;
  params?: Record<string, string | number | boolean>;
  cwd: string;
  source: LiveRunMeta["source"];
  detached?: boolean;
  pid?: number;
  launch?: LiveRunMeta["launch"];
}): LiveRunMeta {
  const createdAt = Date.now();
  return {
    version: LIVE_RUN_META_VERSION,
    id: fields.id,
    workflow: fields.workflow,
    input: fields.input,
    params: fields.params,
    cwd: fields.cwd,
    pid: fields.pid ?? process.pid,
    ownerToken: randomOwnerToken(),
    heartbeatAt: createdAt,
    source: fields.source,
    detached: fields.detached ?? false,
    status: "queued",
    createdAt,
    launch: fields.launch,
  };
}

function randomOwnerToken(): string {
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
