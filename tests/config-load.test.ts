import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILENAME, loadConfig } from "../src/config";

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
    expect(loaded.config.workflows?.bad).toBeUndefined();
  });
});
