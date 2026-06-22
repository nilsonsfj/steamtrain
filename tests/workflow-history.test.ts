import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import { runWorkflow } from "../src/workflow/engine";
import type { WorkflowEvent } from "../src/workflow/events";
import { RUN_RECORD_VERSION, RunRecordBuilder } from "../src/workflow/history";
import { createWorkflowHistoryStore } from "../src/workflow/history-store";
import type { WorkflowSpec } from "../src/workflow/types";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "steamtrain-history-"));
}

const fanOutSpec: WorkflowSpec = {
  name: "fan-out",
  phases: [
    { id: "p1", title: "Split", steps: [{ id: "split", kind: "distributor", items: ["a", "b"] }] },
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

function fakeAdapter(id: AgentId): AgentAdapter {
  return {
    id,
    binary: "fake",
    run(opts: AgentRunOptions) {
      return (async function* () {
        yield {
          kind: "result",
          agent: id,
          ts: 0,
          isError: false,
          text: `out:${opts.prompt}`,
          costUsd: 0.01,
        } satisfies AgentEvent;
      })();
    },
  };
}

async function recordRun(spec: WorkflowSpec, input: string, cwd: string) {
  const builder = new RunRecordBuilder({ id: "run-1", workflow: spec.name, input, cwd });
  let ok = true;
  for await (const event of runWorkflow(
    spec,
    { input },
    { createAdapter: fakeAdapter, maxConcurrency: 2, cwd },
  )) {
    builder.handle(event as WorkflowEvent);
    if (event.kind === "workflow_done") ok = event.ok;
  }
  return builder.build({ status: ok ? "done" : "error" });
}

describe("RunRecordBuilder", () => {
  it("folds a run into a phase -> step tree with totals", async () => {
    const cwd = tempDir();
    const record = await recordRun(fanOutSpec, "go", cwd);

    expect(record.version).toBe(RUN_RECORD_VERSION);
    expect(record.workflow).toBe("fan-out");
    expect(record.status).toBe("done");
    expect(record.ok).toBe(true);
    expect(record.phases).toHaveLength(2);

    const work = record.phases[1]!;
    // distributor parent's two children are recorded as their own steps.
    const childIds = work.steps.map((s) => s.stepId);
    expect(childIds).toContain("work[0]");
    expect(childIds).toContain("work[1]");

    // The fan-out parent is excluded from totals (children counted instead).
    expect(record.totals.steps).toBe(3); // split + work[0] + work[1]
    expect(record.totals.ok).toBe(3);
    expect(record.totals.failed).toBe(0);
    expect(record.totals.costUsd).toBeCloseTo(0.02);
  });

  it("captures step output and error status on failure", async () => {
    const cwd = tempDir();
    const failingAdapter = (id: AgentId): AgentAdapter => ({
      id,
      binary: "fake",
      run() {
        return (async function* () {
          yield { kind: "error", agent: id, ts: 0, message: "boom" } satisfies AgentEvent;
        })();
      },
    });
    const spec: WorkflowSpec = {
      name: "single",
      phases: [
        { id: "p1", title: "One", steps: [{ id: "a", agent: "claude", model: "m", prompt: "x" }] },
      ],
    };
    const builder = new RunRecordBuilder({ id: "r", workflow: "single", input: "i", cwd });
    let ok = true;
    for await (const event of runWorkflow(
      spec,
      { input: "i" },
      { createAdapter: failingAdapter, maxConcurrency: 1, cwd },
    )) {
      builder.handle(event as WorkflowEvent);
      if (event.kind === "workflow_done") ok = event.ok;
    }
    const record = builder.build({ status: ok ? "done" : "error" });

    expect(record.status).toBe("error");
    expect(record.ok).toBe(false);
    const step = record.phases[0]!.steps[0]!;
    expect(step.status).toBe("error");
    expect(step.text).toContain("boom");
  });

  it("marks a canceled run terminal even mid-flight", () => {
    const builder = new RunRecordBuilder({ id: "r", workflow: "wf", input: "i", cwd: "/tmp" });
    builder.handle({ kind: "workflow_start", name: "wf", phaseCount: 1, stepCount: 1, ts: 1 });
    builder.handle({
      kind: "phase_start",
      phaseId: "p1",
      title: "One",
      index: 0,
      stepCount: 1,
      ts: 2,
    });
    builder.handle({
      kind: "step_start",
      phaseId: "p1",
      stepId: "a",
      blockKind: "worker",
      ts: 3,
    });
    const record = builder.build({ status: "canceled" });
    expect(record.status).toBe("canceled");
    expect(record.ok).toBe(false);
    expect(record.phases[0]!.steps[0]!.status).toBe("running");
  });
});

describe("workflow history store", () => {
  it("round-trips records and lists newest first", async () => {
    const root = tempDir();
    const store = createWorkflowHistoryStore(root);
    const cwd = tempDir();

    const first = await recordRun(fanOutSpec, "first", cwd);
    first.id = "a";
    first.startedAt = 1000;
    const second = await recordRun(fanOutSpec, "second", cwd);
    second.id = "b";
    second.startedAt = 2000;

    await store.save(first);
    await store.save(second);

    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
    expect(list[0]).not.toHaveProperty("phases");

    const full = await store.get("a");
    expect(full?.phases).toHaveLength(2);
    expect(await store.get("missing")).toBeUndefined();
  });

  it("prunes to the retention limit", async () => {
    const root = tempDir();
    const store = createWorkflowHistoryStore(root, 2);
    const cwd = tempDir();
    for (let i = 0; i < 5; i++) {
      const record = await recordRun(fanOutSpec, `run-${i}`, cwd);
      record.id = `id-${i}`;
      record.startedAt = i;
      await store.save(record);
    }
    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.id)).toEqual(["id-4", "id-3"]);
  });

  it("ignores corrupt and wrong-version files", async () => {
    const root = tempDir();
    const store = createWorkflowHistoryStore(root);
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "bad.json"), "{ not json", "utf8");
    await writeFile(join(root, "old.json"), JSON.stringify({ version: 0, id: "old" }), "utf8");
    expect(await store.list()).toEqual([]);
  });

  it("removes one record and clears all", async () => {
    const root = tempDir();
    const store = createWorkflowHistoryStore(root);
    const cwd = tempDir();
    const a = await recordRun(fanOutSpec, "a", cwd);
    a.id = "a";
    const b = await recordRun(fanOutSpec, "b", cwd);
    b.id = "b";
    await store.save(a);
    await store.save(b);

    await store.remove("a");
    expect((await store.list()).map((s) => s.id)).toEqual(["b"]);

    await store.clearAll();
    expect(await store.list()).toEqual([]);
  });
});
