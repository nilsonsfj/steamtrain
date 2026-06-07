import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILENAME, loadConfig } from "../src/config";
import { BUNDLED_WORKFLOWS } from "../src/workflow/bundled";
import {
  WORKFLOWS_FILENAME,
  loadWorkflowCatalog,
  userWorkflowsPath,
  workflowCatalogEntries,
} from "../src/workflow/catalog";

describe("loadWorkflowCatalog", () => {
  it("starts from bundled workflows", () => {
    const loaded = loadWorkflowCatalog({ home: mkdtempSync(join(tmpdir(), "steamtrain-home-")) });
    expect(loaded.workflows["multi-plan"]).toEqual(BUNDLED_WORKFLOWS["multi-plan"]);
    expect(loaded.sources["multi-plan"]).toBe("bundled");
    expect(workflowCatalogEntries(loaded).map((entry) => entry.name)).toContain("bug-hunt");
  });

  it("loads user workflows from ~/.steamtrain/workflows.json", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const dir = join(home, ".steamtrain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, WORKFLOWS_FILENAME),
      JSON.stringify({
        workflows: {
          "my-flow": {
            phases: [
              {
                id: "only",
                title: "Only",
                steps: [{ id: "a", agent: "opencode", model: "opencode/qwen3.6-plus-free", prompt: "{{input}}" }],
              },
            ],
          },
        },
      }),
    );

    const loaded = loadWorkflowCatalog({ home });
    expect(loaded.workflows["my-flow"]?.name).toBe("my-flow");
    expect(loaded.sources["my-flow"]).toBe("user");
    expect(loaded.sources["multi-plan"]).toBe("bundled");
  });

  it("lets project workflows override bundled and user entries", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-cwd-"));
    mkdirSync(join(home, ".steamtrain"), { recursive: true });
    writeFileSync(
      userWorkflowsPath(home),
      JSON.stringify({
        workflows: {
          shared: {
            phases: [
              {
                id: "user",
                title: "User",
                steps: [{ id: "u", agent: "opencode", model: "opencode/qwen3.6-plus-free", prompt: "user" }],
              },
            ],
          },
        },
      }),
    );
    writeFileSync(
      join(cwd, CONFIG_FILENAME),
      JSON.stringify({
        workflows: {
          shared: {
            phases: [
              {
                id: "project",
                title: "Project",
                steps: [{ id: "p", agent: "opencode", model: "opencode/qwen3.6-plus-free", prompt: "project" }],
              },
            ],
          },
        },
      }),
    );

    const { config } = loadConfig({ cwd });
    const loaded = loadWorkflowCatalog({ home, projectWorkflows: config.workflows });
    expect(loaded.sources.shared).toBe("project");
    expect(loaded.workflows.shared?.phases[0]?.id).toBe("project");
  });

  it("warns on invalid user workflow files", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    mkdirSync(join(home, ".steamtrain"), { recursive: true });
    writeFileSync(userWorkflowsPath(home), "{ not json");

    const loaded = loadWorkflowCatalog({ home });
    expect(loaded.warning).toMatch(/could not parse/);
    expect(loaded.sources["multi-plan"]).toBe("bundled");
  });
});
