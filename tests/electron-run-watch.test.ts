import { describe, expect, it, vi } from "vitest";
import {
  type FinishedRun,
  type RunSummary,
  finishedBetween,
  isActive,
  startRunWatch,
} from "../electron/main/run-watch";

function run(id: string, status: string, ok?: boolean): RunSummary {
  return { id, workflow: "tour", status, ...(ok === undefined ? {} : { ok }) };
}

/** Let the watcher's initial poll (a resolved promise chain) settle. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("isActive", () => {
  it("counts running and queued", () => {
    expect(isActive(run("a", "running"))).toBe(true);
    expect(isActive(run("a", "queued"))).toBe(true);
  });

  it("does not count terminal states", () => {
    for (const status of ["success", "failed", "cancelled", "error"]) {
      expect(isActive(run("a", status))).toBe(false);
    }
  });
});

describe("finishedBetween", () => {
  it("reports a run that went from running to success", () => {
    const finished = finishedBetween([run("a", "running")], [run("a", "success", true)]);
    expect(finished).toEqual<FinishedRun[]>([{ id: "a", workflow: "tour", ok: true }]);
  });

  it("marks a failed run as not ok", () => {
    const finished = finishedBetween([run("a", "running")], [run("a", "failed", false)]);
    expect(finished[0]?.ok).toBe(false);
  });

  it("treats a missing ok flag as failure rather than success", () => {
    // Announcing success for a run whose outcome we do not know is the one
    // wrong answer here — it tells the user work landed that may not have.
    const finished = finishedBetween([run("a", "running")], [run("a", "cancelled")]);
    expect(finished[0]?.ok).toBe(false);
  });

  it("says nothing about runs it never saw start", () => {
    // The first poll after launch sees the whole run history at once. Without
    // this, every past run in the project would fire a notification.
    expect(finishedBetween([], [run("a", "success", true), run("b", "failed", false)])).toEqual([]);
  });

  it("says nothing while a run is still going", () => {
    expect(finishedBetween([run("a", "running")], [run("a", "running")])).toEqual([]);
  });

  it("reports several runs finishing in the same interval", () => {
    const previous = [run("a", "running"), run("b", "queued")];
    const next = [run("a", "success", true), run("b", "failed", false)];
    expect(finishedBetween(previous, next).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("ignores a run that disappeared instead of finishing", () => {
    // A run pruned from history between polls has no outcome to report.
    expect(finishedBetween([run("a", "running")], [])).toEqual([]);
  });
});

describe("startRunWatch", () => {
  it("reports the active count after its first poll", async () => {
    const counts: number[] = [];
    const watch = startRunWatch({
      origin: "http://127.0.0.1:1",
      fetchRuns: async () => [run("a", "running"), run("b", "success", true)],
      onActiveCount: (n) => counts.push(n),
    });
    await settle();
    expect(watch.activeCount()).toBe(1);
    expect(counts).toEqual([1]);
    watch.stop();
  });

  it("only reports the count when it changes", async () => {
    const counts: number[] = [];
    const watch = startRunWatch({
      origin: "http://127.0.0.1:1",
      fetchRuns: async () => [run("a", "running")],
      onActiveCount: (n) => counts.push(n),
    });
    await settle();
    await watch.refresh();
    await watch.refresh();
    expect(counts).toEqual([1]);
    watch.stop();
  });

  it("emits a finish between two polls", async () => {
    const finished: FinishedRun[] = [];
    let phase = 0;
    const watch = startRunWatch({
      origin: "http://127.0.0.1:1",
      fetchRuns: async () => (phase++ === 0 ? [run("a", "running")] : [run("a", "success", true)]),
      onFinished: (runs) => finished.push(...runs),
    });
    await settle();
    await watch.refresh();
    expect(finished).toEqual<FinishedRun[]>([{ id: "a", workflow: "tour", ok: true }]);
    watch.stop();
  });

  it("survives a failing poll and keeps the previous count", async () => {
    let calls = 0;
    const watch = startRunWatch({
      origin: "http://127.0.0.1:1",
      fetchRuns: async () => {
        calls += 1;
        if (calls === 1) return [run("a", "running")];
        throw new Error("engine restarting");
      },
    });
    await settle();
    expect(watch.activeCount()).toBe(1);
    // The failure is swallowed — this must not reject.
    await expect(watch.refresh()).resolves.toBe(1);
    watch.stop();
  });

  it("cancels every active run and no finished one", async () => {
    const cancelled: string[] = [];
    const watch = startRunWatch({
      origin: "http://127.0.0.1:1",
      fetchRuns: async () => [run("a", "running"), run("b", "success", true), run("c", "queued")],
      cancelRun: async (_origin, id) => {
        cancelled.push(id);
      },
    });
    await settle();
    await watch.cancelActive();
    expect(cancelled.sort()).toEqual(["a", "c"]);
    watch.stop();
  });

  it("cancels the rest when one run refuses", async () => {
    // The app is quitting either way; one stubborn run must not leave the
    // others going.
    const cancelled: string[] = [];
    const watch = startRunWatch({
      origin: "http://127.0.0.1:1",
      fetchRuns: async () => [run("a", "running"), run("b", "running")],
      cancelRun: async (_origin, id) => {
        if (id === "a") throw new Error("nope");
        cancelled.push(id);
      },
    });
    await settle();
    await expect(watch.cancelActive()).resolves.toBeUndefined();
    expect(cancelled).toEqual(["b"]);
    watch.stop();
  });

  // Quitting waits on these two, with the quit already held open: an engine
  // that accepts the request and never answers must not keep the app alive.
  it("answers refresh from the last poll when the engine does not reply in time", async () => {
    let calls = 0;
    const watch = startRunWatch({
      origin: "http://127.0.0.1:1",
      fetchRuns: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve([run("a", "running")]) : new Promise(() => {});
      },
      deadlineMs: 20,
    });
    await settle();
    await expect(watch.refresh()).resolves.toBe(1);
    watch.stop();
  });

  it("gives up on cancelling when the engine does not reply in time", async () => {
    const cancelled: string[] = [];
    let calls = 0;
    const watch = startRunWatch({
      origin: "http://127.0.0.1:1",
      fetchRuns: () => {
        calls += 1;
        return calls === 1 ? Promise.resolve([run("a", "running")]) : new Promise(() => {});
      },
      // The last snapshot still names the run, so the cancel is still sent.
      cancelRun: (_origin, id) => {
        cancelled.push(id);
        return new Promise(() => {});
      },
      deadlineMs: 20,
    });
    await settle();
    await expect(watch.cancelActive()).resolves.toBeUndefined();
    expect(cancelled).toEqual(["a"]);
    watch.stop();
  });

  it("stops polling once stopped", async () => {
    vi.useFakeTimers();
    try {
      const fetchRuns = vi.fn(async () => [] as RunSummary[]);
      const watch = startRunWatch({ origin: "http://127.0.0.1:1", fetchRuns, intervalMs: 10 });
      const initial = fetchRuns.mock.calls.length;
      watch.stop();
      await vi.advanceTimersByTimeAsync(100);
      expect(fetchRuns.mock.calls.length).toBe(initial);
    } finally {
      vi.useRealTimers();
    }
  });
});
