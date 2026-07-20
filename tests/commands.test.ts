import { afterAll, describe, expect, it, vi } from "vitest";
import { defaultDraftModel } from "../src/agents";
import { modelIdsForAgent } from "../src/agents/models";
import {
  clearOpencodeVariantCacheForTests,
  setOpencodeVariantCacheForTests,
} from "../src/agents/opencode-variants";
import { applySlashSuggestion, autocompleteSlashCommand } from "../src/commands/autocomplete";
import { parseSlashInput, slashCommandArgs } from "../src/commands/parse";
import {
  isRegisteredSlashCommand,
  listSlashCommands,
  executeSlashCommand as originalExecuteSlashCommand,
  registerSlashCommand,
} from "../src/commands/registry";
import type { SlashCommandContext, SlashCommandResult } from "../src/commands/types";
import { workspaceById } from "../src/workspace";
import { DEFAULT_WORKSPACE_CONFIG } from "../src/workspace/defaults";

const executeSlashCommand = (raw: string, ctx: SlashCommandContext) =>
  originalExecuteSlashCommand(raw, ctx) as SlashCommandResult;

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

  it("handles escaped quotes inside quoted strings", () => {
    const parsed = parseSlashInput('/prompt "hello \\"world\\""');
    expect(parsed?.command).toBe("prompt");
    expect(slashCommandArgs(parsed!)).toEqual(['hello "world"']);
  });

  it("handles escaped single quotes inside single-quoted strings", () => {
    const parsed = parseSlashInput("/prompt 'it\\'s a test'");
    expect(parsed?.command).toBe("prompt");
    expect(slashCommandArgs(parsed!)).toEqual(["it's a test"]);
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
    expect(result.handled && result.notices?.[0]?.text).toContain(
      "selected agent-backed workflow step",
    );
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

  it("sets the drafting model from /model on the workflow picker", () => {
    const set = vi.fn();
    const model = modelIdsForAgent("claude")[0]!;
    const result = executeSlashCommand(
      `/model claude ${model}`,
      makeCtx({
        mode: "workflow",
        draftModel: { usingOverride: false, healthyAgents: ["opencode", "claude"], set },
      }),
    );
    expect(result.handled).toBe(true);
    expect(set).toHaveBeenCalledWith({ agent: "claude", model });
  });

  it("resets the drafting model with /model auto", () => {
    const set = vi.fn();
    const result = executeSlashCommand(
      "/model auto",
      makeCtx({
        mode: "workflow",
        draftModel: { usingOverride: true, healthyAgents: ["opencode"], set },
      }),
    );
    expect(result.handled).toBe(true);
    expect(set).toHaveBeenCalledWith(null);
  });

  it("shows the current drafting model with bare /model on the picker", () => {
    const set = vi.fn();
    const result = executeSlashCommand(
      "/model",
      makeCtx({
        mode: "workflow",
        draftModel: {
          current: { agent: "opencode", model: defaultDraftModel("opencode") },
          usingOverride: false,
          healthyAgents: ["opencode"],
          set,
        },
      }),
    );
    expect(set).not.toHaveBeenCalled();
    expect(result.handled && result.notices?.[0]?.text).toContain("drafting model:");
  });

  it("errors when /model targets an unhealthy agent on the picker", () => {
    const set = vi.fn();
    const result = executeSlashCommand(
      "/model codex",
      makeCtx({
        mode: "workflow",
        draftModel: { usingOverride: false, healthyAgents: ["opencode"], set },
      }),
    );
    expect(set).not.toHaveBeenCalled();
    expect(result.handled && result.notices?.[0]?.level).toBe("error");
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
      model: "opencode/mimo-v2.5-free",
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
      model: "opencode/mimo-v2.5-free",
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
  afterAll(() => {
    clearOpencodeVariantCacheForTests();
  });
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
    expect(result?.suggestions).toEqual(["opencode/gpt-5.4-mini", "vendor/custom-gpt-wrapper"]);
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

describe("save-workflows command", () => {
  it("delegates to the TUI save handler", () => {
    const saveWorkflows = vi.fn(() => ({
      handled: true as const,
      clearInput: true,
      notices: [{ level: "info" as const, text: "saved multi-plan" }],
    }));
    const result = executeSlashCommand("/save-workflows", makeCtx({ saveWorkflows }));
    expect(saveWorkflows).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      handled: true,
      notices: [{ level: "info", text: "saved multi-plan" }],
    });
  });

  it("reports when save is unavailable outside the TUI", () => {
    const result = executeSlashCommand("/save-workflows", makeCtx());
    expect(result).toMatchObject({
      handled: true,
      notices: [{ level: "warn", text: "/save-workflows is only available in the TUI" }],
    });
  });
});

describe("/prompt command", () => {
  it("warns without a selected workflow step", () => {
    const result = executeSlashCommand("/prompt", makeCtx({ mode: "workflow" }));
    expect(result).toMatchObject({ handled: true });
    expect(result.handled && result.notices?.[0]?.level).toBe("warn");
  });

  it("shows prompt for selected step", () => {
    const result = executeSlashCommand(
      "/prompt",
      makeCtx({
        mode: "workflow",
        workflowStep: {
          workflowName: "multi-plan",
          stepId: "plan",
          agent: "claude",
          model: "claude-sonnet-4-6",
          prompt: "Analyze the codebase",
        },
        updateWorkflowStep: vi.fn(),
      }),
    );
    expect(result).toMatchObject({ handled: true });
    expect(result.handled && result.notices?.[0]?.text).toContain("Analyze the codebase");
  });

  it("shows (none) when step has no prompt", () => {
    const result = executeSlashCommand(
      "/prompt",
      makeCtx({
        mode: "workflow",
        workflowStep: {
          workflowName: "multi-plan",
          stepId: "plan",
          agent: "claude",
          model: "claude-sonnet-4-6",
        },
        updateWorkflowStep: vi.fn(),
      }),
    );
    expect(result).toMatchObject({ handled: true });
    expect(result.handled && result.notices?.[0]?.text).toContain("(none)");
  });

  it("updates prompt on selected step", () => {
    const updateWorkflowStep = vi.fn();
    const result = executeSlashCommand(
      "/prompt do the thing",
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
    expect(result).toMatchObject({ handled: true });
    expect(updateWorkflowStep).toHaveBeenCalledWith("plan", { prompt: "do the thing" });
  });
});

describe("/describe-workflow command", () => {
  it("warns without a workflow spec", () => {
    const result = executeSlashCommand("/describe-workflow", makeCtx({ mode: "workflow" }));
    expect(result).toMatchObject({ handled: true });
    expect(result.handled && result.notices?.[0]?.level).toBe("warn");
  });

  it("warns outside TUI", () => {
    const result = executeSlashCommand("/describe-workflow", makeCtx());
    expect(result).toMatchObject({ handled: true });
    expect(result.handled && result.notices?.[0]?.text).toContain("only available in the TUI");
  });

  it("shows description for current workflow", () => {
    const result = executeSlashCommand(
      "/describe-workflow",
      makeCtx({
        mode: "workflow",
        workflowSpec: { name: "test", phases: [] },
        updateWorkflowDescription: vi.fn(),
      }),
    );
    expect(result).toMatchObject({ handled: true });
    expect(result.handled && result.notices?.[0]?.text).toContain("description for 'test'");
  });

  it("updates description for current workflow", () => {
    const updateWorkflowDescription = vi.fn(() => ({
      handled: true as const,
      notices: [{ level: "info" as const, text: "done" }],
    }));
    const result = executeSlashCommand(
      "/describe-workflow my new description",
      makeCtx({
        mode: "workflow",
        workflowSpec: { name: "test", phases: [] },
        updateWorkflowDescription,
      }),
    );
    expect(result).toMatchObject({ handled: true });
    expect(updateWorkflowDescription).toHaveBeenCalledWith("test", "my new description");
  });
});

describe("/effort on workflow steps", () => {
  it("sets effort on a selected workflow step", () => {
    const updateWorkflowStep = vi.fn();
    const result = executeSlashCommand(
      "/effort high",
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
    expect(result).toMatchObject({ handled: true });
    expect(updateWorkflowStep).toHaveBeenCalledWith("plan", { effort: "high" });
  });

  it("clears effort on a selected workflow step", () => {
    const updateWorkflowStep = vi.fn();
    const result = executeSlashCommand(
      "/effort clear",
      makeCtx({
        mode: "workflow",
        workflowStep: {
          workflowName: "multi-plan",
          stepId: "plan",
          agent: "claude",
          model: "claude-sonnet-4-6",
          effort: "high",
        },
        updateWorkflowStep,
      }),
    );
    expect(result).toMatchObject({ handled: true });
    expect(updateWorkflowStep).toHaveBeenCalledWith("plan", { effort: undefined });
  });

  it("shows effort options for selected step", () => {
    const result = executeSlashCommand(
      "/effort",
      makeCtx({
        mode: "workflow",
        workflowStep: {
          workflowName: "multi-plan",
          stepId: "plan",
          agent: "claude",
          model: "claude-sonnet-4-6",
        },
        updateWorkflowStep: vi.fn(),
      }),
    );
    expect(result).toMatchObject({ handled: true });
    expect(result.handled && result.notices?.[0]?.text).toContain("effort for");
  });
});

const BULK_SPEC = {
  name: "bulk-demo",
  phases: [
    {
      id: "p1",
      title: "Phase 1",
      steps: [
        {
          id: "plan",
          kind: "worker" as const,
          agent: "claude",
          model: "sonnet",
          prompt: "plan it",
        },
        {
          id: "build",
          kind: "worker" as const,
          agent: "codex",
          model: "gpt-5.4",
          prompt: "build it",
        },
      ],
    },
  ],
} as const;

describe("/set-all and --all retarget", () => {
  it("lists set-all among registered commands", () => {
    expect(listSlashCommands().some((c) => c.name === "set-all")).toBe(true);
  });

  it("/set-all retargets every agent-backed step", () => {
    const updateWorkflowStep = vi.fn();
    const result = executeSlashCommand(
      "/set-all claude sonnet",
      makeCtx({
        mode: "workflow",
        workflowSpec: BULK_SPEC as unknown as import("../src/workflow").WorkflowSpec,
        updateWorkflowStep,
        workflowStep: {
          workflowName: "bulk-demo",
          stepId: "plan",
          agent: "claude",
          model: "sonnet",
        },
      }),
    );
    expect(result.handled).toBe(true);
    expect(updateWorkflowStep).toHaveBeenCalledWith(
      "build",
      expect.objectContaining({ agent: "claude", model: "sonnet" }),
    );
    // plan already matches — may or may not be patched depending on effort
    const ids = updateWorkflowStep.mock.calls.map((c) => c[0]);
    expect(ids).toContain("build");
    expect(result.handled && result.notices?.[0]?.text).toMatch(/retargeted|already/);
  });

  it("/agent <id> --all retargets every agent step", () => {
    const updateWorkflowStep = vi.fn();
    const result = executeSlashCommand(
      "/agent claude --all",
      makeCtx({
        mode: "workflow",
        workflowSpec: BULK_SPEC as unknown as import("../src/workflow").WorkflowSpec,
        updateWorkflowStep,
        workflowStep: {
          workflowName: "bulk-demo",
          stepId: "plan",
          agent: "claude",
          model: "sonnet",
        },
      }),
    );
    expect(result.handled).toBe(true);
    expect(updateWorkflowStep.mock.calls.length).toBeGreaterThan(0);
    expect(updateWorkflowStep).toHaveBeenCalledWith(
      "build",
      expect.objectContaining({ agent: "claude" }),
    );
  });

  it("/model <id> --all only updates steps on the same agent", () => {
    const updateWorkflowStep = vi.fn();
    const next = modelIdsForAgent("claude").find((id) => id !== "sonnet") ?? "claude-opus-4-8";
    const result = executeSlashCommand(
      `/model ${next} --all`,
      makeCtx({
        mode: "workflow",
        workflowSpec: BULK_SPEC as unknown as import("../src/workflow").WorkflowSpec,
        updateWorkflowStep,
        workflowStep: {
          workflowName: "bulk-demo",
          stepId: "plan",
          agent: "claude",
          model: "sonnet",
        },
      }),
    );
    expect(result.handled).toBe(true);
    const ids = updateWorkflowStep.mock.calls.map((c) => c[0]);
    expect(ids).toContain("plan");
    expect(ids).not.toContain("build");
  });

  it("/set-all without a preview warns", () => {
    const result = executeSlashCommand("/set-all claude", makeCtx({ mode: "workflow" }));
    expect(result.handled).toBe(true);
    expect(result.handled && result.notices?.[0]?.level).toBe("warn");
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
