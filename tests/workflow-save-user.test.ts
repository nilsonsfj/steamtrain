import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type WorkflowSpec,
  loadWorkflowCatalog,
  saveUserWorkflow,
  userWorkflowsPath,
  workflowAgentIds,
} from "../src/workflow";

const spec: WorkflowSpec = {
  name: "placeholder",
  description: "Echo flow.",
  phases: [
    {
      id: "split",
      title: "Split",
      steps: [{ id: "areas", kind: "distributor", items: ["a: {{input}}"] }],
    },
  ],
};

describe("saveUserWorkflow", () => {
  it("writes a validated workflow to the user file and reloads it", async () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const result = await saveUserWorkflow("echo-flow", spec, home);

    expect(result.ok).toBe(true);
    expect(result.replaced).toBe(false);
    expect(result.path).toBe(userWorkflowsPath(home));

    const onDisk = JSON.parse(readFileSync(result.path!, "utf8"));
    expect(onDisk.workflows["echo-flow"].name).toBe("echo-flow");

    const catalog = loadWorkflowCatalog({ home });
    expect(catalog.sources["echo-flow"]).toBe("user");
    expect(catalog.workflows["echo-flow"]?.phases).toHaveLength(1);
  });

  it("reports replaced=true when overwriting and preserves other workflows", async () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    await saveUserWorkflow("one", spec, home);
    const first = await saveUserWorkflow("two", spec, home);
    expect(first.replaced).toBe(false);

    const second = await saveUserWorkflow("two", spec, home);
    expect(second.replaced).toBe(true);

    const catalog = loadWorkflowCatalog({ home });
    expect(catalog.sources.one).toBe("user");
    expect(catalog.sources.two).toBe("user");
  });

  it("refuses to write an invalid workflow", async () => {
    const home = mkdtempSync(join(tmpdir(), "steamtrain-home-"));
    const bad: WorkflowSpec = { name: "x", phases: [] };
    const result = await saveUserWorkflow("bad", bad, home);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("workflowAgentIds", () => {
  it("returns an empty list for an agentless workflow", () => {
    expect(workflowAgentIds(spec)).toEqual([]);
  });

  it("returns distinct agents across phases", () => {
    const mixed: WorkflowSpec = {
      name: "mixed",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "a",
              agent: "opencode",
              model: "opencode/qwen3.6-plus-free",
              prompt: "{{input}}",
            },
            { id: "b", agent: "claude", model: "claude-sonnet-4-6", prompt: "{{input}}" },
          ],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "c",
              kind: "consolidator",
              dependsOn: ["a"],
              agent: "opencode",
              model: "opencode/qwen3.6-plus-free",
              prompt: "{{steps.a.output}}",
            },
          ],
        },
      ],
    };
    expect(workflowAgentIds(mixed).sort()).toEqual(["claude", "opencode"]);
  });
});
