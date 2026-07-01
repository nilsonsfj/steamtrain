import { describe, expect, it, vi } from "vitest";
import {
  executeSlashCommand,
  isRegisteredSlashCommand,
  listSlashCommands,
} from "../src/commands/registry";
import type { SlashCommandContext, SlashCommandResult } from "../src/commands/types";
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

describe("/clone-workflow", () => {
  it("is registered and passes the new name to ctx.cloneWorkflow", () => {
    expect(isRegisteredSlashCommand("/clone-workflow my copy")).toBe(true);
    const cloneWorkflow = vi.fn(() => ({ handled: true as const, clearInput: true }));
    executeSlashCommand("/clone-workflow My Copy", makeCtx({ cloneWorkflow }));
    expect(cloneWorkflow).toHaveBeenCalledWith("My Copy", "user");
  });

  it("clones into the project layer with --project", () => {
    const cloneWorkflow = vi.fn(() => ({ handled: true as const, clearInput: true }));
    executeSlashCommand("/clone-workflow --project Team Copy", makeCtx({ cloneWorkflow }));
    expect(cloneWorkflow).toHaveBeenCalledWith("Team Copy", "project");
  });

  it("errors without a new name", () => {
    const cloneWorkflow = vi.fn();
    const result = executeSlashCommand(
      "/clone-workflow",
      makeCtx({ cloneWorkflow }),
    ) as SlashCommandResult;
    expect(cloneWorkflow).not.toHaveBeenCalled();
    if (result.handled) expect(result.notices?.[0]?.level).toBe("error");
  });

  it("warns when unavailable (headless)", () => {
    const result = executeSlashCommand("/clone-workflow x", makeCtx()) as SlashCommandResult;
    if (result.handled) expect(result.notices?.[0]?.text).toContain("only available in the TUI");
  });
});

describe("/delete-workflow", () => {
  it("is registered and passes the name to ctx.deleteWorkflow", () => {
    const deleteWorkflow = vi.fn(() => ({ handled: true as const, clearInput: true }));
    executeSlashCommand("/delete-workflow my-flow", makeCtx({ deleteWorkflow }));
    expect(deleteWorkflow).toHaveBeenCalledWith("my-flow");
  });

  it("errors without a name", () => {
    const deleteWorkflow = vi.fn();
    const result = executeSlashCommand(
      "/delete-workflow",
      makeCtx({ deleteWorkflow }),
    ) as SlashCommandResult;
    expect(deleteWorkflow).not.toHaveBeenCalled();
    if (result.handled) expect(result.notices?.[0]?.level).toBe("error");
  });

  it("completes against user workflow names", () => {
    const cmd = listSlashCommands().find((c) => c.name === "delete-workflow");
    const completions = cmd?.complete?.(
      ["my"],
      makeCtx({ userWorkflowNames: ["my-flow", "other"] }),
    );
    expect(completions).toEqual(["my-flow"]);
  });
});

describe("/rename-workflow", () => {
  it("is registered and passes old-name and new-name to ctx.renameWorkflow", () => {
    expect(isRegisteredSlashCommand("/rename-workflow old new")).toBe(true);
    const renameWorkflow = vi.fn(() => ({ handled: true as const, clearInput: true }));
    executeSlashCommand("/rename-workflow old-flow new-flow", makeCtx({ renameWorkflow }));
    expect(renameWorkflow).toHaveBeenCalledWith("old-flow", "new-flow");
  });

  it("works with just a new name (renames active/selected workflow)", () => {
    const renameWorkflow = vi.fn(() => ({ handled: true as const, clearInput: true }));
    executeSlashCommand("/rename-workflow new-flow", makeCtx({ renameWorkflow }));
    expect(renameWorkflow).toHaveBeenCalledWith("", "new-flow");
  });

  it("errors without a new name", () => {
    const renameWorkflow = vi.fn();
    const result = executeSlashCommand(
      "/rename-workflow",
      makeCtx({ renameWorkflow }),
    ) as SlashCommandResult;
    expect(renameWorkflow).not.toHaveBeenCalled();
    if (result.handled) expect(result.notices?.[0]?.level).toBe("error");
  });

  it("completes against user workflow names", () => {
    const cmd = listSlashCommands().find((c) => c.name === "rename-workflow");
    const completions = cmd?.complete?.(
      ["my"],
      makeCtx({ userWorkflowNames: ["my-flow", "other"] }),
    );
    expect(completions).toEqual(["my-flow"]);
  });

  it("does not complete the second argument (new-name)", () => {
    const cmd = listSlashCommands().find((c) => c.name === "rename-workflow");
    const completions = cmd?.complete?.(
      ["old-flow", "my"],
      makeCtx({ userWorkflowNames: ["my-flow", "other"] }),
    );
    expect(completions).toEqual([]);
  });

  it("warns when unavailable (headless)", () => {
    const result = executeSlashCommand("/rename-workflow x", makeCtx()) as SlashCommandResult;
    if (result.handled) expect(result.notices?.[0]?.text).toContain("only available in the TUI");
  });
});
