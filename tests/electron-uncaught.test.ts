import { describe, expect, it, vi } from "vitest";
import { type UncaughtDeps, handleUncaught } from "../electron/main/uncaught";

function deps(overrides: Partial<UncaughtDeps> = {}) {
  return {
    quitting: () => false,
    hasWindow: () => true,
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

  it("never shows one with no window to show it over", () => {
    const d = deps({ hasWindow: () => false });
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

  it("describes a thrown non-Error", () => {
    const d = deps();
    handleUncaught("just a string", d);
    expect(d.showErrorBox).toHaveBeenCalledWith(expect.any(String), "just a string");
  });
});
