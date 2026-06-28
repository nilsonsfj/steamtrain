import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILENAME, loadConfig } from "../src/config";
import { saveProjectConfig } from "../src/config/project-config";
import { resolveWorkflowTimeoutSec } from "../src/workflow/timeout";
import type { WorkflowSpec } from "../src/workflow/types";

function tmpConfig(): { cwd: string; path: string } {
  const cwd = mkdtempSync(join(tmpdir(), "steamtrain-projcfg-"));
  return { cwd, path: join(cwd, CONFIG_FILENAME) };
}

const demoSpec = (): WorkflowSpec => ({
  name: "demo",
  phases: [
    {
      id: "p",
      title: "P",
      steps: [{ id: "s0", agent: "opencode", model: "m", prompt: "go" }],
    },
  ],
});

describe("saveProjectConfig", () => {
  it("clears workflow timeout and strips legacy timeoutMs from disk", () => {
    const { path } = tmpConfig();
    writeFileSync(
      path,
      JSON.stringify({
        timeoutMs: 120_000,
        workflowTimeoutSec: 120,
        stepTimeoutSec: 60,
      }),
    );

    const saved = saveProjectConfig({ workflowTimeoutSec: undefined }, path);
    expect(saved.ok).toBe(true);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.workflowTimeoutSec).toBeUndefined();
    expect(onDisk.timeoutMs).toBeUndefined();
    expect(onDisk.stepTimeoutSec).toBe(60);

    const loaded = loadConfig({ customPath: path }).config;
    expect(loaded.workflowTimeoutSec).toBeUndefined();
    expect(resolveWorkflowTimeoutSec(demoSpec(), loaded)).toBe(60);
  });

  it("strips legacy millisecond keys when saving any timeout patch", () => {
    const { path } = tmpConfig();
    writeFileSync(
      path,
      JSON.stringify({
        timeoutMs: 90_000,
        stepTimeoutMs: 45_000,
        workflowTimeoutMs: 180_000,
      }),
    );

    const saved = saveProjectConfig({ stepTimeoutSec: 120 }, path);
    expect(saved.ok).toBe(true);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk).toEqual({ stepTimeoutSec: 120 });
    expect(saved.config?.stepTimeoutSec).toBe(120);
    expect(saved.config?.workflowTimeoutSec).toBeUndefined();
  });
});
