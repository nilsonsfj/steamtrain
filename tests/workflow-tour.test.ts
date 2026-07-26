import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  runWorkflow,
  validateWorkflow,
  workflowAgentIds,
} from "../src/workflow";
import { BUNDLED_WORKFLOWS } from "../src/workflow/bundled";

const tour = BUNDLED_WORKFLOWS.tour!;
const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-tour-test-"));
  tempRoots.push(dir);
  return dir;
}

/** The tour must never spawn an agent; a throwing adapter proves it. */
function agentlessDeps(cwd: string): WorkflowDeps {
  return {
    createAdapter: () => {
      throw new Error("the tour must not create agent adapters");
    },
    maxConcurrency: 4,
    cwd,
  };
}

async function runTour(cwd: string): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(tour, { input: "all aboard" }, agentlessDeps(cwd))) {
    events.push(ev);
  }
  return events;
}

function doneResults(events: WorkflowEvent[]): Map<string, StepResult> {
  const map = new Map<string, StepResult>();
  for (const ev of events) {
    if (ev.kind === "step_done") map.set(ev.stepId, ev.result);
  }
  return map;
}

describe("bundled tour workflow", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("is bundled, valid, and fully agentless (runs with zero credentials)", () => {
    expect(tour).toBeDefined();
    const result = validateWorkflow(tour);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    // Command steps that embed template data into the shell emit a non-fatal
    // security warning (see SECURITY.md); the tour intentionally fans out via
    // a templated shell cmd.
    expect(result.warnings ?? []).toEqual([expect.stringContaining("shell-quoted on expansion")]);
    expect(workflowAgentIds(tour)).toEqual([]);
  });

  it("runs end-to-end for $0: fan-out, parallel cars, a when-skip, three laps, and a report", async () => {
    const cwd = await tempDir();
    const events = await runTour(cwd);

    const done = events.find((ev) => ev.kind === "workflow_done");
    expect(done?.kind === "workflow_done" && done.ok).toBe(true);

    const results = doneResults(events);

    // Fan-out: the distributor produced the three station items, and the
    // fan-out car received them through a template.
    expect(results.get("stations")?.items).toHaveLength(3);
    expect(results.get("car-fanout")?.output).toContain("Union Station");

    // Every step cost nothing.
    for (const result of results.values()) {
      expect(result.costUsd ?? 0).toBe(0);
    }

    // The when-condition skipped the express service (no station mentions it).
    expect(results.get("express-service")?.skipped).toBe(true);

    // The loop ran exactly three laps before the signal cleared.
    expect(results.get("lap")?.iteration).toBe(3);
    expect(results.get("lap")?.output).toContain("lap 3 of 3");
    const gates = events.filter((ev) => ev.kind === "gate_evaluated");
    expect(gates).toHaveLength(3);
    expect(gates.at(-1)?.kind === "gate_evaluated" && gates.at(-1)!.passed).toBe(true);
    expect(results.get("loop-signal")?.target).toBe("all-laps-complete");

    // The agentless consolidator rendered the arrival report with the run's
    // input and the parallel cars' outputs.
    const report = results.get("conductor")?.output ?? "";
    expect(report).toContain("END OF THE LINE");
    expect(report).toContain("all aboard");
    expect(report).toContain("at the same time");
    expect(report).toContain("worktree isolation");
    expect(report).toContain('target "all-laps-complete"');
  });
});
