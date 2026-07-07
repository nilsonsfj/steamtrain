import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  runWorkflow,
  validateWorkflow,
} from "../src/workflow";

/**
 * Per-step `when` conditions: a false condition skips the step (recorded ok
 * with `skipped: true` and empty output). Skips cascade through explicit
 * dependencies, except consolidators, which treat skipped inputs as absent.
 */

interface RunRecord {
  id: AgentId;
  opts: AgentRunOptions;
}

const echo = (opts: AgentRunOptions): AgentEvent[] => [
  { kind: "result", agent: "claude", ts: 0, isError: false, text: `out:${opts.model}` },
];

function makeDeps(): { deps: WorkflowDeps; runs: RunRecord[] } {
  const runs: RunRecord[] = [];
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        runs.push({ id, opts });
        for (const event of echo(opts)) {
          await Promise.resolve();
          yield event;
        }
      })();
    },
  });
  return { deps: { createAdapter, maxConcurrency: 4, cwd: "/base" }, runs };
}

async function collect(
  spec: WorkflowSpec,
  input: string,
  deps: WorkflowDeps,
  cache?: Map<string, StepResult>,
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input, cache }, deps)) {
    events.push(ev);
  }
  return events;
}

function doneResult(events: WorkflowEvent[], stepId: string): StepResult | undefined {
  const done = events.find((e) => e.kind === "step_done" && e.stepId === stepId);
  return done && done.kind === "step_done" ? done.result : undefined;
}

/** triage distributor emits "frontend"; two conditional branches + consolidator. */
const branchSpec: WorkflowSpec = {
  name: "branches",
  phases: [
    {
      id: "triage",
      title: "Triage",
      steps: [{ id: "triage", kind: "distributor", items: ["frontend"] }],
    },
    {
      id: "fix",
      title: "Fix",
      steps: [
        {
          id: "fix-frontend",
          agent: "claude",
          model: "mf",
          prompt: "fix fe",
          dependsOn: ["triage"],
          when: { step: "triage", contains: "frontend" },
        },
        {
          id: "fix-backend",
          agent: "claude",
          model: "mb",
          prompt: "fix be",
          dependsOn: ["triage"],
          when: { step: "triage", contains: "backend" },
        },
      ],
    },
    {
      id: "report",
      title: "Report",
      steps: [
        {
          id: "report",
          kind: "consolidator",
          dependsOn: ["fix-frontend", "fix-backend"],
        },
      ],
    },
  ],
};

describe("per-step when conditions", () => {
  it("skips a step whose when condition is false and keeps the run ok", async () => {
    const { deps, runs } = makeDeps();
    const events = await collect(branchSpec, "task", deps);

    // Only the frontend branch spawned an agent.
    expect(runs.map((r) => r.opts.model)).toEqual(["mf"]);
    const skipped = doneResult(events, "fix-backend");
    expect(skipped).toMatchObject({ ok: true, skipped: true, output: "", target: "skipped" });
    const ran = doneResult(events, "fix-frontend");
    expect(ran).toMatchObject({ ok: true, output: "out:mf" });
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });

  it("consolidators treat skipped inputs as absent, not failed", async () => {
    const { deps } = makeDeps();
    const events = await collect(branchSpec, "task", deps);

    const report = doneResult(events, "report");
    expect(report?.ok).toBe(true);
    expect(report?.output).toContain("--- fix-frontend ---");
    expect(report?.output).toContain("out:mf");
    expect(report?.output).not.toContain("fix-backend");
  });

  it("cascades skips through dependsOn, and skips a consolidator only when all inputs skipped", async () => {
    const { deps, runs } = makeDeps();
    const spec: WorkflowSpec = {
      name: "cascade",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "seed", kind: "distributor", items: ["frontend"] }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "branch",
              agent: "claude",
              model: "m1",
              prompt: "x",
              dependsOn: ["seed"],
              when: { step: "seed", contains: "backend" },
            },
          ],
        },
        {
          id: "p3",
          title: "P3",
          steps: [
            { id: "follow", agent: "claude", model: "m2", prompt: "x", dependsOn: ["branch"] },
          ],
        },
        {
          id: "p4",
          title: "P4",
          steps: [{ id: "merge", kind: "consolidator", dependsOn: ["follow"] }],
        },
      ],
    };
    const events = await collect(spec, "task", deps);

    expect(runs).toHaveLength(0);
    expect(doneResult(events, "branch")).toMatchObject({ ok: true, skipped: true });
    expect(doneResult(events, "follow")).toMatchObject({ ok: true, skipped: true });
    // All of the consolidator's inputs were skipped → it is skipped too.
    expect(doneResult(events, "merge")).toMatchObject({ ok: true, skipped: true });
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });

  it("skips a forEach processor whose distributor source was skipped", async () => {
    const { deps, runs } = makeDeps();
    const spec: WorkflowSpec = {
      name: "foreach-skip",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "seed", kind: "distributor", items: ["frontend"] }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "targets",
              kind: "distributor",
              items: ["a", "b"],
              dependsOn: ["seed"],
              when: { step: "seed", contains: "backend" },
            },
          ],
        },
        {
          id: "p3",
          title: "P3",
          steps: [
            {
              id: "work",
              kind: "processor",
              agent: "claude",
              model: "m",
              dependsOn: ["targets"],
              forEach: "steps.targets.items",
              prompt: "{{item}}",
            },
          ],
        },
      ],
    };
    const events = await collect(spec, "task", deps);

    expect(runs).toHaveLength(0);
    expect(doneResult(events, "targets")).toMatchObject({ ok: true, skipped: true });
    expect(doneResult(events, "work")).toMatchObject({ ok: true, skipped: true });
    expect(events.some((e) => e.kind === "fan_out")).toBe(false);
  });

  it("a skipped gate does not evaluate and cannot stop the run", async () => {
    const { deps, runs } = makeDeps();
    const spec: WorkflowSpec = {
      name: "gate-when",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "seed", kind: "distributor", items: ["frontend"] }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "gate",
              kind: "gate",
              dependsOn: ["seed"],
              when: { step: "seed", contains: "backend" },
              condition: { step: "seed", contains: "never-matches" },
              onFalse: "fail",
            },
          ],
        },
        {
          id: "p3",
          title: "P3",
          steps: [{ id: "later", agent: "claude", model: "ml", prompt: "x" }],
        },
      ],
    };
    const events = await collect(spec, "task", deps);

    expect(events.some((e) => e.kind === "gate_evaluated")).toBe(false);
    expect(doneResult(events, "gate")).toMatchObject({ ok: true, skipped: true });
    expect(runs.map((r) => r.opts.model)).toEqual(["ml"]);
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });

  it("evaluates when against the workflow input when no step is referenced", async () => {
    const { deps, runs } = makeDeps();
    const spec: WorkflowSpec = {
      name: "input-when",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "a", agent: "claude", model: "ma", prompt: "x", when: { contains: "go" } },
            { id: "b", agent: "claude", model: "mb", prompt: "x", when: { contains: "halt" } },
          ],
        },
      ],
    };
    const events = await collect(spec, "please go", deps);

    expect(runs.map((r) => r.opts.model)).toEqual(["ma"]);
    expect(doneResult(events, "b")).toMatchObject({ ok: true, skipped: true });
  });

  it("replays a skipped step from the cache on resume", async () => {
    const { deps, runs } = makeDeps();
    const cache = new Map<string, StepResult>();
    await collect(branchSpec, "task", deps, cache);
    expect(cache.get("fix-backend")).toMatchObject({ skipped: true });

    const resumed = await collect(branchSpec, "task", deps, cache);
    // No new agent runs on resume; the skip replays as cached.
    expect(runs.map((r) => r.opts.model)).toEqual(["mf"]);
    const done = resumed.find((e) => e.kind === "step_done" && e.stepId === "fix-backend");
    expect(done && done.kind === "step_done" && done.cached).toBe(true);
    expect(done && done.kind === "step_done" && done.result.skipped).toBe(true);
  });

  it("works in the phase-sequential (loop) scheduler too", async () => {
    const { deps, runs } = makeDeps();
    const spec: WorkflowSpec = {
      name: "loop-when",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "seed", kind: "distributor", items: ["frontend"] }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "branch",
              agent: "claude",
              model: "mb",
              prompt: "x",
              dependsOn: ["seed"],
              when: { step: "seed", contains: "backend" },
            },
          ],
        },
        {
          id: "p3",
          title: "P3",
          steps: [
            {
              id: "converge",
              kind: "gate",
              dependsOn: ["seed"],
              condition: { step: "seed", contains: "frontend" },
              loopTo: "p2",
              maxIterations: 2,
            },
          ],
        },
      ],
    };
    const events = await collect(spec, "task", deps);

    expect(runs).toHaveLength(0);
    expect(doneResult(events, "branch")).toMatchObject({ ok: true, skipped: true });
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });
});

describe("when validation", () => {
  const worker = (id: string, extra: object = {}) => ({
    id,
    agent: "claude",
    model: "m",
    prompt: "x",
    ...extra,
  });

  it("rejects a when.step that is not in an earlier phase", () => {
    const spec: WorkflowSpec = {
      name: "bad-when",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [worker("a"), worker("b", { when: { step: "a", contains: "x" } })],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/when condition references 'a'/);
  });

  it("rejects a when.step that does not exist", () => {
    const spec: WorkflowSpec = {
      name: "bad-when-unknown",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [worker("a", { when: { step: "ghost", contains: "x" } })],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown step 'ghost'/);
  });

  it("rejects a when condition with no predicate", () => {
    const spec: WorkflowSpec = {
      name: "bad-when-empty",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [worker("a", { when: { step: "a" } })],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/requires human, ok, contains, matches, or equals/);
  });

  it("accepts a valid when condition on any step kind", () => {
    const spec: WorkflowSpec = {
      name: "good-when",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "seed", kind: "distributor", items: ["x"] }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            worker("w", { when: { step: "seed", contains: "x" } }),
            {
              id: "g",
              kind: "gate",
              condition: { step: "seed", ok: true },
              when: { step: "seed", contains: "x" },
            },
          ],
        },
        {
          id: "p3",
          title: "P3",
          steps: [
            {
              id: "c",
              kind: "consolidator",
              dependsOn: ["w"],
              when: { step: "seed", contains: "x" },
            },
          ],
        },
      ],
    };
    expect(validateWorkflow(spec)).toEqual({ ok: true });
  });
});
