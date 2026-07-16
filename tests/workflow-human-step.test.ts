import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  HUMAN_INPUT_MAX_ATTEMPTS,
  type HumanInputProvider,
  type HumanInputRequest,
  RunRecordBuilder,
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  headlessHumanInputProvider,
  initialWorkflowState,
  matchPendingInput,
  runWorkflow,
  validateHumanInputValue,
  validateWorkflow,
  workflowReducer,
} from "../src/workflow";

function fakeAdapter(id: AgentId): AgentAdapter {
  return {
    id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        yield {
          kind: "result",
          agent: "claude",
          ts: 0,
          isError: false,
          text: `out:${opts.prompt}`,
        } as AgentEvent;
      })();
    },
  };
}

function makeDeps(requestHumanInput?: HumanInputProvider): WorkflowDeps {
  return {
    createAdapter: fakeAdapter,
    maxConcurrency: 4,
    cwd: "/base",
    requestHumanInput,
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

const findDone = (events: WorkflowEvent[], stepId: string) =>
  events.find((e) => e.kind === "step_done" && e.stepId === stepId) as
    | (WorkflowEvent & { kind: "step_done" })
    | undefined;

/** One human step feeding a downstream agent step. */
const humanSpec: WorkflowSpec = {
  name: "ask-human",
  phases: [
    {
      id: "ask",
      title: "Ask",
      steps: [
        { id: "context", kind: "human", prompt: "Paste the incident timeline for {{input}}" },
      ],
    },
    {
      id: "work",
      title: "Work",
      steps: [
        {
          id: "analyze",
          agent: "claude",
          model: "sonnet",
          prompt: "analyze: {{steps.context.output}}",
          dependsOn: ["context"],
        },
      ],
    },
  ],
};

describe("human step spec validation", () => {
  it("accepts a minimal human step and choices", () => {
    expect(validateWorkflow(humanSpec).ok).toBe(true);
    const withChoices: WorkflowSpec = {
      name: "w",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [{ id: "pick", kind: "human", prompt: "pick one", choices: ["a", "b"] }],
        },
      ],
    };
    expect(validateWorkflow(withChoices).ok).toBe(true);
  });

  it("rejects choices combined with an output schema", () => {
    const bad: WorkflowSpec = {
      name: "w",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [
            {
              id: "pick",
              kind: "human",
              prompt: "pick",
              choices: ["a"],
              output: { type: "object" },
            },
          ],
        },
      ],
    };
    const result = validateWorkflow(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("mutually exclusive");
  });

  it("rejects a human step without a prompt", () => {
    const bad = {
      name: "w",
      phases: [{ id: "p", title: "P", steps: [{ id: "ask", kind: "human" }] }],
    } as unknown as WorkflowSpec;
    expect(validateWorkflow(bad).ok).toBe(false);
  });
});

describe("human step engine", () => {
  it("renders the prompt, awaits the provider, and feeds the answer downstream", async () => {
    const requests: HumanInputRequest[] = [];
    const provider: HumanInputProvider = async (req) => {
      requests.push(req);
      return { value: "the server ran out of disk", by: "human:test" };
    };
    const events = await collect(humanSpec, makeDeps(provider), { input: "incident-42" });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.prompt).toBe("Paste the incident timeline for incident-42");
    expect(requests[0]!.origin).toBe("human-step");

    const pending = events.find((e) => e.kind === "human_input_pending");
    const resolved = events.find((e) => e.kind === "human_input_resolved");
    expect(pending).toMatchObject({ stepId: "context", attempt: 1, origin: "human-step" });
    expect(resolved).toMatchObject({
      stepId: "context",
      value: "the server ran out of disk",
      by: "human:test",
    });

    const context = findDone(events, "context");
    expect(context?.result.ok).toBe(true);
    expect(context?.result.output).toBe("the server ran out of disk");
    expect(context?.result.suppliedBy).toBe("human:test");
    expect(findDone(events, "analyze")?.result.output).toBe(
      "out:analyze: the server ran out of disk",
    );
  });

  it("caches an accepted answer so a resumed run replays instead of re-asking", async () => {
    let asks = 0;
    const provider: HumanInputProvider = async () => {
      asks += 1;
      return { value: "answer", by: "human:test" };
    };
    const cache = new Map<string, StepResult>();
    await collect(humanSpec, makeDeps(provider), { cache });
    expect(asks).toBe(1);
    const events = await collect(humanSpec, makeDeps(provider), { cache });
    expect(asks).toBe(1); // replayed, not re-asked
    expect(findDone(events, "context")?.cached).toBe(true);
    // A fresh run (cleared cache — what --fresh does) re-asks.
    const freshEvents = await collect(humanSpec, makeDeps(provider), {
      cache: new Map<string, StepResult>(),
    });
    expect(asks).toBe(2);
    expect(findDone(freshEvents, "context")?.cached).toBe(false);
  });

  it("treats a throwing provider as a canceled ask (never crashes the run)", async () => {
    const provider: HumanInputProvider = async () => {
      throw new Error("UI exploded");
    };
    const events = await collect(humanSpec, makeDeps(provider));
    const done = findDone(events, "context");
    expect(done?.result.ok).toBe(false);
    expect(done?.result.error).toContain("human-input provider failed: UI exploded");
    const resolved = events.find((e) => e.kind === "human_input_resolved");
    expect(resolved).toMatchObject({ canceled: true, by: "auto:provider-error" });
    // The run still settles cleanly with a workflow_done.
    const workflowDone = events.find((e) => e.kind === "workflow_done") as
      | (WorkflowEvent & { kind: "workflow_done" })
      | undefined;
    expect(workflowDone?.ok).toBe(false);
  });

  it("fails the step with guidance when no provider is configured", async () => {
    const events = await collect(humanSpec, makeDeps(undefined));
    const context = findDone(events, "context");
    expect(context?.result.ok).toBe(false);
    expect(context?.result.error).toContain("no human-input provider");
    // The dependent never executes — it settles as a failed-dependency placeholder.
    expect(findDone(events, "analyze")?.result.ok).toBe(false);
    expect(findDone(events, "analyze")?.result.error).toContain("dependency 'context' failed");
    const resolved = events.find((e) => e.kind === "human_input_resolved");
    expect(resolved).toMatchObject({ canceled: true });
  });

  it("re-asks with retryError on an invalid choice, then accepts", async () => {
    const spec: WorkflowSpec = {
      name: "choices",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [
            { id: "pick", kind: "human", prompt: "pick a design", choices: ["blue", "green"] },
          ],
        },
      ],
    };
    const answers = ["purple", "2"];
    const seen: HumanInputRequest[] = [];
    const provider: HumanInputProvider = async (req) => {
      seen.push(req);
      return { value: answers.shift() ?? "", by: "human:test" };
    };
    const events = await collect(spec, makeDeps(provider));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.attempt).toBe(2);
    expect(seen[1]!.retryError).toContain("one of the choices");
    // "2" resolves to the second choice by 1-based index.
    expect(findDone(events, "pick")?.result.output).toBe("green");
    const pendings = events.filter((e) => e.kind === "human_input_pending");
    expect(pendings).toHaveLength(2);
    const resolved = events.filter((e) => e.kind === "human_input_resolved");
    expect(resolved).toHaveLength(1);
  });

  it("fails after exhausting attempts on persistently invalid answers", async () => {
    const spec: WorkflowSpec = {
      name: "choices",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [{ id: "pick", kind: "human", prompt: "pick", choices: ["a", "b"] }],
        },
      ],
    };
    let asks = 0;
    const provider: HumanInputProvider = async () => {
      asks += 1;
      return { value: "nope", by: "human:test" };
    };
    const events = await collect(spec, makeDeps(provider));
    expect(asks).toBe(HUMAN_INPUT_MAX_ATTEMPTS);
    const done = findDone(events, "pick");
    expect(done?.result.ok).toBe(false);
    expect(done?.result.error).toContain("no acceptable answer");
    // The ask still ends with exactly one resolved event (canceled).
    const resolved = events.filter((e) => e.kind === "human_input_resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ canceled: true });
  });

  it("validates a JSON reply against the output schema and stores parsed json", async () => {
    const spec: WorkflowSpec = {
      name: "typed",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [
            {
              id: "form",
              kind: "human",
              prompt: "fill the form",
              output: {
                type: "object",
                properties: { severity: { enum: ["low", "high"] } },
                required: ["severity"],
              },
            },
          ],
        },
      ],
    };
    const provider: HumanInputProvider = async () => ({
      value: '{"severity": "high"}',
      by: "human:test",
    });
    const events = await collect(spec, makeDeps(provider));
    const done = findDone(events, "form");
    expect(done?.result.ok).toBe(true);
    expect(done?.result.json).toEqual({ severity: "high" });
    expect(done?.result.output).toBe('{"severity":"high"}');
  });

  it("settles as canceled when the run aborts mid-wait", async () => {
    const controller = new AbortController();
    const provider: HumanInputProvider = () =>
      new Promise(() => {
        // Never settles on its own; the abort race must unblock the run.
        controller.abort();
      });
    const events = await collect(humanSpec, makeDeps(provider), { signal: controller.signal });
    const done = findDone(events, "context");
    expect(done?.result.ok).toBe(false);
    expect(done?.result.error).toContain("canceled");
  });

  it("headlessHumanInputProvider resolves supplied values and cancels missing ones", async () => {
    const provider = headlessHumanInputProvider({ context: "from --human" });
    const events = await collect(humanSpec, makeDeps(provider));
    expect(findDone(events, "context")?.result.output).toBe("from --human");
    expect(findDone(events, "context")?.result.suppliedBy).toBe("headless:--human");

    const empty = headlessHumanInputProvider({});
    const failed = await collect(humanSpec, makeDeps(empty));
    const done = findDone(failed, "context");
    expect(done?.result.ok).toBe(false);
    expect(done?.result.error).toContain("--human context=");
  });
});

describe("human input value validation", () => {
  it("accepts exact choice text and 1-based indexes", () => {
    expect(validateHumanInputValue("blue", { choices: ["blue", "green"] })).toMatchObject({
      ok: true,
      output: "blue",
    });
    expect(validateHumanInputValue(" 1 ", { choices: ["blue", "green"] })).toMatchObject({
      ok: true,
      output: "blue",
    });
    expect(validateHumanInputValue("3", { choices: ["blue", "green"] }).ok).toBe(false);
  });

  it("prefers a literal choice over index interpretation", () => {
    expect(validateHumanInputValue("2", { choices: ["2", "4"] })).toMatchObject({
      ok: true,
      output: "2",
    });
  });

  it("rejects blank free text", () => {
    expect(validateHumanInputValue("  \n ", {}).ok).toBe(false);
    expect(validateHumanInputValue(" fine ", {})).toMatchObject({ ok: true, output: "fine" });
  });
});

describe("human input reducer + history", () => {
  it("tracks pending inputs, supersedes re-asks, and clears on resolve", () => {
    let state = initialWorkflowState;
    const apply = (event: WorkflowEvent) => {
      state = workflowReducer(state, { type: "event", event });
    };
    apply({ kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 1 });
    apply({ kind: "phase_start", phaseId: "p", title: "P", index: 0, stepCount: 1, ts: 1 });
    apply({ kind: "step_start", phaseId: "p", stepId: "ask", blockKind: "human", ts: 1 });
    apply({
      kind: "human_input_pending",
      phaseId: "p",
      stepId: "ask",
      attempt: 1,
      prompt: "q?",
      origin: "human-step",
      ts: 2,
    });
    expect(state.pendingInputs).toHaveLength(1);
    expect(state.pendingInputs?.[0]).toMatchObject({ stepId: "ask", attempt: 1 });
    // A re-ask supersedes rather than stacking.
    apply({
      kind: "human_input_pending",
      phaseId: "p",
      stepId: "ask",
      attempt: 2,
      prompt: "q?",
      origin: "human-step",
      retryError: "bad answer",
      ts: 3,
    });
    expect(state.pendingInputs).toHaveLength(1);
    expect(state.pendingInputs?.[0]).toMatchObject({ attempt: 2, retryError: "bad answer" });
    const step = state.phases[0]!.steps[0]!;
    expect(step.humanInput).toMatchObject({ pending: true, attempt: 2 });

    apply({
      kind: "human_input_resolved",
      phaseId: "p",
      stepId: "ask",
      value: "answer",
      by: "human:web",
      origin: "human-step",
      ts: 4,
    });
    expect(state.pendingInputs).toHaveLength(0);
    expect(state.phases[0]!.steps[0]!.humanInput).toMatchObject({
      pending: false,
      value: "answer",
      by: "human:web",
    });
  });

  it("records the exchange into run history", () => {
    const builder = new RunRecordBuilder({ id: "r1", workflow: "w", input: "go", cwd: "/" });
    const events: WorkflowEvent[] = [
      { kind: "workflow_start", name: "w", phaseCount: 1, stepCount: 1, ts: 1 },
      { kind: "phase_start", phaseId: "p", title: "P", index: 0, stepCount: 1, ts: 1 },
      { kind: "step_start", phaseId: "p", stepId: "ask", blockKind: "human", ts: 1 },
      {
        kind: "human_input_pending",
        phaseId: "p",
        stepId: "ask",
        attempt: 1,
        prompt: "q?",
        choices: ["a", "b"],
        origin: "human-step",
        ts: 2,
      },
      {
        kind: "human_input_resolved",
        phaseId: "p",
        stepId: "ask",
        value: "a",
        by: "human:cli",
        origin: "human-step",
        ts: 3,
      },
      {
        kind: "step_done",
        phaseId: "p",
        stepId: "ask",
        result: { stepId: "ask", ok: true, output: "a", durationMs: 5, suppliedBy: "human:cli" },
        cached: false,
        ts: 4,
      },
      { kind: "phase_done", phaseId: "p", ok: true, ts: 5 },
      { kind: "workflow_done", ok: true, results: [], ts: 6 },
    ];
    for (const event of events) builder.handle(event);
    const record = builder.build({ status: "done" });
    const step = record.phases[0]!.steps[0]!;
    expect(step.humanInput).toMatchObject({
      prompt: "q?",
      choices: ["a", "b"],
      origin: "human-step",
      value: "a",
      by: "human:cli",
    });
  });
});

describe("human step inside a sub-workflow", () => {
  it("surfaces the nested ask under a namespaced id and answers it", async () => {
    const child: WorkflowSpec = {
      name: "child",
      phases: [
        { id: "cp", title: "CP", steps: [{ id: "ask", kind: "human", prompt: "child asks?" }] },
      ],
    };
    const parent: WorkflowSpec = {
      name: "parent",
      phases: [
        { id: "p", title: "P", steps: [{ id: "call", kind: "workflow", workflow: "child" }] },
      ],
    };
    const requests: HumanInputRequest[] = [];
    const provider: HumanInputProvider = async (req) => {
      requests.push(req);
      return { value: "nested answer", by: "human:test" };
    };
    const deps: WorkflowDeps = {
      ...makeDeps(provider),
      resolveWorkflow: (name) => (name === "child" ? child : undefined),
    };
    const events = await collect(parent, deps);

    // The provider sees the child's LOCAL id (matching approval semantics)…
    expect(requests[0]!.stepId).toBe("ask");
    // …while the surfaced events carry the NAMESPACED id, so every UI can
    // render and answer the nested ask.
    const pending = events.find((e) => e.kind === "human_input_pending");
    const resolved = events.find((e) => e.kind === "human_input_resolved");
    expect(pending).toMatchObject({ stepId: "call::ask", phaseId: "call::cp" });
    expect(resolved).toMatchObject({ stepId: "call::ask", value: "nested answer" });

    expect(findDone(events, "call::ask")?.result.output).toBe("nested answer");
    expect(findDone(events, "call")?.result.ok).toBe(true);
    expect(findDone(events, "call")?.result.output).toBe("nested answer");
  });
});

describe("matchPendingInput", () => {
  it("matches local and namespaced step ids", () => {
    const pending = [{ stepId: "parent::ask", iteration: 1, attempt: 1 }];
    expect(matchPendingInput(pending, "ask")).toBe(pending[0]);
    expect(matchPendingInput(pending, "parent::ask")).toBe(pending[0]);
    expect(matchPendingInput(pending, "other")).toBeUndefined();
    expect(matchPendingInput(pending, "ask", 2)).toBeUndefined();
  });
});
