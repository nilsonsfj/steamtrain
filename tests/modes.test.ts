import { describe, expect, it } from "vitest";
import { buildModes, nextMode } from "../src/tui/modes";
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
