import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import { DEFAULT_CONFIG } from "../src/config/defaults";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  buildWorkflowGenerationPrompt,
  extractWorkflowSpec,
  runWorkflow,
} from "../src/workflow";

/** A fake agent that echoes its model so we can trace which step ran. */
function makeBacklogDeps() {
  const prompts: string[] = [];
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      prompts.push(opts.prompt);
      const text =
        opts.prompt.includes("One task per line only") && opts.prompt.includes("Backlog:")
          ? "Fix auth module\nAdd tests for API\nUpdate docs"
          : `out:${opts.model}`;
      return (async function* () {
        await Promise.resolve();
        yield { kind: "result", agent: id, ts: 0, isError: false, text };
      })();
    },
  });
  const deps: WorkflowDeps = {
    createAdapter,
    maxConcurrency: DEFAULT_CONFIG.maxConcurrency ?? 5,
    cwd: "/base",
  };
  return { deps, prompts };
}

/** Fake agent for the bounded review/fix loop worked example. */
function makeLoopDeps() {
  const prompts: string[] = [];
  let reviewCalls = 0;
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      prompts.push(opts.prompt);
      let text = `out:${opts.model}`;
      if (opts.prompt.startsWith("Implement the task fully:")) {
        text = "impl out";
      } else if (opts.prompt.startsWith("Review the implementation")) {
        reviewCalls += 1;
        text = reviewCalls >= 2 ? "DONE" : "issues: missing tests";
      } else if (opts.prompt.startsWith("Apply fixes for these review findings:")) {
        text = "fixes applied";
      }
      return (async function* () {
        await Promise.resolve();
        yield { kind: "result", agent: id, ts: 0, isError: false, text };
      })();
    },
  });
  const deps: WorkflowDeps = {
    createAdapter,
    maxConcurrency: DEFAULT_CONFIG.maxConcurrency ?? 5,
    cwd: "/base",
  };
  return { deps, prompts };
}

async function run(
  spec: WorkflowSpec,
  input: string,
  deps: WorkflowDeps,
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input }, deps)) events.push(ev);
  return events;
}

describe("the meta-prompt's parallel backlog example executes on the engine", () => {
  const prompt = buildWorkflowGenerationPrompt("anything");
  const extracted = extractWorkflowSpec(
    prompt.slice(prompt.indexOf("# Worked example: parallel backlog implement")),
  );

  it("extracts and validates", () => {
    expect(extracted.ok).toBe(true);
  });

  it("fans out per item, respects phase order, and completes", async () => {
    if (!extracted.ok) throw new Error("worked example did not extract");
    const { deps, prompts } = makeBacklogDeps();
    const events = await run(extracted.spec, "go through my backlog", deps);

    // agent-backed distributor emits 3 lines -> split x1, impl x3, report x1 = 5 runs.
    expect(prompts).toHaveLength(5);

    // forEach substituted the current item into each implement prompt.
    const implementPrompts = prompts.filter((p) =>
      p.startsWith("Implement this backlog task fully"),
    );
    expect(implementPrompts).toHaveLength(3);
    expect(implementPrompts.some((p) => p.includes("Task:\nFix auth module"))).toBe(true);
    expect(implementPrompts.some((p) => p.includes("Task:\nAdd tests for API"))).toBe(true);
    expect(implementPrompts.some((p) => p.includes("Task:\nUpdate docs"))).toBe(true);

    // The consolidator (report) ran last, after the implement phase.
    const reportDone = events.findIndex((e) => e.kind === "step_done" && e.stepId === "report");
    const lastImplDone = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.kind === "step_done" && e.stepId === "impl")
      .map(({ i }) => i)
      .at(-1);
    expect(reportDone).toBeGreaterThan(lastImplDone ?? Number.POSITIVE_INFINITY);

    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });
});

describe("the meta-prompt's bounded loop example executes on the engine", () => {
  const prompt = buildWorkflowGenerationPrompt("anything");
  const extracted = extractWorkflowSpec(
    prompt.slice(
      prompt.indexOf("# Worked example: a bounded review/fix loop"),
      prompt.indexOf("# Output format"),
    ),
  );

  it("extracts and validates", () => {
    expect(extracted.ok).toBe(true);
  });

  it("loops review/fix until DONE, then completes forward", async () => {
    if (!extracted.ok) throw new Error("loop example did not extract");
    const { deps, prompts } = makeLoopDeps();
    const events = await run(extracted.spec, "implement feature X", deps);

    // impl x1, review x2 (loop once), fix x2 = 5 agent runs (gate is not agent-backed).
    expect(prompts).toHaveLength(5);
    expect(prompts.filter((p) => p.startsWith("Review the implementation"))).toHaveLength(2);
    expect(
      prompts.filter((p) => p.startsWith("Apply fixes for these review findings:")),
    ).toHaveLength(2);

    expect(events.filter((e) => e.kind === "loop_iteration")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "step_start" && e.stepId === "review").length).toBe(2);
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });
});
