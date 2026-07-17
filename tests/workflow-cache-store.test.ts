import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  WORKFLOW_CACHE_VERSION,
  createWorkflowCacheStore,
  hashWorkflowCacheInput,
  hashWorkflowSpec,
  loadWorkflowCache,
  persistWorkflowStepDone,
  saveWorkflowCache,
  workflowCacheFileName,
  workflowCacheKey,
} from "../src/workflow/cache-store";
import { runWorkflow } from "../src/workflow/engine";
import type { StepResult, WorkflowSpec } from "../src/workflow/types";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "steamtrain-cache-"));
}

function sampleResult(stepId: string, output = "ok"): StepResult {
  return { stepId, ok: true, output, durationMs: 12 };
}

const twoStepSpec: WorkflowSpec = {
  name: "two-step",
  phases: [
    {
      id: "p1",
      title: "One",
      steps: [{ id: "first", agent: "claude", model: "m", prompt: "first" }],
    },
    {
      id: "p2",
      title: "Two",
      steps: [
        {
          id: "second",
          agent: "claude",
          model: "m",
          prompt: "second",
          dependsOn: ["first"],
        },
      ],
    },
  ],
};

describe("workflow cache store", () => {
  it("round-trips step results to disk", async () => {
    const root = tempDir();
    const key = workflowCacheKey("multi-plan", "design cache", root, {
      name: "multi-plan",
      phases: [],
    });
    const cache = new Map<string, StepResult>([
      ["draft-a", sampleResult("draft-a", "plan a")],
      ["draft-b", sampleResult("draft-b", "plan b")],
    ]);

    await saveWorkflowCache(root, key, cache);
    const loaded = await loadWorkflowCache(root, key);

    expect([...loaded.entries()]).toEqual([...cache.entries()]);
    expect(readFileSync(join(root, workflowCacheFileName(key)), "utf8")).toContain(
      `"version": ${WORKFLOW_CACHE_VERSION}`,
    );
    expect(readFileSync(join(root, workflowCacheFileName(key)), "utf8")).toContain(key.specHash);
  });

  it("isolates caches by workflow, input, and cwd", async () => {
    const root = tempDir();
    const specA = { name: "wf-a", phases: [] };
    const specB = { name: "wf-b", phases: [] };
    const keyA = workflowCacheKey("wf-a", "same text", root, specA);
    const keyB = workflowCacheKey("wf-b", "same text", root, specB);
    const keyC = workflowCacheKey("wf-a", "other text", root, specA);

    await saveWorkflowCache(root, keyA, new Map([["s1", sampleResult("s1", "a")]]));
    await saveWorkflowCache(root, keyB, new Map([["s1", sampleResult("s1", "b")]]));
    await saveWorkflowCache(root, keyC, new Map([["s1", sampleResult("s1", "c")]]));

    expect((await loadWorkflowCache(root, keyA)).get("s1")?.output).toBe("a");
    expect((await loadWorkflowCache(root, keyB)).get("s1")?.output).toBe("b");
    expect((await loadWorkflowCache(root, keyC)).get("s1")?.output).toBe("c");
    expect(workflowCacheFileName(keyA)).not.toBe(workflowCacheFileName(keyB));
  });

  it("rejects stale files when metadata does not match the key", async () => {
    const root = tempDir();
    const spec = { name: "wf", phases: [] };
    const key = workflowCacheKey("wf", "input", root, spec);
    await saveWorkflowCache(root, key, new Map([["s1", sampleResult("s1")]]));

    const mismatched = workflowCacheKey("other", "input", root, spec);
    expect(await loadWorkflowCache(root, mismatched)).toEqual(new Map());
  });

  it("hashes specs with and without undefined fields the same way", () => {
    const withDesc = { name: "wf", description: undefined, phases: [] };
    const withoutDesc = { name: "wf", phases: [] };
    expect(hashWorkflowSpec(withDesc as WorkflowSpec)).toBe(
      hashWorkflowSpec(withoutDesc as WorkflowSpec),
    );
  });

  it("rejects cache when the workflow spec changes", async () => {
    const root = tempDir();
    const specV1: WorkflowSpec = {
      name: "wf",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "a", agent: "claude", model: "m", prompt: "v1" }] },
      ],
    };
    const specV2: WorkflowSpec = {
      name: "wf",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "a", agent: "claude", model: "m", prompt: "v2" }] },
      ],
    };
    const keyV1 = workflowCacheKey("wf", "input", root, specV1);
    await saveWorkflowCache(root, keyV1, new Map([["a", sampleResult("a")]]));

    const keyV2 = workflowCacheKey("wf", "input", root, specV2);
    expect(hashWorkflowSpec(specV1)).not.toBe(hashWorkflowSpec(specV2));
    expect(await loadWorkflowCache(root, keyV2)).toEqual(new Map());
  });

  it("returns an empty map for corrupt cache files", async () => {
    const root = tempDir();
    const key = workflowCacheKey("wf", "input", root, { name: "wf", phases: [] });
    await mkdir(root, { recursive: true });
    await writeFile(join(root, workflowCacheFileName(key)), "{ not valid json", "utf8");

    expect(await loadWorkflowCache(root, key)).toEqual(new Map());
  });

  it("rejects gate steps with invalid gate metadata", async () => {
    const root = tempDir();
    const key = workflowCacheKey("wf", "input", root, { name: "wf", phases: [] });
    await mkdir(root, { recursive: true });
    writeFileSync(
      join(root, workflowCacheFileName(key)),
      JSON.stringify({
        version: WORKFLOW_CACHE_VERSION,
        workflow: "wf",
        cwd: root,
        inputHash: hashWorkflowCacheInput("input"),
        specHash: key.specHash,
        updatedAt: 1,
        steps: {
          gate: {
            stepId: "gate",
            ok: true,
            output: "blocked",
            durationMs: 1,
            gate: { passed: false, onFalse: "stop" },
          },
          tampered: {
            stepId: "tampered",
            ok: true,
            output: "blocked",
            durationMs: 1,
            gate: { passed: false, onFalse: "bogus" },
          },
        },
      }),
      "utf8",
    );

    const loaded = await loadWorkflowCache(root, key);
    expect([...loaded.keys()]).toEqual(["gate"]);
  });

  it("strips unknown fields but preserves known optional fields", async () => {
    const root = tempDir();
    const key = workflowCacheKey("wf", "input", root, { name: "wf", phases: [] });
    await mkdir(root, { recursive: true });
    writeFileSync(
      join(root, workflowCacheFileName(key)),
      JSON.stringify({
        version: WORKFLOW_CACHE_VERSION,
        workflow: "wf",
        cwd: root,
        inputHash: hashWorkflowCacheInput("input"),
        specHash: key.specHash,
        updatedAt: 1,
        steps: {
          s1: {
            stepId: "s1",
            ok: true,
            output: "ok",
            durationMs: 10,
            target: "passed",
            error: "some error",
            costUsd: 0.05,
            attempts: 3,
            iteration: 2,
            items: ["a", "b"],
            json: { verdict: "pass", targets: ["a", "b"] },
            skipped: true,
            parentStepId: "parent",
            extraField: "should be stripped",
            anotherExtra: 42,
          },
        },
      }),
      "utf8",
    );

    const loaded = await loadWorkflowCache(root, key);
    const result = loaded.get("s1");
    expect(result).toBeDefined();
    // Required fields
    expect(result!.stepId).toBe("s1");
    expect(result!.ok).toBe(true);
    expect(result!.output).toBe("ok");
    expect(result!.durationMs).toBe(10);
    // Known optional fields must be preserved
    expect(result!.target).toBe("passed");
    expect(result!.error).toBe("some error");
    expect(result!.costUsd).toBe(0.05);
    expect(result!.attempts).toBe(3);
    expect(result!.iteration).toBe(2);
    expect(result!.items).toEqual(["a", "b"]);
    expect(result!.json).toEqual({ verdict: "pass", targets: ["a", "b"] });
    expect(result!.skipped).toBe(true);
    expect(result!.parentStepId).toBe("parent");
    // Unknown fields must be stripped
    expect((result as unknown as Record<string, unknown>).extraField).toBeUndefined();
    expect((result as unknown as Record<string, unknown>).anotherExtra).toBeUndefined();
  });

  it("drops step entries with invalid shape", async () => {
    const root = tempDir();
    const key = workflowCacheKey("wf", "input", root, { name: "wf", phases: [] });
    await mkdir(root, { recursive: true });
    writeFileSync(
      join(root, workflowCacheFileName(key)),
      JSON.stringify({
        version: WORKFLOW_CACHE_VERSION,
        workflow: "wf",
        cwd: root,
        inputHash: hashWorkflowCacheInput("input"),
        specHash: key.specHash,
        updatedAt: 1,
        steps: {
          good: sampleResult("good"),
          bad: { ok: "yes" },
        },
      }),
      "utf8",
    );

    const loaded = await loadWorkflowCache(root, key);
    expect([...loaded.keys()]).toEqual(["good"]);
  });

  it("clears one cache entry or all entries including temp files", async () => {
    const root = tempDir();
    const store = createWorkflowCacheStore(root);
    const specA = { name: "a", phases: [] };
    const specB = { name: "b", phases: [] };
    const keyA = workflowCacheKey("a", "one", root, specA);
    const keyB = workflowCacheKey("b", "two", root, specB);
    await store.save(keyA, new Map([["s1", sampleResult("s1")]]));
    await store.save(keyB, new Map([["s2", sampleResult("s2")]]));
    writeFileSync(join(root, `${workflowCacheFileName(keyA)}.999.tmp`), "orphan", "utf8");

    await store.clear(keyA);
    expect(await store.load(keyA)).toEqual(new Map());
    expect((await store.load(keyB)).get("s2")?.stepId).toBe("s2");

    await store.clearAll();
    expect(await store.load(keyB)).toEqual(new Map());
    expect(existsSync(join(root, `${workflowCacheFileName(keyA)}.999.tmp`))).toBe(false);
  });

  it("persists only successful, non-cached step completions", async () => {
    const root = tempDir();
    const store = createWorkflowCacheStore(root);
    const key = workflowCacheKey("wf", "input", root, { name: "wf", phases: [] });
    const cache = new Map<string, StepResult>();

    await persistWorkflowStepDone(store, key, cache, "ok-step", sampleResult("ok-step"), false);
    await persistWorkflowStepDone(
      store,
      key,
      cache,
      "cached-step",
      sampleResult("cached-step"),
      true,
    );
    await persistWorkflowStepDone(
      store,
      key,
      cache,
      "bad-step",
      { stepId: "bad-step", ok: false, output: "nope", durationMs: 1 },
      false,
    );
    // A noCache result (approval checkpoint) is never persisted, even when ok.
    await persistWorkflowStepDone(
      store,
      key,
      cache,
      "approval-step",
      { stepId: "approval-step", ok: true, output: "approved", durationMs: 1, noCache: true },
      false,
    );

    const loaded = await store.load(key);
    expect([...loaded.keys()]).toEqual(["ok-step"]);
  });
});

describe("workflow cache resume", () => {
  it("round-trips forEach parent childResults through disk", async () => {
    const root = tempDir();
    const spec: WorkflowSpec = {
      name: "fan-out",
      phases: [
        {
          id: "p1",
          title: "Split",
          steps: [{ id: "split", kind: "distributor", items: ["a", "b"] }],
        },
        {
          id: "p2",
          title: "Work",
          steps: [
            {
              id: "work",
              agent: "claude",
              model: "m",
              dependsOn: ["split"],
              forEach: "steps.split.items",
              prompt: "{{item}}",
            },
          ],
        },
      ],
    };
    const store = createWorkflowCacheStore(root);
    const key = workflowCacheKey("fan-out", "items", root, spec);
    const cache = new Map<string, StepResult>();

    for await (const event of runWorkflow(
      spec,
      { input: key.input, cache },
      {
        createAdapter: (id) => ({
          id,
          binary: "fake",
          defaultModel: "test",
          run(opts: AgentRunOptions) {
            return (async function* () {
              yield {
                kind: "result",
                agent: id,
                ts: 0,
                isError: false,
                text: `out:${opts.prompt}`,
              } satisfies AgentEvent;
            })();
          },
        }),
        maxConcurrency: 2,
        cwd: root,
      },
    )) {
      if (event.kind === "step_done") {
        await persistWorkflowStepDone(store, key, cache, event.stepId, event.result, event.cached);
      }
    }

    const loaded = await store.load(key);
    const parent = loaded.get("work");
    expect(parent?.childResults).toHaveLength(2);
    expect(loaded.get("work[0]")?.output).toContain("a");
    expect(loaded.get("work[1]")?.output).toContain("b");
  });

  it("replays persisted steps on a later run", async () => {
    const root = tempDir();
    const store = createWorkflowCacheStore(root);
    const key = workflowCacheKey("two-step", "resume me", root, twoStepSpec);
    const runs: string[] = [];

    const createAdapter = (id: AgentId): AgentAdapter => ({
      id,
      binary: "fake",
      defaultModel: "test",
      run(opts: AgentRunOptions) {
        return (async function* () {
          runs.push(opts.prompt);
          yield {
            kind: "result",
            agent: id,
            ts: 0,
            isError: false,
            text: `out:${opts.prompt}`,
          } satisfies AgentEvent;
        })();
      },
    });

    const cache = new Map<string, StepResult>();
    for await (const event of runWorkflow(
      twoStepSpec,
      { input: key.input, cache },
      { createAdapter, maxConcurrency: 2, cwd: root },
    )) {
      if (event.kind === "step_done") {
        await persistWorkflowStepDone(store, key, cache, event.stepId, event.result, event.cached);
      }
    }

    expect(runs).toEqual(["first", "second"]);

    const resumed = await store.load(key);
    const replayRuns: string[] = [];
    let cachedSteps = 0;
    for await (const event of runWorkflow(
      twoStepSpec,
      { input: key.input, cache: resumed },
      {
        createAdapter: (id) => ({
          id,
          binary: "fake",
          defaultModel: "test",
          run(opts: AgentRunOptions) {
            return (async function* () {
              replayRuns.push(opts.prompt);
              yield {
                kind: "result",
                agent: id,
                ts: 0,
                isError: false,
                text: `out:${opts.prompt}`,
              } satisfies AgentEvent;
            })();
          },
        }),
        maxConcurrency: 2,
        cwd: root,
      },
    )) {
      if (event.kind === "step_done" && event.cached) cachedSteps += 1;
    }

    expect(replayRuns).toEqual([]);
    expect(cachedSteps).toBe(2);
  });
});

describe("workflow cache session lineage", () => {
  it("round-trips sessionId and resumedSessionId", async () => {
    const rootDir = tempDir();
    const key = workflowCacheKey("two-step", "input", "/cwd", twoStepSpec);
    const cache = new Map<string, StepResult>([
      ["first", { ...sampleResult("first"), sessionId: "ses-a" }],
      ["second", { ...sampleResult("second"), sessionId: "ses-b", resumedSessionId: "ses-a" }],
    ]);
    await saveWorkflowCache(rootDir, key, cache);
    const loaded = await loadWorkflowCache(rootDir, key);
    expect(loaded.get("first")?.sessionId).toBe("ses-a");
    expect(loaded.get("second")?.sessionId).toBe("ses-b");
    expect(loaded.get("second")?.resumedSessionId).toBe("ses-a");
  });
});

function existsSync(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
