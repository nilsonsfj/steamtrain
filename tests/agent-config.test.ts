import { describe, expect, it } from "vitest";
import {
  buildAgentMeta,
  defaultDraftModel,
  resolveAgentInstance,
  resolveAgentInstances,
} from "../src/agents";
import type { AgentAdapter } from "../src/agents";
import type { SteamtrainConfig } from "../src/config";
import { runDoctor } from "../src/doctor";
import { Orchestrator } from "../src/orchestrator";
import type { AgentProviderId } from "../src/types/events";
import { type WorkflowSpec, runWorkflow } from "../src/workflow";
import type { WorkspaceConfig } from "../src/workspace";

const customConfig: SteamtrainConfig = {
  agents: [
    { id: "claude", provider: "claude", enabled: false },
    {
      id: "opencode-fork",
      provider: "opencode",
      binary: "opencode-fork",
      env: { OPENCODE_CONFIG: "fork" },
      extraArgs: ["--profile", "fork"],
      defaultModel: "opencode/mimo-v2.5-free",
    },
  ],
  maxConcurrency: 2,
  stepTimeoutSec: 30,
};

function fakeAdapter(provider: AgentProviderId, binary?: string): AgentAdapter {
  return {
    id: provider,
    binary: binary ?? provider,
    async *run(opts) {
      yield {
        kind: "result",
        agent: provider,
        ts: Date.now(),
        isError: false,
        text: JSON.stringify({
          binary,
          env: opts.env,
          extraArgs: opts.extraArgs,
          model: opts.model,
        }),
      };
    },
  };
}

describe("agent configuration", () => {
  it("keeps the zero-config built-in agents enabled", () => {
    expect(resolveAgentInstances().map((agent) => agent.id)).toEqual([
      "claude",
      "opencode",
      "codex",
      "amp",
    ]);
  });

  it("hides disabled agents outside all-agent config views", () => {
    expect(resolveAgentInstances(customConfig).map((agent) => agent.id)).not.toContain("claude");
    expect(
      resolveAgentInstances(customConfig, { includeDisabled: true }).find(
        (agent) => agent.id === "claude",
      )?.enabled,
    ).toBe(false);
  });

  it("builds metadata for custom instances from their provider catalog", () => {
    const meta = buildAgentMeta(customConfig, (agent) => agent === "opencode-fork", {
      includeDisabled: true,
    });
    const fork = meta.find((agent) => agent.id === "opencode-fork");
    expect(fork).toMatchObject({
      id: "opencode-fork",
      provider: "opencode",
      healthy: true,
      binary: "opencode-fork",
      defaultModel: "opencode/mimo-v2.5-free",
    });
    expect(fork?.models.some((model) => model.id === "opencode/mimo-v2.5-free")).toBe(true);
    expect(defaultDraftModel("opencode-fork", customConfig)).toBe("opencode/mimo-v2.5-free");
  });

  it("runs doctor only for enabled configured instances", async () => {
    const result = await runDoctor({
      agents: [
        { id: "missing-opencode", provider: "opencode", binary: "__missing_opencode__" },
        { id: "disabled-codex", provider: "codex", enabled: false, binary: "__missing_codex__" },
      ],
    });
    expect(result.map((agent) => agent.agent)).toEqual([
      "claude",
      "opencode",
      "codex",
      "amp",
      "missing-opencode",
    ]);
    expect(result.some((agent) => agent.agent === "disabled-codex")).toBe(false);
    expect(result.find((agent) => agent.agent === "missing-opencode")).toMatchObject({
      provider: "opencode",
      status: "binary_missing",
    });
  });

  it("resolves workspace adapters through the configured instance", () => {
    const workspaces: WorkspaceConfig = {
      workspaces: [{ id: "fork", agent: "opencode-fork", model: "opencode/mimo-v2.5-free" }],
    };
    const orch = new Orchestrator(
      customConfig,
      workspaces,
      [
        {
          agent: "opencode-fork",
          provider: "opencode",
          status: "ok",
          binary: "opencode-fork",
          message: "ready",
        },
      ],
      { workflows: {}, sources: {} },
    );
    const resolved = orch.resolve("fork");
    expect(resolved.adapter.id).toBe("opencode");
    expect(resolved.adapter.binary).toBe("opencode-fork");
  });

  it("passes instance env and args into workflow steps", async () => {
    const spec: WorkflowSpec = {
      name: "demo",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "s1",
              agent: "opencode-fork",
              model: "opencode/mimo-v2.5-free",
              prompt: "{{input}}",
              env: { STEP_ONLY: "1" },
              extraArgs: ["--step"],
            },
          ],
        },
      ],
    };
    const done = [];
    for await (const event of runWorkflow(
      spec,
      { input: "x" },
      {
        createAdapter: fakeAdapter,
        agentConfig: customConfig,
        maxConcurrency: 1,
        cwd: "/tmp",
      },
    )) {
      if (event.kind === "step_done") done.push(event.result);
    }

    expect(done).toHaveLength(1);
    expect(JSON.parse(done[0]!.output)).toMatchObject({
      binary: "opencode-fork",
      env: { OPENCODE_CONFIG: "fork", STEP_ONLY: "1" },
      extraArgs: ["--profile", "fork", "--step"],
    });
  });

  it("resolves configured instances by id", () => {
    expect(resolveAgentInstance(customConfig, "opencode-fork")).toMatchObject({
      provider: "opencode",
      binary: "opencode-fork",
    });
    expect(resolveAgentInstance(customConfig, "claude")).toBeUndefined();
    expect(resolveAgentInstance(customConfig, "claude", { includeDisabled: true })?.enabled).toBe(
      false,
    );
  });
});
