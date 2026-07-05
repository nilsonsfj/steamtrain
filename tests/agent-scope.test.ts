import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentConfigScope, agentScopeLabel, removeAgent, upsertAgent } from "../src/agents";
import { executeSlashCommand } from "../src/commands/registry";
import type { SlashCommandContext, SlashCommandResult } from "../src/commands/types";
import {
  CONFIG_FILENAME,
  configDisplayLabel,
  loadConfig,
  mergeAgentLists,
  saveUserConfig,
  userConfigPath,
} from "../src/config";
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

function run(raw: string, ctx: SlashCommandContext): SlashCommandResult {
  return executeSlashCommand(raw, ctx) as SlashCommandResult;
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
  mkdirSync(join(home, ".steamtrain"), { recursive: true });
  return home;
}

describe("user config layer", () => {
  it("merges global config under project config", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-config-"));
    writeFileSync(
      userConfigPath(home),
      JSON.stringify({
        agents: [
          { id: "mimocode", provider: "opencode", binary: "mimocode" },
          { id: "claude", provider: "claude", enabled: false },
        ],
        stepTimeoutSec: 45,
      }),
    );
    writeFileSync(
      join(cwd, CONFIG_FILENAME),
      JSON.stringify({
        agents: [{ id: "claude", provider: "claude", enabled: true, label: "proj" }],
        maxConcurrency: 2,
      }),
    );

    const loaded = loadConfig({ cwd, home });
    // Project entry replaces the same-id global entry wholesale; other global entries survive.
    const byId = new Map((loaded.config.agents ?? []).map((agent) => [agent.id, agent]));
    expect(byId.get("mimocode")).toMatchObject({ provider: "opencode", binary: "mimocode" });
    expect(byId.get("claude")).toMatchObject({ enabled: true, label: "proj" });
    expect(loaded.config.stepTimeoutSec).toBe(45);
    expect(loaded.config.maxConcurrency).toBe(2);
    expect(loaded.user).toMatchObject({ exists: true });
    expect(loaded.userAgents?.map((agent) => agent.id)).toEqual(["mimocode", "claude"]);
    expect(loaded.projectAgents?.map((agent) => agent.id)).toEqual(["claude"]);
  });

  it("uses only the global layer when no project file exists", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-config-"));
    writeFileSync(
      userConfigPath(home),
      JSON.stringify({ agents: [{ id: "mimocode", provider: "opencode" }] }),
    );

    const loaded = loadConfig({ cwd, home });
    expect(loaded.config.agents?.map((agent) => agent.id)).toEqual(["mimocode"]);
    expect(loaded.scope.exists).toBe(false);
    expect(configDisplayLabel(loaded.scope, { hasUserConfig: loaded.user?.exists })).toBe("user");
    // Either user-level file lights up the label on its own.
    expect(configDisplayLabel(loaded.scope, { hasUserSettings: true })).toBe("user");
  });

  it("rejects workflows in the global config with a warning", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-config-"));
    writeFileSync(userConfigPath(home), JSON.stringify({ workflows: {} }));

    const loaded = loadConfig({ cwd, home });
    expect(loaded.warning).toMatch(/invalid .*config\.json/);
    expect(loaded.config.workflows).toBeUndefined();
  });

  it("keeps the user layer when the project file is invalid", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-config-"));
    writeFileSync(
      userConfigPath(home),
      JSON.stringify({ agents: [{ id: "mimocode", provider: "opencode" }] }),
    );
    writeFileSync(join(cwd, CONFIG_FILENAME), "{ not json");

    const loaded = loadConfig({ cwd, home });
    expect(loaded.warning).toMatch(/could not parse/);
    expect(loaded.config.agents?.map((agent) => agent.id)).toEqual(["mimocode"]);
  });

  it("does not load the global layer for a custom --config file", () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-config-"));
    writeFileSync(
      userConfigPath(home),
      JSON.stringify({ agents: [{ id: "mimocode", provider: "opencode" }] }),
    );
    const custom = join(cwd, "team.json");
    writeFileSync(custom, JSON.stringify({ maxConcurrency: 3 }));

    const loaded = loadConfig({ cwd, home, customPath: custom });
    expect(loaded.config.agents).toBeUndefined();
    expect(loaded.user).toBeUndefined();
    expect(loaded.scope.kind).toBe("custom");
  });
});

describe("saveUserConfig", () => {
  it("creates and patches ~/.steamtrain/config.json", () => {
    const home = tempHome();
    const path = userConfigPath(home);

    expect(existsSync(path)).toBe(false);
    const first = saveUserConfig({ agents: [{ id: "mimocode", provider: "opencode" }] }, path);
    expect(first.ok).toBe(true);
    expect(existsSync(path)).toBe(true);

    const second = saveUserConfig({ stepTimeoutSec: 90 }, path);
    expect(second.ok).toBe(true);

    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.agents).toEqual([{ id: "mimocode", provider: "opencode" }]);
    expect(raw.stepTimeoutSec).toBe(90);
  });

  it("rejects invalid agents", () => {
    const home = tempHome();
    const result = saveUserConfig(
      { agents: [{ id: "bad id!", provider: "opencode" }] },
      userConfigPath(home),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot save/);
  });
});

describe("mergeAgentLists / scope helpers", () => {
  it("merges by id with override winning", () => {
    const merged = mergeAgentLists(
      [
        { id: "a", provider: "claude" },
        { id: "b", provider: "opencode" },
      ],
      [{ id: "b", provider: "opencode", enabled: false }],
    );
    expect(merged).toEqual([
      { id: "a", provider: "claude" },
      { id: "b", provider: "opencode", enabled: false },
    ]);
    expect(mergeAgentLists(undefined, undefined)).toBeUndefined();
    expect(mergeAgentLists([{ id: "a", provider: "claude" }], undefined)).toEqual([
      { id: "a", provider: "claude" },
    ]);
  });

  it("resolves scope with project shadowing user", () => {
    const layers = {
      userAgents: [{ id: "a", provider: "claude" as const }],
      projectAgents: [{ id: "a", provider: "claude" as const }],
    };
    expect(agentConfigScope("a", layers)).toBe("project");
    expect(agentConfigScope("a", { userAgents: layers.userAgents })).toBe("user");
    expect(agentConfigScope("missing", layers)).toBeUndefined();
    expect(agentScopeLabel("user")).toBe("global");
    expect(agentScopeLabel("project")).toBe("project");
    expect(agentScopeLabel(undefined)).toBe("builtin");
  });

  it("upserts and removes entries", () => {
    const list = upsertAgent([{ id: "a", provider: "claude" }], { id: "a", provider: "opencode" });
    expect(list).toEqual([{ id: "a", provider: "opencode" }]);
    expect(removeAgent(list, "a")).toEqual([]);
    expect(removeAgent(undefined, "a")).toEqual([]);
  });
});

describe("/agent scope handling", () => {
  it("adds to the global config by default", () => {
    const updateConfig = vi.fn().mockReturnValue({ ok: true });
    const updateUserConfig = vi.fn().mockReturnValue({ ok: true });
    const ctx = makeCtx({
      configPath: "/proj/steamtrain.json",
      updateConfig,
      userConfigPath: "/home/.steamtrain/config.json",
      updateUserConfig,
      userAgents: [],
      projectAgents: [],
    });

    const result = run("/agent add mimocode opencode mimocode", ctx);
    expect(result).toMatchObject({ handled: true });
    expect(updateUserConfig).toHaveBeenCalledWith({
      agents: [{ id: "mimocode", provider: "opencode", enabled: true, binary: "mimocode" }],
    });
    expect(updateConfig).not.toHaveBeenCalled();
    expect((result as { notices?: { text: string }[] }).notices?.[0]?.text).toMatch(/global/);
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

    run("/agent add mimocode opencode --project", ctx);
    expect(updateConfig).toHaveBeenCalledWith({
      agents: [{ id: "mimocode", provider: "opencode", enabled: true }],
    });
    expect(updateUserConfig).not.toHaveBeenCalled();
  });

  it("falls back to the project config when no global writer exists", () => {
    const updateConfig = vi.fn().mockReturnValue({ ok: true });
    const ctx = makeCtx({ configPath: "/proj/steamtrain.json", updateConfig });

    run("/agent add mimocode opencode", ctx);
    expect(updateConfig).toHaveBeenCalledWith({
      agents: [{ id: "mimocode", provider: "opencode", enabled: true }],
    });
  });

  it("disables an agent in the scope where it is configured", () => {
    const updateConfig = vi.fn().mockReturnValue({ ok: true });
    const updateUserConfig = vi.fn().mockReturnValue({ ok: true });
    const ctx = makeCtx({
      config: { agents: [{ id: "mimocode", provider: "opencode", binary: "mimocode" }] },
      configPath: "/proj/steamtrain.json",
      updateConfig,
      userConfigPath: "/home/.steamtrain/config.json",
      updateUserConfig,
      userAgents: [{ id: "mimocode", provider: "opencode", binary: "mimocode" }],
      projectAgents: [],
    });

    run("/agent disable mimocode", ctx);
    expect(updateUserConfig).toHaveBeenCalledWith({
      agents: [{ id: "mimocode", provider: "opencode", binary: "mimocode", enabled: false }],
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("disables a built-in agent globally by default", () => {
    const updateUserConfig = vi.fn().mockReturnValue({ ok: true });
    const ctx = makeCtx({
      configPath: "/proj/steamtrain.json",
      updateConfig: vi.fn().mockReturnValue({ ok: true }),
      userConfigPath: "/home/.steamtrain/config.json",
      updateUserConfig,
    });

    run("/agent disable codex", ctx);
    expect(updateUserConfig).toHaveBeenCalledWith({
      agents: [{ id: "codex", provider: "codex", enabled: false }],
    });
  });

  it("preserves configured fields when a flag forces a different scope", () => {
    const updateConfig = vi.fn().mockReturnValue({ ok: true });
    const updateUserConfig = vi.fn().mockReturnValue({ ok: true });
    const configured = {
      id: "mimocode",
      provider: "opencode" as const,
      binary: "mimocode-fork",
      env: { OPENCODE_CONFIG: "fork" },
      defaultModel: "opencode/mimo-v2.5-free",
    };
    const ctx = makeCtx({
      config: { agents: [configured] },
      configPath: "/proj/steamtrain.json",
      updateConfig,
      userConfigPath: "/home/.steamtrain/config.json",
      updateUserConfig,
      userAgents: [configured],
      projectAgents: [],
    });

    // Configured globally, but the user forces the project scope: the project
    // copy must carry the global entry's fields, not a stripped-down default.
    run("/agent disable mimocode --project", ctx);
    expect(updateConfig).toHaveBeenCalledWith({ agents: [{ ...configured, enabled: false }] });
    expect(updateUserConfig).not.toHaveBeenCalled();
  });

  it("honors --project for enable/disable", () => {
    const updateConfig = vi.fn().mockReturnValue({ ok: true });
    const updateUserConfig = vi.fn().mockReturnValue({ ok: true });
    const ctx = makeCtx({
      configPath: "/proj/steamtrain.json",
      updateConfig,
      userConfigPath: "/home/.steamtrain/config.json",
      updateUserConfig,
    });

    run("/agent disable codex --project", ctx);
    expect(updateConfig).toHaveBeenCalledWith({
      agents: [{ id: "codex", provider: "codex", enabled: false }],
    });
    expect(updateUserConfig).not.toHaveBeenCalled();
  });

  it("keeps legacy project-only behavior for contexts without a global writer", () => {
    const updateConfig = vi.fn().mockReturnValue({ ok: true });
    const ctx = makeCtx({
      config: { agents: [{ id: "mimocode", provider: "opencode", binary: "mimocode" }] },
      configPath: "/proj/steamtrain.json",
      updateConfig,
    });

    run("/agent disable mimocode", ctx);
    expect(updateConfig).toHaveBeenCalledWith({
      agents: [{ id: "mimocode", provider: "opencode", binary: "mimocode", enabled: false }],
    });
  });

  it("lists agents with their config scope", () => {
    const ctx = makeCtx({
      config: {
        agents: [
          { id: "mimocode", provider: "opencode" },
          { id: "claude", provider: "claude", enabled: false },
        ],
      },
      userAgents: [{ id: "mimocode", provider: "opencode" }],
      projectAgents: [{ id: "claude", provider: "claude", enabled: false }],
      updateUserConfig: vi.fn().mockReturnValue({ ok: true }),
    });

    const result = run("/agent list", ctx);
    const text = (result as { notices?: { text: string }[] }).notices?.[0]?.text ?? "";
    expect(text).toMatch(/mimocode \(enabled global/);
    expect(text).toMatch(/claude \(disabled project/);
  });

  it("errors when adding globally with no writers at all", () => {
    const result = run("/agent add mimocode opencode --global", makeCtx());
    const text = (result as { notices?: { level: string; text: string }[] }).notices?.[0];
    expect(text?.level).toBe("error");
    expect(text?.text).toMatch(/global agent config is unavailable/);
  });
});

describe("/agents command", () => {
  it("opens the agent manager when available", () => {
    const openAgentManager = vi.fn().mockReturnValue({ handled: true, clearInput: true });
    const result = run("/agents", makeCtx({ openAgentManager }));
    expect(openAgentManager).toHaveBeenCalled();
    expect(result).toMatchObject({ handled: true });
  });

  it("warns when the manager is unavailable", () => {
    const result = run("/agents", makeCtx());
    const notice = (result as { notices?: { level: string }[] }).notices?.[0];
    expect(notice?.level).toBe("warn");
  });
});
