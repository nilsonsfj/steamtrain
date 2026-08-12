import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The remembered-workflow bridge is held together by two channel names that
 * have to agree across main, preload, and the renderer with nothing but
 * string matching to enforce it — a rename on one side silently strands the
 * other, same risk as the switch-project button.
 */
describe("last workflow bridge", () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
  const main = read("../electron/main/index.ts");
  const preload = read("../electron/preload/index.ts");
  const core = read("../src/web/public/st-core.js");

  it("bridges the get-last-workflow channel name on both ends", () => {
    expect(main).toContain('ipcMain.handle("steamtrain:get-last-workflow"');
    expect(preload).toContain('ipcRenderer.invoke("steamtrain:get-last-workflow")');
  });

  it("bridges the set-last-workflow channel name on both ends", () => {
    expect(main).toContain('ipcMain.handle("steamtrain:set-last-workflow"');
    expect(preload).toContain('ipcRenderer.invoke("steamtrain:set-last-workflow"');
  });

  it("exposes both functions on the bridge without exposing ipcRenderer itself", () => {
    expect(preload).toContain("getLastWorkflow:");
    expect(preload).toContain("setLastWorkflow:");
    expect(preload).not.toContain("ipcRenderer,");
    expect(preload).not.toContain('exposeInMainWorld("ipcRenderer"');
  });

  it("reads the remembered workflow through the bridge before falling back to localStorage", () => {
    expect(core).toContain("window.steamtrainDesktop.getLastWorkflow()");
  });

  it("writes the selection through the bridge alongside localStorage", () => {
    expect(core).toContain("window.steamtrainDesktop.setLastWorkflow(name)");
  });

  it("prunes lastWorkflow everywhere recents shrinks", () => {
    // index.ts can't be imported directly — it has Electron side effects at
    // module load — so this checks the same way electron-switch-project does:
    // string matching. `onClearRecents` and the dead-directory cleanup in
    // `switchProject` both drop entries from recents, and without a matching
    // `pruneLastWorkflow` call the corresponding lastWorkflow entries would be
    // orphaned rather than dropped alongside them.
    expect(main).toContain(
      "persist({ recents: [], lastWorkflow: pruneLastWorkflow(state.lastWorkflow, []) });",
    );
    expect(main).toContain(
      "persist({ recents, lastWorkflow: pruneLastWorkflow(state.lastWorkflow, recents) });",
    );
  });
});
