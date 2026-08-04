import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { ready, tick, type } from "./helpers/ink-input";

/**
 * The helper exists because a keypress written before Ink attaches its stdin
 * listener is dropped in silence. These specs pin that down with a stdin that
 * mounts late on purpose — the state a loaded CI runner produces by accident.
 */

/** A stand-in for ink-testing-library's stdin that starts listening after `turns`. */
class LateStdin extends EventEmitter {
  received: string[] = [];

  constructor(turns: number) {
    super();
    let left = turns;
    const attach = (): void => {
      if (left-- > 0) {
        setTimeout(attach, 0);
        return;
      }
      this.on("readable", () => {
        this.received.push(this.pending);
      });
    };
    attach();
  }

  private pending = "";

  // Mirrors the real fake: emit once, buffer nothing.
  write = (data: string): void => {
    this.pending = data;
    this.emit("readable");
  };
}

describe("ink input helper", () => {
  it("waits for a listener that takes many turns to attach", async () => {
    const stdin = new LateStdin(20);
    await type(stdin, "\r");
    expect(stdin.received).toEqual(["\r"]);
  });

  it("delivers every keypress in order once mounted", async () => {
    const stdin = new LateStdin(5);
    await type(stdin, "h", "i", "\r");
    expect(stdin.received).toEqual(["h", "i", "\r"]);
  });

  it("shows what the single-tick wait it replaced would have done", async () => {
    // The old helper spent exactly one turn before writing, so a mount slower
    // than that lost the keypress with no error — the CI flake, reproduced.
    const stdin = new LateStdin(20);
    await tick();
    stdin.write("\r");
    expect(stdin.received).toEqual([]);
  });

  it("gives up rather than hanging when nothing ever listens", async () => {
    const stdin = new LateStdin(Number.POSITIVE_INFINITY);
    await expect(ready(stdin, 5)).rejects.toThrow("never attached");
  });
});
