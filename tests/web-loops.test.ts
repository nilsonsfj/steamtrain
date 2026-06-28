import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type WorkflowHost, WorkflowRunManager } from "../src/web/runs";
import { createWebServer } from "../src/web/server";
import type { StepResult, WorkflowCacheStore, WorkflowEvent, WorkflowSpec } from "../src/workflow";
import { validateWorkflow } from "../src/workflow/types";
import { readSse } from "./helpers/read-sse";

const loopWorkflow: WorkflowSpec = {
  name: "review-loop",
  phases: [
    {
      id: "review",
      title: "review",
      steps: [{ id: "r", agent: "opencode", model: "m", prompt: "review {{input}}" }],
    },
    {
      id: "fix",
      title: "fix",
      steps: [{ id: "f", agent: "opencode", model: "m", prompt: "fix {{steps.r.output}}" }],
    },
    {
      id: "check",
      title: "check",
      steps: [
        {
          id: "g",
          kind: "gate",
          dependsOn: ["f"],
          condition: { step: "f", contains: "DONE" },
          loopTo: "review",
          maxIterations: 4,
          onFalse: "fail",
        },
      ],
    },
  ],
};

const noopStore: WorkflowCacheStore = {
  rootDir: "/tmp/none",
  async load() {
    return new Map<string, StepResult>();
  },
  async save() {},
  async clear() {},
  async clearAll() {},
};

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

class FakeHost implements WorkflowHost {
  constructor(
    private readonly spec: WorkflowSpec,
    private readonly gen: (input: string, signal?: AbortSignal) => AsyncIterable<WorkflowEvent>,
  ) {}
  listWorkflows(): Record<string, WorkflowSpec> {
    return { [this.spec.name]: this.spec };
  }
  canDispatchWorkflowSpec(): { ok: true } | { ok: false; reason: string } {
    return { ok: true };
  }
  runWorkflow(name: string, input: string, signal?: AbortSignal): AsyncIterable<WorkflowEvent> {
    return this.gen(input, signal);
  }
}

/** A synthetic loop event stream: two iterations of review → fix → gate, with
 * the gate looping back once and converging on the second pass. */
async function* loopRun(): AsyncIterable<WorkflowEvent> {
  const ts = () => Date.now();
  yield { kind: "workflow_start", name: "review-loop", phaseCount: 3, stepCount: 3, ts: ts() };
  // Iteration 1
  yield {
    kind: "phase_start",
    phaseId: "review",
    title: "review",
    index: 0,
    stepCount: 1,
    iteration: 1,
    ts: ts(),
  };
  yield {
    kind: "step_start",
    phaseId: "review",
    stepId: "r",
    blockKind: "worker",
    agent: "opencode",
    model: "m",
    iteration: 1,
    ts: ts(),
  };
  yield {
    kind: "step_done",
    phaseId: "review",
    stepId: "r",
    result: { stepId: "r", ok: true, output: "v1", durationMs: 1 },
    cached: false,
    iteration: 1,
    ts: ts(),
  };
  yield { kind: "phase_done", phaseId: "review", ok: true, iteration: 1, ts: ts() };
  yield {
    kind: "phase_start",
    phaseId: "fix",
    title: "fix",
    index: 1,
    stepCount: 1,
    iteration: 1,
    ts: ts(),
  };
  yield {
    kind: "step_start",
    phaseId: "fix",
    stepId: "f",
    blockKind: "worker",
    agent: "opencode",
    model: "m",
    iteration: 1,
    ts: ts(),
  };
  yield {
    kind: "step_done",
    phaseId: "fix",
    stepId: "f",
    result: { stepId: "f", ok: true, output: "NOPE", durationMs: 1 },
    cached: false,
    iteration: 1,
    ts: ts(),
  };
  yield { kind: "phase_done", phaseId: "fix", ok: true, iteration: 1, ts: ts() };
  yield {
    kind: "phase_start",
    phaseId: "check",
    title: "check",
    index: 2,
    stepCount: 1,
    iteration: 1,
    ts: ts(),
  };
  yield {
    kind: "step_start",
    phaseId: "check",
    stepId: "g",
    blockKind: "gate",
    dependsOn: ["f"],
    iteration: 1,
    loopTo: "review",
    maxIterations: 4,
    ts: ts(),
  };
  yield {
    kind: "gate_evaluated",
    phaseId: "check",
    stepId: "g",
    passed: false,
    target: "blocked",
    onFalse: "fail",
    iteration: 1,
    ts: ts(),
  };
  yield {
    kind: "step_done",
    phaseId: "check",
    stepId: "g",
    result: {
      stepId: "g",
      ok: false,
      output: "blocked",
      gate: { passed: false, onFalse: "fail" },
      durationMs: 1,
    },
    cached: false,
    iteration: 1,
    ts: ts(),
  };
  yield { kind: "phase_done", phaseId: "check", ok: false, iteration: 1, ts: ts() };
  // Loop back → iteration 2
  yield {
    kind: "loop_iteration",
    gateStepId: "g",
    loopTo: "review",
    iteration: 2,
    maxIterations: 4,
    ts: ts(),
  };
  yield {
    kind: "phase_start",
    phaseId: "review",
    title: "review",
    index: 0,
    stepCount: 1,
    iteration: 2,
    ts: ts(),
  };
  yield {
    kind: "step_start",
    phaseId: "review",
    stepId: "r",
    blockKind: "worker",
    agent: "opencode",
    model: "m",
    iteration: 2,
    ts: ts(),
  };
  yield {
    kind: "step_done",
    phaseId: "review",
    stepId: "r",
    result: { stepId: "r", ok: true, output: "v2", durationMs: 1 },
    cached: false,
    iteration: 2,
    ts: ts(),
  };
  yield { kind: "phase_done", phaseId: "review", ok: true, iteration: 2, ts: ts() };
  yield {
    kind: "phase_start",
    phaseId: "fix",
    title: "fix",
    index: 1,
    stepCount: 1,
    iteration: 2,
    ts: ts(),
  };
  yield {
    kind: "step_start",
    phaseId: "fix",
    stepId: "f",
    blockKind: "worker",
    agent: "opencode",
    model: "m",
    iteration: 2,
    ts: ts(),
  };
  yield {
    kind: "step_done",
    phaseId: "fix",
    stepId: "f",
    result: { stepId: "f", ok: true, output: "DONE", durationMs: 1 },
    cached: false,
    iteration: 2,
    ts: ts(),
  };
  yield { kind: "phase_done", phaseId: "fix", ok: true, iteration: 2, ts: ts() };
  yield {
    kind: "phase_start",
    phaseId: "check",
    title: "check",
    index: 2,
    stepCount: 1,
    iteration: 2,
    ts: ts(),
  };
  yield {
    kind: "step_start",
    phaseId: "check",
    stepId: "g",
    blockKind: "gate",
    dependsOn: ["f"],
    iteration: 2,
    loopTo: "review",
    maxIterations: 4,
    ts: ts(),
  };
  yield {
    kind: "gate_evaluated",
    phaseId: "check",
    stepId: "g",
    passed: true,
    target: "passed",
    onFalse: "fail",
    iteration: 2,
    ts: ts(),
  };
  yield {
    kind: "step_done",
    phaseId: "check",
    stepId: "g",
    result: {
      stepId: "g",
      ok: true,
      output: "passed",
      gate: { passed: true, onFalse: "fail" },
      durationMs: 1,
    },
    cached: false,
    iteration: 2,
    ts: ts(),
  };
  yield { kind: "phase_done", phaseId: "check", ok: true, iteration: 2, ts: ts() };
  yield { kind: "workflow_done", ok: true, results: [], ts: ts() };
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("web accepts loop workflows", () => {
  it("validates a loop spec the authoring layer would persist", () => {
    expect(validateWorkflow(loopWorkflow)).toEqual({ ok: true });
  });

  it("streams iteration-tagged phase_start and loop_iteration markers over SSE", async () => {
    const runs = new WorkflowRunManager({
      host: new FakeHost(loopWorkflow, loopRun),
      cacheStore: noopStore,
      cwd: "/tmp",
      config: { stepTimeoutSec: 60, workflowTimeoutSec: 60 * 60 },
    });
    const server = createWebServer({
      host: new FakeHost(loopWorkflow, loopRun),
      runs,
      workflowSource: () => "bundled",
    });
    servers.push(server);
    const base = await start(server);

    const created = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "review-loop", input: "go" }),
    });
    expect(created.status).toBe(201);
    const { runId } = (await created.json()) as { runId: string };

    const frames = await readSse(`${base}/api/runs/${runId}/stream`);
    const events = frames.filter((f) => f.type === "event").map((f) => f.event as WorkflowEvent);

    // phase_start carries iteration tags (1 and 2 for the review phase).
    const reviewStarts = events.filter((e) => e.kind === "phase_start" && e.phaseId === "review");
    expect(reviewStarts.map((e) => (e.kind === "phase_start" ? e.iteration : undefined))).toEqual([
      1, 2,
    ]);

    // loop_iteration marker is emitted with the about-to-start iteration.
    const loopMarkers = events.filter((e) => e.kind === "loop_iteration");
    expect(loopMarkers).toHaveLength(1);
    const marker = loopMarkers[0];
    expect(marker).toBeDefined();
    if (marker && marker.kind === "loop_iteration") {
      expect(marker.gateStepId).toBe("g");
      expect(marker.loopTo).toBe("review");
      expect(marker.iteration).toBe(2);
      expect(marker.maxIterations).toBe(4);
    }

    // The run converged (workflow_done ok:true).
    const done = events.find((e) => e.kind === "workflow_done");
    expect(done && (done as { ok: boolean }).ok).toBe(true);
  });
});
