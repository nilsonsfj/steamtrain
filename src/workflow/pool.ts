/**
 * Two small concurrency primitives the engine builds on. Kept dependency-free
 * and pure so they can be unit-tested in isolation (these are the risk centers,
 * like the NDJSON line buffer).
 */

/**
 * Run `worker` over `items` with at most `limit` calls in flight at once.
 * Resolves once every item has been processed. If a worker rejects, scheduling
 * stops and the first rejection is rethrown after in-flight work settles.
 * Aborting `signal` likewise stops scheduling new work — in-flight workers
 * should honor the same signal to stop early.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const max = Math.max(1, Math.floor(limit));
  let next = 0;
  let errored = false;
  let firstError: unknown;

  const runOne = async (): Promise<void> => {
    while (true) {
      if (errored || signal?.aborted) return;
      const index = next++;
      if (index >= items.length) return;
      try {
        await worker(items[index] as T, index);
      } catch (err) {
        if (!errored) {
          errored = true;
          firstError = err;
        }
        return;
      }
    }
  };

  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(max, items.length); i++) runners.push(runOne());
  await Promise.all(runners);

  if (errored) throw firstError;
}

export interface Channel<T> {
  /** Enqueue an item for the single consumer. No-op after `close()`. */
  push(item: T): void;
  /** End iteration once buffered items drain. */
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

/**
 * A single-consumer async queue. Producers (parallel step workers) call
 * `push`; one consumer (the engine's phase loop) iterates the items in order.
 * Mirrors the queue+resolver idiom in `src/agents/spawn.ts`.
 *
 * No queue cap: the engine already bounds total steps via MAX_STEPS, and the
 * pool drains continuously. Silently dropping lifecycle events (step_done,
 * phase_done, workflow_done) would leave the reducer/UI stuck on "running".
 */
export function createChannel<T>(): Channel<T> {
  const queue: T[] = [];
  let closed = false;
  let resolveNext: (() => void) | null = null;

  const wake = (): void => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  return {
    push(item: T): void {
      if (closed) return;
      queue.push(item);
      wake();
    },
    close(): void {
      closed = true;
      wake();
    },
    async *[Symbol.asyncIterator](): AsyncIterator<T> {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift() as T;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    },
  };
}
