/**
 * What the app knows about runs in flight.
 *
 * Three things need this: the dock indicator, the completion notification, and
 * the quit dialog that asks what to do about work still running. All three want
 * the same question answered — what is active right now, and what just finished
 * — so it is polled once here rather than three times.
 *
 * Polling `GET /api/runs` rather than consuming the SSE stream is deliberate.
 * The stream is per-run and carries every step event; this needs neither. A
 * poll a few seconds apart is enough for a dock badge and a notification about
 * work that takes minutes, and it has no reconnect story to get wrong.
 *
 * The engine binds loopback with no token, so these requests need no auth. If
 * that ever changes, this is the code that breaks.
 */

import { writeSync } from "node:fs";

/** How often to ask. Slow enough to be free, fast enough for a dock badge. */
const POLL_MS = 3_000;

/**
 * How long a request to the engine may take. An engine that accepts the
 * connection and never answers would otherwise leave a poll hanging for good,
 * and a new one piling on every tick. Under `POLL_MS`, so polls never overlap.
 */
const REQUEST_MS = 2_500;

/**
 * How long quitting waits on the engine before going on without its answer.
 * The quit holds the app open while it asks (see `performQuit`), so an engine
 * that is busy or wedged must not be able to hold it forever.
 */
const QUIT_DEADLINE_MS = 2_000;

export interface RunSummary {
  id: string;
  workflow: string;
  status: string;
  ok?: boolean;
  detached?: boolean;
}

/** A run that reached a terminal state between two polls. */
export interface FinishedRun {
  id: string;
  workflow: string;
  ok: boolean;
}

const ACTIVE = new Set(["running", "queued"]);

export function isActive(run: RunSummary): boolean {
  return ACTIVE.has(run.status);
}

/**
 * Which runs finished between two snapshots.
 *
 * Keyed off the *previous* snapshot's active set, so only runs this app
 * actually watched start produce a notification. Without that, the first poll
 * after launch would announce every run in the project's history.
 */
export function finishedBetween(
  previous: readonly RunSummary[],
  next: readonly RunSummary[],
): FinishedRun[] {
  const wasActive = new Set(previous.filter(isActive).map((run) => run.id));
  if (wasActive.size === 0) return [];
  return next
    .filter((run) => wasActive.has(run.id) && !isActive(run))
    .map((run) => ({ id: run.id, workflow: run.workflow, ok: run.ok === true }));
}

export interface RunWatchEvents {
  /** The number of active runs changed. */
  onActiveCount?: (count: number) => void;
  /** One or more runs reached a terminal state. */
  onFinished?: (runs: FinishedRun[]) => void;
}

export interface RunWatch {
  /** Active runs as of the last successful poll. */
  activeCount(): number;
  /**
   * Active runs, refreshed now — used by the quit dialog, which must not guess.
   * Falls back to the last poll's count if the engine does not answer in time.
   */
  refresh(): Promise<number>;
  /**
   * Cancel everything in flight. Resolves once every request has been answered,
   * or the quit deadline has passed.
   */
  cancelActive(): Promise<void>;
  stop(): void;
}

export interface StartRunWatchOptions extends RunWatchEvents {
  /** Engine origin, e.g. `http://127.0.0.1:53412`. */
  origin: string;
  /** Injected for tests. */
  fetchRuns?: (origin: string) => Promise<RunSummary[]>;
  /** Injected for tests. */
  cancelRun?: (origin: string, id: string) => Promise<void>;
  intervalMs?: number;
  /** How long `refresh` and each step of `cancelActive` wait. Injected for tests. */
  deadlineMs?: number;
}

async function defaultFetchRuns(origin: string): Promise<RunSummary[]> {
  const res = await fetch(`${origin}/api/runs`, { signal: AbortSignal.timeout(REQUEST_MS) });
  if (!res.ok) throw new Error(`GET /api/runs -> ${res.status}`);
  const body: unknown = await res.json();
  const runs = (body as { runs?: unknown }).runs;
  return Array.isArray(runs) ? (runs as RunSummary[]) : [];
}

async function defaultCancelRun(origin: string, id: string): Promise<void> {
  await fetch(`${origin}/api/runs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    signal: AbortSignal.timeout(REQUEST_MS),
  });
}

/**
 * What `promise` settles to, or `fallback()` if it rejects or `ms` passes
 * first. A thunk, so a poll that lands during the wait is what it falls back to.
 */
function within<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms);
    timer.unref?.();
  });
  return Promise.race([promise.catch(() => fallback()), late]).finally(() => clearTimeout(timer));
}

/**
 * Begin polling. Never rejects: a failed poll keeps the previous snapshot and
 * tries again, because the engine restarting is a normal thing to survive.
 */
export function startRunWatch(options: StartRunWatchOptions): RunWatch {
  const {
    origin,
    fetchRuns = defaultFetchRuns,
    cancelRun = defaultCancelRun,
    intervalMs = POLL_MS,
    deadlineMs = QUIT_DEADLINE_MS,
    onActiveCount,
    onFinished,
  } = options;

  let snapshot: RunSummary[] = [];
  let active = 0;
  let stopped = false;

  const apply = (runs: RunSummary[]): number => {
    const finished = finishedBetween(snapshot, runs);
    snapshot = runs;
    const count = runs.filter(isActive).length;
    // STRESS DIAGNOSTIC (not for merge).
    if (count > 0 || count !== active) {
      try {
        writeSync(1, `[steamtrain] watch ${new Date().toISOString()}: ${count} active of ${runs.length}: ${JSON.stringify(runs).slice(0, 600)}\n`);
      } catch {}
    }
    if (count !== active) {
      active = count;
      onActiveCount?.(count);
    }
    if (finished.length > 0) onFinished?.(finished);
    return count;
  };

  const poll = async (): Promise<number> => {
    const runs = await fetchRuns(origin);
    return apply(runs);
  };

  const timer = setInterval(() => {
    if (stopped) return;
    void poll().catch(() => {
      // Transient — the next tick retries. Nothing here is worth a dialog.
    });
  }, intervalMs);
  timer.unref?.();
  void poll().catch(() => {});

  return {
    activeCount: () => active,
    refresh: () => within(poll(), deadlineMs, () => active),
    async cancelActive(): Promise<void> {
      // From a fresh list, not the snapshot: this runs at quit time, when the
      // last poll may be seconds stale and cancelling the wrong id is silent.
      // The snapshot is only the fallback for an engine that does not answer.
      const runs = await within(fetchRuns(origin), deadlineMs, () => snapshot);
      // `allSettled`, because one run refusing to cancel must not leave the
      // others running — and the app is quitting either way.
      const cancels = Promise.allSettled(
        runs.filter(isActive).map((run) => cancelRun(origin, run.id)),
      );
      await within(
        cancels.then(() => undefined),
        deadlineMs,
        () => undefined,
      );
    },
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
