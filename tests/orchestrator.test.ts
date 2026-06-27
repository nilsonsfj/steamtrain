import { describe, expect, it } from "vitest";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import type { SteamtrainConfig } from "../src/config";
import type { DoctorResult } from "../src/doctor";
import type { LoadedWorkflowCatalog, WorkflowSpec } from "../src/workflow";
import type { WorkspaceConfig } from "../src/workspace";

function makeConfig(overrides?: Partial<SteamtrainConfig>): SteamtrainConfig {
  return {
    binaries: {},
    maxConcurrency: 2,
    timeoutMs: 30_000,
    loopMaxIterations: 10,
    ...overrides,
  };
}

function makeWorkspaces(...ids: string[]): WorkspaceConfig {
  return {
    workspaces: ids.map((id) => ({
      id,
      agent: "opencode" as const,
      model: "test-model",
    })),
  };
}

function makeCatalog(
  workflows?: Record<string, WorkflowSpec>,
  sources?: Record<string, string>,
): LoadedWorkflowCatalog {
  return {
    workflows: workflows ?? {},
    sources: (sources ?? {}) as Record<string, "bundled" | "user" | "project">,
  };
}

function healthyDoctor(agent: string): DoctorResult {
  return { agent: agent as never, status: "ok", message: "ready" };
}

function unhealthyDoctor(agent: string): DoctorResult {
  return { agent: agent as never, status: "error", message: "binary missing" };
}

const demoSpec: WorkflowSpec = {
  name: "demo",
  phases: [
    {
      id: "p1",
      title: "Phase 1",
      steps: [{ id: "s1", agent: "opencode", model: "m", prompt: "{{input}}" }],
    },
  ],
};

describe("Orchestrator", () => {
  it("returns catalog workflows via listWorkflows", () => {
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [],
      makeCatalog({ demo: demoSpec }, { demo: "bundled" }),
    );
    expect(orch.listWorkflows()).toEqual({ demo: demoSpec });
  });

  it("setCatalog replaces the live catalog", () => {
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [],
      makeCatalog(),
    );
    expect(orch.listWorkflows()).toEqual({});
    orch.setCatalog(makeCatalog({ demo: demoSpec }, { demo: "user" }));
    expect(orch.listWorkflows()).toEqual({ demo: demoSpec });
  });

  it("setDoctor updates health results", () => {
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [],
      makeCatalog({ demo: demoSpec }, { demo: "bundled" }),
    );
    expect(orch.isAgentHealthy("opencode")).toBe(false);
    orch.setDoctor([healthyDoctor("opencode")]);
    expect(orch.isAgentHealthy("opencode")).toBe(true);
  });

  it("workflowSource returns the source kind", () => {
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [],
      makeCatalog({ demo: demoSpec }, { demo: "project" }),
    );
    expect(orch.workflowSource("demo")).toBe("project");
    expect(orch.workflowSource("unknown")).toBeUndefined();
  });

  it("canDispatch returns ok for healthy agents", () => {
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [healthyDoctor("opencode")],
      makeCatalog({ demo: demoSpec }, { demo: "bundled" }),
    );
    expect(orch.canDispatch("ws1")).toEqual({ ok: true });
  });

  it("canDispatch returns error for unknown workspace", () => {
    const orch = new Orchestrator(makeConfig(), makeWorkspaces(), [], makeCatalog());
    const result = orch.canDispatch("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unknown workspace");
  });

  it("canDispatch returns error when health unknown", () => {
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [],
      makeCatalog({ demo: demoSpec }, { demo: "bundled" }),
    );
    const result = orch.canDispatch("ws1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("health unknown");
  });

  it("canDispatch returns error for unhealthy agent", () => {
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [unhealthyDoctor("opencode")],
      makeCatalog({ demo: demoSpec }, { demo: "bundled" }),
    );
    const result = orch.canDispatch("ws1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("error");
  });

  it("canDispatchWorkflow validates and checks agent health", () => {
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [healthyDoctor("opencode")],
      makeCatalog({ demo: demoSpec }, { demo: "bundled" }),
    );
    expect(orch.canDispatchWorkflow("demo")).toEqual({ ok: true });
    expect(orch.canDispatchWorkflow("unknown").ok).toBe(false);
  });

  it("canDispatchWorkflowSpec rejects unhealthy agent in workflow", () => {
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [unhealthyDoctor("opencode")],
      makeCatalog({ demo: demoSpec }, { demo: "bundled" }),
    );
    const result = orch.canDispatchWorkflowSpec(demoSpec);
    expect(result.ok).toBe(false);
  });

  it("run throws for unknown workspace", () => {
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [healthyDoctor("opencode")],
      makeCatalog(),
    );
    expect(() => orch.run("nope", "hello")).toThrow("unknown workspace");
  });

  it("run throws when agent is unhealthy (canDispatch check)", () => {
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [unhealthyDoctor("opencode")],
      makeCatalog({ demo: demoSpec }, { demo: "bundled" }),
    );
    expect(() => orch.run("ws1", "hello")).toThrow();
  });

  it("runWorkflow throws for unknown workflow", () => {
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [],
      makeCatalog(),
    );
    expect(() => orch.runWorkflow("nope", "hello")).toThrow("unknown workflow");
  });

  it("getConfig returns the config", () => {
    const config = makeConfig({ timeoutMs: 5000 });
    const orch = new Orchestrator(config, makeWorkspaces(), [], makeCatalog());
    expect(orch.getConfig()).toBe(config);
  });
});
