import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  WORKFLOW_CACHE_VERSION,
  createWorkflowCacheStore,
  loadWorkflowCache,
  persistWorkflowStepDone,
  saveWorkflowCache,
  workflowCacheFileName,
  workflowCacheKey,
} from "../src/workflow/cache-store";
import { runWorkflow } from "../src/workflow/engine";
import type { StepResult } from "../src/workflow/types";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "steamtrain-cache-"));
}

function sampleResult(stepId: string, output = "ok"): StepResult {
  return { stepId, ok: true, output, durationMs: 12 };
}

describe("workflow cache store", () => {
  it("round-trips step results to disk", async () => {
    const root = tempDir();
    const key = workflowCacheKey("multi-plan", "design cache", root);
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
  });

  it("isolates caches by workflow, input, and cwd", async () => {
    const root = tempDir();
    const keyA = workflowCacheKey("wf-a", "same text", root);
    const keyB = workflowCacheKey("wf-b", "same text", root);
    const keyC = workflowCacheKey("wf-a", "other text", root);

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
    const key = workflowCacheKey("wf", "input", root);
    await saveWorkflowCache(root, key, new Map([["s1", sampleResult("s1")]]));

    const mismatched = workflowCacheKey("other", "input", root);
    expect(await loadWorkflowCache(root, mismatched)).toEqual(new Map());
  });

  it("clears one cache entry or all entries", async () => {
    const root = tempDir();
    const store = createWorkflowCacheStore(root);
    const keyA = workflowCacheKey("a", "one", root);
    const keyB = workflowCacheKey("b", "two", root);
    await store.save(keyA, new Map([["s1", sampleResult("s1")]]));
    await store.save(keyB, new Map([["s2", sampleResult("s2")]]));

    await store.clear(keyA);
    expect(await store.load(keyA)).toEqual(new Map());
    expect((await store.load(keyB)).get("s2")?.stepId).toBe("s2");

    await store.clearAll();
    expect(await store.load(keyB)).toEqual(new Map());
  });

  it("persists only successful, non-cached step completions", async () => {
    const root = tempDir();
    const store = createWorkflowCacheStore(root);
    const key = workflowCacheKey("wf", "input", root);
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

    const loaded = await store.load(key);
    expect([...loaded.keys()]).toEqual(["ok-step"]);
  });
});

describe("workflow cache resume", () => {
  it("replays persisted steps on a later run", async () => {
    const root = tempDir();
    const store = createWorkflowCacheStore(root);
    const key = workflowCacheKey("two-step", "resume me", root);
    const runs: string[] = [];

    const createAdapter = (id: AgentId): AgentAdapter => ({
      id,
      binary: "fake",
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

    const spec = {
      name: "two-step",
      phases: [
        {
          id: "p1",
          title: "One",
          steps: [{ id: "first", agent: "claude" as const, model: "m", prompt: "first" }],
        },
        {
          id: "p2",
          title: "Two",
          steps: [
            {
              id: "second",
              agent: "claude" as const,
              model: "m",
              prompt: "second",
              dependsOn: ["first"],
            },
          ],
        },
      ],
    };

    const cache = new Map<string, StepResult>();
    for await (const event of runWorkflow(
      spec,
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
      spec,
      { input: key.input, cache: resumed },
      {
        createAdapter: (id) => ({
          id,
          binary: "fake",
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
