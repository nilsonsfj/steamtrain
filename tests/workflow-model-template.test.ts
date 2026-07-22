import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type LlmCallRequest,
  type LlmCallResult,
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  lintTemplateRefs,
  runWorkflow,
} from "../src/workflow";

/**
 * Building block 5: templated `model`/`effort` on agent-backed and `llm`
 * steps render through the standard template pipeline at execution time.
 */

const touchedEnv: string[] = [];
afterEach(() => {
  for (const name of touchedEnv.splice(0)) delete process.env[name];
});

interface RunRecord {
  opts: AgentRunOptions;
}

function agentDeps(runs: RunRecord[]): WorkflowDeps {
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        runs.push({ opts });
        yield {
          kind: "result",
          agent: id,
          ts: 0,
          isError: false,
          text: `out:${opts.model}`,
        } satisfies AgentEvent;
      })();
    },
  });
  return { createAdapter, maxConcurrency: 4, cwd: process.cwd() };
}

async function runToEvents(
  spec: WorkflowSpec,
  deps: WorkflowDeps,
  inputs?: Record<string, string>,
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input: "task", inputs }, deps)) events.push(ev);
  return events;
}

function doneResults(events: WorkflowEvent[]): Map<string, StepResult> {
  const map = new Map<string, StepResult>();
  for (const ev of events) if (ev.kind === "step_done") map.set(ev.stepId, ev.result);
  return map;
}

describe("templated model/effort on agent-backed steps", () => {
  it("renders {{inputs.*}} in model before spawning the agent", async () => {
    const runs: RunRecord[] = [];
    const spec: WorkflowSpec = {
      name: "model-template",
      inputs: { coderModel: { default: "claude-sonnet" } },
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "work", agent: "claude", model: "{{inputs.coderModel}}", prompt: "go" }],
        },
      ],
    };
    const events = await runToEvents(spec, agentDeps(runs), { coderModel: "opus-x" });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.opts.model).toBe("opus-x");
    expect(doneResults(events).get("work")?.output).toBe("out:opus-x");
  });

  it("fails the step with a clear message when the model renders empty", async () => {
    const runs: RunRecord[] = [];
    const spec: WorkflowSpec = {
      name: "model-template-empty",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "work", agent: "claude", model: "{{inputs.missing}}", prompt: "go" }],
        },
      ],
    };
    const events = await runToEvents(spec, agentDeps(runs));
    expect(runs).toHaveLength(0);
    const result = doneResults(events).get("work");
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("rendered empty");
  });

  it("renders per-item model inside a forEach fan-out", async () => {
    const runs: RunRecord[] = [];
    const spec: WorkflowSpec = {
      name: "model-template-foreach",
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "split", kind: "distributor", items: ["gpt", "claude-x"] }],
        },
        {
          id: "work",
          title: "Work",
          steps: [
            {
              id: "work",
              kind: "worker",
              agent: "claude",
              model: "{{item}}",
              prompt: "go",
              forEach: "steps.split.items",
              dependsOn: ["split"],
            },
          ],
        },
      ],
    };
    const events = await runToEvents(spec, agentDeps(runs));
    const results = doneResults(events);
    expect(results.get("work[0]")?.output).toBe("out:gpt");
    expect(results.get("work[1]")?.output).toBe("out:claude-x");
    expect(runs.map((r) => r.opts.model).sort()).toEqual(["claude-x", "gpt"]);
  });

  it("re-renders an edited model template applied mid-run", async () => {
    // A mid-run edit lands a NEW template; execution renders it, not the
    // original. Simulated here via `applyWorkflowStepOverrides`.
    const { applyWorkflowStepOverrides } = await import("../src/workflow/overrides");
    const runs: RunRecord[] = [];
    const spec: WorkflowSpec = {
      name: "model-template-edit",
      inputs: { coderModel: { default: "claude-sonnet" } },
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "work", agent: "claude", model: "original", prompt: "go" }],
        },
      ],
    };
    const edited = applyWorkflowStepOverrides(spec, {
      work: { model: "{{inputs.coderModel}}" },
    });
    const events = await runToEvents(edited, agentDeps(runs), { coderModel: "grok-5" });
    expect(runs[0]?.opts.model).toBe("grok-5");
  });

  it("rematerializes model-only steps before workspace allocation", async () => {
    const runs: RunRecord[] = [];
    const allocatedAgents: string[] = [];
    const createAdapter = (id: AgentId): AgentAdapter => ({
      id,
      binary: "fake",
      defaultModel: "test",
      run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
        return (async function* () {
          runs.push({ opts });
          yield {
            kind: "result",
            agent: id,
            ts: 0,
            isError: false,
            text: `out:${opts.model}`,
          } satisfies AgentEvent;
        })();
      },
    });
    const deps: WorkflowDeps = {
      createAdapter,
      maxConcurrency: 4,
      cwd: process.cwd(),
      agentWorkspace: {
        async allocate(request) {
          if (!request.agent) throw new Error("no concrete agent binding for workspace allocation");
          allocatedAgents.push(request.agent);
          return { cwd: process.cwd(), dispose: async () => {} };
        },
      },
    };
    const spec: WorkflowSpec = {
      name: "model-only-workspace",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "prepare",
              kind: "processor",
              model: "mimo/mimo-auto",
              prompt: "go",
            },
          ],
        },
      ],
    };
    const events = await runToEvents(spec, deps);
    const result = doneResults(events).get("prepare");
    expect(result?.ok).toBe(true);
    expect(allocatedAgents).toEqual(["mimo"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.opts.model).toBe("mimo/mimo-auto");
    expect(runs[0]?.opts.agentId).toBe("mimo");
  });

  it("rematerializes templated model-only inputs before workspace allocation", async () => {
    const runs: RunRecord[] = [];
    const allocatedAgents: string[] = [];
    const createAdapter = (id: AgentId): AgentAdapter => ({
      id,
      binary: "fake",
      defaultModel: "test",
      run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
        return (async function* () {
          runs.push({ opts });
          yield {
            kind: "result",
            agent: id,
            ts: 0,
            isError: false,
            text: `out:${opts.model}`,
          } satisfies AgentEvent;
        })();
      },
    });
    const deps: WorkflowDeps = {
      createAdapter,
      maxConcurrency: 4,
      cwd: process.cwd(),
      agentWorkspace: {
        async allocate(request) {
          if (!request.agent) throw new Error("no concrete agent binding for workspace allocation");
          allocatedAgents.push(request.agent);
          return { cwd: process.cwd(), dispose: async () => {} };
        },
      },
    };
    const spec: WorkflowSpec = {
      name: "templated-model-only-workspace",
      inputs: {
        babysitterModel: { type: "model", default: "mimo/mimo-auto" },
      },
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "prepare",
              kind: "processor",
              model: "{{inputs.babysitterModel}}",
              prompt: "go",
            },
          ],
        },
      ],
    };
    const events = await runToEvents(spec, deps, { babysitterModel: "mimo/mimo-auto" });
    const result = doneResults(events).get("prepare");
    expect(result?.ok).toBe(true);
    expect(allocatedAgents).toEqual(["mimo"]);
    expect(runs[0]?.opts.agentId).toBe("mimo");
  });

  it("rematerializes a mismatched agent pin onto the model family before spawn", async () => {
    const runs: RunRecord[] = [];
    const createAdapter = (id: AgentId): AgentAdapter => ({
      id,
      binary: "fake",
      defaultModel: "test",
      run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
        return (async function* () {
          runs.push({ opts });
          yield {
            kind: "result",
            agent: id,
            ts: 0,
            isError: false,
            text: "ok",
          } satisfies AgentEvent;
        })();
      },
    });
    const deps: WorkflowDeps = {
      createAdapter,
      maxConcurrency: 4,
      cwd: process.cwd(),
      agentConfig: {
        agents: [
          { id: "opencode", provider: "opencode", enabled: true },
          { id: "mimo", provider: "mimo", enabled: true },
        ],
      },
    };
    const spec: WorkflowSpec = {
      name: "mismatched-pin",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "work",
              kind: "worker",
              agent: "opencode",
              model: "mimo/mimo-auto",
              prompt: "go",
            },
          ],
        },
      ],
    };
    const events = await runToEvents(spec, deps);
    expect(doneResults(events).get("work")?.ok).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.opts.agentId).toBe("mimo");
    expect(runs[0]?.opts.model).toBe("mimo/mimo-auto");
  });
});

describe("templated model on llm steps", () => {
  function llmDeps(complete: WorkflowDeps["llmComplete"]): WorkflowDeps {
    return {
      createAdapter: () => {
        throw new Error("llm workflows must not create agent adapters");
      },
      maxConcurrency: 4,
      cwd: process.cwd(),
      llmComplete: complete,
    };
  }

  it("renders {{inputs.*}} in model before resolving the api/pricing and records the rendered model", async () => {
    process.env.STEAMTRAIN_TEST_LLM_KEY = "sk-test";
    touchedEnv.push("STEAMTRAIN_TEST_LLM_KEY");
    const requests: LlmCallRequest[] = [];
    const complete = async (req: LlmCallRequest): Promise<LlmCallResult> => {
      requests.push(req);
      return { ok: true, text: "done", tokens: { input: 10, output: 5 } };
    };
    const spec: WorkflowSpec = {
      name: "llm-model-template",
      inputs: { model: { default: "gpt-4o" } },
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "judge",
              kind: "llm",
              provider: "openai",
              model: "{{inputs.model}}",
              prompt: "go",
              apiKeyEnv: "STEAMTRAIN_TEST_LLM_KEY",
            },
          ],
        },
      ],
    };
    const events = await runToEvents(spec, llmDeps(complete), { model: "gpt-5-mini" });
    expect(requests[0]?.model).toBe("gpt-5-mini");
    const result = doneResults(events).get("judge");
    expect(result?.model).toBe("gpt-5-mini");
  });

  it("fails the llm step with a clear message when the model renders empty", async () => {
    const complete = async (): Promise<LlmCallResult> => ({
      ok: true,
      text: "unreachable",
      tokens: { input: 1, output: 1 },
    });
    const spec: WorkflowSpec = {
      name: "llm-model-template-empty",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "judge",
              kind: "llm",
              provider: "openai",
              model: "{{inputs.missing}}",
              prompt: "go",
              apiKeyEnv: "STEAMTRAIN_TEST_LLM_KEY_UNSET",
            },
          ],
        },
      ],
    };
    const events = await runToEvents(spec, llmDeps(complete));
    const result = doneResults(events).get("judge");
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("rendered empty");
  });
});

describe("template lint for model/effort/value/params", () => {
  it("flags an undeclared input referenced in a step's model template", () => {
    const spec: WorkflowSpec = {
      name: "lint-model",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "work", agent: "claude", model: "{{inputs.nope}}", prompt: "go" }],
        },
      ],
    };
    const warnings = lintTemplateRefs(spec);
    expect(warnings.some((w) => w.includes("undeclared input 'nope'"))).toBe(true);
  });

  it("flags an undeclared input referenced in a workflow call step's params", () => {
    const spec: WorkflowSpec = {
      name: "lint-params",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "call",
              kind: "workflow",
              workflow: "child",
              params: { coderModel: "{{inputs.nope}}" },
            },
          ],
        },
      ],
    };
    const warnings = lintTemplateRefs(spec);
    expect(warnings.some((w) => w.includes("undeclared input 'nope'"))).toBe(true);
  });

  it("flags {{item}} in a non-forEach workflow call step's params", () => {
    const spec: WorkflowSpec = {
      name: "lint-params-item",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "call", kind: "workflow", workflow: "child", params: { x: "{{item}}" } }],
        },
      ],
    };
    const warnings = lintTemplateRefs(spec);
    expect(warnings.some((w) => w.includes("not a forEach child"))).toBe(true);
  });
});
