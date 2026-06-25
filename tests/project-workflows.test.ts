import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILENAME } from "../src/config";
import {
  deleteProjectWorkflow,
  loadProjectWorkflows,
  saveProjectWorkflow,
} from "../src/config/project-workflows";
import type { WorkflowSpec } from "../src/workflow/types";

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "steamtrain-proj-"));
}

function sampleSpec(name: string): WorkflowSpec {
  return {
    name,
    phases: [
      {
        id: "only",
        title: "Only",
        steps: [
          {
            id: "a",
            kind: "worker",
            agent: "opencode",
            model: "opencode/glm-5",
            prompt: "{{input}}",
          },
        ],
      },
    ],
  };
}

function readConfig(cwd: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cwd, CONFIG_FILENAME), "utf8"));
}

describe("saveProjectWorkflow", () => {
  it("creates steamtrain.json with the workflow when none exists", () => {
    const cwd = tmpCwd();
    const result = saveProjectWorkflow("my-flow", sampleSpec("my-flow"), cwd);

    expect(result.ok).toBe(true);
    expect(result.replaced).toBe(false);
    expect(loadProjectWorkflows(cwd)["my-flow"]?.name).toBe("my-flow");
  });

  it("preserves other config keys on write", () => {
    const cwd = tmpCwd();
    writeFileSync(
      join(cwd, CONFIG_FILENAME),
      JSON.stringify({
        timeoutMs: 12345,
        binaries: { codex: "/usr/bin/codex" },
        maxConcurrency: 2,
      }),
    );

    const result = saveProjectWorkflow("my-flow", sampleSpec("my-flow"), cwd);
    expect(result.ok).toBe(true);

    const cfg = readConfig(cwd);
    expect(cfg.timeoutMs).toBe(12345);
    expect(cfg.binaries).toEqual({ codex: "/usr/bin/codex" });
    expect(cfg.maxConcurrency).toBe(2);
    expect((cfg.workflows as Record<string, unknown>)["my-flow"]).toBeDefined();
  });

  it("reports replaced when overwriting an existing project workflow", () => {
    const cwd = tmpCwd();
    saveProjectWorkflow("my-flow", sampleSpec("my-flow"), cwd);
    const result = saveProjectWorkflow("my-flow", sampleSpec("my-flow"), cwd);
    expect(result.replaced).toBe(true);
  });

  it("rejects an invalid spec without writing", () => {
    const cwd = tmpCwd();
    const bad = { name: "bad", phases: [] } as unknown as WorkflowSpec;
    const result = saveProjectWorkflow("bad", bad, cwd);
    expect(result.ok).toBe(false);
    expect(loadProjectWorkflows(cwd)).toEqual({});
  });

  it("canonicalizes the stored name to the key", () => {
    const cwd = tmpCwd();
    saveProjectWorkflow("renamed", sampleSpec("original"), cwd);
    expect(loadProjectWorkflows(cwd).renamed?.name).toBe("renamed");
  });

  it("refuses to clobber an unparseable steamtrain.json", () => {
    const cwd = tmpCwd();
    writeFileSync(join(cwd, CONFIG_FILENAME), "{ not valid json");
    const result = saveProjectWorkflow("my-flow", sampleSpec("my-flow"), cwd);
    expect(result.ok).toBe(false);
    // The original (broken) file is left untouched, not overwritten.
    expect(readFileSync(join(cwd, CONFIG_FILENAME), "utf8")).toBe("{ not valid json");
  });

  it("refuses to clobber a non-object top-level config (e.g. an array)", () => {
    const cwd = tmpCwd();
    writeFileSync(join(cwd, CONFIG_FILENAME), JSON.stringify([1, 2, 3]));
    const result = saveProjectWorkflow("my-flow", sampleSpec("my-flow"), cwd);
    expect(result.ok).toBe(false);
    expect(JSON.parse(readFileSync(join(cwd, CONFIG_FILENAME), "utf8"))).toEqual([1, 2, 3]);
  });
});

describe("deleteProjectWorkflow", () => {
  it("removes the workflow but keeps other config keys", () => {
    const cwd = tmpCwd();
    writeFileSync(join(cwd, CONFIG_FILENAME), JSON.stringify({ timeoutMs: 999 }));
    saveProjectWorkflow("a", sampleSpec("a"), cwd);
    saveProjectWorkflow("b", sampleSpec("b"), cwd);

    const result = deleteProjectWorkflow("a", cwd);
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);

    const remaining = loadProjectWorkflows(cwd);
    expect(remaining.a).toBeUndefined();
    expect(remaining.b).toBeDefined();
    expect(readConfig(cwd).timeoutMs).toBe(999);
  });

  it("is a no-op (still ok) when the workflow is absent", () => {
    const cwd = tmpCwd();
    const result = deleteProjectWorkflow("ghost", cwd);
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });
});

describe("loadProjectWorkflows", () => {
  it("returns an empty map when no config exists", () => {
    expect(loadProjectWorkflows(tmpCwd())).toEqual({});
  });

  it("skips invalid workflow entries rather than throwing", () => {
    const cwd = tmpCwd();
    writeFileSync(
      join(cwd, CONFIG_FILENAME),
      JSON.stringify({ workflows: { good: sampleSpec("good"), bad: { phases: [] } } }),
    );
    const loaded = loadProjectWorkflows(cwd);
    expect(loaded.good).toBeDefined();
    expect(loaded.bad).toBeUndefined();
  });
});
