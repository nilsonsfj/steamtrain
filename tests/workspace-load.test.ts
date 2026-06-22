import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROJECT_WORKSPACE_FILENAME,
  WORKSPACE_CONFIG_FILENAME,
  type WorkspaceConfig,
  loadWorkspaceConfig,
  mergeWorkspaceEntries,
  projectWorkspaceConfigPath,
  resolveWorkspaceScope,
  saveWorkspaceConfig,
  workspaceConfigPath,
  workspaceScopeLabel,
} from "../src/workspace";
import { DEFAULT_WORKSPACE_CONFIG } from "../src/workspace/defaults";

function userScope(home: string) {
  return { kind: "user" as const, path: workspaceConfigPath(home) };
}

describe("loadWorkspaceConfig", () => {
  it("materializes the user workspace file on first run", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const path = workspaceConfigPath(home);
    expect(existsSync(path)).toBe(false);

    const loaded = loadWorkspaceConfig({ home, cwd: home });
    expect(loaded.config).toEqual(DEFAULT_WORKSPACE_CONFIG);
    expect(loaded.scope).toEqual(userScope(home));
    expect(workspaceScopeLabel(loaded.scope)).toBe("user");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(DEFAULT_WORKSPACE_CONFIG);
    expect(loaded.warning).toBeUndefined();
  });

  it("merges user overrides by workspace id", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const dir = join(home, ".steamtrain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, WORKSPACE_CONFIG_FILENAME),
      JSON.stringify({
        workspaces: [
          { id: "implement", agent: "claude", model: "haiku" },
          { id: "debug", agent: "opencode", model: "openai/gpt-5.4-mini" },
        ],
      }),
    );

    const loaded = loadWorkspaceConfig({ home, cwd: home });
    expect(loaded.config.workspaces.map((w) => w.id)).toEqual([
      "plan",
      "implement",
      "review",
      "debug",
    ]);
    expect(loaded.config.workspaces.find((w) => w.id === "implement")).toMatchObject({
      agent: "claude",
      model: "haiku",
    });
    expect(loaded.scope.kind).toBe("user");
  });

  it("prefers project scope when ./workspace.json exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    mkdirSync(join(home, ".steamtrain"), { recursive: true });
    writeFileSync(
      join(home, ".steamtrain", WORKSPACE_CONFIG_FILENAME),
      JSON.stringify(DEFAULT_WORKSPACE_CONFIG),
    );
    writeFileSync(
      join(cwd, PROJECT_WORKSPACE_FILENAME),
      JSON.stringify({
        workspaces: [{ id: "plan", agent: "opencode", model: "openai/gpt-5.4-mini" }],
      }),
    );

    const loaded = loadWorkspaceConfig({ home, cwd });
    expect(loaded.scope).toEqual({
      kind: "project",
      path: projectWorkspaceConfigPath(cwd),
    });
    expect(loaded.config.workspaces.find((w) => w.id === "plan")).toMatchObject({
      agent: "opencode",
      model: "openai/gpt-5.4-mini",
    });
  });

  it("materializes and loads a custom workspace file when customPath is set", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const custom = join(home, "team.json");
    expect(existsSync(custom)).toBe(false);

    const loaded = loadWorkspaceConfig({ home, customPath: custom });
    expect(loaded.scope).toEqual({ kind: "custom", path: custom });
    expect(workspaceScopeLabel(loaded.scope, home)).toBe("~/team.json");
    expect(loaded.config).toEqual(DEFAULT_WORKSPACE_CONFIG);
    expect(existsSync(custom)).toBe(true);
  });

  it("loads overrides from an existing custom workspace file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-cwd-"));
    const custom = join(cwd, "team.json");
    writeFileSync(
      custom,
      JSON.stringify({
        workspaces: [{ id: "review", agent: "opencode", model: "openai/gpt-5.4-mini" }],
      }),
    );

    const loaded = loadWorkspaceConfig({ cwd, customPath: custom });
    expect(loaded.config.workspaces.find((w) => w.id === "review")).toMatchObject({
      agent: "opencode",
    });
  });

  it("warns when duplicate workspace ids appear in the user file", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const dir = join(home, ".steamtrain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, WORKSPACE_CONFIG_FILENAME),
      JSON.stringify({
        workspaces: [
          { id: "plan", agent: "claude", model: "haiku" },
          { id: "plan", agent: "claude", model: "claude-opus-4-8" },
        ],
      }),
    );

    const loaded = loadWorkspaceConfig({ home, cwd: home });
    expect(loaded.warning).toMatch(/duplicate workspace ids/);
    expect(loaded.config.workspaces.find((w) => w.id === "plan")?.model).toBe("claude-opus-4-8");
  });

  it("ignores reserved workflow workspace id with a warning", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const dir = join(home, ".steamtrain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, WORKSPACE_CONFIG_FILENAME),
      JSON.stringify({
        workspaces: [
          { id: "workflow", agent: "claude", model: "haiku" },
          { id: "scratch", agent: "opencode", model: "openai/gpt-5.4-mini" },
        ],
      }),
    );

    const loaded = loadWorkspaceConfig({ home, cwd: home });
    expect(loaded.warning).toMatch(/reserved workspace id/);
    expect(loaded.config.workspaces.map((w) => w.id)).toEqual([
      "plan",
      "implement",
      "review",
      "scratch",
    ]);
  });

  it("falls back to seed defaults with a warning on invalid json", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const dir = join(home, ".steamtrain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, WORKSPACE_CONFIG_FILENAME), "{ not json");

    const loaded = loadWorkspaceConfig({ home, cwd: home });
    expect(loaded.config).toEqual(DEFAULT_WORKSPACE_CONFIG);
    expect(loaded.warning).toMatch(/could not parse/);
  });
});

describe("resolveWorkspaceScope", () => {
  it("returns custom scope when customPath is provided", () => {
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-cwd-"));
    const custom = join(cwd, "alt.json");
    expect(resolveWorkspaceScope({ cwd, customPath: custom })).toEqual({
      kind: "custom",
      path: custom,
    });
  });
});

describe("mergeWorkspaceEntries", () => {
  it("preserves base order and appends new ids", () => {
    const merged = mergeWorkspaceEntries(DEFAULT_WORKSPACE_CONFIG.workspaces, [
      { id: "review", agent: "claude", model: "claude-opus-4-8-thinking", effort: "max" },
      { id: "scratch", agent: "opencode", model: "openai/gpt-5.4-mini" },
    ]);
    expect(merged.map((w) => w.id)).toEqual(["plan", "implement", "review", "scratch"]);
    expect(merged.find((w) => w.id === "review")?.model).toBe("claude-opus-4-8-thinking");
    expect(merged.find((w) => w.id === "review")?.effort).toBe("max");
  });
});

describe("saveWorkspaceConfig", () => {
  it("writes the full workspace list to the user file", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const scope = userScope(home);
    const config: WorkspaceConfig = {
      workspaces: [
        { id: "plan", agent: "opencode", model: "openai/gpt-5.4-mini" },
        { id: "implement", agent: "opencode", model: "openai/gpt-5.4-mini" },
        { id: "review", agent: "claude", model: "claude-opus-4-8" },
      ],
    };
    const label = saveWorkspaceConfig(config, scope);

    const path = workspaceConfigPath(home);
    expect(label).toBe("user");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(config);

    const loaded = loadWorkspaceConfig({ home, cwd: home });
    expect(loaded.config).toEqual(config);
  });

  it("writes the full workspace list to the project workspace file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-cwd-"));
    const scope = { kind: "project" as const, path: projectWorkspaceConfigPath(cwd) };
    const config: WorkspaceConfig = {
      workspaces: [
        { id: "plan", agent: "opencode", model: "openai/gpt-5.4-mini" },
        { id: "implement", agent: "opencode", model: "openai/gpt-5.4-mini" },
        { id: "review", agent: "claude", model: "claude-opus-4-8" },
      ],
    };
    const label = saveWorkspaceConfig(config, scope);

    expect(label).toBe("project");
    expect(JSON.parse(readFileSync(scope.path, "utf8"))).toEqual(config);
  });

  it("keeps the user file when saving seed defaults", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const scope = userScope(home);
    loadWorkspaceConfig({ home, cwd: home });

    const label = saveWorkspaceConfig(DEFAULT_WORKSPACE_CONFIG, scope);
    expect(label).toBe("user");
    expect(existsSync(workspaceConfigPath(home))).toBe(true);
    expect(JSON.parse(readFileSync(workspaceConfigPath(home), "utf8"))).toEqual(
      DEFAULT_WORKSPACE_CONFIG,
    );
  });
});
