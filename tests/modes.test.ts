import { describe, expect, it } from "vitest";
import {
  type WorkflowScreenState,
  buildModes,
  isWorkflowPickerActive,
  nextMode,
} from "../src/tui/modes";
import { DEFAULT_WORKSPACE_CONFIG } from "../src/workspace/defaults";

describe("buildModes", () => {
  it("lists workflow first, then workspace ids", () => {
    expect(buildModes(DEFAULT_WORKSPACE_CONFIG)).toEqual([
      "workflow",
      "plan",
      "implement",
      "review",
    ]);
  });

  it("drops a reserved workflow workspace id", () => {
    const modes = buildModes({
      workspaces: [
        ...DEFAULT_WORKSPACE_CONFIG.workspaces,
        { id: "workflow", agent: "claude", model: "haiku" },
      ],
    });
    expect(modes.filter((mode) => mode === "workflow")).toEqual(["workflow"]);
    expect(modes).toEqual(["workflow", "plan", "implement", "review"]);
  });
});

describe("nextMode", () => {
  it("cycles through modes", () => {
    const modes = buildModes(DEFAULT_WORKSPACE_CONFIG);
    expect(nextMode("workflow", modes)).toBe("plan");
    expect(nextMode("review", modes)).toBe("workflow");
  });
});

describe("isWorkflowPickerActive", () => {
  const picker: WorkflowScreenState = {
    mode: "workflow",
    history: false,
    wfCreate: false,
    previewing: false,
    showWorkflowView: false,
  };

  it("is true only on the bare workflow picker", () => {
    expect(isWorkflowPickerActive(picker)).toBe(true);
  });

  it("is false in a workspace mode", () => {
    expect(isWorkflowPickerActive({ ...picker, mode: "plan" })).toBe(false);
  });

  it("is false while previewing, running, drafting, or in history", () => {
    // These are exactly the states where mode stays "workflow" but the picker is
    // hidden — `/model` must fall back to its legacy warning, not set a draft.
    expect(isWorkflowPickerActive({ ...picker, previewing: true })).toBe(false);
    expect(isWorkflowPickerActive({ ...picker, showWorkflowView: true })).toBe(false);
    expect(isWorkflowPickerActive({ ...picker, wfCreate: true })).toBe(false);
    expect(isWorkflowPickerActive({ ...picker, history: true })).toBe(false);
  });
});
