import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILENAME, loadConfig } from "../src/config";
import { BUNDLED_WORKFLOWS } from "../src/workflow/bundled";
import {
  WORKFLOWS_FILENAME,
  collectSessionWorkflowSaves,
  loadWorkflowCatalog,
  saveSessionWorkflowsToUser,
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
                steps: [
                  {
                    id: "a",
                    agent: "opencode",
                    model: "opencode/qwen3.6-plus-free",
                    prompt: "{{input}}",
                  },
                ],
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
                steps: [
                  {
                    id: "u",
                    agent: "opencode",
                    model: "opencode/qwen3.6-plus-free",
                    prompt: "user",
                  },
                ],
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
                steps: [
                  {
                    id: "p",
                    agent: "opencode",
                    model: "opencode/qwen3.6-plus-free",
                    prompt: "project",
                  },
                ],
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

  it("exposes each workflow name once with the winning source", () => {
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
                steps: [
                  {
                    id: "u",
                    agent: "opencode",
                    model: "opencode/qwen3.6-plus-free",
                    prompt: "user",
                  },
                ],
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
                steps: [
                  {
                    id: "p",
                    agent: "opencode",
                    model: "opencode/qwen3.6-plus-free",
                    prompt: "project",
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    const { config } = loadConfig({ cwd });
    const loaded = loadWorkflowCatalog({ home, projectWorkflows: config.workflows });
    const names = workflowCatalogEntries(loaded).map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(loaded.sources.shared).toBe("project");
    expect(loaded.sources["multi-plan"]).toBe("bundled");
  });
});

describe("saveSessionWorkflowsToUser", () => {
  it("writes bundled workflows with session overrides to the user file", async () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const catalog = loadWorkflowCatalog({ home });
    const result = await saveSessionWorkflowsToUser({
      catalog,
      home,
      sessionOverrides: {
        "multi-plan": {
          "draft-correctness": { model: "opencode/minimax-m3-free" },
        },
      },
    });

    expect(result.saved).toEqual(["multi-plan"]);
    expect(result.path).toBe(userWorkflowsPath(home));
    expect(existsSync(result.path!)).toBe(true);

    const saved = JSON.parse(readFileSync(result.path!, "utf8"));
    expect(saved.workflows["multi-plan"].phases[1].steps[0].model).toBe("opencode/minimax-m3-free");

    const reloaded = loadWorkflowCatalog({ home });
    expect(reloaded.sources["multi-plan"]).toBe("user");
    const reloadedStep = reloaded.workflows["multi-plan"]?.phases[1]?.steps[0] as
      | { model?: string }
      | undefined;
    expect(reloadedStep?.model).toBe("opencode/minimax-m3-free");
    expect(reloaded.workflows["multi-plan"]).not.toEqual(BUNDLED_WORKFLOWS["multi-plan"]);
  });

  it("skips project workflows with session overrides", () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-cwd-"));
    writeFileSync(
      join(cwd, CONFIG_FILENAME),
      JSON.stringify({
        workflows: {
          custom: {
            phases: [
              {
                id: "only",
                title: "Only",
                steps: [
                  {
                    id: "a",
                    agent: "opencode",
                    model: "opencode/qwen3.6-plus-free",
                    prompt: "{{input}}",
                  },
                ],
              },
            ],
          },
        },
      }),
    );
    const { config } = loadConfig({ cwd });
    const catalog = loadWorkflowCatalog({ home, projectWorkflows: config.workflows });
    const result = collectSessionWorkflowSaves({
      catalog,
      home,
      sessionOverrides: { custom: { a: { model: "opencode/mimo-v2.5-free" } } },
    });

    expect(result.saved).toEqual([]);
    expect(result.skipped).toEqual([
      { name: "custom", reason: "project workflows are edited in steamtrain.json" },
    ]);
  });
});
