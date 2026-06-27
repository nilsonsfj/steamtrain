import { describe, expect, it } from "vitest";
import { migrateSessionOverrides, updatePreviewOnRename } from "../src/tui/App";
import type { WorkflowStepOverrides } from "../src/workflow";

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
