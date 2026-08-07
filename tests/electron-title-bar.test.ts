import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TITLE_BAR_INSET_PX, overlaysTitleBar } from "../electron/shared/title-bar";

/**
 * The window controls sit inside the page on macOS, and the page has to leave
 * room for them. That agreement spans three files in two trees — the main
 * process hides the title bar, the preload publishes the inset, the stylesheet
 * spends it — with nothing but a class name holding it together, which is
 * exactly the kind of seam that rots quietly. It already shipped broken once,
 * with the controls drawn over the wordmark.
 */
describe("title bar inset", () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
  const preload = read("../electron/preload/index.ts");
  const css = read("../src/web/public/shell.css");

  it("only claims an inset where the controls overlap the page", () => {
    expect(overlaysTitleBar("darwin")).toBe(true);
    // Everywhere else keeps a real title bar, and reserving space under one
    // would leave a gap with nothing in it.
    expect(overlaysTitleBar("linux")).toBe(false);
    expect(overlaysTitleBar("win32")).toBe(false);
  });

  it("reserves more than the controls occupy", () => {
    // Three 12px controls on a 20px pitch, starting 20px in.
    expect(TITLE_BAR_INSET_PX).toBeGreaterThan(20 + 2 * 20 + 12);
  });

  it("styles the class and the variable the preload actually sets", () => {
    expect(preload).toContain('classList.add("desktop-titlebar-overlay")');
    expect(preload).toContain('"--desktop-titlebar-inset"');
    expect(css).toContain("html.desktop-titlebar-overlay #topbar");
    expect(css).toContain("var(--desktop-titlebar-inset");
  });

  it("keeps the topbar's controls clickable inside the drag region", () => {
    // Without a title bar the topbar is the only handle for moving the window,
    // and a drag region swallows presses unless its controls opt out.
    expect(css).toContain("-webkit-app-region: drag");
    expect(css).toContain("-webkit-app-region: no-drag");
  });
});
