import { describe, expect, it } from "vitest";
import {
  CANCEL_CONFIRM_NOTICE,
  CONFIRM_WINDOW_MS,
  QUIT_CONFIRM_NOTICE,
  armOrConfirm,
} from "../src/tui/confirm-action";

describe("armOrConfirm", () => {
  it("arms on the first press", () => {
    const first = armOrConfirm(null, "quit", 1_000);
    expect(first.confirmed).toBe(false);
    expect(first.next).toEqual({ action: "quit", at: 1_000 });
  });

  it("confirms the same action within the window", () => {
    const armed = { action: "quit" as const, at: 1_000 };
    const second = armOrConfirm(armed, "quit", 1_000 + CONFIRM_WINDOW_MS);
    expect(second.confirmed).toBe(true);
    expect(second.next).toBeNull();
  });

  it("re-arms after the window expires", () => {
    const armed = { action: "cancel" as const, at: 1_000 };
    const late = armOrConfirm(armed, "cancel", 1_000 + CONFIRM_WINDOW_MS + 1);
    expect(late.confirmed).toBe(false);
    expect(late.next).toEqual({ action: "cancel", at: 1_000 + CONFIRM_WINDOW_MS + 1 });
  });

  it("switching actions re-arms instead of confirming", () => {
    const armed = { action: "quit" as const, at: 1_000 };
    const switched = armOrConfirm(armed, "cancel", 1_500);
    expect(switched.confirmed).toBe(false);
    expect(switched.next).toEqual({ action: "cancel", at: 1_500 });
  });

  it("exposes stable notice copy for the TUI", () => {
    expect(QUIT_CONFIRM_NOTICE).toMatch(/press Ctrl\+C or \/exit again/);
    expect(CANCEL_CONFIRM_NOTICE).toMatch(/press Ctrl\+Q again/);
  });
});
