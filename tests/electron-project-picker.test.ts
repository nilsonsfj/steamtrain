import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_STALE_MS,
  ORPHAN_GRACE_MS,
  RUNS_DIR,
  displayPath,
  summarizeRuns,
} from "../electron/main/project-list";
import {
  LIVE_RUN_HEARTBEAT_STALE_MS,
  LIVE_RUN_ORPHAN_GRACE_MS,
  WORKFLOW_RUNS_DIR,
} from "../src/workflow/live-run-store";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

/**
 * The switcher's rows are a reading of the engine's live-run registry from
 * outside the engine. Nothing but these constants keeps the two readings
 * agreeing, so they are asserted equal rather than trusted to stay in sync.
 */
describe("project-list mirrors the engine's live-run rules", () => {
  it("reads the same registry directory", () => {
    expect(RUNS_DIR).toBe(WORKFLOW_RUNS_DIR);
  });

  it("uses the same liveness windows", () => {
    expect(HEARTBEAT_STALE_MS).toBe(LIVE_RUN_HEARTBEAT_STALE_MS);
    expect(ORPHAN_GRACE_MS).toBe(LIVE_RUN_ORPHAN_GRACE_MS);
  });
});

describe("summarizeRuns", () => {
  const now = 1_000_000;
  const alive = () => true;
  const dead = () => false;

  it("counts running and queued runs whose owner is alive", () => {
    const metas = [
      { status: "running", pid: 10, heartbeatAt: now - 1_000 },
      { status: "queued", pid: 11, heartbeatAt: now - 1_000 },
      { status: "done", ok: true, pid: 12 },
    ];
    expect(summarizeRuns(metas, now, alive)).toEqual({ running: 2, failed: 0 });
  });

  it("does not count a run whose owning process is gone", () => {
    const metas = [{ status: "running", pid: 10, heartbeatAt: now - 1_000 }];
    expect(summarizeRuns(metas, now, dead)).toEqual({ running: 0, failed: 0 });
  });

  it("does not count a live pid whose heartbeat went stale", () => {
    const metas = [{ status: "running", pid: 10, heartbeatAt: now - HEARTBEAT_STALE_MS - 1 }];
    expect(summarizeRuns(metas, now, alive)).toEqual({ running: 0, failed: 0 });
  });

  it("counts a detached run that has not reported its pid yet, until the grace window closes", () => {
    const starting = [{ status: "queued", pid: -1, createdAt: now - 1_000 }];
    const stalled = [{ status: "queued", pid: -1, createdAt: now - ORPHAN_GRACE_MS - 1 }];
    expect(summarizeRuns(starting, now, dead).running).toBe(1);
    expect(summarizeRuns(stalled, now, dead).running).toBe(0);
  });

  it("counts failed and budget-exceeded runs as broken", () => {
    const metas = [
      { status: "error", ok: false },
      { status: "budget-exceeded", ok: false },
    ];
    expect(summarizeRuns(metas, now, alive)).toEqual({ running: 0, failed: 2 });
  });

  it("treats a canceled run as neither running nor broken", () => {
    // Someone already dealt with it — the row must not send anyone back.
    expect(summarizeRuns([{ status: "canceled", ok: false }], now, alive)).toEqual({
      running: 0,
      failed: 0,
    });
  });

  it("survives a meta.json with nothing usable in it", () => {
    expect(summarizeRuns([{}, { status: 7 }], now, alive)).toEqual({ running: 0, failed: 0 });
  });
});

describe("displayPath", () => {
  it("shortens a path under home", () => {
    expect(displayPath("/Users/ada/projects/camelo", "/Users/ada")).toBe("~/projects/camelo");
  });

  it("leaves a path outside home absolute", () => {
    expect(displayPath("/srv/checkouts/camelo", "/Users/ada")).toBe("/srv/checkouts/camelo");
  });

  it("does not mistake a sibling of home for a child of it", () => {
    expect(displayPath("/Users/adam/code", "/Users/ada")).toBe("/Users/adam/code");
  });

  it("names home itself", () => {
    expect(displayPath("/Users/ada", "/Users/ada")).toBe("~");
  });
});

/**
 * The picker spans main, preload, the page skeleton, the stylesheet and two
 * client modules, held together only by matching strings. A rename on one side
 * strands the other silently, so each seam is asserted here.
 */
describe("project picker wiring", () => {
  const main = read("../electron/main/index.ts");
  const preload = read("../electron/preload/index.ts");
  const html = read("../src/web/html.ts");
  const css = read("../src/web/public/shell.css");
  const boot = read("../src/web/public/st-boot.js");
  const shell = read("../src/web/public/st-shell.js");
  const projects = read("../src/web/public/st-projects.js");

  it("bridges the same IPC channel names on both ends", () => {
    for (const channel of [
      "steamtrain:switch-project",
      "steamtrain:list-projects",
      "steamtrain:open-project",
    ]) {
      expect(main).toContain(`ipcMain.handle("${channel}"`);
      expect(preload).toContain(`ipcRenderer.invoke("${channel}"`);
    }
  });

  it("exposes the picker's functions on the bridge without exposing ipcRenderer itself", () => {
    expect(preload).toContain("listProjects:");
    expect(preload).toContain("openProject:");
    expect(preload).toContain("switchProject:");
    expect(preload).not.toContain("ipcRenderer,");
    expect(preload).not.toContain('exposeInMainWorld("ipcRenderer"');
  });

  it("refuses a project directory the app has not opened before", () => {
    // The renderer is a web page; an arbitrary path from it must never become
    // the directory the engine is forked against.
    expect(main).toContain("state.recents.includes(dir)");
  });

  it("ships the client module and the popup it renders into", () => {
    expect(html).toContain('{ file: "st-projects.js"');
    expect(html).toContain('id="projectMenu"');
    expect(css).toContain(".proj-pop");
    expect(css).toContain(".crumb-project");
  });

  it("keeps the popup outside the breadcrumb, which is rebuilt on every render", () => {
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(header).not.toContain('id="projectMenu"');
  });

  it("puts the switcher in the first crumb only where a project can be switched", () => {
    expect(shell).toContain("ST.projects.enabled()");
    expect(shell).toContain("ST.projects.crumbButton()");
    expect(projects).toContain("window.steamtrainDesktop");
  });

  it("opens the switcher on the shortcut the menu advertises", () => {
    expect(boot).toContain("ST.projects.toggle()");
    expect(boot).toMatch(/e\.key === "p"/);
  });

  it("drops the topbar button the switcher replaced", () => {
    expect(html).not.toContain("switchProjectBtn");
    expect(css).not.toContain("switchProjectBtn");
    expect(boot).not.toContain("switchProjectBtn");
  });
});
