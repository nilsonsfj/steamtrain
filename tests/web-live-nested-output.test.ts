/**
 * Source-level contract: Live panes bubble nested sub-workflow agent output
 * instead of staying on an empty workflow-container step.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const runJs = readFileSync(join(PUBLIC_DIR, "st-run.js"), "utf8");
const inspectorJs = readFileSync(join(PUBLIC_DIR, "st-inspector.js"), "utf8");

describe("live nested output wiring", () => {
  it("resolves band/inspector Live bodies through SteamtrainReducer.resolveLiveOutputStep", () => {
    expect(runJs).toMatch(/resolveLiveOutputStep/);
    expect(runJs).toMatch(/liveOutputBody/);
    expect(runJs).toMatch(/function liveViewStep/);
    expect(inspectorJs).toMatch(/resolveLiveOutputStep/);
    expect(inspectorJs).toMatch(/liveOutputBody/);
  });

  it("prefers phases with running leaf work over workflow-container parents", () => {
    expect(runJs).toMatch(/function isLiveRunning/);
    expect(runJs).toMatch(/blockKind !== "workflow"/);
    // expandedPhaseKey tries isLiveRunning before plain isRunning.
    const expand = runJs.slice(runJs.indexOf("function expandedPhaseKey"));
    const liveIdx = expand.indexOf("isLiveRunning");
    const anyIdx = expand.indexOf(".some(isRunning)");
    expect(liveIdx).toBeGreaterThan(-1);
    expect(anyIdx).toBeGreaterThan(liveIdx);
  });

  it("labels bubbled output with the nested leaf step id", () => {
    expect(runJs).toMatch(/view\.stepId === s\.stepId/);
    expect(inspectorJs).toMatch(/Output · /);
  });
});
