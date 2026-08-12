import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The topbar's "Switch Project" button is held together by a channel name and
 * an id that have to agree across five files with nothing but string matching
 * to enforce it — a rename on one side silently strands the other.
 */
describe("switch project button", () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
  const main = read("../electron/main/index.ts");
  const preload = read("../electron/preload/index.ts");
  const html = read("../src/web/html.ts");
  const css = read("../src/web/public/shell.css");
  const boot = read("../src/web/public/st-boot.js");

  it("bridges the same IPC channel name on both ends", () => {
    expect(main).toContain('ipcMain.handle("steamtrain:switch-project"');
    expect(preload).toContain('ipcRenderer.invoke("steamtrain:switch-project")');
  });

  it("exposes switchProject on the bridge without exposing ipcRenderer itself", () => {
    expect(preload).toContain("switchProject:");
    expect(preload).not.toContain("ipcRenderer,");
    expect(preload).not.toContain('exposeInMainWorld("ipcRenderer"');
  });

  it("renders the button with no inline display, so CSS alone controls visibility", () => {
    const button = html.match(/<button[^>]*id="switchProjectBtn"[^>]*>/);
    expect(button?.[0]).toBeTruthy();
    expect(button?.[0]).not.toMatch(/style=/);
  });

  it("hides the button outside the desktop app and reveals it inside", () => {
    expect(css).toMatch(/#switchProjectBtn\s*\{[^}]*display:\s*none/);
    expect(css).toContain("html.desktop-app #switchProjectBtn");
  });

  it("wires the click to the bridged function, guarded for a plain browser tab", () => {
    expect(boot).toContain('getElementById("switchProjectBtn")');
    expect(boot).toContain("window.steamtrainDesktop.switchProject()");
  });
});
