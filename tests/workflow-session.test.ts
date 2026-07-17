import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  runWorkflow,
  sessionSourceId,
  validateWorkflow,
} from "../src/workflow";

/** What one scripted agent invocation replies with. */
interface ScriptedReply {
  text: string;
  sessionId?: string;
  isError?: boolean;
}

/**
 * A fake adapter that records every invocation and replies from `script`,
 * which sees the run options and the 0-based global call index.
 */
function scriptedAdapter(
  script: (opts: AgentRunOptions, call: number) => ScriptedReply,
  calls: AgentRunOptions[],
  supportsResume = true,
): (id: AgentId) => AgentAdapter {
  let call = 0;
  return (id: AgentId) => ({
    id,
    binary: "fake",
    defaultModel: "test",
    supportsResume,
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      calls.push(opts);
      const reply = script(opts, call++);
      return (async function* () {
        if (reply.sessionId) {
          yield {
            kind: "session_start",
            agent: id,
            ts: 0,
            sessionId: reply.sessionId,
          } as AgentEvent;
        }
        yield {
          kind: "result",
          agent: id,
          ts: 0,
          isError: Boolean(reply.isError),
          text: reply.text,
        } as AgentEvent;
      })();
    },
  });
}

async function collect(
  spec: WorkflowSpec,
  deps: WorkflowDeps,
  ctx: { input?: string; cache?: Map<string, StepResult> } = {},
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input: ctx.input ?? "go", cache: ctx.cache }, deps)) {
    events.push(ev);
  }
  return events;
}

const findDone = (events: WorkflowEvent[], stepId: string) =>
  events.find((e) => e.kind === "step_done" && e.stepId === stepId) as
    | (WorkflowEvent & { kind: "step_done" })
    | undefined;

/** plan (phase 1) → impl (phase 2) continuing plan's session. */
function chainSpec(overrides: Partial<Record<"plan" | "impl", object>> = {}): WorkflowSpec {
  return {
    name: "chain",
    phases: [
      {
        id: "p1",
        title: "Plan",
        steps: [
          { id: "plan", agent: "claude", model: "m", prompt: "plan {{input}}", ...overrides.plan },
        ],
      },
      {
        id: "p2",
        title: "Implement",
        steps: [
          {
            id: "impl",
            agent: "claude",
            model: "m",
            prompt: "implement the plan",
            session: "continue:plan",
            ...overrides.impl,
          },
        ],
      },
    ],
  };
}

describe("sessionSourceId", () => {
  it("parses continue:<stepId> and ignores steps without the field", () => {
    expect(
      sessionSourceId({
        id: "a",
        agent: "claude",
        model: "m",
        prompt: "p",
        session: "continue:plan",
      }),
    ).toBe("plan");
    expect(sessionSourceId({ id: "a", agent: "claude", model: "m", prompt: "p" })).toBeUndefined();
    expect(
      sessionSourceId({ id: "g", kind: "gate", condition: { ok: true, step: "a" } }),
    ).toBeUndefined();
  });
});

describe("session validation", () => {
  it("accepts continuing an earlier-phase step on the same agent", () => {
    expect(validateWorkflow(chainSpec()).ok).toBe(true);
  });

  it("rejects a malformed session value", () => {
    const spec = chainSpec({ impl: { session: "resume:plan" } });
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('session must be "continue:<stepId>"');
  });

  it("rejects an unknown source step", () => {
    const result = validateWorkflow(chainSpec({ impl: { session: "continue:ghost" } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown step 'ghost'");
  });

  it("rejects a same-phase source", () => {
    const spec: WorkflowSpec = {
      name: "same-phase",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [
            { id: "a", agent: "claude", model: "m", prompt: "x" },
            { id: "b", agent: "claude", model: "m", prompt: "y", session: "continue:a" },
          ],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not in an earlier phase");
  });

  it("rejects a non-agent source", () => {
    const spec: WorkflowSpec = {
      name: "cmd-source",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "tests", kind: "command", cmd: "true" }] },
        {
          id: "p2",
          title: "P2",
          steps: [{ id: "b", agent: "claude", model: "m", prompt: "y", session: "continue:tests" }],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not an agent-backed step");
  });

  it("rejects continuing a different agent's session", () => {
    const result = validateWorkflow(chainSpec({ plan: { agent: "opencode" } }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("same agent instance");
  });

  it("rejects session combined with forEach on the continuing step", () => {
    const spec: WorkflowSpec = {
      name: "fanout-continuer",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "plan", agent: "claude", model: "m", prompt: "plan" },
            { id: "areas", kind: "distributor", items: ["a", "b"] },
          ],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "impl",
              agent: "claude",
              model: "m",
              prompt: "do {{item}}",
              forEach: "steps.areas.items",
              session: "continue:plan",
            },
          ],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot combine session with forEach");
  });

  it("rejects continuing a forEach fan-out source", () => {
    const spec: WorkflowSpec = {
      name: "fanout-source",
      phases: [
        { id: "p0", title: "P0", steps: [{ id: "areas", kind: "distributor", items: ["a", "b"] }] },
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "work",
              agent: "claude",
              model: "m",
              prompt: "do {{item}}",
              forEach: "steps.areas.items",
            },
          ],
        },
        {
          id: "p2",
          title: "P2",
          steps: [{ id: "b", agent: "claude", model: "m", prompt: "y", session: "continue:work" }],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("fan-out step 'work'");
  });

  it("rejects two steps continuing the same source session", () => {
    const spec: WorkflowSpec = {
      name: "double-continue",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "plan", agent: "claude", model: "m", prompt: "plan" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            { id: "implA", agent: "claude", model: "m", prompt: "a", session: "continue:plan" },
            { id: "implB", agent: "claude", model: "m", prompt: "b", session: "continue:plan" },
          ],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("both continue session 'plan'");
  });

  it("accepts a linear chain of continuations", () => {
    const spec: WorkflowSpec = {
      name: "chain-3",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "a", agent: "claude", model: "m", prompt: "a" }] },
        {
          id: "p2",
          title: "P2",
          steps: [{ id: "b", agent: "claude", model: "m", prompt: "b", session: "continue:a" }],
        },
        {
          id: "p3",
          title: "P3",
          steps: [{ id: "c", agent: "claude", model: "m", prompt: "c", session: "continue:b" }],
        },
      ],
    };
    expect(validateWorkflow(spec).ok).toBe(true);
  });

  it("accepts self-continuation inside a loop region", () => {
    expect(validateWorkflow(selfLoopSpec()).ok).toBe(true);
  });

  it("rejects self-continuation outside a loop region", () => {
    const spec = chainSpec({ impl: { session: "continue:impl" } });
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("inside a loop region");
  });
});

/** fixer continuing its own previous iteration, looped by a gate until DONE. */
function selfLoopSpec(): WorkflowSpec {
  return {
    name: "fix-loop",
    phases: [
      {
        id: "fix",
        title: "Fix",
        steps: [
          {
            id: "fixer",
            agent: "claude",
            model: "m",
            prompt: "fix (iter {{iteration}})",
            session: "continue:fixer",
          },
        ],
      },
      {
        id: "check",
        title: "Check",
        steps: [
          {
            id: "verdict",
            kind: "gate",
            dependsOn: ["fixer"],
            condition: { step: "fixer", contains: "DONE" },
            loopTo: "fix",
            maxIterations: 5,
            onFalse: "fail",
          },
        ],
      },
    ],
  };
}

describe("session continuity engine", () => {
  it("resumes the source step's recorded session and records the lineage", async () => {
    const calls: AgentRunOptions[] = [];
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter(
        (opts) =>
          opts.prompt.startsWith("plan")
            ? { text: "the plan", sessionId: "ses-plan" }
            : { text: "implemented", sessionId: "ses-impl" },
        calls,
      ),
      maxConcurrency: 2,
      cwd: "/base",
    };
    const events = await collect(chainSpec(), deps);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.resumeSessionId).toBeUndefined();
    expect(calls[1]!.resumeSessionId).toBe("ses-plan");

    const done = findDone(events, "impl");
    expect(done?.result.ok).toBe(true);
    expect(done?.result.sessionId).toBe("ses-impl");
    expect(done?.result.resumedSessionId).toBe("ses-plan");
    expect(findDone(events, "plan")?.result.resumedSessionId).toBeUndefined();
  });

  it("fails the step loudly when the adapter cannot resume sessions", async () => {
    const calls: AgentRunOptions[] = [];
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter(() => ({ text: "ok", sessionId: "s" }), calls, false),
      maxConcurrency: 2,
      cwd: "/base",
    };
    const events = await collect(chainSpec(), deps);
    const done = findDone(events, "impl");
    expect(done?.result.ok).toBe(false);
    expect(done?.result.error).toContain("cannot resume recorded sessions");
    // Only the plan step actually spawned an agent.
    expect(calls).toHaveLength(1);
  });

  it("fails the step when the source recorded no session id", async () => {
    const calls: AgentRunOptions[] = [];
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter((opts) => ({ text: `did ${opts.prompt}` }), calls),
      maxConcurrency: 2,
      cwd: "/base",
    };
    const events = await collect(chainSpec(), deps);
    const done = findDone(events, "impl");
    expect(done?.result.ok).toBe(false);
    expect(done?.result.error).toContain("recorded no agent session id");
    expect(calls).toHaveLength(1);
  });

  it("cascades a skipped source into a skipped continuer", async () => {
    const calls: AgentRunOptions[] = [];
    const spec = chainSpec({ plan: { when: { contains: "never-matches" } } });
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter(() => ({ text: "x", sessionId: "s" }), calls),
      maxConcurrency: 2,
      cwd: "/base",
    };
    const events = await collect(spec, deps);
    expect(findDone(events, "plan")?.result.skipped).toBe(true);
    const done = findDone(events, "impl");
    expect(done?.result.skipped).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("fails the continuer when the source failed (implicit dependency)", async () => {
    const calls: AgentRunOptions[] = [];
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter(
        (opts) =>
          opts.prompt.startsWith("plan")
            ? { text: "boom", isError: true, sessionId: "s" }
            : { text: "implemented", sessionId: "s2" },
        calls,
      ),
      maxConcurrency: 2,
      cwd: "/base",
    };
    const events = await collect(chainSpec(), deps);
    const done = findDone(events, "impl");
    expect(done?.result.ok).toBe(false);
    expect(done?.result.error).toContain("dependency 'plan' failed");
    expect(calls).toHaveLength(1);
  });

  it("self-continuation resumes the previous loop iteration's session", async () => {
    const calls: AgentRunOptions[] = [];
    let fixCalls = 0;
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter(() => {
        fixCalls += 1;
        return { text: fixCalls >= 3 ? "DONE" : "NOPE", sessionId: `s${fixCalls}` };
      }, calls),
      maxConcurrency: 2,
      cwd: "/base",
    };
    const events = await collect(selfLoopSpec(), deps);

    expect(calls.map((c) => c.resumeSessionId)).toEqual([undefined, "s1", "s2"]);
    // The final gate evaluation (3rd pass) converged.
    const gateDones = events.filter(
      (e) => e.kind === "step_done" && e.stepId === "verdict",
    ) as (WorkflowEvent & { kind: "step_done" })[];
    expect(gateDones[gateDones.length - 1]?.result.gate?.passed).toBe(true);

    // The last fixer pass carries the chained lineage.
    const fixerDones = events.filter(
      (e) => e.kind === "step_done" && e.stepId === "fixer",
    ) as (WorkflowEvent & { kind: "step_done" })[];
    const last = fixerDones[fixerDones.length - 1];
    expect(last?.result.sessionId).toBe("s3");
    expect(last?.result.resumedSessionId).toBe("s2");
  });

  it("fails a self-continuing step loudly on iteration 1 when the adapter cannot resume", async () => {
    const calls: AgentRunOptions[] = [];
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter(() => ({ text: "DONE", sessionId: "s" }), calls, false),
      maxConcurrency: 2,
      cwd: "/base",
    };
    const events = await collect(selfLoopSpec(), deps);
    const done = findDone(events, "fixer");
    expect(done?.result.ok).toBe(false);
    expect(done?.result.error).toContain("cannot resume recorded sessions");
    // Fails before spawning — not silently fresh on every pass.
    expect(calls).toHaveLength(0);
  });

  it("the structured-output fix turn resumes the step's own session", async () => {
    const calls: AgentRunOptions[] = [];
    const spec: WorkflowSpec = {
      name: "structured",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "judge",
              agent: "claude",
              model: "m",
              prompt: "judge it",
              output: {
                type: "object",
                properties: { verdict: { type: "string" } },
                required: ["verdict"],
              },
            },
          ],
        },
      ],
    };
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter(
        (_opts, call) =>
          call === 0
            ? { text: "not json at all", sessionId: "ses-main" }
            : { text: '{"verdict":"pass"}', sessionId: "ses-fix" },
        calls,
      ),
      maxConcurrency: 2,
      cwd: "/base",
    };
    const events = await collect(spec, deps);

    expect(calls).toHaveLength(2);
    // The fix turn continues the conversation that produced the invalid reply.
    expect(calls[1]!.resumeSessionId).toBe("ses-main");
    const done = findDone(events, "judge");
    expect(done?.result.ok).toBe(true);
    expect(done?.result.json).toEqual({ verdict: "pass" });
    // The latest session (the fix turn's) is what a later continue: resumes.
    expect(done?.result.sessionId).toBe("ses-fix");
  });

  it("resumes from a cached source result (cross-run resume)", async () => {
    const calls: AgentRunOptions[] = [];
    const cache = new Map<string, StepResult>([
      [
        "plan",
        { stepId: "plan", ok: true, output: "the plan", durationMs: 1, sessionId: "ses-cached" },
      ],
    ]);
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter(() => ({ text: "implemented", sessionId: "ses-impl" }), calls),
      maxConcurrency: 2,
      cwd: "/base",
    };
    const events = await collect(chainSpec(), deps, { cache });

    expect(findDone(events, "plan")?.cached).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.resumeSessionId).toBe("ses-cached");
  });

  it("replays a cached continuer whose lineage still matches the source", async () => {
    const calls: AgentRunOptions[] = [];
    const cache = new Map<string, StepResult>([
      ["plan", { stepId: "plan", ok: true, output: "the plan", durationMs: 1, sessionId: "ses-a" }],
      [
        "impl",
        {
          stepId: "impl",
          ok: true,
          output: "implemented",
          durationMs: 1,
          sessionId: "ses-b",
          resumedSessionId: "ses-a",
        },
      ],
    ]);
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter(() => ({ text: "should not run" }), calls),
      maxConcurrency: 2,
      cwd: "/base",
    };
    const events = await collect(chainSpec(), deps, { cache });
    expect(findDone(events, "impl")?.cached).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("re-runs a cached continuer when the source re-ran with a fresh session", async () => {
    const calls: AgentRunOptions[] = [];
    // Only the continuer is cached: its recorded lineage (ses-old) no longer
    // matches what the freshly-run source records (ses-new).
    const cache = new Map<string, StepResult>([
      [
        "impl",
        {
          stepId: "impl",
          ok: true,
          output: "stale",
          durationMs: 1,
          sessionId: "ses-stale",
          resumedSessionId: "ses-old",
        },
      ],
    ]);
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter(
        (opts) =>
          opts.prompt.startsWith("plan")
            ? { text: "fresh plan", sessionId: "ses-new" }
            : { text: "fresh impl", sessionId: "ses-impl-2" },
        calls,
      ),
      maxConcurrency: 2,
      cwd: "/base",
    };
    const events = await collect(chainSpec(), deps, { cache });

    const done = findDone(events, "impl");
    expect(done?.cached).toBe(false);
    expect(done?.result.output).toBe("fresh impl");
    expect(done?.result.resumedSessionId).toBe("ses-new");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.resumeSessionId).toBe("ses-new");
  });
});
