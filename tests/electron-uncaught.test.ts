import { describe, expect, it, vi } from "vitest";
import { type UncaughtDeps, handleUncaught } from "../electron/main/uncaught";

type Spied = UncaughtDeps & {
  log: ReturnType<typeof vi.fn>;
  showErrorBox: ReturnType<typeof vi.fn>;
};

function deps(overrides: Partial<Pick<UncaughtDeps, "quitting" | "windowGone">> = {}): Spied {
  return {
    quitting: () => false,
    windowGone: () => false,
    log: vi.fn(),
    showErrorBox: vi.fn(),
    ...overrides,
  };
}

/** What Electron 33 throws from its own window teardown (#266). */
function teardownRace(): TypeError {
  const err = new TypeError("Object has been destroyed");
  err.stack = `${err.name}: ${err.message}\n    at BrowserWindow.visibilityChanged (node:electron/js2c/browser_init:2:13331)`;
  return err;
}

describe("handleUncaught", () => {
  it("never shows a modal box mid-quit, where it would block the quit forever", () => {
    const d = deps({ quitting: () => true });
    handleUncaught(teardownRace(), d);
    expect(d.showErrorBox).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("visibilityChanged"));
  });

  it("never shows one once the window has gone", () => {
    const d = deps({ windowGone: () => true });
    handleUncaught(new Error("boom"), d);
    expect(d.showErrorBox).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("still reports an error while the app is up, as Electron would", () => {
    const d = deps();
    handleUncaught(new Error("boom"), d);
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.showErrorBox).toHaveBeenCalledWith(
      "A JavaScript error occurred in the main process",
      expect.stringContaining("boom"),
    );
  });

  it("only logs an unhandled rejection, as Electron itself only warns", () => {
    const d = deps();
    handleUncaught(new Error("ERR_ABORTED"), d, "rejection");
    expect(d.showErrorBox).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("unhandled rejection"));
  });

  it("names an error that has lost its stack", () => {
    const d = deps();
    const err = new RangeError("too far");
    err.stack = undefined;
    handleUncaught(err, d);
    expect(d.showErrorBox).toHaveBeenCalledWith(expect.any(String), "RangeError: too far");
  });

  it("describes a thrown non-Error", () => {
    const d = deps();
    handleUncaught("just a string", d);
    expect(d.showErrorBox).toHaveBeenCalledWith(expect.any(String), "just a string");
  });
});
