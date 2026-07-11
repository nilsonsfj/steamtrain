import { describe, expect, it } from "vitest";
import { migrateSessionOverrides, updatePreviewOnRename } from "../src/tui/App";
import {
  planFromInputFormSubmit,
  workflowHasDeclaredInputs,
} from "../src/tui/workflow-input-pending";
import type { WorkflowSpec, WorkflowStepOverrides } from "../src/workflow";

function workerSpec(prompt: string): WorkflowSpec {
  return {
    name: "test",
    inputs: { target: { type: "string" } },
    phases: [
      {
        id: "p1",
        title: "p1",
        steps: [
          {
            id: "w1",
            kind: "worker",
            agent: "claude",
            model: "sonnet",
            prompt,
          } as unknown as WorkflowSpec["phases"][number]["steps"][number],
        ],
      },
    ],
  };
}

describe("TUI App state helpers", () => {
  describe("migrateSessionOverrides", () => {
    it("returns previous state untouched if old workflow name has no overrides", () => {
      const prev: Record<string, WorkflowStepOverrides> = {
        other: { s1: { model: "m1" } },
      };
      const next = migrateSessionOverrides(prev, "non-existent", "target");
      expect(next).toBe(prev);
    });

    it("correctly migrates overrides from old name to new name and removes old key", () => {
      const prev: Record<string, WorkflowStepOverrides> = {
        old_wf: { s1: { model: "m1" } },
        other: { s2: { model: "m2" } },
      };
      const next = migrateSessionOverrides(prev, "old_wf", "new_wf");
      expect(next).toEqual({
        new_wf: { s1: { model: "m1" } },
        other: { s2: { model: "m2" } },
      });
      expect(next).not.toBe(prev); // should be cloned
    });
  });

  describe("updatePreviewOnRename", () => {
    it("returns previous state untouched if preview is null", () => {
      const prev = null;
      const next = updatePreviewOnRename(prev, "old_wf", "new_wf");
      expect(next).toBeNull();
    });

    it("returns previous state untouched if preview is for a different workflow", () => {
      const prev = { name: "other_wf", input: "hello" };
      const next = updatePreviewOnRename(prev, "old_wf", "new_wf");
      expect(next).toBe(prev);
    });

    it("correctly updates preview name if preview is for the renamed workflow", () => {
      const prev = { name: "old_wf", input: "hello" };
      const next = updatePreviewOnRename(prev, "old_wf", "new_wf");
      expect(next).toEqual({ name: "new_wf", input: "hello" });
    });
  });
});

describe("workflow input form pending", () => {
  it("detects workflows with declared inputs", () => {
    expect(workflowHasDeclaredInputs({ name: "x", phases: [] })).toBe(false);
    expect(workflowHasDeclaredInputs(workerSpec("do work"))).toBe(true);
  });

  it("plans with resolved params after input form submit", () => {
    const spec = workerSpec("fix {{inputs.target}}");
    const plan = planFromInputFormSubmit(
      spec,
      { name: "test", prompt: "hello", action: "plan" },
      { target: "src/foo.ts" },
    );
    expect(plan?.ok).toBe(true);
    expect(plan?.steps[0]?.renderedPrompt).toBe("fix src/foo.ts");
  });

  it("returns null when the workflow spec is unavailable", () => {
    expect(
      planFromInputFormSubmit(undefined, { name: "missing", prompt: "hi", action: "plan" }, {}),
    ).toBeNull();
  });
});
