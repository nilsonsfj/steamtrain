import type { SteamtrainConfig } from "../config";
import type { ApprovalDecision, ApprovalProvider } from "./approval";
import type { WorkflowEvent } from "./events";
import type { RunRecordStatus } from "./history";
import {
  DEFAULT_MAX_PARALLEL_RUNS,
  LIVE_RUN_META_VERSION,
  type LiveRunMeta,
  type LiveRunStore,
  MAX_STREAM_EVENTS_PER_RUN,
  isPidAlive,
  isTerminalLiveRunStatus,
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
  /** Flush buffered events, then write the terminal meta. */
  finish(status: RunRecordStatus, opts?: { ok?: boolean; error?: string }): Promise<void>;
}

const PUBLISH_FLUSH_MS = 25;

/**
 * Buffered, best-effort mirror of a run's event stream into the live-run
 * store. Writes are batched (~{@link PUBLISH_FLUSH_MS}) and serialized on one
 * promise chain so append order matches event order; a store write failure
 * never breaks the run itself. `finish` flushes everything *before* marking
 * the meta terminal, so tailers that see a terminal meta have the full stream.
 */
export function createLiveRunPublisher(store: LiveRunStore, runId: string): LiveRunPublisher {
  let pending: string[] = [];
  let streamEventCount = 0;
  let streamCapNoted = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  const pendingApprovals: { stepId: string; iteration: number }[] = [];

  const enqueue = (task: () => Promise<void>): void => {
    chain = chain.then(task).catch(() => {});
  };

  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (pending.length === 0) return;
    const lines = pending.join("");
    pending = [];
    enqueue(() => store.appendEventLines(runId, lines));
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
        if (idx >= 0) pendingApprovals.splice(idx, 1);
        syncPendingApprovals();
      }
      pending.push(`${JSON.stringify(event)}\n`);
      scheduleFlush();
    },
    async finish(status, opts = {}) {
      flush();
      enqueue(async () => {
        await store.update(runId, {
          status,
          ok: opts.ok,
          error: opts.error,
          endedAt: Date.now(),
          pendingApprovals: [],
        });
      });
      await chain;
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
 * `"running"` only when its position fits into the free slots. All waiters
 * compute the same deterministic order, so at most `limit` runs execute at
 * once (best-effort — this is a local-machine queue, not a distributed lock).
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
  for (;;) {
    if (options.signal?.aborted || (await store.cancelRequested(runId))) {
      return { ok: false, reason: "canceled" };
    }
    const runs = await store.list();
    const alive = runs.filter(
      (run) => !isTerminalLiveRunStatus(run.status) && (run.pid === -1 || isPidAlive(run.pid)),
    );
    const running = alive.filter((run) => run.status === "running").length;
    const queued = alive
      .filter((run) => run.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const position = queued.findIndex((run) => run.id === runId);
    if (position === -1) {
      // Our own entry disappeared (external cleanup) — treat as canceled.
      return { ok: false, reason: "canceled" };
    }
    const freeSlots = Math.max(0, limit - running);
    if (position < freeSlots) {
      await store.update(runId, { status: "running", startedAt: Date.now() });
      return { ok: true };
    }
    options.onQueued?.(position + 1, running, limit);
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
      const timer = setInterval(() => {
        void store
          .readApprovalDecision(runId, request.stepId, request.iteration ?? 1)
          .then((decision) => {
            if (decision && !settled) {
              settled = true;
              clearInterval(timer);
              resolve({ ...decision, by: decision.by ?? "human" });
            }
          })
          .catch(() => {});
      }, APPROVAL_POLL_MS);
      timer.unref?.();
      void Promise.resolve(inner(request, signal)).then((decision) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        resolve(decision);
      });
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
  return {
    version: LIVE_RUN_META_VERSION,
    id: fields.id,
    workflow: fields.workflow,
    input: fields.input,
    params: fields.params,
    cwd: fields.cwd,
    pid: fields.pid ?? process.pid,
    source: fields.source,
    detached: fields.detached ?? false,
    status: "queued",
    createdAt: Date.now(),
    launch: fields.launch,
  };
}

/**
 * A control-flow sleep: gates forward progress (queue waits, approval polls),
 * so its timer must KEEP the event loop alive — an unref'd timer here would
 * let a process whose only remaining work is this wait (a queued foreground
 * run, a detached runner parked on an approval) silently exit mid-wait.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
