import { describe, expect, it, vi } from "vitest";
import {
  isRegisteredSlashCommand,
  executeSlashCommand as originalExecuteSlashCommand,
} from "../src/commands/registry";
import type { SlashCommandContext, SlashCommandResult } from "../src/commands/types";
import { workspaceById } from "../src/workspace";
import { DEFAULT_WORKSPACE_CONFIG } from "../src/workspace/defaults";

const executeSlashCommand = (raw: string, ctx: SlashCommandContext) =>
  originalExecuteSlashCommand(raw, ctx) as SlashCommandResult;

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

describe("/create-workflow", () => {
  it("is a registered slash command", () => {
    expect(isRegisteredSlashCommand("/create-workflow audit my code")).toBe(true);
  });

  it("delegates the description to ctx.createWorkflow", () => {
    const createWorkflow = vi.fn(() => ({ handled: true as const, clearInput: true }));
    const result = executeSlashCommand(
      "/create-workflow review the auth module for security",
      makeCtx({ createWorkflow }),
    );
    expect(createWorkflow).toHaveBeenCalledWith("review the auth module for security", "user");
    expect(result.handled).toBe(true);
  });

  it("routes to the project layer with --project", () => {
    const createWorkflow = vi.fn(() => ({ handled: true as const, clearInput: true }));
    executeSlashCommand("/create-workflow --project audit the api", makeCtx({ createWorkflow }));
    expect(createWorkflow).toHaveBeenCalledWith("audit the api", "project");
  });

  it("errors when no description is given", () => {
    const createWorkflow = vi.fn();
    const result = executeSlashCommand("/create-workflow", makeCtx({ createWorkflow }));
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.notices?.[0]?.level).toBe("error");
    }
  });

  it("warns when the TUI callback is unavailable (e.g. headless)", () => {
    const result = executeSlashCommand("/create-workflow do a thing", makeCtx());
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.notices?.[0]?.level).toBe("warn");
      expect(result.notices?.[0]?.text).toContain("only available in the TUI");
    }
  });
});
