import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  AGENT_QUESTION_PROTOCOL,
  type HumanInputProvider,
  type HumanInputRequest,
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  parseAgentQuestion,
  runWorkflow,
} from "../src/workflow";

interface ScriptedTurn {
  /** Reply text for this invocation (in call order). */
  text: string;
  sessionId?: string;
  costUsd?: number;
}

/** A fake adapter that replays scripted turns and records every invocation. */
function scriptedAdapter(
  turns: ScriptedTurn[],
  calls: AgentRunOptions[],
  supportsResume: boolean,
): (id: AgentId) => AgentAdapter {
  let call = 0;
  return (id: AgentId) => ({
    id,
    binary: "fake",
    defaultModel: "test",
    supportsResume,
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      calls.push(opts);
      const turn = turns[Math.min(call, turns.length - 1)]!;
      call += 1;
      return (async function* () {
        if (turn.sessionId) {
          yield {
            kind: "session_start",
            agent: "claude",
            ts: 0,
            sessionId: turn.sessionId,
          } as AgentEvent;
        }
        yield {
          kind: "result",
          agent: "claude",
          ts: 0,
          isError: false,
          text: turn.text,
          costUsd: turn.costUsd,
        } as AgentEvent;
      })();
    },
  });
}

const canAskSpec: WorkflowSpec = {
  name: "ask-away",
  phases: [
    {
      id: "p",
      title: "P",
      steps: [{ id: "impl", agent: "claude", model: "opus", prompt: "do {{input}}", canAsk: true }],
    },
  ],
};

async function collect(
  spec: WorkflowSpec,
  deps: WorkflowDeps,
  input = "the task",
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input }, deps)) events.push(ev);
  return events;
}

const findDone = (events: WorkflowEvent[], stepId: string) =>
  events.find((e) => e.kind === "step_done" && e.stepId === stepId) as
    | (WorkflowEvent & { kind: "step_done" })
    | undefined;

describe("parseAgentQuestion", () => {
  it("extracts the trailing QUESTION: line", () => {
    expect(parseAgentQuestion("I looked around.\nQUESTION: which auth flow?")).toBe(
      "which auth flow?",
    );
    expect(parseAgentQuestion("QUESTION: only thing")).toBe("only thing");
    expect(parseAgentQuestion("done, no questions")).toBeUndefined();
    expect(parseAgentQuestion("QUESTION:")).toBeUndefined();
  });

  it("takes the LAST question line and keeps wrapped continuation text", () => {
    expect(parseAgentQuestion("QUESTION: a?\nwork...\nQUESTION: b or\nc?")).toBe("b or\nc?");
  });
});

describe("canAsk engine", () => {
  it("injects the protocol line into the prompt", async () => {
    const calls: AgentRunOptions[] = [];
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter([{ text: "done" }], calls, true),
      maxConcurrency: 2,
      cwd: "/base",
    };
    await collect(canAskSpec, deps);
    expect(calls[0]!.prompt).toContain("do the task");
    expect(calls[0]!.prompt).toContain("QUESTION:");
    expect(calls[0]!.prompt.endsWith(AGENT_QUESTION_PROTOCOL)).toBe(true);
  });

  it("does not inject the protocol without canAsk", async () => {
    const calls: AgentRunOptions[] = [];
    const spec: WorkflowSpec = {
      name: "plain",
      phases: [
        { id: "p", title: "P", steps: [{ id: "impl", agent: "claude", model: "o", prompt: "x" }] },
      ],
    };
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter([{ text: "done" }], calls, true),
      maxConcurrency: 2,
      cwd: "/base",
    };
    await collect(spec, deps);
    expect(calls[0]!.prompt).not.toContain("QUESTION:");
  });

  it("pauses on a question, resumes the session with the answer, and merges costs", async () => {
    const calls: AgentRunOptions[] = [];
    const requests: HumanInputRequest[] = [];
    const provider: HumanInputProvider = async (req) => {
      requests.push(req);
      return { value: "use OAuth", by: "human:test" };
    };
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter(
        [
          { text: "QUESTION: which auth flow?", sessionId: "ses-1", costUsd: 0.01 },
          { text: "implemented with OAuth", sessionId: "ses-1", costUsd: 0.02 },
        ],
        calls,
        true,
      ),
      maxConcurrency: 2,
      cwd: "/base",
      requestHumanInput: provider,
    };
    const events = await collect(canAskSpec, deps);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.origin).toBe("agent-question");
    expect(requests[0]!.prompt).toBe("which auth flow?");

    expect(calls).toHaveLength(2);
    // Native resume: the continuation carries the session id and only the answer.
    expect(calls[1]!.resumeSessionId).toBe("ses-1");
    expect(calls[1]!.prompt).toContain("use OAuth");
    expect(calls[1]!.prompt).not.toContain("do the task");

    const done = findDone(events, "impl");
    expect(done?.result.ok).toBe(true);
    expect(done?.result.output).toBe("implemented with OAuth");
    expect(done?.result.costUsd).toBeCloseTo(0.03);
    expect(done?.result.questions).toEqual([
      { question: "which auth flow?", answer: "use OAuth", by: "human:test" },
    ]);
    expect(done?.result.sessionId).toBe("ses-1");

    const pending = events.find((e) => e.kind === "human_input_pending");
    expect(pending).toMatchObject({ stepId: "impl", origin: "agent-question" });
  });

  it("falls back to a composed prompt when the adapter cannot resume", async () => {
    const calls: AgentRunOptions[] = [];
    const provider: HumanInputProvider = async () => ({ value: "answer!", by: "human:test" });
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter(
        [{ text: "QUESTION: hm?", sessionId: "ses-9" }, { text: "finished" }],
        calls,
        false,
      ),
      maxConcurrency: 2,
      cwd: "/base",
      requestHumanInput: provider,
    };
    const events = await collect(canAskSpec, deps);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.resumeSessionId).toBeUndefined();
    // Self-contained continuation: original prompt + the Q&A.
    expect(calls[1]!.prompt).toContain("do the task");
    expect(calls[1]!.prompt).toContain("QUESTION: hm?");
    expect(calls[1]!.prompt).toContain("answer!");
    expect(findDone(events, "impl")?.result.ok).toBe(true);
  });

  it("fails the step when the question goes unanswered (headless, no value)", async () => {
    const calls: AgentRunOptions[] = [];
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter([{ text: "QUESTION: blocked on what?" }], calls, true),
      maxConcurrency: 2,
      cwd: "/base",
      // No provider configured at all.
    };
    const events = await collect(canAskSpec, deps);
    const done = findDone(events, "impl");
    expect(done?.result.ok).toBe(false);
    expect(done?.result.error).toContain("clarifying question unanswered");
    expect(calls).toHaveLength(1); // no continuation was attempted
  });

  it("fails the step when the agent asks a second question", async () => {
    const provider: HumanInputProvider = async () => ({ value: "here", by: "human:test" });
    const deps: WorkflowDeps = {
      createAdapter: scriptedAdapter(
        [
          { text: "QUESTION: first?", sessionId: "s" },
          { text: "QUESTION: second?", sessionId: "s" },
        ],
        [],
        true,
      ),
      maxConcurrency: 2,
      cwd: "/base",
      requestHumanInput: provider,
    };
    const events = await collect(canAskSpec, deps);
    const done = findDone(events, "impl");
    expect(done?.result.ok).toBe(false);
    expect(done?.result.error).toContain("second clarifying question");
  });
});
