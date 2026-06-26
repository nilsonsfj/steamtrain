import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
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
function makeDeps() {
  const prompts: string[] = [];
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      prompts.push(opts.prompt);
      return (async function* () {
        await Promise.resolve();
        yield { kind: "result", agent: id, ts: 0, isError: false, text: `out:${opts.model}` };
      })();
    },
  });
  const deps: WorkflowDeps = { createAdapter, maxConcurrency: 4, cwd: "/base" };
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

describe("the meta-prompt's worked example actually executes on the engine", () => {
  // Extract the example exactly as the model would imitate it, then RUN it
  // (not just validate it) through the real engine with a fake agent.
  const prompt = buildWorkflowGenerationPrompt("anything");
  const extracted = extractWorkflowSpec(prompt.slice(prompt.indexOf("# Worked example")));

  it("extracts and validates", () => {
    expect(extracted.ok).toBe(true);
  });

  it("fans out per item, respects phase order, and completes", async () => {
    if (!extracted.ok) throw new Error("worked example did not extract");
    const { deps, prompts } = makeDeps();
    const events = await run(extracted.spec, "go through my backlog", deps);

    // distributor has 3 items -> impl x3, review-each x3, apply-fixes x3, report x1 = 10 runs.
    expect(prompts).toHaveLength(10);

    // forEach substituted the current item into each fanned-out prompt.
    expect(prompts.some((p) => p.includes("Task 1 from backlog: go through my backlog"))).toBe(
      true,
    );

    // The consolidator (report) ran last, after the fix phase.
    const reportDone = events.findIndex((e) => e.kind === "step_done" && e.stepId === "report");
    const lastFixDone = events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.kind === "step_done" && e.stepId === "apply-fixes")
      .map(({ i }) => i)
      .at(-1);
    expect(reportDone).toBeGreaterThan(lastFixDone ?? Number.POSITIVE_INFINITY);

    // The whole workflow succeeded.
    expect(events.at(-1)).toMatchObject({ kind: "workflow_done", ok: true });
  });
});
