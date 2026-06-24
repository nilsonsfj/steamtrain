import { describe, expect, it } from "vitest";
import type { AgentAdapter } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import type { RetryPolicy, StepResult, WorkflowEvent, WorkflowSpec } from "../src/workflow";
import { runWorkflow } from "../src/workflow/engine";

/** A scripted outcome for one adapter invocation. */
type Outcome =
  | { kind: "ok"; text?: string }
  | { kind: "error" } // transport-level ErrorEvent (retryable)
  | { kind: "throw" } // adapter throws before any result (retryable)
  | { kind: "result-error" }; // completed turn reporting failure (NOT retryable)

/**
 * Build deps whose adapter follows a per-prompt script of {@link Outcome}s,
 * counting every invocation. Default outcome when the script is exhausted is ok.
 */
function scriptedDeps(script: Record<string, Outcome[]>, calls: string[]) {
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    async *run(opts): AsyncGenerator<AgentEvent> {
      // Derive a key from the prompt: the item name, or "a".
      const key = opts.prompt.replace("do ", "").trim() || "a";
      calls.push(key);
      const queue = script[key] ?? [];
      const outcome = queue.shift() ?? { kind: "ok" };
      if (outcome.kind === "throw") throw new Error("boom-throw");
      if (outcome.kind === "error") {
        yield { kind: "error", message: "transport boom", agent: id, ts: Date.now() };
        return;
      }
      if (outcome.kind === "result-error") {
        yield { kind: "result", text: "logic fail", isError: true, agent: id, ts: Date.now() };
        return;
      }
      yield {
        kind: "result",
        text: outcome.text ?? `${key}-ok`,
        isError: false,
        agent: id,
        ts: Date.now(),
      };
    },
  });
  return { createAdapter, maxConcurrency: 2, cwd: "/tmp" };
}

const fastRetry: RetryPolicy = { maxAttempts: 3, initialDelayMs: 1, factor: 1, jitter: false };

function workerSpec(retry: RetryPolicy): WorkflowSpec {
  return {
    name: "demo",
    description: "d",
    phases: [
      {
        id: "p1",
        title: "P1",
        steps: [
          { id: "a", kind: "worker", agent: "claude", model: "sonnet", prompt: "do a", retry },
        ],
      },
    ],
  };
}

async function drain(
  spec: WorkflowSpec,
  deps: ReturnType<typeof scriptedDeps>,
  signal?: AbortSignal,
) {
  const events: WorkflowEvent[] = [];
  let ok: boolean | undefined;
  const cache = new Map<string, StepResult>();
  for await (const ev of runWorkflow(spec, { input: "in", cache }, deps, signal)) {
    events.push(ev);
    if (ev.kind === "workflow_done") ok = ev.ok;
  }
  return { events, ok, cache };
}

describe("auto-retry transient failures", () => {
  it("retries a transient error then succeeds, recording attempts", async () => {
    const calls: string[] = [];
    const deps = scriptedDeps({ a: [{ kind: "error" }, { kind: "error" }, { kind: "ok" }] }, calls);
    const { events, ok, cache } = await drain(workerSpec(fastRetry), deps);
    expect(calls).toEqual(["a", "a", "a"]); // ran 3 times
    expect(ok).toBe(true);
    expect(cache.get("a")?.attempts).toBe(3);
    const retries = events.filter((e) => e.kind === "step_retry");
    expect(retries.map((e) => (e.kind === "step_retry" ? e.attempt : 0))).toEqual([1, 2]);
  });

  it("retries a thrown adapter error", async () => {
    const calls: string[] = [];
    const deps = scriptedDeps({ a: [{ kind: "throw" }, { kind: "ok" }] }, calls);
    const { ok } = await drain(workerSpec(fastRetry), deps);
    expect(calls).toEqual(["a", "a"]);
    expect(ok).toBe(true);
  });

  it("stops at maxAttempts when the failure persists", async () => {
    const calls: string[] = [];
    const deps = scriptedDeps(
      { a: [{ kind: "error" }, { kind: "error" }, { kind: "error" }, { kind: "error" }] },
      calls,
    );
    const { ok } = await drain(workerSpec(fastRetry), deps);
    expect(calls).toEqual(["a", "a", "a"]); // exactly maxAttempts
    expect(ok).toBe(false);
  });

  it("never retries a completed-but-errored turn (possible side effects)", async () => {
    const calls: string[] = [];
    const deps = scriptedDeps({ a: [{ kind: "result-error" }, { kind: "ok" }] }, calls);
    const { ok } = await drain(workerSpec(fastRetry), deps);
    expect(calls).toEqual(["a"]); // ran exactly once
    expect(ok).toBe(false);
  });

  it("disables retry when maxAttempts <= 1", async () => {
    const calls: string[] = [];
    const deps = scriptedDeps({ a: [{ kind: "error" }, { kind: "ok" }] }, calls);
    const { ok } = await drain(workerSpec({ maxAttempts: 1 }), deps);
    expect(calls).toEqual(["a"]);
    expect(ok).toBe(false);
  });

  it("retries a flaky fan-out child independently of its siblings", async () => {
    const fanSpec: WorkflowSpec = {
      name: "fan",
      description: "d",
      phases: [
        {
          id: "p1",
          title: "Split",
          steps: [{ id: "split", kind: "distributor", items: ["alpha", "beta"] }],
        },
        {
          id: "p2",
          title: "Work",
          steps: [
            {
              id: "work",
              kind: "worker",
              agent: "claude",
              model: "sonnet",
              dependsOn: ["split"],
              forEach: "steps.split.items",
              prompt: "do {{item}}",
              retry: fastRetry,
            },
          ],
        },
      ],
    };
    const calls: string[] = [];
    const deps = scriptedDeps({ beta: [{ kind: "error" }, { kind: "ok" }] }, calls);
    const { ok } = await drain(fanSpec, deps);
    expect(calls.filter((c) => c === "alpha")).toEqual(["alpha"]); // sibling ran once
    expect(calls.filter((c) => c === "beta")).toEqual(["beta", "beta"]); // child retried
    expect(ok).toBe(true);
  });

  it("aborts promptly during a backoff wait without further retries", async () => {
    const calls: string[] = [];
    // Long backoff so the abort lands during the wait.
    const deps = scriptedDeps({ a: [{ kind: "error" }, { kind: "error" }, { kind: "ok" }] }, calls);
    const controller = new AbortController();
    const spec = workerSpec({ maxAttempts: 3, initialDelayMs: 5000, factor: 1, jitter: false });
    const run = drain(spec, deps, controller.signal);
    // Let the first attempt fail and enter backoff, then abort.
    setTimeout(() => controller.abort(), 50);
    const { ok } = await run;
    expect(ok).toBe(false);
    expect(calls).toEqual(["a"]); // never started a second attempt
  });
});
