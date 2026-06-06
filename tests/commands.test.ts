import { describe, expect, it, vi } from "vitest";
import { autocompleteSlashCommand } from "../src/commands/autocomplete";
import { parseSlashInput } from "../src/commands/parse";
import { executeSlashCommand, listSlashCommands } from "../src/commands/registry";
import type { SlashCommandContext } from "../src/commands/types";
import { workspaceById } from "../src/workspace";
import { DEFAULT_WORKSPACE_CONFIG } from "../src/workspace/defaults";

function makeCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  const workspaces = DEFAULT_WORKSPACE_CONFIG;
  return {
    mode: "plan",
    modes: ["workflow", "plan", "implement", "review"],
    workspaces,
    workspaceMap: workspaceById(workspaces),
    updateWorkspace: vi.fn(),
    setMode: vi.fn(),
    version: "0.1.0-test",
    ...overrides,
  };
}

describe("parseSlashInput", () => {
  it("parses command and args", () => {
    expect(parseSlashInput("/model claude-sonnet-4-6")).toEqual({
      command: "model",
      args: [],
      activeArg: "claude-sonnet-4-6",
      activeArgIndex: 0,
    });
  });

  it("parses bare slash", () => {
    expect(parseSlashInput("/")).toEqual({
      command: "",
      args: [],
      activeArg: "",
      activeArgIndex: 0,
    });
  });
});

describe("executeSlashCommand", () => {
  it("lists commands for bare /", () => {
    const result = executeSlashCommand("/", makeCtx());
    expect(result).toMatchObject({ handled: true });
    expect(result.handled && result.notices?.[0]?.text).toContain("/exit");
  });

  it("runs /version", () => {
    const result = executeSlashCommand("/version", makeCtx());
    expect(result).toEqual({
      handled: true,
      clearInput: true,
      notices: [{ level: "info", text: "steamtrain 0.1.0-test" }],
    });
  });

  it("runs /exit", () => {
    const result = executeSlashCommand("/exit", makeCtx());
    expect(result).toMatchObject({ handled: true, exit: true, clearInput: true });
  });

  it("sets model on workspace tab", () => {
    const updateWorkspace = vi.fn();
    const result = executeSlashCommand("/model claude-opus-4-8", makeCtx({ updateWorkspace }));
    expect(result.handled).toBe(true);
    expect(updateWorkspace).toHaveBeenCalledWith("plan", { model: "claude-opus-4-8" });
  });

  it("rejects /model in workflow mode", () => {
    const result = executeSlashCommand("/model", makeCtx({ mode: "workflow" }));
    expect(result.handled).toBe(true);
    expect(result.handled && result.notices?.[0]?.level).toBe("warn");
  });

  it("sets agent and default model", () => {
    const updateWorkspace = vi.fn();
    const result = executeSlashCommand("/agent opencode", makeCtx({ updateWorkspace }));
    expect(result.handled).toBe(true);
    expect(updateWorkspace).toHaveBeenCalledWith("plan", {
      agent: "opencode",
      model: "openai/gpt-5.4-mini",
    });
  });
});

describe("autocompleteSlashCommand", () => {
  it("completes command prefix", () => {
    const result = autocompleteSlashCommand("/ver", listSlashCommands(), makeCtx());
    expect(result?.value).toBe("/version ");
    expect(result?.suggestions).toContain("version");
  });

  it("completes model for current agent", () => {
    const result = autocompleteSlashCommand("/model claude-op", listSlashCommands(), makeCtx());
    expect(result?.value).toContain("claude-opus-4-8");
  });
});
