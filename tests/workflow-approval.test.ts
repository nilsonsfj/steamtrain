import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type ApprovalDecision,
  type ApprovalProvider,
  type ApprovalRequest,
  RunRecordBuilder,
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  headlessApprovalProvider,
  initialWorkflowState,
  runWorkflow,
  validateWorkflow,
  workflowReducer,
} from "../src/workflow";

/** A minimal fake adapter that emits one result carrying the model in its text. */
function fakeAdapter(id: AgentId): AgentAdapter {
  return {
    id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        yield { kind: "session_start", agent: "claude", ts: 0 } as AgentEvent;
        yield {
          kind: "result",
          agent: "claude",
          ts: 0,
          isError: false,
          text: `out:${opts.model}`,
          costUsd: 0.001,
        } as AgentEvent;
      })();
    },
  };
}

function makeDeps(requestApproval?: ApprovalProvider): WorkflowDeps {
  return {
    createAdapter: fakeAdapter,
    maxConcurrency: 4,
    cwd: "/base",
    requestApproval,
  };
}

async function collect(
  spec: WorkflowSpec,
  deps: WorkflowDeps,
  opts: { signal?: AbortSignal; cache?: Map<string, StepResult>; input?: string } = {},
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(
    spec,
    { input: opts.input ?? "go", cache: opts.cache },
    deps,
    opts.signal,
  )) {
    events.push(ev);
  }
  return events;
}

/** A workflow: one agent step, then an approval step reviewing it, then a final step. */
const approvalSpec: WorkflowSpec = {
  name: "approve-plan",
  phases: [
    {
      id: "plan",
      title: "Plan",
      steps: [{ id: "draft", agent: "claude", model: "opus", prompt: "{{input}}" }],
    },
    {
      id: "gate",
      title: "Approve",
      steps: [
        {
          id: "ok-to-proceed",
          kind: "approval",
          step: "draft",
          prompt: "Approve the draft?",
          dependsOn: ["draft"],
        },
      ],
    },
    {
      id: "impl",
      title: "Implement",
      steps: [
        {
          id: "build",
          agent: "claude",
          model: "sonnet",
          prompt: "{{steps.draft.output}}",
          dependsOn: ["ok-to-proceed"],
        },
      ],
    },
  ],
};

const findDone = (events: WorkflowEvent[], stepId: string) =>
  events.find((e) => e.kind === "step_done" && e.stepId === stepId) as
    | (WorkflowEvent & { kind: "step_done" })
    | undefined;

describe("approval engine", () => {
  it("approves a checkpoint and continues to the dependent step", async () => {
    const requests: ApprovalRequest[] = [];
    const provider: ApprovalProvider = async (req) => {
      requests.push(req);
      return { approved: true, by: "human:test" };
    };
    const events = await collect(approvalSpec, makeDeps(provider));

    expect(requests).toHaveLength(1);
    expect(requests[0]!.reviewStepId).toBe("draft");
    expect(requests[0]!.output).toBe("out:opus");
    expect(requests[0]!.message).toBe("Approve the draft?");

    const pending = events.find((e) => e.kind === "approval_pending");
    const resolved = events.find((e) => e.kind === "approval_resolved");
    expect(pending).toBeDefined();
    expect(resolved).toMatchObject({ approved: true, by: "human:test", stepId: "ok-to-proceed" });

    expect(findDone(events, "ok-to-proceed")?.result.ok).toBe(true);
    expect(findDone(events, "build")?.result.ok).toBe(true);
    const done = events.find((e) => e.kind === "workflow_done") as
      | (WorkflowEvent & { kind: "workflow_done" })
      | undefined;
    expect(done?.ok).toBe(true);
  });

  it("rejects with onReject 'fail' → the run fails and the dependent step does not run", async () => {
    const provider: ApprovalProvider = async () => ({ approved: false, by: "human:test" });
    const events = await collect(approvalSpec, makeDeps(provider));

    expect(findDone(events, "ok-to-proceed")?.result.ok).toBe(false);
    expect(findDone(events, "build")).toBeUndefined();
    const done = events.find((e) => e.kind === "workflow_done") as
      | (WorkflowEvent & { kind: "workflow_done" })
      | undefined;
    expect(done?.ok).toBe(false);
  });

  it("rejects with onReject 'stop' → a graceful halt that does not start later steps", async () => {
    const stopSpec: WorkflowSpec = {
      name: "approve-stop",
      phases: [
        {
          id: "plan",
          title: "Plan",
          steps: [{ id: "draft", agent: "claude", model: "opus", prompt: "{{input}}" }],
        },
        {
          id: "gate",
          title: "Approve",
          steps: [
            { id: "chk", kind: "approval", step: "draft", onReject: "stop", dependsOn: ["draft"] },
          ],
        },
        {
          id: "impl",
          title: "Implement",
          steps: [{ id: "build", agent: "claude", model: "s", prompt: "x", dependsOn: ["chk"] }],
        },
      ],
    };
    const provider: ApprovalProvider = async () => ({ approved: false });
    const events = await collect(stopSpec, makeDeps(provider));
    expect(findDone(events, "build")).toBeUndefined();
    const gate = events.find((e) => e.kind === "gate_evaluated" && e.stepId === "chk");
    expect(gate).toMatchObject({ passed: false });
    // A graceful stop keeps the run successful (unlike a fail rejection).
    const done = events.find((e) => e.kind === "workflow_done") as
      | (WorkflowEvent & { kind: "workflow_done" })
      | undefined;
    expect(done?.ok).toBe(true);
  });

  it("degrades gracefully when the provider throws (no crash, treated as rejection)", async () => {
    const provider: ApprovalProvider = async () => {
      throw new Error("provider exploded");
    };
    const events = await collect(approvalSpec, makeDeps(provider));
    const resolved = events.find((e) => e.kind === "approval_resolved") as
      | (WorkflowEvent & { kind: "approval_resolved" })
      | undefined;
    expect(resolved?.approved).toBe(false);
    expect(resolved?.by).toBe("auto:provider-error");
    // The run settles (a failing checkpoint) instead of crashing.
    const done = events.find((e) => e.kind === "workflow_done") as
      | (WorkflowEvent & { kind: "workflow_done" })
      | undefined;
    expect(done).toBeDefined();
    expect(done?.ok).toBe(false);
    expect(findDone(events, "ok-to-proceed")?.result.ok).toBe(false);
  });

  it("routes a gate with condition.human like an approval", async () => {
    const humanGateSpec: WorkflowSpec = {
      name: "human-gate",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "draft", agent: "claude", model: "opus", prompt: "{{input}}" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "human",
              kind: "gate",
              condition: { human: true, step: "draft" },
              onFalse: "fail",
              target: "shipit",
              dependsOn: ["draft"],
            },
          ],
        },
      ],
    };
    const provider: ApprovalProvider = async () => ({ approved: true });
    const events = await collect(humanGateSpec, makeDeps(provider));
    const gate = events.find((e) => e.kind === "gate_evaluated" && e.stepId === "human");
    expect(gate).toMatchObject({ passed: true, target: "shipit" });
    expect(events.find((e) => e.kind === "approval_pending")).toBeDefined();
  });

  it("with no provider configured auto-rejects the checkpoint", async () => {
    const events = await collect(approvalSpec, makeDeps(undefined));
    const resolved = events.find((e) => e.kind === "approval_resolved") as
      | (WorkflowEvent & { kind: "approval_resolved" })
      | undefined;
    expect(resolved?.approved).toBe(false);
    expect(resolved?.by).toBe("auto:no-provider");
    expect(findDone(events, "build")).toBeUndefined();
  });

  it("with no provider and a human gate onFalse:continue, the run continues", async () => {
    const spec: WorkflowSpec = {
      name: "human-continue",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "draft", agent: "claude", model: "opus", prompt: "{{input}}" }],
        },
        {
          id: "p2",
          title: "Gate",
          steps: [
            {
              id: "chk",
              kind: "gate",
              condition: { human: true, step: "draft" },
              onFalse: "continue",
              dependsOn: ["draft"],
            },
          ],
        },
        {
          id: "p3",
          title: "After",
          steps: [{ id: "after", agent: "claude", model: "s", prompt: "x", dependsOn: ["chk"] }],
        },
      ],
    };
    const events = await collect(spec, makeDeps(undefined));
    // No provider → rejected, but onFalse:continue keeps the run going.
    expect(findDone(events, "chk")?.result.ok).toBe(true);
    expect(findDone(events, "after")?.result.ok).toBe(true);
  });

  it("honors a headless approve-all provider", async () => {
    const events = await collect(approvalSpec, makeDeps(headlessApprovalProvider("approve-all")));
    expect(findDone(events, "build")?.result.ok).toBe(true);
    const resolved = events.find((e) => e.kind === "approval_resolved") as
      | (WorkflowEvent & { kind: "approval_resolved" })
      | undefined;
    expect(resolved?.by).toBe("auto:approve-all");
  });

  it("does not cache the approval decision — a resumed run re-asks", async () => {
    let calls = 0;
    const provider: ApprovalProvider = async () => {
      calls += 1;
      return { approved: true };
    };
    const cache = new Map<string, StepResult>();
    await collect(approvalSpec, makeDeps(provider), { cache });
    expect(calls).toBe(1);
    expect(cache.has("draft")).toBe(true);
    expect(cache.has("ok-to-proceed")).toBe(false);
    await collect(approvalSpec, makeDeps(provider), { cache });
    expect(calls).toBe(2);
  });

  it("unblocks a pending approval when the run is aborted", async () => {
    const ac = new AbortController();
    const provider: ApprovalProvider = () => new Promise<ApprovalDecision>(() => {});
    let sawPending = false;
    const events: WorkflowEvent[] = [];
    for await (const ev of runWorkflow(
      approvalSpec,
      { input: "go" },
      makeDeps(provider),
      ac.signal,
    )) {
      events.push(ev);
      if (ev.kind === "approval_pending" && !sawPending) {
        sawPending = true;
        ac.abort();
      }
    }
    expect(sawPending).toBe(true);
    const done = events.find((e) => e.kind === "workflow_done") as
      | (WorkflowEvent & { kind: "workflow_done" })
      | undefined;
    expect(done?.ok).toBe(false);
  });
});

describe("headless approval provider", () => {
  it("approve-all approves", async () => {
    const d = await headlessApprovalProvider("approve-all")({} as ApprovalRequest);
    expect(d).toMatchObject({ approved: true, by: "auto:approve-all" });
  });
  it("reject-fail rejects with the fail disposition", async () => {
    const d = await headlessApprovalProvider("reject-fail")({} as ApprovalRequest);
    expect(d).toMatchObject({ approved: false, rejectDisposition: "fail" });
  });
  it("reject-stop rejects with the stop disposition", async () => {
    const d = await headlessApprovalProvider("reject-stop")({} as ApprovalRequest);
    expect(d).toMatchObject({ approved: false, rejectDisposition: "stop" });
  });
});

describe("approval validation", () => {
  it("rejects an approval step referencing a step not in an earlier phase", () => {
    const spec: WorkflowSpec = {
      name: "bad",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "chk", kind: "approval", step: "draft" },
            { id: "draft", agent: "claude", model: "m", prompt: "x" },
          ],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/approval 'chk' step references/);
  });

  it("rejects a human gate combined with a mechanical predicate", () => {
    const spec: WorkflowSpec = {
      name: "bad-human",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "draft", agent: "claude", model: "m", prompt: "x" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "g",
              kind: "gate",
              condition: { human: true, contains: "done", step: "draft" },
              dependsOn: ["draft"],
            },
          ],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/human cannot be combined/);
  });

  it("accepts a well-formed approval workflow", () => {
    expect(validateWorkflow(approvalSpec).ok).toBe(true);
  });
});

describe("approval reducer + history", () => {
  it("tracks a pending approval then clears it on resolution", () => {
    let state = initialWorkflowState;
    state = workflowReducer(state, {
      type: "event",
      event: {
        kind: "phase_start",
        phaseId: "gate",
        title: "Approve",
        index: 0,
        stepCount: 1,
        iteration: 1,
        ts: 0,
      },
    });
    state = workflowReducer(state, {
      type: "event",
      event: {
        kind: "step_start",
        phaseId: "gate",
        stepId: "chk",
        blockKind: "approval",
        iteration: 1,
        ts: 0,
      },
    });
    state = workflowReducer(state, {
      type: "event",
      event: {
        kind: "approval_pending",
        phaseId: "gate",
        stepId: "chk",
        reviewStepId: "draft",
        message: "ok?",
        output: "the plan",
        onReject: "fail",
        iteration: 1,
        ts: 1,
      },
    });
    expect(state.pendingApprovals).toHaveLength(1);
    expect(state.pendingApprovals?.[0]).toMatchObject({ stepId: "chk", reviewStepId: "draft" });
    expect(state.phases[0]!.steps[0]!.approval?.pending).toBe(true);

    state = workflowReducer(state, {
      type: "event",
      event: {
        kind: "approval_resolved",
        phaseId: "gate",
        stepId: "chk",
        approved: true,
        by: "human:test",
        iteration: 1,
        ts: 2,
      },
    });
    expect(state.pendingApprovals).toHaveLength(0);
    expect(state.phases[0]!.steps[0]!.approval).toMatchObject({
      pending: false,
      approved: true,
      by: "human:test",
    });
  });

  it("records the approval decision in the run history", async () => {
    const builder = new RunRecordBuilder({
      id: "r",
      workflow: approvalSpec.name,
      input: "go",
      cwd: "/base",
    });
    for await (const ev of runWorkflow(
      approvalSpec,
      { input: "go" },
      makeDeps(headlessApprovalProvider("approve-all")),
    )) {
      builder.handle(ev);
    }
    const record = builder.build({ status: "done" });
    let approvalStep: { approval?: { approved?: boolean; by?: string } } | undefined;
    for (const phase of record.phases) {
      for (const step of phase.steps) {
        if (step.stepId === "ok-to-proceed") approvalStep = step;
      }
    }
    expect(approvalStep?.approval).toMatchObject({ approved: true, by: "auto:approve-all" });
  });
});
