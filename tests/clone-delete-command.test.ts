import { describe, expect, it, vi } from "vitest";
import {
  executeSlashCommand,
  isRegisteredSlashCommand,
  listSlashCommands,
} from "../src/commands/registry";
import type { SlashCommandContext } from "../src/commands/types";
import { workspaceById } from "../src/workspace";
import { DEFAULT_WORKSPACE_CONFIG } from "../src/workspace/defaults";

function makeCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  const workspaces = DEFAULT_WORKSPACE_CONFIG;
  return {
    mode: "workflow",
    modes: ["workflow", "plan", "implement", "review"],
    workspaces,
    workspaceMap: workspaceById(workspaces),
    updateWorkspace: vi.fn(),
    setMode: vi.fn(),
    version: "0.1.0-test",
    ...overrides,
  };
}

describe("/cloneworkflow", () => {
  it("is registered and passes the new name to ctx.cloneWorkflow", () => {
    expect(isRegisteredSlashCommand("/cloneworkflow my copy")).toBe(true);
    const cloneWorkflow = vi.fn(() => ({ handled: true as const, clearInput: true }));
    executeSlashCommand("/cloneworkflow My Copy", makeCtx({ cloneWorkflow }));
    expect(cloneWorkflow).toHaveBeenCalledWith("My Copy", "user");
  });

  it("clones into the project layer with --project", () => {
    const cloneWorkflow = vi.fn(() => ({ handled: true as const, clearInput: true }));
    executeSlashCommand("/cloneworkflow --project Team Copy", makeCtx({ cloneWorkflow }));
    expect(cloneWorkflow).toHaveBeenCalledWith("Team Copy", "project");
  });

  it("errors without a new name", () => {
    const cloneWorkflow = vi.fn();
    const result = executeSlashCommand("/cloneworkflow", makeCtx({ cloneWorkflow }));
    expect(cloneWorkflow).not.toHaveBeenCalled();
    if (result.handled) expect(result.notices?.[0]?.level).toBe("error");
  });

  it("warns when unavailable (headless)", () => {
    const result = executeSlashCommand("/cloneworkflow x", makeCtx());
    if (result.handled) expect(result.notices?.[0]?.text).toContain("only available in the TUI");
  });
});

describe("/deleteworkflow", () => {
  it("is registered and passes the name to ctx.deleteWorkflow", () => {
    const deleteWorkflow = vi.fn(() => ({ handled: true as const, clearInput: true }));
    executeSlashCommand("/deleteworkflow my-flow", makeCtx({ deleteWorkflow }));
    expect(deleteWorkflow).toHaveBeenCalledWith("my-flow");
  });

  it("errors without a name", () => {
    const deleteWorkflow = vi.fn();
    const result = executeSlashCommand("/deleteworkflow", makeCtx({ deleteWorkflow }));
    expect(deleteWorkflow).not.toHaveBeenCalled();
    if (result.handled) expect(result.notices?.[0]?.level).toBe("error");
  });

  it("completes against user workflow names", () => {
    const cmd = listSlashCommands().find((c) => c.name === "deleteworkflow");
    const completions = cmd?.complete?.(
      ["my"],
      makeCtx({ userWorkflowNames: ["my-flow", "other"] }),
    );
    expect(completions).toEqual(["my-flow"]);
  });
});
