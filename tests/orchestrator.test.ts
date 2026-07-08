import { describe, expect, it } from "vitest";
import type { SteamtrainConfig } from "../src/config";
import type { DoctorResult } from "../src/doctor";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import type { LoadedWorkflowCatalog, WorkflowSpec } from "../src/workflow";
import type { WorkspaceConfig } from "../src/workspace";

function makeConfig(overrides?: Partial<SteamtrainConfig>): SteamtrainConfig {
  return {
    binaries: {},
    maxConcurrency: 2,
    stepTimeoutSec: 30,
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

function healthyDoctor(agent: string, provider: string = agent): DoctorResult {
  return {
    category: "agent",
    agent,
    provider: provider as DoctorResult["provider"],
    status: "ok",
    binary: agent,
    message: "ready",
  };
}

function unhealthyDoctor(agent: string, provider: string = agent): DoctorResult {
  return {
    category: "agent",
    agent,
    provider: provider as DoctorResult["provider"],
    status: "unknown_error",
    binary: agent,
    message: "binary missing",
  };
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
    const orch = new Orchestrator(makeConfig(), makeWorkspaces("ws1"), [], makeCatalog());
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

  it("canDispatchWorkflowSpec rejects llm step when API key is missing", () => {
    const llmSpec: WorkflowSpec = {
      name: "llm-test",
      phases: [
        {
          id: "p1",
          title: "phase 1",
          steps: [
            {
              id: "judge",
              kind: "llm",
              model: "claude-opus-4-8",
              prompt: "Judge {{input}}",
            },
          ],
        },
      ],
    };
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [],
      makeCatalog({ "llm-test": llmSpec }, { "llm-test": "bundled" }),
    );
    const orig = process.env.ANTHROPIC_API_KEY;
    try {
      // biome-ignore lint/performance/noDelete: setting to undefined sets the string "undefined" which is truthy
      delete process.env.ANTHROPIC_API_KEY;
      const result = orch.canDispatchWorkflowSpec(llmSpec);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("ANTHROPIC_API_KEY");
        expect(result.reason).toContain("llm API key missing");
      }
    } finally {
      if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  it("canDispatchWorkflowSpec accepts llm step when API key is present", () => {
    const llmSpec: WorkflowSpec = {
      name: "llm-ok",
      phases: [
        {
          id: "p1",
          title: "phase 1",
          steps: [
            {
              id: "judge",
              kind: "llm",
              model: "claude-opus-4-8",
              prompt: "Judge {{input}}",
            },
          ],
        },
      ],
    };
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [],
      makeCatalog({ "llm-ok": llmSpec }, { "llm-ok": "bundled" }),
    );
    const orig = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      const result = orch.canDispatchWorkflowSpec(llmSpec);
      expect(result).toEqual({ ok: true });
    } finally {
      if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
      // biome-ignore lint/performance/noDelete: must remove env var entirely, not set to "undefined" string
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("canDispatchWorkflowSpec rejects mixed agent+llm when key missing", () => {
    const mixedSpec: WorkflowSpec = {
      name: "mixed",
      phases: [
        {
          id: "p1",
          title: "phase 1",
          steps: [
            {
              id: "llm-step",
              kind: "llm",
              model: "claude-opus-4-8",
              prompt: "judge",
            },
            {
              id: "agent-step",
              kind: "worker",
              agent: "opencode",
              model: "m",
              prompt: "{{input}}",
            },
          ],
        },
      ],
    };
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [healthyDoctor("opencode")],
      makeCatalog({ mixed: mixedSpec }, { mixed: "bundled" }),
    );
    const orig = process.env.ANTHROPIC_API_KEY;
    try {
      // biome-ignore lint/performance/noDelete: must remove env var entirely, not set to "undefined" string
      delete process.env.ANTHROPIC_API_KEY;
      const result = orch.canDispatchWorkflowSpec(mixedSpec);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("ANTHROPIC_API_KEY");
      }
    } finally {
      if (orig !== undefined) process.env.ANTHROPIC_API_KEY = orig;
    }
  });

  it("setLlmDoctor preserves agent results when refreshing llm-key entries", () => {
    const orch = new Orchestrator(
      makeConfig(),
      makeWorkspaces("ws1"),
      [healthyDoctor("opencode")],
      makeCatalog({ demo: demoSpec }, { demo: "bundled" }),
    );
    orch.setLlmDoctor([
      {
        category: "llm-key",
        provider: "anthropic",
        requirement: "ANTHROPIC_API_KEY",
        status: "api_key_missing",
        message: "missing",
      },
    ]);
    const doctor = orch.getDoctor();
    expect(doctor).toHaveLength(2);
    expect(doctor.some((d) => d.category === "agent" && d.agent === "opencode")).toBe(true);
    expect(
      doctor.some((d) => d.category === "llm-key" && d.requirement === "ANTHROPIC_API_KEY"),
    ).toBe(true);
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

  it("run throws when workspace has no model configured (M6)", () => {
    const noModelWorkspaces: WorkspaceConfig = {
      workspaces: [{ id: "ws-nomodel", agent: "opencode", model: "" }],
    };
    const orch = new Orchestrator(
      makeConfig(),
      noModelWorkspaces,
      [healthyDoctor("opencode")],
      makeCatalog(),
    );
    expect(() => orch.run("ws-nomodel", "hello")).toThrow("has no model configured");
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
    const orch = new Orchestrator(makeConfig(), makeWorkspaces("ws1"), [], makeCatalog());
    expect(() => orch.runWorkflow("nope", "hello")).toThrow("unknown workflow");
  });

  it("getConfig returns the config", () => {
    const config = makeConfig({ stepTimeoutSec: 5 });
    const orch = new Orchestrator(config, makeWorkspaces(), [], makeCatalog());
    expect(orch.getConfig()).toBe(config);
  });
});
