import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiConfigScope,
  apiScopeLabel,
  removeApi,
  resolveApiInstance,
  upsertApi,
} from "../src/apis";
import { apiCommand } from "../src/commands/builtins/api";
import { executeSlashCommand } from "../src/commands/registry";
import type {
  SlashCommandContext,
  SlashCommandNotice,
  SlashCommandResult,
} from "../src/commands/types";
import type { ApiInstanceConfig } from "../src/config/types";
import { workspaceById } from "../src/workspace";
import { DEFAULT_WORKSPACE_CONFIG } from "../src/workspace/defaults";

const touchedEnv: string[] = [];
afterEach(() => {
  for (const name of touchedEnv.splice(0)) delete process.env[name];
});

function makeCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  const workspaces = DEFAULT_WORKSPACE_CONFIG;
  return {
    mode: "workflow",
    modes: ["workflow", "plan"],
    workspaces,
    workspaceMap: workspaceById(workspaces),
    updateWorkspace: vi.fn(),
    setMode: vi.fn(),
    version: "0.1.0-test",
    ...overrides,
  };
}

function run(raw: string, ctx: SlashCommandContext): SlashCommandResult {
  return executeSlashCommand(raw, ctx) as SlashCommandResult;
}

function noticeText(result: SlashCommandResult): string {
  const notices = (result as { notices?: SlashCommandNotice[] }).notices ?? [];
  return notices.map((n) => n.text).join("\n");
}

describe("api scope helpers", () => {
  it("resolves scope with project shadowing user and labels each scope", () => {
    const layers = {
      userApis: [{ id: "groq", provider: "openai" as const }],
      projectApis: [{ id: "groq", provider: "openai" as const }],
    };
    expect(apiConfigScope("groq", layers)).toBe("project");
    expect(apiConfigScope("groq", { userApis: layers.userApis })).toBe("user");
    expect(apiConfigScope("anthropic", layers)).toBeUndefined();
    expect(apiScopeLabel("user")).toBe("global");
    expect(apiScopeLabel("project")).toBe("project");
    expect(apiScopeLabel(undefined)).toBe("builtin");
  });

  it("upserts and removes entries", () => {
    const list = upsertApi([{ id: "a", provider: "openai" }], { id: "a", provider: "anthropic" });
    expect(list).toEqual([{ id: "a", provider: "anthropic" }]);
    expect(removeApi(list, "a")).toEqual([]);
    expect(removeApi(undefined, "a")).toEqual([]);
  });
});

describe("/api command", () => {
  it("lists the built-in instances with key presence", () => {
    process.env.STEAMTRAIN_TEST_GROQ_KEY = "k";
    touchedEnv.push("STEAMTRAIN_TEST_GROQ_KEY");
    const ctx = makeCtx({
      config: {
        apis: [{ id: "groq", provider: "openai", apiKeyEnv: "STEAMTRAIN_TEST_GROQ_KEY" }],
      },
    });
    const text = noticeText(run("/api list", ctx));
    expect(text).toContain("anthropic (enabled");
    expect(text).toContain("openai (enabled");
    expect(text).toContain("groq (enabled");
    expect(text).toContain("key=STEAMTRAIN_TEST_GROQ_KEY");
    expect(text).not.toContain("STEAMTRAIN_TEST_GROQ_KEY (unset)");
  });

  it("adds to the global config by default, with flags for key env and model", () => {
    const updateConfig = vi.fn().mockReturnValue({ ok: true });
    const updateUserConfig = vi.fn().mockReturnValue({ ok: true });
    const ctx = makeCtx({
      configPath: "/proj/steamtrain.json",
      updateConfig,
      userConfigPath: "/home/.steamtrain/config.json",
      updateUserConfig,
      userApis: [],
      projectApis: [],
    });

    const result = run(
      "/api add groq openai https://api.groq.com/openai/v1 --key-env GROQ_API_KEY --model llama-3.3-70b",
      ctx,
    );
    expect(result).toMatchObject({ handled: true });
    expect(updateUserConfig).toHaveBeenCalledWith({
      apis: [
        {
          id: "groq",
          provider: "openai",
          enabled: true,
          baseUrl: "https://api.groq.com/openai/v1",
          apiKeyEnv: "GROQ_API_KEY",
          defaultModel: "llama-3.3-70b",
        },
      ],
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("adds to the project config with --project", () => {
    const updateConfig = vi.fn().mockReturnValue({ ok: true });
    const updateUserConfig = vi.fn().mockReturnValue({ ok: true });
    const ctx = makeCtx({
      configPath: "/proj/steamtrain.json",
      updateConfig,
      userConfigPath: "/home/.steamtrain/config.json",
      updateUserConfig,
    });
    run("/api add proxy anthropic --project", ctx);
    expect(updateConfig).toHaveBeenCalledWith({
      apis: [{ id: "proxy", provider: "anthropic", enabled: true }],
    });
    expect(updateUserConfig).not.toHaveBeenCalled();
  });

  it("rejects unknown providers with a usage hint", () => {
    const ctx = makeCtx({ updateUserConfig: vi.fn(), userConfigPath: "/h/c.json" });
    const text = noticeText(run("/api add g gemini", ctx));
    expect(text).toContain("usage: /api add");
  });

  it("disables into the scope that configures the instance, preserving its fields", () => {
    const updateConfig = vi.fn().mockReturnValue({ ok: true });
    const updateUserConfig = vi.fn().mockReturnValue({ ok: true });
    const groq = {
      id: "groq",
      provider: "openai" as const,
      baseUrl: "https://api.groq.com/openai/v1",
    };
    const ctx = makeCtx({
      config: { apis: [groq] },
      configPath: "/proj/steamtrain.json",
      updateConfig,
      userConfigPath: "/home/.steamtrain/config.json",
      updateUserConfig,
      userApis: [groq],
      projectApis: [],
    });
    run("/api disable groq", ctx);
    expect(updateUserConfig).toHaveBeenCalledWith({ apis: [{ ...groq, enabled: false }] });
  });

  it("enables a built-in into the global scope by default", () => {
    const updateUserConfig = vi.fn().mockReturnValue({ ok: true });
    const ctx = makeCtx({
      updateUserConfig,
      userConfigPath: "/home/.steamtrain/config.json",
      userApis: [],
      projectApis: [],
    });
    run("/api enable openai", ctx);
    expect(updateUserConfig).toHaveBeenCalledWith({
      apis: [{ id: "openai", provider: "openai", enabled: true }],
    });
  });

  it("enabling a gateway built-in writes a minimal entry that still resolves to its endpoint", () => {
    const updateUserConfig = vi.fn().mockReturnValue({ ok: true });
    const ctx = makeCtx({
      updateUserConfig,
      userConfigPath: "/home/.steamtrain/config.json",
      userApis: [],
      projectApis: [],
    });
    run("/api enable openrouter", ctx);
    // The command writes only id/provider/enabled...
    expect(updateUserConfig).toHaveBeenCalledWith({
      apis: [{ id: "openrouter", provider: "openai", enabled: true }],
    });
    // ...and that minimal entry, once merged, keeps the built-in's endpoint and key env.
    const written = updateUserConfig.mock.calls[0]![0] as { apis: ApiInstanceConfig[] };
    expect(resolveApiInstance({ apis: written.apis }, "openrouter")).toMatchObject({
      enabled: true,
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
    });
  });

  it("errors on unknown instances and unknown subcommands", () => {
    const ctx = makeCtx({ updateUserConfig: vi.fn(), userConfigPath: "/h/c.json" });
    expect(noticeText(run("/api disable nope", ctx))).toContain("unknown api 'nope'");
    expect(noticeText(run("/api frobnicate", ctx))).toContain("unknown /api subcommand");
  });

  it("completes subcommands and instance ids", () => {
    const ctx = makeCtx({ config: { apis: [{ id: "groq", provider: "openai" }] } });
    expect(apiCommand.complete?.([""], ctx)).toContain("list");
    expect(apiCommand.complete?.(["enable", ""], ctx)).toEqual(
      expect.arrayContaining(["anthropic", "openai", "groq"]),
    );
    expect(apiCommand.complete?.(["add", "groq", ""], ctx)).toEqual(["anthropic", "openai"]);
  });
});
