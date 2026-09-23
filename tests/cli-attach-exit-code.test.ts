import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAttachCommand } from "../src/run-cli";
import type { WorkflowEvent } from "../src/workflow/events";
import { newLiveRunMeta } from "../src/workflow/live-run";
import { WORKFLOW_RUNS_DIR, createLiveRunStore } from "../src/workflow/live-run-store";
import type { StepResult } from "../src/workflow/types";

/**
 * `workflow attach` exits with the code a foreground run would. It classifies
 * from the run's history record, and when that record never lands it falls
 * back to the live status plus the run's final `workflow_done` results.
 */
async function attachToFinishedRun(results: StepResult[]): Promise<number> {
  const cwd = mkdtempSync(join(tmpdir(), "steamtrain-attach-"));
  const store = createLiveRunStore(join(cwd, WORKFLOW_RUNS_DIR));
  const id = "run-1";
  await store.create({
    ...newLiveRunMeta({ id, workflow: "wf", input: "go", cwd, source: "cli" }),
    status: "error",
    ok: false,
  });
  const done: WorkflowEvent = { kind: "workflow_done", ok: false, results, ts: Date.now() };
  await store.appendEventLines(id, `${JSON.stringify(done)}\n`);
  return runAttachCommand(
    [id, "--json"],
    cwd,
    () => {},
    () => {},
  );
}

describe("workflow attach without a history record", () => {
  it("exits 2 when a gate failed the run", async () => {
    const code = await attachToFinishedRun([
      { stepId: "build", ok: true, output: "", durationMs: 1 },
      {
        stepId: "check",
        ok: false,
        output: "",
        durationMs: 1,
        gate: { passed: false, onFalse: "fail" },
      },
    ]);
    expect(code).toBe(2);
  }, 10_000);

  it("exits 1 when a step failed the run", async () => {
    const code = await attachToFinishedRun([
      { stepId: "build", ok: false, output: "boom", error: "boom", durationMs: 1 },
    ]);
    expect(code).toBe(1);
  }, 10_000);
});
