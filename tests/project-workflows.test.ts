import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILENAME, loadConfig } from "../src/config";
import {
  deleteProjectWorkflow,
  loadProjectWorkflows,
  saveProjectWorkflow,
} from "../src/config/project-workflows";
import type { WorkflowSpec } from "../src/workflow/types";

/** Fresh temp dir and the path of its `steamtrain.json`. */
function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "steamtrain-proj-"));
}
function cfg(cwd: string): string {
  return join(cwd, CONFIG_FILENAME);
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
  return JSON.parse(readFileSync(cfg(cwd), "utf8"));
}

function mergedConfig(cwd: string) {
  return loadConfig({ customPath: cfg(cwd) }).config;
}

describe("saveProjectWorkflow", () => {
  it("creates steamtrain.json with the workflow when none exists", () => {
    const cwd = tmpCwd();
    const result = saveProjectWorkflow("my-flow", sampleSpec("my-flow"), cfg(cwd));

    expect(result.ok).toBe(true);
    expect(result.replaced).toBe(false);
    expect(loadProjectWorkflows(cfg(cwd))["my-flow"]?.name).toBe("my-flow");
  });

  it("preserves other config keys on write", () => {
    const cwd = tmpCwd();
    writeFileSync(
      cfg(cwd),
      JSON.stringify({
        timeoutMs: 12345,
        binaries: { codex: "/usr/bin/codex" },
        maxConcurrency: 2,
      }),
    );

    const result = saveProjectWorkflow("my-flow", sampleSpec("my-flow"), cfg(cwd));
    expect(result.ok).toBe(true);

    const config = mergedConfig(cwd);
    expect(config.stepTimeoutSec).toBe(12.345);
    expect(config.workflowTimeoutSec).toBe(12.345);
    expect(config.timeoutMs).toBe(12345);
    expect(config.binaries).toEqual({ codex: "/usr/bin/codex" });
    expect(config.maxConcurrency).toBe(2);
    expect((config.workflows as Record<string, unknown>)["my-flow"]).toBeDefined();
  });

  it("reports replaced when overwriting an existing project workflow", () => {
    const cwd = tmpCwd();
    saveProjectWorkflow("my-flow", sampleSpec("my-flow"), cfg(cwd));
    const result = saveProjectWorkflow("my-flow", sampleSpec("my-flow"), cfg(cwd));
    expect(result.replaced).toBe(true);
  });

  it("rejects an invalid spec without writing", () => {
    const cwd = tmpCwd();
    const bad = { name: "bad", phases: [] } as unknown as WorkflowSpec;
    const result = saveProjectWorkflow("bad", bad, cfg(cwd));
    expect(result.ok).toBe(false);
    expect(loadProjectWorkflows(cfg(cwd))).toEqual({});
  });

  it("canonicalizes the stored name to the key", () => {
    const cwd = tmpCwd();
    saveProjectWorkflow("renamed", sampleSpec("original"), cfg(cwd));
    expect(loadProjectWorkflows(cfg(cwd)).renamed?.name).toBe("renamed");
  });

  it("refuses to clobber an unparseable steamtrain.json", () => {
    const cwd = tmpCwd();
    writeFileSync(cfg(cwd), "{ not valid json");
    const result = saveProjectWorkflow("my-flow", sampleSpec("my-flow"), cfg(cwd));
    expect(result.ok).toBe(false);
    // The original (broken) file is left untouched, not overwritten.
    expect(readFileSync(cfg(cwd), "utf8")).toBe("{ not valid json");
  });

  it("refuses to clobber a non-object top-level config (e.g. an array)", () => {
    const cwd = tmpCwd();
    writeFileSync(cfg(cwd), JSON.stringify([1, 2, 3]));
    const result = saveProjectWorkflow("my-flow", sampleSpec("my-flow"), cfg(cwd));
    expect(result.ok).toBe(false);
    expect(JSON.parse(readFileSync(cfg(cwd), "utf8"))).toEqual([1, 2, 3]);
  });

  it("fails loud when the existing config would not survive a strict load", () => {
    // The file already holds an unrecognized top-level key, so the engine would
    // ignore it wholesale at load time — a written workflow would be invisible.
    // Refuse at write time (with a clear error) instead, and leave the file as-is.
    const cwd = tmpCwd();
    const original = JSON.stringify({ workflows: {}, bogusKey: true });
    writeFileSync(cfg(cwd), original);
    const result = saveProjectWorkflow("my-flow", sampleSpec("my-flow"), cfg(cwd));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot save/i);
    expect(readFileSync(cfg(cwd), "utf8")).toBe(original);
  });
});

describe("deleteProjectWorkflow", () => {
  it("removes the workflow but keeps other config keys", () => {
    const cwd = tmpCwd();
    writeFileSync(cfg(cwd), JSON.stringify({ timeoutMs: 999 }));
    saveProjectWorkflow("a", sampleSpec("a"), cfg(cwd));
    saveProjectWorkflow("b", sampleSpec("b"), cfg(cwd));

    const result = deleteProjectWorkflow("a", cfg(cwd));
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(true);

    const remaining = loadProjectWorkflows(cfg(cwd));
    expect(remaining.a).toBeUndefined();
    expect(remaining.b).toBeDefined();
    expect(readConfig(cwd).timeoutMs).toBe(999);
    expect(mergedConfig(cwd).stepTimeoutSec).toBe(0.999);
  });

  it("is a no-op (still ok) when the workflow is absent", () => {
    const cwd = tmpCwd();
    const result = deleteProjectWorkflow("ghost", cfg(cwd));
    expect(result.ok).toBe(true);
    expect(result.removed).toBe(false);
  });

  it("rejects deletion when merged config would fail schema validation (M15)", () => {
    const cwd = tmpCwd();
    // Write a config with an unrecognized top-level key — the strict schema
    // rejects it. Deleting a workflow from it should fail rather than write
    // a config the engine would ignore.
    writeFileSync(
      cfg(cwd),
      JSON.stringify({ workflows: { a: sampleSpec("a") }, bogusKey: true }),
    );
    const result = deleteProjectWorkflow("a", cfg(cwd));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot delete/i);
    // The original file should be untouched.
    const raw = JSON.parse(readFileSync(cfg(cwd), "utf8"));
    expect(raw.bogusKey).toBe(true);
    expect(raw.workflows.a).toBeDefined();
  });
});

describe("loadProjectWorkflows", () => {
  it("returns an empty map when no config exists", () => {
    expect(loadProjectWorkflows(cfg(tmpCwd()))).toEqual({});
  });

  it("matches the engine: drops a semantically-invalid entry, keeps valid ones", () => {
    const cwd = tmpCwd();
    // `bad` is structurally valid but its step depends on a nonexistent step, so
    // validateWorkflow (the same gate the engine runs) rejects just that entry.
    const bad: WorkflowSpec = {
      name: "bad",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [
            {
              id: "s",
              kind: "worker",
              agent: "opencode",
              model: "opencode/glm-5",
              prompt: "x",
              dependsOn: ["ghost"],
            },
          ],
        },
      ],
    };
    writeFileSync(cfg(cwd), JSON.stringify({ workflows: { good: sampleSpec("good"), bad } }));
    const loaded = loadProjectWorkflows(cfg(cwd));
    expect(loaded.good).toBeDefined();
    expect(loaded.bad).toBeUndefined();
  });

  it("matches the engine: an unknown top-level key voids the whole file", () => {
    const cwd = tmpCwd();
    // configFileSchema is strict, so the engine rejects the entire file (and so
    // must this loader, or the live catalog would diverge from a fresh run).
    // This parity is also why saveProjectWorkflow refuses to write into such a
    // file (see "fails loud when the existing config would not survive a strict
    // load" above) — together they avoid a save that silently disappears.
    writeFileSync(
      cfg(cwd),
      JSON.stringify({ workflows: { good: sampleSpec("good") }, bogusKey: true }),
    );
    expect(loadProjectWorkflows(cfg(cwd))).toEqual({});
  });
});
