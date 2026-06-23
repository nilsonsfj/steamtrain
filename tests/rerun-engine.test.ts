import { describe, expect, it } from "vitest";
import type { AgentAdapter } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import { RunRecordBuilder, seedCacheFromRecord } from "../src/workflow";
import { runWorkflow } from "../src/workflow/engine";
import type { StepResult, WorkflowSpec } from "../src/workflow/types";

const spec: WorkflowSpec = {
  name: "demo",
  description: "d",
  phases: [
    {
      id: "p1",
      title: "P1",
      steps: [{ id: "a", kind: "worker", agent: "claude", model: "sonnet", prompt: "do a" }],
    },
    {
      id: "p2",
      title: "P2",
      steps: [
        {
          id: "b",
          kind: "worker",
          agent: "claude",
          model: "sonnet",
          prompt: "do b",
          dependsOn: ["a"],
        },
      ],
    },
  ],
};

/** A counting adapter; `failStep` makes that step fail this run. */
function makeDeps(spawns: string[], failStep?: string) {
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    async *run(opts): AsyncGenerator<AgentEvent> {
      const which = opts.prompt.includes("do b") ? "b" : "a";
      spawns.push(which);
      if (which === failStep) {
        yield { kind: "result", text: "boom", isError: true, agent: id, ts: Date.now() };
        return;
      }
      yield { kind: "result", text: `${which}-ok`, isError: false, agent: id, ts: Date.now() };
    },
  });
  return { createAdapter, maxConcurrency: 2, cwd: "/tmp" };
}

async function drain(cache: Map<string, StepResult>, deps: ReturnType<typeof makeDeps>) {
  const builder = new RunRecordBuilder({ id: "x", workflow: "demo", input: "in", cwd: "/tmp" });
  for await (const ev of runWorkflow(spec, { input: "in", cache }, deps)) builder.handle(ev);
  return builder;
}

describe("seeded cache re-run", () => {
  it("re-runs only the previously-failed step", async () => {
    const firstSpawns: string[] = [];
    const cache1 = new Map<string, StepResult>();
    const builder = await drain(cache1, makeDeps(firstSpawns, "b"));
    expect(firstSpawns.sort()).toEqual(["a", "b"]); // both ran
    const record = builder.build({ status: "error" });

    const seed = seedCacheFromRecord(record);
    expect([...seed.keys()]).toEqual(["a"]); // only "a" succeeded

    const secondSpawns: string[] = [];
    await drain(seed, makeDeps(secondSpawns)); // no failStep this time
    expect(secondSpawns).toEqual(["b"]); // "a" replayed from seed, only "b" re-ran
  });
});
