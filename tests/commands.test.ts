import { describe, expect, it, vi } from "vitest";
import { modelIdsForAgent } from "../src/agents/models";
import {
  clearOpencodeVariantCacheForTests,
  setOpencodeVariantCacheForTests,
} from "../src/agents/opencode-variants";
import { applySlashSuggestion, autocompleteSlashCommand } from "../src/commands/autocomplete";
import { parseSlashInput, slashCommandArgs } from "../src/commands/parse";
import {
  executeSlashCommand,
  isRegisteredSlashCommand,
  listSlashCommands,
  registerSlashCommand,
} from "../src/commands/registry";
import type { SlashCommandContext } from "../src/commands/types";
import { workspaceById } from "../src/workspace";
import { DEFAULT_WORKSPACE_CONFIG } from "../src/workspace/defaults";

function makeCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  clearOpencodeVariantCacheForTests();
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

  it("strips quotes from args", () => {
    const parsed = parseSlashInput('/model "claude-sonnet-4-6"');
    expect(parsed?.command).toBe("model");
    expect(slashCommandArgs(parsed!)).toEqual(["claude-sonnet-4-6"]);
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

  it("warns /model in workflow mode without a selected step", () => {
    const result = executeSlashCommand("/model", makeCtx({ mode: "workflow" }));
    expect(result.handled).toBe(true);
    expect(result.handled && result.notices?.[0]?.level).toBe("warn");
    expect(result.handled && result.notices?.[0]?.text).toContain("selected agent-backed workflow step");
  });

  it("sets model on a selected workflow step", () => {
    const updateWorkflowStep = vi.fn();
    const result = executeSlashCommand(
      "/model claude-opus-4-8",
      makeCtx({
        mode: "workflow",
        workflowStep: {
          workflowName: "multi-plan",
          stepId: "plan",
          agent: "claude",
          model: "claude-sonnet-4-6",
        },
        updateWorkflowStep,
      }),
    );
    expect(result.handled).toBe(true);
    expect(updateWorkflowStep).toHaveBeenCalledWith("plan", { model: "claude-opus-4-8" });
  });

  it("sets agent on a selected workflow step", () => {
    const updateWorkflowStep = vi.fn();
    const result = executeSlashCommand(
      "/agent codex",
      makeCtx({
        mode: "workflow",
        workflowStep: {
          workflowName: "multi-plan",
          stepId: "plan",
          agent: "claude",
          model: "claude-sonnet-4-6",
        },
        updateWorkflowStep,
      }),
    );
    expect(result.handled).toBe(true);
    expect(updateWorkflowStep).toHaveBeenCalledWith("plan", {
      agent: "codex",
      model: "gpt-5.5",
      effort: undefined,
    });
  });

  it("sets agent and default model for codex", () => {
    const updateWorkspace = vi.fn();
    const result = executeSlashCommand("/agent codex", makeCtx({ updateWorkspace }));
    expect(result.handled).toBe(true);
    expect(updateWorkspace).toHaveBeenCalledWith("plan", {
      agent: "codex",
      model: "gpt-5.5",
    });
  });

  it("sets agent and default model", () => {
    const updateWorkspace = vi.fn();
    const result = executeSlashCommand("/agent opencode", makeCtx({ updateWorkspace }));
    expect(result.handled).toBe(true);
    expect(updateWorkspace).toHaveBeenCalledWith("plan", {
      agent: "opencode",
      model: "opencode/gpt-5.4-mini",
    });
  });

  it("accepts quoted model ids", () => {
    const updateWorkspace = vi.fn();
    const result = executeSlashCommand('/model "claude-opus-4-8"', makeCtx({ updateWorkspace }));
    expect(result.handled).toBe(true);
    expect(updateWorkspace).toHaveBeenCalledWith("plan", { model: "claude-opus-4-8" });
  });

  it("ignores unknown slash-like paths", () => {
    expect(isRegisteredSlashCommand("/home/user/project")).toBe(false);
    expect(executeSlashCommand("/home/user/project", makeCtx())).toEqual({ handled: false });
  });

  it("rejects partial command names on enter", () => {
    expect(isRegisteredSlashCommand("/ver")).toBe(false);
    expect(executeSlashCommand("/ver", makeCtx())).toEqual({ handled: false });
  });

  it("accepts registered commands with surrounding whitespace", () => {
    expect(isRegisteredSlashCommand("  /version  ")).toBe(true);
    const result = executeSlashCommand("  /version  ", makeCtx());
    expect(result).toMatchObject({ handled: true, clearInput: true });
  });

  it("sets opencode model ids containing slashes", () => {
    const updateWorkspace = vi.fn();
    const result = executeSlashCommand(
      "/model opencode/gpt-5.4-mini",
      makeCtx({ mode: "implement", updateWorkspace }),
    );
    expect(result.handled).toBe(true);
    expect(updateWorkspace).toHaveBeenCalledWith("implement", { model: "opencode/gpt-5.4-mini" });
  });

  it("keeps model when re-selecting the same agent", () => {
    const updateWorkspace = vi.fn();
    const result = executeSlashCommand(
      "/agent claude",
      makeCtx({
        mode: "plan",
        updateWorkspace,
        workspaceMap: workspaceById({
          workspaces: [{ id: "plan", agent: "claude", model: "claude-opus-4-8", effort: "max" }],
        }),
      }),
    );
    expect(result.handled).toBe(true);
    expect(updateWorkspace).toHaveBeenCalledWith("plan", {
      agent: "claude",
      model: "claude-opus-4-8",
      effort: "max",
    });
  });

  it("clears effort when switching agents", () => {
    const updateWorkspace = vi.fn();
    const result = executeSlashCommand(
      "/agent opencode",
      makeCtx({
        mode: "plan",
        updateWorkspace,
        workspaceMap: workspaceById({
          workspaces: [{ id: "plan", agent: "claude", model: "claude-opus-4-8", effort: "max" }],
        }),
      }),
    );
    expect(result.handled).toBe(true);
    expect(updateWorkspace).toHaveBeenCalledWith("plan", {
      agent: "opencode",
      model: "opencode/gpt-5.4-mini",
      effort: undefined,
    });
  });

  it("sets claude effort", () => {
    const updateWorkspace = vi.fn();
    const result = executeSlashCommand("/effort high", makeCtx({ updateWorkspace }));
    expect(result.handled).toBe(true);
    expect(updateWorkspace).toHaveBeenCalledWith("plan", { effort: "high" });
  });

  it("clears effort", () => {
    const updateWorkspace = vi.fn();
    const result = executeSlashCommand("/effort clear", makeCtx({ updateWorkspace }));
    expect(result.handled).toBe(true);
    expect(updateWorkspace).toHaveBeenCalledWith("plan", { effort: undefined });
  });

  it("rejects unknown effort for current agent", () => {
    const result = executeSlashCommand("/effort definitely-invalid", makeCtx());
    expect(result.handled).toBe(true);
    expect(result.handled && result.notices?.[0]?.level).toBe("error");
  });

  it("rejects xhigh for sonnet 4.6", () => {
    const updateWorkspace = vi.fn();
    const result = executeSlashCommand(
      "/effort xhigh",
      makeCtx({
        updateWorkspace,
        workspaceMap: workspaceById({
          workspaces: [{ id: "plan", agent: "claude", model: "claude-sonnet-4-6" }],
        }),
      }),
    );
    expect(result.handled).toBe(true);
    expect(result.handled && result.notices?.[0]?.level).toBe("error");
    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it("clears effort when switching to a model without effort support", () => {
    const updateWorkspace = vi.fn();
    const result = executeSlashCommand(
      "/model claude-haiku-4-5",
      makeCtx({
        updateWorkspace,
        workspaceMap: workspaceById({
          workspaces: [{ id: "plan", agent: "claude", model: "claude-opus-4-8", effort: "max" }],
        }),
      }),
    );
    expect(result.handled).toBe(true);
    expect(updateWorkspace).toHaveBeenCalledWith("plan", {
      model: "claude-haiku-4-5",
      effort: undefined,
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
    expect(result?.value).toBe("/model claude-opus-4-");
    expect(result?.suggestions).toContain("claude-opus-4-8");
  });

  it("matches model ids containing the query, prioritizing prefix matches", () => {
    const ctx = makeCtx({
      mode: "implement",
      workspaceMap: workspaceById({
        workspaces: [{ id: "implement", agent: "opencode", model: "opencode/gpt-5.4-mini" }],
      }),
    });
    setOpencodeVariantCacheForTests(
      new Map([
        ["opencode/gpt-5.4-mini", { name: "GPT 5.4 Mini", efforts: [] }],
        ["opencode/claude-sonnet-4-6", { name: "Claude Sonnet 4.6", efforts: [] }],
        ["vendor/custom-gpt-wrapper", { name: "Custom GPT", efforts: [] }],
      ]),
    );
    const result = autocompleteSlashCommand("/model gpt", listSlashCommands(), ctx);
    expect(result?.suggestions).toEqual([
      "opencode/gpt-5.4-mini",
      "vendor/custom-gpt-wrapper",
    ]);
    clearOpencodeVariantCacheForTests();
  });

  it("finds models by substring when prefix matches none", () => {
    const ctx = makeCtx({
      mode: "implement",
      workspaceMap: workspaceById({
        workspaces: [{ id: "implement", agent: "opencode", model: "opencode/gpt-5.4-mini" }],
      }),
    });
    setOpencodeVariantCacheForTests(
      new Map([
        ["opencode/claude-sonnet-4-6", { name: "Claude Sonnet 4.6", efforts: [] }],
        ["opencode/claude-opus-4-8", { name: "Claude Opus 4.8", efforts: [] }],
      ]),
    );
    const result = autocompleteSlashCommand("/model sonnet", listSlashCommands(), ctx);
    expect(result?.suggestions).toEqual(["opencode/claude-sonnet-4-6"]);
    clearOpencodeVariantCacheForTests();
  });

  it("lists live OpenCode models for autocomplete when cache is loaded", () => {
    const ctx = makeCtx({
      mode: "implement",
      workspaceMap: workspaceById({
        workspaces: [{ id: "implement", agent: "opencode", model: "opencode/gpt-5.4-mini" }],
      }),
    });
    setOpencodeVariantCacheForTests(
      new Map([
        ["deepseek/deepseek-chat", { name: "DeepSeek Chat", efforts: [] }],
        ["opencode/gpt-5.4-mini", { name: "GPT 5.4 Mini", efforts: [] }],
      ]),
    );
    const result = autocompleteSlashCommand("/model ", listSlashCommands(), ctx);
    expect(result?.suggestions).toContain("deepseek/deepseek-chat");
    expect(result?.suggestions?.length).toBe(modelIdsForAgent("opencode").length);
    clearOpencodeVariantCacheForTests();
  });

  it("lists all commands for bare slash without jumping to the first", () => {
    const result = autocompleteSlashCommand("/", listSlashCommands(), makeCtx());
    expect(result?.value).toBe("/");
    expect(result?.suggestions).toEqual(listSlashCommands().map((c) => c.name));
  });

  it("does not suggest agents in workflow mode", () => {
    const result = autocompleteSlashCommand(
      "/agent ",
      listSlashCommands(),
      makeCtx({ mode: "workflow" }),
    );
    expect(result?.suggestions).toEqual([]);
    expect(result?.value).toBe("/agent ");
  });
});

describe("applySlashSuggestion", () => {
  it("applies a command name from prefix", () => {
    const next = applySlashSuggestion("/ver", "version", listSlashCommands(), makeCtx());
    expect(next).toBe("/version ");
  });

  it("applies a command name from bare slash", () => {
    const next = applySlashSuggestion("/", "exit", listSlashCommands(), makeCtx());
    expect(next).toBe("/exit ");
  });

  it("applies a model argument", () => {
    const next = applySlashSuggestion(
      "/model claude-op",
      "claude-opus-4-8",
      listSlashCommands(),
      makeCtx(),
    );
    expect(next).toBe("/model claude-opus-4-8 ");
  });

  it("returns raw input when command has no complete hook", () => {
    const next = applySlashSuggestion(
      "/version partial",
      "partial",
      listSlashCommands(),
      makeCtx(),
    );
    expect(next).toBe("/version partial");
  });
});

describe("autocompleteSlashCommand edge cases", () => {
  it("returns empty suggestions for unknown command prefix", () => {
    const result = autocompleteSlashCommand("/zzz", listSlashCommands(), makeCtx());
    expect(result?.value).toBe("/zzz");
    expect(result?.suggestions).toEqual([]);
  });

  it("keeps value but lists candidates when arg query matches nothing", () => {
    const result = autocompleteSlashCommand("/model zzz", listSlashCommands(), makeCtx());
    expect(result?.value).toBe("/model zzz");
    expect(result?.suggestions?.length).toBeGreaterThan(0);
  });

  it("lists multiple command matches without forcing a single completion", () => {
    const commands = [
      ...listSlashCommands(),
      {
        name: "verbose",
        description: "verbose cmd",
        execute: () => ({ handled: true }),
      },
    ];
    const result = autocompleteSlashCommand("/ver", commands, makeCtx());
    expect(result?.value).toBe("/ver");
    expect(result?.suggestions).toContain("version");
    expect(result?.suggestions).toContain("verbose");
  });

  it("completes a partial command name even with a trailing space", () => {
    const result = autocompleteSlashCommand("/ver ", listSlashCommands(), makeCtx());
    expect(result?.value).toBe("/version ");
    expect(result?.suggestions).toContain("version");
  });

  it("returns null for registered commands without complete hooks", () => {
    expect(autocompleteSlashCommand("/exit ", listSlashCommands(), makeCtx())).toBeNull();
  });
});

describe("registerSlashCommand", () => {
  it("overrides an existing command", () => {
    const original = listSlashCommands().find((c) => c.name === "version");
    expect(original).toBeDefined();
    registerSlashCommand({
      name: "version",
      description: "test override",
      execute: () => ({ handled: true, notices: [{ level: "info", text: "override" }] }),
    });
    expect(executeSlashCommand("/version", makeCtx())).toMatchObject({
      handled: true,
      notices: [{ level: "info", text: "override" }],
    });
    registerSlashCommand(original!);
  });
});
