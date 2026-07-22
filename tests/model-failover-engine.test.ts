import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { AgentAdapter } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import type { RetryPolicy, StepResult, WorkflowEvent, WorkflowSpec } from "../src/workflow";
import { runWorkflow } from "../src/workflow/engine";

/**
 * Script keyed by `agent::model` so failover between bindings is observable.
 * Each queue entry is one adapter invocation outcome.
 *
 * Tests use custom (non-catalog) primary model ids so same-family remaps do
 * not insert extra candidates ahead of explicit `fallbackModels`.
 */
type Outcome =
  | { kind: "ok"; text?: string }
  | { kind: "error"; message?: string }
  | { kind: "quota-result"; message?: string }
  | { kind: "rate-limit-result"; message?: string }
  | { kind: "result-error"; message?: string }
  | { kind: "tool-then-quota"; message?: string };

function modelScriptedDeps(
  script: Record<string, Outcome[]>,
  calls: Array<{ agent: string; model: string }>,
) {
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    defaultModel: "test",
    async *run(opts): AsyncGenerator<AgentEvent> {
      const model = opts.model ?? "unknown";
      const key = `${id}::${model}`;
      calls.push({ agent: id, model });
      const queue = script[key] ?? [];
      const outcome = queue.shift() ?? { kind: "ok" };
      if (outcome.kind === "error") {
        yield {
          kind: "error",
          message: outcome.message ?? "transport boom",
          agent: id,
          ts: Date.now(),
        };
        return;
      }
      if (outcome.kind === "quota-result") {
        const message =
          outcome.message ??
          "You have exceeded your current quota. Please check your plan and billing details.";
        yield {
          kind: "error",
          message,
          category: "quota",
          agent: id,
          ts: Date.now(),
        };
        yield {
          kind: "result",
          text: message,
          isError: true,
          agent: id,
          ts: Date.now(),
        };
        return;
      }
      if (outcome.kind === "rate-limit-result") {
        const message = outcome.message ?? "rate limit exceeded";
        yield {
          kind: "error",
          message,
          category: "rate_limit",
          agent: id,
          ts: Date.now(),
        };
        yield {
          kind: "result",
          text: message,
          isError: true,
          agent: id,
          ts: Date.now(),
        };
        return;
      }
      if (outcome.kind === "result-error") {
        yield {
          kind: "result",
          text: outcome.message ?? "logic fail",
          isError: true,
          agent: id,
          ts: Date.now(),
        };
        return;
      }
      if (outcome.kind === "tool-then-quota") {
        yield { kind: "tool_use", name: "Bash", agent: id, ts: Date.now() };
        const message = outcome.message ?? "quota exceeded after tool";
        yield {
          kind: "error",
          message,
          category: "quota",
          agent: id,
          ts: Date.now(),
        };
        yield {
          kind: "result",
          text: message,
          isError: true,
          agent: id,
          ts: Date.now(),
        };
        return;
      }
      yield {
        kind: "result",
        text: outcome.text ?? "ok",
        isError: false,
        agent: id,
        ts: Date.now(),
      };
    },
  });
  // Only Claude is "ready" so failover stays on one provider and does not
  // wander into unscripted family remaps on other agents.
  return {
    createAdapter,
    maxConcurrency: 2,
    cwd: tmpdir(),
    agentConfig: {
      agents: [
        { id: "claude", provider: "claude" as const, enabled: true },
        { id: "opencode", provider: "opencode" as const, enabled: false },
        { id: "codex", provider: "codex" as const, enabled: false },
        { id: "cursor", provider: "cursor" as const, enabled: false },
        { id: "amp", provider: "amp" as const, enabled: false },
        { id: "kiro", provider: "kiro" as const, enabled: false },
        { id: "antigravity", provider: "antigravity" as const, enabled: false },
      ],
    },
  };
}

const fastRetry: RetryPolicy = { maxAttempts: 3, initialDelayMs: 1, factor: 1, jitter: false };

async function drain(
  spec: WorkflowSpec,
  deps: ReturnType<typeof modelScriptedDeps>,
  signal?: AbortSignal,
) {
  const events: WorkflowEvent[] = [];
  let ok: boolean | undefined;
  const cache = new Map<string, StepResult>();
  for await (const ev of runWorkflow(spec, { input: "in", cache }, deps, signal)) {
    events.push(ev);
    if (ev.kind === "workflow_done") ok = ev.ok;
  }
  return { events, ok, cache };
}

describe("mid-flight model failover on capacity errors", () => {
  it("fails over from a quota result error to fallbackModels and succeeds", async () => {
    const calls: Array<{ agent: string; model: string }> = [];
    const deps = modelScriptedDeps(
      {
        "claude::primary-model": [{ kind: "quota-result" }],
        "claude::claude-sonnet-5": [{ kind: "ok", text: "sonnet-ok" }],
      },
      calls,
    );
    const spec: WorkflowSpec = {
      name: "failover-quota",
      description: "d",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "a",
              kind: "worker",
              agent: "claude",
              model: "primary-model",
              fallbackModels: ["claude-sonnet-5"],
              prompt: "do work",
              retry: fastRetry,
              modelFailover: { failoverDelayMs: 1 },
            },
          ],
        },
      ],
    };
    const { events, ok, cache } = await drain(spec, deps);
    expect(ok).toBe(true);
    expect(calls.map((c) => `${c.agent}/${c.model}`)).toEqual([
      "claude/primary-model",
      "claude/claude-sonnet-5",
    ]);
    expect(cache.get("a")?.model).toBe("claude-sonnet-5");
    expect(cache.get("a")?.output).toBe("sonnet-ok");
    const retries = events.filter((e) => e.kind === "step_retry");
    expect(retries).toHaveLength(1);
    const retry = retries[0]!;
    expect(retry.kind).toBe("step_retry");
    if (retry.kind === "step_retry") {
      expect(retry.failover?.fromModel).toBe("primary-model");
      expect(retry.failover?.toModel).toBe("claude-sonnet-5");
      expect(retry.failover?.failureKind).toBe("quota");
      expect(retry.reason).toMatch(/quota/i);
      expect(retry.reason).toMatch(/failing over/);
    }
  });

  it("fails over on rate-limit result errors", async () => {
    const calls: Array<{ agent: string; model: string }> = [];
    const deps = modelScriptedDeps(
      {
        "claude::primary-model": [{ kind: "rate-limit-result" }],
        "claude::claude-haiku-4-5": [{ kind: "ok", text: "haiku-ok" }],
      },
      calls,
    );
    const spec: WorkflowSpec = {
      name: "failover-rate",
      description: "d",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "a",
              kind: "worker",
              agent: "claude",
              model: "primary-model",
              fallbackModels: ["claude-haiku-4-5"],
              prompt: "do work",
              retry: fastRetry,
              modelFailover: { failoverDelayMs: 1 },
            },
          ],
        },
      ],
    };
    const { ok } = await drain(spec, deps);
    expect(ok).toBe(true);
    expect(calls.map((c) => c.model)).toEqual(["primary-model", "claude-haiku-4-5"]);
  });

  it("still does not retry ordinary logic result errors", async () => {
    const calls: Array<{ agent: string; model: string }> = [];
    const deps = modelScriptedDeps(
      {
        "claude::primary-model": [{ kind: "result-error" }, { kind: "ok" }],
      },
      calls,
    );
    const spec: WorkflowSpec = {
      name: "no-logic-retry",
      description: "d",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "a",
              kind: "worker",
              agent: "claude",
              model: "primary-model",
              fallbackModels: ["claude-sonnet-5"],
              prompt: "do work",
              retry: fastRetry,
            },
          ],
        },
      ],
    };
    const { ok } = await drain(spec, deps);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("does not failover after tool use by default", async () => {
    const calls: Array<{ agent: string; model: string }> = [];
    const deps = modelScriptedDeps(
      {
        "claude::primary-model": [{ kind: "tool-then-quota" }],
        "claude::claude-sonnet-5": [{ kind: "ok" }],
      },
      calls,
    );
    const spec: WorkflowSpec = {
      name: "tool-blocks",
      description: "d",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "a",
              kind: "worker",
              agent: "claude",
              model: "primary-model",
              fallbackModels: ["claude-sonnet-5"],
              prompt: "do work",
              retry: fastRetry,
            },
          ],
        },
      ],
    };
    const { ok } = await drain(spec, deps);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("honors allowAfterToolUse for capacity failover", async () => {
    const calls: Array<{ agent: string; model: string }> = [];
    const deps = modelScriptedDeps(
      {
        "claude::primary-model": [{ kind: "tool-then-quota" }],
        "claude::claude-sonnet-5": [{ kind: "ok", text: "recovered" }],
      },
      calls,
    );
    const spec: WorkflowSpec = {
      name: "tool-allowed",
      description: "d",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "a",
              kind: "worker",
              agent: "claude",
              model: "primary-model",
              fallbackModels: ["claude-sonnet-5"],
              prompt: "do work",
              retry: fastRetry,
              modelFailover: { allowAfterToolUse: true, failoverDelayMs: 1 },
            },
          ],
        },
      ],
    };
    const { ok, cache } = await drain(spec, deps);
    expect(ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(cache.get("a")?.output).toBe("recovered");
  });

  it("can disable mid-flight failover via modelFailover.enabled", async () => {
    const calls: Array<{ agent: string; model: string }> = [];
    const deps = modelScriptedDeps(
      {
        "claude::primary-model": [{ kind: "quota-result" }, { kind: "ok" }],
        "claude::claude-sonnet-5": [{ kind: "ok" }],
      },
      calls,
    );
    const spec: WorkflowSpec = {
      name: "disabled",
      description: "d",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "a",
              kind: "worker",
              agent: "claude",
              model: "primary-model",
              fallbackModels: ["claude-sonnet-5"],
              prompt: "do work",
              retry: fastRetry,
              modelFailover: { enabled: false },
            },
          ],
        },
      ],
    };
    const { ok } = await drain(spec, deps);
    // Quota result is not classic-retryable; with failover disabled the step fails once.
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("uses workflow-level fallbackModels for the failover chain", async () => {
    const calls: Array<{ agent: string; model: string }> = [];
    const deps = modelScriptedDeps(
      {
        "claude::primary-model": [{ kind: "quota-result" }],
        "claude::claude-sonnet-5": [{ kind: "ok", text: "wf-fallback" }],
      },
      calls,
    );
    const spec: WorkflowSpec = {
      name: "wf-fallback",
      description: "d",
      fallbackModels: ["claude-sonnet-5"],
      modelFailover: { failoverDelayMs: 1 },
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "a",
              kind: "worker",
              agent: "claude",
              model: "primary-model",
              prompt: "do work",
              retry: fastRetry,
            },
          ],
        },
      ],
    };
    const { ok, cache } = await drain(spec, deps);
    expect(ok).toBe(true);
    expect(calls.map((c) => c.model)).toEqual(["primary-model", "claude-sonnet-5"]);
    expect(cache.get("a")?.output).toBe("wf-fallback");
  });

  it("fails fast on quota when no fallback remains", async () => {
    const calls: Array<{ agent: string; model: string }> = [];
    const deps = modelScriptedDeps(
      {
        "claude::primary-model": [
          { kind: "quota-result" },
          { kind: "quota-result" },
          { kind: "quota-result" },
        ],
      },
      calls,
    );
    const spec: WorkflowSpec = {
      name: "quota-alone",
      description: "d",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "a",
              kind: "worker",
              agent: "claude",
              model: "primary-model",
              prompt: "do work",
              retry: fastRetry,
            },
          ],
        },
      ],
    };
    const { ok } = await drain(spec, deps);
    expect(ok).toBe(false);
    // Prefer-next-model fail-fast: do not burn maxAttempts on the same binding.
    expect(calls).toHaveLength(1);
  });
});
