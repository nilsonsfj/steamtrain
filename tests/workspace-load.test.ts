import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_CONFIG_FILENAME,
  loadWorkspaceConfig,
  mergeWorkspaceEntries,
  saveWorkspaceConfig,
  workspacesToPersist,
  workspaceConfigPath,
} from "../src/workspace";
import { DEFAULT_WORKSPACE_CONFIG } from "../src/workspace/defaults";

describe("loadWorkspaceConfig", () => {
  it("returns built-in defaults when the file is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const loaded = loadWorkspaceConfig(home);
    expect(loaded.config).toEqual(DEFAULT_WORKSPACE_CONFIG);
    expect(loaded.source).toBe("built-in workspace defaults");
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

    const loaded = loadWorkspaceConfig(home);
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
    expect(loaded.source).toBe(workspaceConfigPath(home));
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

    const loaded = loadWorkspaceConfig(home);
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

    const loaded = loadWorkspaceConfig(home);
    expect(loaded.warning).toMatch(/reserved workspace id/);
    expect(loaded.config.workspaces.map((w) => w.id)).toEqual([
      "plan",
      "implement",
      "review",
      "scratch",
    ]);
  });

  it("falls back to defaults with a warning on invalid json", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const dir = join(home, ".steamtrain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, WORKSPACE_CONFIG_FILENAME), "{ not json");

    const loaded = loadWorkspaceConfig(home);
    expect(loaded.config).toEqual(DEFAULT_WORKSPACE_CONFIG);
    expect(loaded.warning).toMatch(/could not parse/);
  });
});

describe("mergeWorkspaceEntries", () => {
  it("preserves base order and appends new ids", () => {
    const merged = mergeWorkspaceEntries(DEFAULT_WORKSPACE_CONFIG.workspaces, [
      { id: "review", agent: "claude", model: "claude-opus-4-8-thinking" },
      { id: "scratch", agent: "opencode", model: "openai/gpt-5.4-mini" },
    ]);
    expect(merged.map((w) => w.id)).toEqual(["plan", "implement", "review", "scratch"]);
    expect(merged.find((w) => w.id === "review")?.model).toBe("claude-opus-4-8-thinking");
  });
});

describe("workspacesToPersist", () => {
  it("returns only entries that differ from built-in defaults", () => {
    const persisted = workspacesToPersist({
      workspaces: [
        { id: "plan", agent: "opencode", model: "openai/gpt-5.4-mini" },
        { id: "implement", agent: "opencode", model: "openai/gpt-5.4-mini" },
        { id: "review", agent: "claude", model: "claude-opus-4-8" },
      ],
    });
    expect(persisted).toEqual([
      { id: "plan", agent: "opencode", model: "openai/gpt-5.4-mini" },
    ]);
  });
});

describe("saveWorkspaceConfig", () => {
  it("writes overrides to ~/.steamtrain/workspace.json", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const source = saveWorkspaceConfig(
      {
        workspaces: [
          { id: "plan", agent: "opencode", model: "openai/gpt-5.4-mini" },
          { id: "implement", agent: "opencode", model: "openai/gpt-5.4-mini" },
          { id: "review", agent: "claude", model: "claude-opus-4-8" },
        ],
      },
      home,
    );

    const path = workspaceConfigPath(home);
    expect(source).toBe(path);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      workspaces: [{ id: "plan", agent: "opencode", model: "openai/gpt-5.4-mini" }],
    });

    const loaded = loadWorkspaceConfig(home);
    expect(loaded.config.workspaces.find((w) => w.id === "plan")).toMatchObject({
      agent: "opencode",
      model: "openai/gpt-5.4-mini",
    });
    expect(loaded.source).toBe(path);
  });

  it("removes the file when config matches built-in defaults", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    saveWorkspaceConfig(
      {
        workspaces: [
          { id: "plan", agent: "opencode", model: "openai/gpt-5.4-mini" },
          { id: "implement", agent: "opencode", model: "openai/gpt-5.4-mini" },
          { id: "review", agent: "claude", model: "claude-opus-4-8" },
        ],
      },
      home,
    );

    const source = saveWorkspaceConfig(DEFAULT_WORKSPACE_CONFIG, home);
    expect(source).toBe("built-in workspace defaults");
    expect(existsSync(workspaceConfigPath(home))).toBe(false);
  });
});
