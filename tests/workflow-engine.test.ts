import { resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  runWorkflow,
} from "../src/workflow";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface RunRecord {
  id: AgentId;
  opts: AgentRunOptions;
}
interface FakeState {
  runs: RunRecord[];
  active: number;
  peak: number;
  delayMs: number;
}
type Script = (opts: AgentRunOptions, id: AgentId) => AgentEvent[];

/** A default adapter script: streams a little text, then echoes the model in its result. */
const echo: Script = (opts) => [
  { kind: "session_start", agent: "claude", ts: 0 },
  { kind: "text_delta", agent: "claude", ts: 0, text: "working" },
  {
    kind: "result",
    agent: "claude",
    ts: 0,
    isError: false,
    text: `out:${opts.model}`,
    costUsd: 0.002,
  },
];

function makeCreateAdapter(script: Script, state: FakeState) {
  return (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        state.runs.push({ id, opts });
        state.active += 1;
        state.peak = Math.max(state.peak, state.active);
        try {
          if (state.delayMs > 0) await delay(state.delayMs);
          let first = true;
          for (const event of script(opts, id)) {
            if (!first && opts.signal?.aborted) return; // mimic process kill on cancel
            first = false;
            await Promise.resolve();
            yield event;
          }
        } finally {
          state.active -= 1;
        }
      })();
    },
  });
}

function makeDeps(
  script: Script,
  over: { maxConcurrency?: number; cwd?: string; delayMs?: number } = {},
): { deps: WorkflowDeps; state: FakeState } {
  const state: FakeState = { runs: [], active: 0, peak: 0, delayMs: over.delayMs ?? 0 };
  const deps: WorkflowDeps = {
    createAdapter: makeCreateAdapter(script, state),
    maxConcurrency: over.maxConcurrency ?? 4,
    cwd: over.cwd ?? "/base",
  };
  return { deps, state };
}

async function collect(
  spec: WorkflowSpec,
  input: string,
  deps: WorkflowDeps,
  opts: { signal?: AbortSignal; cache?: Map<string, StepResult> } = {},
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input, cache: opts.cache }, deps, opts.signal)) {
    events.push(ev);
  }
  return events;
}

const twoPhase: WorkflowSpec = {
  name: "two-phase",
  phases: [
    {
      id: "p1",
      title: "P1",
      steps: [
        { id: "a", agent: "claude", model: "ma", prompt: "{{input}}" },
        { id: "b", agent: "claude", model: "mb", prompt: "{{input}}" },
        { id: "c", agent: "claude", model: "mc", prompt: "{{input}}" },
      ],
    },
    {
      id: "p2",
      title: "P2",
      steps: [{ id: "d", agent: "claude", model: "md", prompt: "{{input}}" }],
    },
  ],
};

describe("runWorkflow", () => {
  it("runs phases sequentially and steps within a phase in parallel", async () => {
    const { deps, state } = makeDeps(echo, { maxConcurrency: 3, delayMs: 20 });
    const events = await collect(twoPhase, "hi", deps);

    expect(state.peak).toBe(3); // all three phase-1 steps overlapped

    const lastP1Done = lastIndex(events, (e) => e.kind === "step_done" && e.stepId !== "d");
    const dStart = events.findIndex((e) => e.kind === "step_start" && e.stepId === "d");
    expect(dStart).toBeGreaterThan(lastP1Done); // phase 2 started only after phase 1

    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });

  it("honors maxConcurrency", async () => {
    const { deps, state } = makeDeps(echo, { maxConcurrency: 2, delayMs: 20 });
    await collect(twoPhase, "hi", deps);
    expect(state.peak).toBe(2);
  });

  it("feeds a prior step's output into a later step's prompt", async () => {
    const spec: WorkflowSpec = {
      name: "chain",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", agent: "claude", model: "alpha", prompt: "{{input}}" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "b",
              agent: "claude",
              model: "beta",
              prompt: "use {{steps.a.output}}",
              dependsOn: ["a"],
            },
          ],
        },
      ],
    };
    const { deps, state } = makeDeps(echo);
    await collect(spec, "x", deps);

    const bRun = state.runs.find((r) => r.opts.model === "beta");
    expect(bRun?.opts.prompt).toBe("use out:alpha");
  });

  it("marks a failed step not-ok but still runs later phases", async () => {
    const failing: Script = (opts, id) =>
      opts.model === "bad"
        ? [{ kind: "error", agent: id, ts: 0, message: "boom" }]
        : echo(opts, id);
    const spec: WorkflowSpec = {
      name: "fail",
      phases: [
        { id: "p1", title: "P1", steps: [{ id: "a", agent: "claude", model: "bad", prompt: "x" }] },
        { id: "p2", title: "P2", steps: [{ id: "b", agent: "claude", model: "ok", prompt: "x" }] },
      ],
    };
    const { deps, state } = makeDeps(failing);
    const events = await collect(spec, "x", deps);

    const aDone = events.find((e) => e.kind === "step_done" && e.stepId === "a");
    expect(aDone && aDone.kind === "step_done" && aDone.result.ok).toBe(false);
    expect(state.runs.some((r) => r.opts.model === "ok")).toBe(true); // phase 2 ran
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: false });
  });

  it("resumes completed steps from the cache without re-running them", async () => {
    const spec: WorkflowSpec = {
      name: "resume",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", agent: "claude", model: "ma", prompt: "{{input}}" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "b",
              agent: "claude",
              model: "mb",
              prompt: "{{steps.a.output}}",
              dependsOn: ["a"],
            },
          ],
        },
      ],
    };
    const cache = new Map<string, StepResult>([
      ["a", { stepId: "a", ok: true, output: "CACHED", durationMs: 1 }],
    ]);
    const { deps, state } = makeDeps(echo);
    const events = await collect(spec, "x", deps, { cache });

    expect(state.runs.some((r) => r.opts.model === "ma")).toBe(false); // 'a' not re-run
    const aDone = events.find((e) => e.kind === "step_done" && e.stepId === "a");
    expect(aDone && aDone.kind === "step_done" && aDone.cached).toBe(true);

    const bRun = state.runs.find((r) => r.opts.model === "mb");
    expect(bRun?.opts.prompt).toBe("CACHED");
  });

  it("passes per-step cwd, env and extraArgs to the adapter", async () => {
    const spec: WorkflowSpec = {
      name: "targets",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "a",
              agent: "claude",
              model: "ma",
              prompt: "x",
              cwd: "sub/dir",
              env: { FOO: "bar" },
              extraArgs: ["--add-dir", "."],
            },
          ],
        },
      ],
    };
    const { deps, state } = makeDeps(echo, { cwd: "/base" });
    await collect(spec, "x", deps);

    const rec = state.runs[0];
    expect(rec?.opts.cwd).toBe(resolvePath("/base", "sub/dir"));
    expect(rec?.opts.env).toEqual({ FOO: "bar" });
    expect(rec?.opts.extraArgs).toEqual(["--add-dir", "."]);
  });

  it("aborts mid-run without hanging and does not start later phases", async () => {
    const { deps } = makeDeps(echo, { maxConcurrency: 2, delayMs: 30 });
    const ac = new AbortController();
    const events: WorkflowEvent[] = [];
    for await (const ev of runWorkflow(twoPhase, { input: "x" }, deps, ac.signal)) {
      events.push(ev);
      if (ev.kind === "step_start") ac.abort(); // cancel as soon as work begins
    }

    expect(events.some((e) => e.kind === "step_start" && e.stepId === "d")).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: false });
  });

  it("rejects an invalid workflow before running anything", async () => {
    const bad: WorkflowSpec = {
      name: "bad",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "a", agent: "claude", model: "m", prompt: "x", dependsOn: ["ghost"] }],
        },
      ],
    };
    const { deps } = makeDeps(echo);
    await expect(collect(bad, "x", deps)).rejects.toThrow(/unknown step/);
  });
});

function lastIndex(events: WorkflowEvent[], pred: (e: WorkflowEvent) => boolean): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i] && pred(events[i] as WorkflowEvent)) return i;
  }
  return -1;
}
