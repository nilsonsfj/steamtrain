import { describe, expect, it } from "vitest";
import {
  MAX_OUTPUT_LINES,
  initialOutputScroll,
  scrollOutputBy,
  selectOutputWindow,
  staticOutputScroll,
  wrapOutputLines,
} from "../src/tui/output-window";

describe("wrapOutputLines", () => {
  it("keeps short lines and blank lines as-is", () => {
    expect(wrapOutputLines("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });

  it("hard-wraps long lines at the column budget", () => {
    expect(wrapOutputLines("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("normalizes tabs so the column budget holds", () => {
    expect(wrapOutputLines("a\tb", 10)).toEqual(["a  b"]);
  });

  it("trims the oldest lines past the cap with a marker", () => {
    const text = Array.from({ length: MAX_OUTPUT_LINES + 10 }, (_, i) => `line ${i}`).join("\n");
    const lines = wrapOutputLines(text, 80);
    expect(lines).toHaveLength(MAX_OUTPUT_LINES + 1);
    expect(lines[0]).toContain("10 earlier lines trimmed");
    expect(lines[lines.length - 1]).toBe(`line ${MAX_OUTPUT_LINES + 9}`);
  });
});

describe("selectOutputWindow", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `l${i}`);

  it("pins to the newest lines while following", () => {
    const w = selectOutputWindow(lines, initialOutputScroll, 10);
    expect(w.start).toBe(90);
    expect(w.end).toBe(100);
    expect(w.atBottom).toBe(true);
    expect(w.visible[9]).toBe("l99");
  });

  it("anchors at the offset when not following", () => {
    const w = selectOutputWindow(lines, { offset: 20, follow: false }, 10);
    expect(w.start).toBe(20);
    expect(w.end).toBe(30);
    expect(w.atBottom).toBe(false);
  });

  it("clamps an overshooting offset to the bottom", () => {
    const w = selectOutputWindow(lines, { offset: 500, follow: false }, 10);
    expect(w.start).toBe(90);
    expect(w.atBottom).toBe(true);
  });

  it("shows everything when the budget exceeds the content", () => {
    const w = selectOutputWindow(["a", "b"], staticOutputScroll, 10);
    expect(w.visible).toEqual(["a", "b"]);
    expect(w.atBottom).toBe(true);
  });
});

describe("scrollOutputBy", () => {
  it("scrolling up disengages follow mode", () => {
    const next = scrollOutputBy(initialOutputScroll, -10, 100, 10);
    expect(next.follow).toBe(false);
    expect(next.offset).toBe(80); // bottom (90) minus a page of 10
  });

  it("scrolling back to the bottom re-engages follow mode", () => {
    const up = scrollOutputBy(initialOutputScroll, -10, 100, 10);
    const down = scrollOutputBy(up, 10, 100, 10);
    expect(down.follow).toBe(true);
  });

  it("clamps at the top", () => {
    const next = scrollOutputBy({ offset: 3, follow: false }, -100, 100, 10);
    expect(next.offset).toBe(0);
    expect(next.follow).toBe(false);
  });

  it("supports absolute top/bottom motions", () => {
    expect(scrollOutputBy(initialOutputScroll, "top", 100, 10)).toEqual({
      offset: 0,
      follow: false,
    });
    expect(scrollOutputBy({ offset: 0, follow: false }, "bottom", 100, 10)).toEqual({
      offset: 90,
      follow: true,
    });
  });

  it("stays following when there is nothing to scroll", () => {
    const next = scrollOutputBy(initialOutputScroll, 5, 3, 10);
    expect(next.follow).toBe(true);
    expect(next.offset).toBe(0);
  });
});
