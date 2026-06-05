import { describe, expect, it } from "vitest";
import { createChannel, runPool } from "../src/workflow";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("runPool", () => {
  it("never exceeds the concurrency limit and runs every item", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    const items = [1, 2, 3, 4, 5, 6, 7];

    await runPool(items, 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(5);
      active -= 1;
      done.push(n);
    });

    expect(peak).toBe(3);
    expect(done.slice().sort((a, b) => a - b)).toEqual(items);
  });

  it("runs items serially when the limit is 1", async () => {
    let active = 0;
    let peak = 0;
    await runPool([1, 2, 3], 1, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(1);
      active -= 1;
    });
    expect(peak).toBe(1);
  });

  it("rethrows the first worker rejection and stops scheduling", async () => {
    const seen: number[] = [];
    await expect(
      runPool([1, 2, 3, 4, 5], 1, async (n) => {
        seen.push(n);
        if (n === 2) throw new Error("boom");
        await delay(1);
      }),
    ).rejects.toThrow("boom");
    // It stopped after the failure rather than running all five.
    expect(seen.length).toBeLessThan(5);
  });

  it("stops scheduling once the signal is aborted", async () => {
    const ac = new AbortController();
    const seen: number[] = [];
    await runPool(
      [1, 2, 3, 4, 5, 6],
      1,
      async (n) => {
        seen.push(n);
        if (n === 2) ac.abort();
        await delay(1);
      },
      ac.signal,
    );
    expect(seen).toContain(1);
    expect(seen.length).toBeLessThan(6);
  });
});

describe("createChannel", () => {
  it("delivers pushed items in order, then ends on close", async () => {
    const ch = createChannel<number>();
    ch.push(1);
    ch.push(2);

    const got: number[] = [];
    const consumed = (async () => {
      for await (const n of ch) got.push(n);
    })();

    ch.push(3);
    ch.close();
    await consumed;

    expect(got).toEqual([1, 2, 3]);
  });

  it("ignores pushes after close", async () => {
    const ch = createChannel<number>();
    ch.push(1);
    ch.close();
    ch.push(2);

    const got: number[] = [];
    for await (const n of ch) got.push(n);
    expect(got).toEqual([1]);
  });
});
