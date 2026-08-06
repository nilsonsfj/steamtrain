import { describe, expect, it, vi } from "vitest";
import type { QuitChoice } from "../electron/main/quit-prompt";
import { quitChoiceFor, quitPromptSpec } from "../electron/main/quit-prompt";
import { type ShutdownDeps, performQuit } from "../electron/main/shutdown";

function deps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    askAboutRuns: async (): Promise<QuitChoice> => {
      calls.push("ask");
      return "leave-running";
    },
    cancelActive: async () => {
      calls.push("cancel");
    },
    stopWatch: () => {
      calls.push("stopWatch");
    },
    stopServer: async () => {
      calls.push("stopServer");
    },
    quit: () => {
      calls.push("quit");
    },
    ...overrides,
  };
}

describe("quitPromptSpec", () => {
  it("agrees on the singular", () => {
    expect(quitPromptSpec(1).message).toContain("1 run is");
    expect(quitPromptSpec(3).message).toContain("3 runs are");
  });

  it("defaults to the non-destructive answer", () => {
    const spec = quitPromptSpec(2);
    expect(spec.choices[spec.defaultId]).toBe("leave-running");
  });

  it("maps escape to cancel", () => {
    const spec = quitPromptSpec(2);
    expect(spec.choices[spec.cancelId]).toBe("cancel");
  });

  it("has a choice for every button", () => {
    const spec = quitPromptSpec(1);
    expect(spec.choices).toHaveLength(spec.buttons.length);
  });

  it("reads a dismissed dialog as cancel", () => {
    const spec = quitPromptSpec(1);
    expect(quitChoiceFor(spec, -1)).toBe("cancel");
    expect(quitChoiceFor(spec, 99)).toBe("cancel");
  });
});

describe("performQuit", () => {
  it("leaves runs alone and stops the engine", async () => {
    const d = deps();
    await expect(performQuit(d)).resolves.toBe("quit");
    expect(d.calls).toEqual(["ask", "stopWatch", "stopServer", "quit"]);
  });

  it("cancels runs first when asked to stop them", async () => {
    const d = deps({ askAboutRuns: async () => "stop-runs" });
    await performQuit(d);
    expect(d.calls).toEqual(["cancel", "stopWatch", "stopServer", "quit"]);
  });

  it("does not quit when the user cancels", async () => {
    const d = deps({ askAboutRuns: async () => "cancel" });
    await expect(performQuit(d)).resolves.toBe("cancelled");
    expect(d.calls).not.toContain("quit");
    expect(d.calls).not.toContain("stopServer");
  });

  // The regression that motivated extracting this: `will-quit` has already
  // called preventDefault, so any path that fails to reach `quit()` leaves an
  // app that cannot be closed at all.
  it("still quits when stopping the engine rejects", async () => {
    const onError = vi.fn();
    const d = deps({
      stopServer: async () => {
        throw new Error("child would not die");
      },
      onError,
    });
    await expect(performQuit(d)).resolves.toBe("quit");
    expect(d.calls).toContain("quit");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("still quits when cancelling runs rejects", async () => {
    const onError = vi.fn();
    const d = deps({
      askAboutRuns: async () => "stop-runs",
      cancelActive: async () => {
        throw new Error("engine unreachable");
      },
      onError,
    });
    await expect(performQuit(d)).resolves.toBe("quit");
    expect(d.calls).toContain("stopServer");
    expect(d.calls).toContain("quit");
  });

  it("still quits when stopping the watcher throws", async () => {
    const d = deps({
      stopWatch: () => {
        throw new Error("already stopped");
      },
      onError: () => {},
    });
    await expect(performQuit(d)).resolves.toBe("quit");
    expect(d.calls).toContain("quit");
  });

  it("quits when it cannot even ask about runs", async () => {
    // Failing to ask must not mean refusing to quit — leaving runs going is
    // what quitting has always done.
    const onError = vi.fn();
    const d = deps({
      askAboutRuns: async () => {
        throw new Error("no window");
      },
      onError,
    });
    await expect(performQuit(d)).resolves.toBe("quit");
    expect(d.calls).not.toContain("cancel");
    expect(d.calls).toContain("quit");
    expect(onError).toHaveBeenCalledOnce();
  });
});
