import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILENAME, configDisplayLabel, loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("ignores invalid user workflows with a warning", () => {
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-config-"));
    writeFileSync(
      join(cwd, CONFIG_FILENAME),
      JSON.stringify({
        workflows: {
          good: {
            phases: [
              {
                id: "p1",
                title: "P1",
                steps: [{ id: "a", agent: "claude", model: "m", prompt: "{{input}}" }],
              },
            ],
          },
          bad: {
            phases: [
              {
                id: "p1",
                title: "P1",
                steps: [
                  { id: "a", agent: "claude", model: "m", prompt: "x", dependsOn: ["ghost"] },
                ],
              },
            ],
          },
        },
      }),
    );

    const loaded = loadConfig(cwd);
    expect(loaded.warning).toMatch(/workflow 'bad' ignored/);
    expect(loaded.config.workflows?.good).toBeDefined();
    expect(loaded.scope.exists).toBe(true);
    expect(configDisplayLabel(loaded.scope)).toBe("project");
  });

  it("returns defaults when custom path does not exist", () => {
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-config-"));
    const loaded = loadConfig({ cwd, customPath: join(cwd, "nonexistent.json") });
    expect(loaded.config).toBeDefined();
    expect(loaded.warning).toBeDefined();
    expect(loaded.scope.kind).toBe("custom");
  });

  it("warns when legacy tasks key is present", () => {
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-config-"));
    writeFileSync(
      join(cwd, CONFIG_FILENAME),
      JSON.stringify({
        tasks: {
          plan: { agent: "claude", model: "claude-sonnet-4-6" },
        },
      }),
    );

    const loaded = loadConfig(cwd);
    expect(loaded.warning).toMatch(/'tasks' in steamtrain\.json is no longer supported/);
    expect(loaded.warning).toMatch(/~\/\.steamtrain\/workspace\.json/);
    expect(loaded.scope.exists).toBe(true);
  });
});

describe("configDisplayLabel", () => {
  it("combines user settings and project config", () => {
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-config-"));
    writeFileSync(join(cwd, CONFIG_FILENAME), JSON.stringify({ timeoutMs: 1 }));
    const loaded = loadConfig({ cwd });
    expect(configDisplayLabel(loaded.scope, { hasUserSettings: true })).toBe("user+project");
    expect(configDisplayLabel(loaded.scope)).toBe("project");
    expect(configDisplayLabel(loaded.scope, { hasUserSettings: true, home: cwd })).toBe(
      "user+project",
    );
  });

  it("shows defaults when no files contribute", () => {
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-config-"));
    const loaded = loadConfig({ cwd });
    expect(configDisplayLabel(loaded.scope)).toBe("defaults");
    expect(configDisplayLabel(loaded.scope, { hasUserSettings: true })).toBe("user");
  });

  it("shows a home-relative custom config path", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const custom = join(home, ".steamtrain", "team.json");
    mkdirSync(join(custom, ".."), { recursive: true });
    writeFileSync(custom, JSON.stringify({ timeoutMs: 1 }));
    const loaded = loadConfig({ customPath: custom, home });
    expect(configDisplayLabel(loaded.scope, { home })).toBe("~/.steamtrain/team.json");
  });
});
