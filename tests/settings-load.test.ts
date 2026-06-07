import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings, mergeSettings, settingsConfigPath } from "../src/settings";
import { DEFAULT_PROMPT_HISTORY_LIMIT } from "../src/settings/defaults";

describe("loadSettings", () => {
  it("returns defaults when no file exists", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-settings-"));
    const loaded = loadSettings(home);
    expect(loaded.settings.promptHistoryLimit).toBe(DEFAULT_PROMPT_HISTORY_LIMIT);
    expect(loaded.source).toBe("built-in defaults");
  });

  it("merges promptHistoryLimit from user settings", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-settings-"));
    const path = settingsConfigPath(home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ promptHistoryLimit: 250 }));

    const loaded = loadSettings(home);
    expect(loaded.settings.promptHistoryLimit).toBe(250);
    expect(loaded.source).toBe(settingsConfigPath(home));
  });

  it("falls back to defaults on invalid settings", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-settings-"));
    const path = settingsConfigPath(home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ promptHistoryLimit: 0 }));

    const loaded = loadSettings(home);
    expect(loaded.settings.promptHistoryLimit).toBe(DEFAULT_PROMPT_HISTORY_LIMIT);
    expect(loaded.warning).toMatch(/invalid/);
  });
});

describe("mergeSettings", () => {
  it("keeps base values when override omits them", () => {
    expect(mergeSettings({ promptHistoryLimit: 50 }, {})).toEqual({ promptHistoryLimit: 50 });
  });
});
