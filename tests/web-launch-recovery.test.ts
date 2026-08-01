import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");

describe("web launch recovery contract", () => {
  it("reconciles an ambiguous POST failure with a recent live run", () => {
    const source = readFileSync(join(PUBLIC_DIR, "st-run.js"), "utf8");

    expect(source).not.toContain("/api/debug-log");
    expect(source).not.toContain("#region agent log");
    expect(source).toContain("function reconcileLaunch(workflow, input, launchedAt)");
    expect(source).toContain('api("GET", "/api/runs")');
    expect(source).toContain("run.external !== true");
    expect(source).toContain('(run.status === "running" || run.status === "queued")');
    expect(source).toContain("run.workflow === workflow");
    expect(source).toContain("run.input === expectedInput");
    expect(source).toContain("run.startedAt >= launchedAt - LAUNCH_RECONCILE_WINDOW_MS");
    expect(source).toContain("attachRun(run)");
    expect(source).toContain('setBanner("could not start run: network error", "err")');
  });
});
