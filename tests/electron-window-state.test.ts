import { describe, expect, it } from "vitest";
import { parseState } from "../electron/main/store";
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  type Rect,
  restoreWindowState,
} from "../electron/main/window-state";

/** A single 1920x1080 display at the origin. */
const LAPTOP: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
/** A second display to the right, as an external monitor usually is. */
const EXTERNAL: Rect = { x: 1920, y: 0, width: 2560, height: 1440 };

describe("restoreWindowState", () => {
  it("centres at the default size on first launch", () => {
    const state = restoreWindowState(undefined, [LAPTOP]);
    expect(state).toEqual({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, maximized: false });
    // No x/y at all — that is what makes Electron centre the window.
    expect(state.x).toBeUndefined();
  });

  it("restores bounds that are still on a display", () => {
    const saved = { x: 100, y: 80, width: 1200, height: 800, maximized: false };
    expect(restoreWindowState(saved, [LAPTOP])).toEqual(saved);
  });

  it("restores onto a secondary display", () => {
    const saved = { x: 2000, y: 100, width: 1200, height: 800, maximized: false };
    expect(restoreWindowState(saved, [LAPTOP, EXTERNAL])).toEqual(saved);
  });

  it("drops the position when the display it was on is gone", () => {
    // Saved on the external monitor, restored with only the laptop attached:
    // keeping x=2000 would put the window somewhere the user cannot reach.
    const saved = { x: 2000, y: 100, width: 1200, height: 800, maximized: false };
    const state = restoreWindowState(saved, [LAPTOP]);
    expect(state.x).toBeUndefined();
    expect(state.y).toBeUndefined();
    expect(state.width).toBe(1200);
  });

  it("drops a position that only grazes a display", () => {
    // Ten pixels of overlap is not enough of a title bar to grab.
    const saved = { x: 1910, y: 100, width: 1200, height: 800, maximized: false };
    expect(restoreWindowState(saved, [LAPTOP]).x).toBeUndefined();
  });

  it("keeps a window deliberately hanging off the edge", () => {
    // Most of it is off-screen to the right, but enough remains to grab — this
    // is a position a user can choose, so it must survive a restart.
    const saved = { x: 1700, y: 100, width: 1200, height: 800, maximized: false };
    expect(restoreWindowState(saved, [LAPTOP]).x).toBe(1700);
  });

  it("shrinks a window saved on a larger display", () => {
    const saved = { x: 0, y: 0, width: 3000, height: 2000, maximized: false };
    const state = restoreWindowState(saved, [LAPTOP]);
    expect(state.width).toBe(LAPTOP.width);
    expect(state.height).toBe(LAPTOP.height);
  });

  it("enforces the minimum size", () => {
    const saved = { x: 0, y: 0, width: 200, height: 100, maximized: false };
    const state = restoreWindowState(saved, [LAPTOP]);
    expect(state.width).toBe(MIN_WIDTH);
    expect(state.height).toBe(MIN_HEIGHT);
  });

  it("carries the maximized flag through", () => {
    const saved = { x: 0, y: 0, width: 1200, height: 800, maximized: true };
    expect(restoreWindowState(saved, [LAPTOP]).maximized).toBe(true);
  });

  it("survives having no displays at all", () => {
    // `screen.getAllDisplays()` returning nothing should not throw on the way
    // to a window; the defaults are the right answer.
    const saved = { x: 10, y: 10, width: 1200, height: 800, maximized: false };
    const state = restoreWindowState(saved, []);
    expect(state.x).toBeUndefined();
    expect(state.width).toBeGreaterThanOrEqual(MIN_WIDTH);
  });
});

describe("parseState", () => {
  it("reads a well-formed file", () => {
    const raw = JSON.stringify({
      recents: ["/a", "/b"],
      window: { x: 1, y: 2, width: 1200, height: 800, maximized: true },
    });
    expect(parseState(raw)).toEqual({
      recents: ["/a", "/b"],
      window: { x: 1, y: 2, width: 1200, height: 800, maximized: true },
    });
  });

  it("degrades to a first launch on unparseable JSON", () => {
    expect(parseState("{not json")).toEqual({ recents: [] });
  });

  it("degrades to a first launch on a non-object document", () => {
    expect(parseState("[1,2,3]")).toEqual({ recents: [] });
    expect(parseState("null")).toEqual({ recents: [] });
  });

  it("drops non-string recents rather than carrying them into the menu", () => {
    const raw = JSON.stringify({ recents: ["/a", 42, null, "", "/b"] });
    expect(parseState(raw).recents).toEqual(["/a", "/b"]);
  });

  it("ignores window state missing a dimension", () => {
    // Width without height cannot open a window, so it is no state at all.
    expect(parseState(JSON.stringify({ window: { width: 1200 } })).window).toBeUndefined();
  });

  it("keeps window size when the position is absent", () => {
    const state = parseState(JSON.stringify({ window: { width: 1200, height: 800 } }));
    expect(state.window).toEqual({ width: 1200, height: 800, maximized: false });
  });

  it("treats a non-boolean maximized as not maximized", () => {
    const raw = JSON.stringify({ window: { width: 1200, height: 800, maximized: "yes" } });
    expect(parseState(raw).window?.maximized).toBe(false);
  });

  it("reads well-formed lastWorkflow entries", () => {
    const raw = JSON.stringify({ lastWorkflow: { "/a": "release", "/b": "tour" } });
    expect(parseState(raw).lastWorkflow).toEqual({ "/a": "release", "/b": "tour" });
  });

  it("drops non-string and empty-string lastWorkflow values", () => {
    const raw = JSON.stringify({
      lastWorkflow: { "/a": "release", "/b": 42, "/c": null, "/d": "" },
    });
    expect(parseState(raw).lastWorkflow).toEqual({ "/a": "release" });
  });

  it("omits lastWorkflow entirely once every entry is dropped", () => {
    const raw = JSON.stringify({ lastWorkflow: { "/a": 42, "/b": "" } });
    expect(parseState(raw).lastWorkflow).toBeUndefined();
  });

  it("treats a missing lastWorkflow as absent", () => {
    expect(parseState(JSON.stringify({ recents: [] })).lastWorkflow).toBeUndefined();
  });

  it("treats a non-object lastWorkflow as absent", () => {
    expect(parseState(JSON.stringify({ lastWorkflow: "release" })).lastWorkflow).toBeUndefined();
    expect(parseState(JSON.stringify({ lastWorkflow: ["release"] })).lastWorkflow).toBeUndefined();
  });
});
