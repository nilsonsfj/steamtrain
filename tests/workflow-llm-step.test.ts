import { afterEach, describe, expect, it } from "vitest";
import {
  type LlmCallRequest,
  type LlmCallResult,
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  callLlm,
  lintTemplateRefs,
  llmApiKeyEnvName,
  planWorkflow,
  resolveLlmBaseUrl,
  resolveLlmProvider,
  runWorkflow,
  validateWorkflow,
} from "../src/workflow";

const KEY_ENV = "STEAMTRAIN_TEST_LLM_KEY";
const touchedEnv: string[] = [];

function setKey(name = KEY_ENV, value = "sk-test-123"): void {
  process.env[name] = value;
  touchedEnv.push(name);
}

afterEach(() => {
  for (const name of touchedEnv.splice(0)) delete process.env[name];
});

/** llm workflows never spawn an agent CLI; a throwing adapter proves it. */
function llmDeps(
  complete: WorkflowDeps["llmComplete"],
  over: Partial<WorkflowDeps> = {},
): WorkflowDeps {
  return {
    createAdapter: () => {
      throw new Error("llm-step workflows must not create agent adapters");
    },
    maxConcurrency: 4,
    cwd: process.cwd(),
    llmComplete: complete,
    ...over,
  };
}

async function runToEvents(
  spec: WorkflowSpec,
  deps: WorkflowDeps,
  input = "task",
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input }, deps)) events.push(ev);
  return events;
}

function doneResults(events: WorkflowEvent[]): Map<string, StepResult> {
  const map = new Map<string, StepResult>();
  for (const ev of events) {
    if (ev.kind === "step_done") map.set(ev.stepId, ev.result);
  }
  return map;
}

function workflowOk(events: WorkflowEvent[]): boolean {
  const done = events.find((ev) => ev.kind === "workflow_done");
  return done?.kind === "workflow_done" ? done.ok : false;
}

function spec(phases: WorkflowSpec["phases"]): WorkflowSpec {
  return { name: "llm-test", phases };
}

function okResult(
  text: string,
  extra: Partial<Extract<LlmCallResult, { ok: true }>> = {},
): LlmCallResult {
  return { ok: true, text, tokens: { input: 100, output: 20 }, ...extra };
}

describe("llm step validation", () => {
  it("accepts a minimal llm step", () => {
    const result = validateWorkflow(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "judge", kind: "llm", model: "claude-opus-4-8", prompt: "Judge {{input}}" },
          ],
        },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects itemsPath without an output schema", () => {
    const result = validateWorkflow(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "split",
              kind: "llm",
              model: "claude-opus-4-8",
              prompt: "x",
              itemsPath: "targets",
            },
          ],
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("itemsPath requires an output schema");
  });

  it("allows an llm step with an output schema as a forEach source", () => {
    const result = validateWorkflow(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "split",
              kind: "llm",
              model: "claude-opus-4-8",
              prompt: "split {{input}}",
              output: { type: "array", items: { type: "string" } },
            },
          ],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "judge-each",
              kind: "llm",
              model: "claude-opus-4-8",
              dependsOn: ["split"],
              forEach: "steps.split.items",
              prompt: "judge {{item}}",
            },
          ],
        },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a forEach source llm step without an output schema", () => {
    const result = validateWorkflow(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [{ id: "split", kind: "llm", model: "claude-opus-4-8", prompt: "split" }],
        },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "judge-each",
              kind: "llm",
              model: "claude-opus-4-8",
              dependsOn: ["split"],
              forEach: "steps.split.items",
              prompt: "judge {{item}}",
            },
          ],
        },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      "must be a distributor step (or an llm step with an output schema)",
    );
  });

  it("lints template refs inside the system prompt", () => {
    const warnings = lintTemplateRefs(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "judge",
              kind: "llm",
              model: "claude-opus-4-8",
              prompt: "x",
              system: "context: {{steps.nope.output}}",
            },
          ],
        },
      ]),
    );
    expect(warnings.some((w) => w.includes("unknown step 'nope'"))).toBe(true);
  });
});

describe("llm step execution", () => {
  it("runs one completion, records tokens, and streams the text", async () => {
    setKey();
    const requests: LlmCallRequest[] = [];
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "judge",
              kind: "llm",
              model: "claude-opus-4-8",
              apiKeyEnv: KEY_ENV,
              system: "You judge {{input}}.",
              prompt: "Judge: {{input}}",
            },
          ],
        },
      ]),
      llmDeps(async (request) => {
        requests.push(request);
        return okResult("verdict: fine");
      }),
      "the release",
    );
    expect(workflowOk(events)).toBe(true);
    const result = doneResults(events).get("judge");
    expect(result?.ok).toBe(true);
    expect(result?.output).toBe("verdict: fine");
    expect(result?.tokens).toEqual({ input: 100, output: 20 });
    expect(result?.costUsd).toBeUndefined();
    expect(result?.worktree).toBeUndefined();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.provider).toBe("anthropic");
    expect(requests[0]?.apiKey).toBe("sk-test-123");
    expect(requests[0]?.prompt).toBe("Judge: the release");
    expect(requests[0]?.system).toBe("You judge the release.");
    expect(requests[0]?.jsonOutput).toBe(false);

    const stream = events.find((ev) => ev.kind === "step_event");
    expect(stream?.kind === "step_event" && stream.event.kind === "text_delta").toBe(true);
  });

  it("fails fast with a clear error when the API key env var is unset", async () => {
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "judge",
              kind: "llm",
              model: "claude-opus-4-8",
              apiKeyEnv: "STEAMTRAIN_TEST_DEFINITELY_UNSET",
              prompt: "x",
            },
          ],
        },
      ]),
      llmDeps(async () => {
        throw new Error("must not be called without a key");
      }),
    );
    expect(workflowOk(events)).toBe(false);
    const result = doneResults(events).get("judge");
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("STEAMTRAIN_TEST_DEFINITELY_UNSET");
    expect(result?.error).toContain("anthropic");
  });

  it("auto-retries transient failures under the retry policy", async () => {
    setKey();
    let calls = 0;
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "judge",
              kind: "llm",
              model: "claude-opus-4-8",
              apiKeyEnv: KEY_ENV,
              prompt: "x",
              retry: { maxAttempts: 3, initialDelayMs: 0, jitter: false },
            },
          ],
        },
      ]),
      llmDeps(async () => {
        calls += 1;
        if (calls < 3)
          return {
            ok: false,
            error: "anthropic API error 529: overloaded",
            status: 529,
            retryable: true,
          };
        return okResult("recovered");
      }),
    );
    expect(workflowOk(events)).toBe(true);
    expect(calls).toBe(3);
    const result = doneResults(events).get("judge");
    expect(result?.output).toBe("recovered");
    expect(result?.attempts).toBe(3);
    expect(events.filter((ev) => ev.kind === "step_retry")).toHaveLength(2);
  });

  it("does not retry non-retryable failures", async () => {
    setKey();
    let calls = 0;
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "judge",
              kind: "llm",
              model: "claude-opus-4-8",
              apiKeyEnv: KEY_ENV,
              prompt: "x",
              retry: { maxAttempts: 3, initialDelayMs: 0 },
            },
          ],
        },
      ]),
      llmDeps(async () => {
        calls += 1;
        return {
          ok: false,
          error: "anthropic API error 400: bad request",
          status: 400,
          retryable: false,
        };
      }),
    );
    expect(workflowOk(events)).toBe(false);
    expect(calls).toBe(1);
  });

  it("enforces structured output with one bounded fix retry and sums tokens", async () => {
    setKey();
    const prompts: string[] = [];
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "judge",
              kind: "llm",
              model: "claude-opus-4-8",
              apiKeyEnv: KEY_ENV,
              prompt: "Judge {{input}}",
              output: {
                type: "object",
                required: ["verdict"],
                properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
              },
            },
          ],
        },
      ]),
      llmDeps(async (request) => {
        prompts.push(request.prompt);
        expect(request.jsonOutput).toBe(true);
        if (prompts.length === 1) return okResult("not json at all");
        return okResult('{"verdict": "pass"}');
      }),
    );
    expect(workflowOk(events)).toBe(true);
    const result = doneResults(events).get("judge");
    expect(result?.json).toEqual({ verdict: "pass" });
    expect(result?.attempts).toBe(2);
    // Both billable calls are summed.
    expect(result?.tokens).toEqual({
      input: 200,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    });
    expect(prompts[0]).toContain("Required output format");
    expect(prompts[1]).toContain("did not contain valid JSON");
  });

  it("splits into items via itemsPath and fans an llm judge out over them", async () => {
    setKey();
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "Split",
          steps: [
            {
              id: "split",
              kind: "llm",
              model: "claude-opus-4-8",
              apiKeyEnv: KEY_ENV,
              prompt: "split {{input}}",
              output: {
                type: "object",
                required: ["targets"],
                properties: { targets: { type: "array", items: { type: "string" } } },
              },
              itemsPath: "targets",
            },
          ],
        },
        {
          id: "p2",
          title: "Judge",
          steps: [
            {
              id: "judge-each",
              kind: "llm",
              model: "claude-opus-4-8",
              apiKeyEnv: KEY_ENV,
              dependsOn: ["split"],
              forEach: "steps.split.items",
              prompt: "judge {{item}}",
            },
          ],
        },
      ]),
      llmDeps(async (request) => {
        if (request.prompt.startsWith("split")) {
          return okResult('{"targets": ["alpha", "beta"]}');
        }
        return okResult(`judged ${request.prompt.slice("judge ".length)}`);
      }),
    );
    expect(workflowOk(events)).toBe(true);
    const results = doneResults(events);
    expect(results.get("split")?.items).toEqual(["alpha", "beta"]);
    expect(results.get("judge-each[0]")?.output).toBe("judged alpha");
    expect(results.get("judge-each[1]")?.output).toBe("judged beta");
    const fanOut = events.find((ev) => ev.kind === "fan_out");
    expect(fanOut?.kind === "fan_out" && fanOut.count === 2).toBe(true);
  });

  it("fails the step when itemsPath does not resolve to an array", async () => {
    setKey();
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "Split",
          steps: [
            {
              id: "split",
              kind: "llm",
              model: "claude-opus-4-8",
              apiKeyEnv: KEY_ENV,
              prompt: "split",
              output: { type: "object" },
              itemsPath: "targets",
            },
          ],
        },
      ]),
      llmDeps(async () => okResult('{"other": 1}')),
    );
    expect(workflowOk(events)).toBe(false);
    expect(doneResults(events).get("split")?.error).toContain(
      "itemsPath 'targets' is not a JSON array",
    );
  });

  it("computes exact costUsd from declared pricing", async () => {
    setKey();
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "judge",
              kind: "llm",
              model: "claude-opus-4-8",
              apiKeyEnv: KEY_ENV,
              prompt: "x",
              pricing: { inputPerMTok: 5, outputPerMTok: 25 },
            },
          ],
        },
      ]),
      llmDeps(async () => ({
        ok: true,
        text: "done",
        tokens: { input: 1_000_000, output: 200_000 },
      })),
    );
    const result = doneResults(events).get("judge");
    expect(result?.costUsd).toBeCloseTo(5 + 25 * 0.2, 10);
  });

  it("keeps tokens and cost when a cancel races with a completed call", async () => {
    setKey();
    const controller = new AbortController();
    const events: WorkflowEvent[] = [];
    const run = runWorkflow(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "judge",
              kind: "llm",
              model: "claude-opus-4-8",
              apiKeyEnv: KEY_ENV,
              prompt: "x",
              pricing: { inputPerMTok: 5 },
            },
          ],
        },
      ]),
      { input: "task" },
      llmDeps(async () => {
        // The call completed on the provider side, but the run was cancelled
        // while it was in flight — the spend is real and must be recorded.
        controller.abort();
        return { ok: true, text: "done", tokens: { input: 1_000_000, output: 0 } };
      }),
      controller.signal,
    );
    for await (const ev of run) events.push(ev);
    const result = doneResults(events).get("judge");
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe("cancelled");
    expect(result?.tokens).toEqual({ input: 1_000_000, output: 0 });
    expect(result?.costUsd).toBeCloseTo(5, 10);
  });

  it("carries model and effort on the step_start event for cost attribution", async () => {
    setKey();
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "judge",
              kind: "llm",
              model: "claude-opus-4-8",
              effort: "low",
              apiKeyEnv: KEY_ENV,
              prompt: "x",
            },
          ],
        },
      ]),
      llmDeps(async () => okResult("done")),
    );
    const start = events.find((ev) => ev.kind === "step_start" && ev.stepId === "judge");
    expect(start?.kind === "step_start" && start.model).toBe("claude-opus-4-8");
    expect(start?.kind === "step_start" && start.effort).toBe("low");
    expect(start?.kind === "step_start" && start.agent).toBeUndefined();
  });

  it("enforces a per-step maxCostUsd budget on llm forEach fan-outs", async () => {
    setKey();
    let calls = 0;
    const events = await runToEvents(
      spec([
        {
          id: "p1",
          title: "Split",
          steps: [{ id: "targets", kind: "distributor", items: ["a", "b", "c"] }],
        },
        {
          id: "p2",
          title: "Judge",
          steps: [
            {
              id: "judge-each",
              kind: "llm",
              model: "claude-opus-4-8",
              apiKeyEnv: KEY_ENV,
              dependsOn: ["targets"],
              forEach: "steps.targets.items",
              prompt: "judge {{item}}",
              pricing: { outputPerMTok: 1 },
              maxCostUsd: 1.5,
            },
          ],
        },
      ]),
      llmDeps(
        async () => {
          calls += 1;
          // Each call costs exactly $1 at the declared rate.
          return { ok: true, text: "judged", tokens: { input: 0, output: 1_000_000 } };
        },
        { maxConcurrency: 1 },
      ),
    );
    expect(workflowOk(events)).toBe(false);
    expect(calls).toBe(2); // third child never dispatched
    const results = doneResults(events);
    expect(results.get("judge-each")?.childResults?.[2]?.notRun).toBe(true);
    const budget = events.find((ev) => ev.kind === "budget_exceeded");
    expect(budget?.kind).toBe("budget_exceeded");
    if (budget?.kind === "budget_exceeded") {
      expect(budget.scope).toBe("step");
      expect(budget.stepId).toBe("judge-each");
      expect(budget.limitUsd).toBe(1.5);
      // Two dispatched children at $1 each had settled when the cap tripped.
      expect(budget.spentUsd).toBeCloseTo(2, 10);
    }
  });
});

describe("llm session overrides", () => {
  it("applies model/prompt/effort patches to llm steps and drops agent-only fields", async () => {
    const { applyWorkflowStepOverrides } = await import("../src/workflow");
    const base = spec([
      {
        id: "p1",
        title: "P1",
        steps: [{ id: "judge", kind: "llm", model: "claude-opus-4-8", prompt: "old" }],
      },
    ]);
    const patched = applyWorkflowStepOverrides(base, {
      judge: {
        model: "claude-haiku-4-5",
        prompt: "new",
        effort: "low",
        agent: "claude",
        cwd: "/x",
      },
    });
    const step = patched.phases[0]?.steps[0];
    expect(step).toMatchObject({
      kind: "llm",
      model: "claude-haiku-4-5",
      prompt: "new",
      effort: "low",
    });
    // Agent-only fields must never leak onto an llm step (an `agent` field
    // would make it read as agent-backed).
    expect(step && "agent" in step).toBe(false);
    expect(step && "cwd" in step).toBe(false);
  });
});

describe("llm plan integration", () => {
  it("counts llm calls separately and renders their prompts", () => {
    const plan = planWorkflow(
      spec([
        {
          id: "p1",
          title: "P1",
          steps: [
            { id: "judge", kind: "llm", model: "claude-opus-4-8", prompt: "Judge {{input}}" },
            { id: "echo", kind: "command", cmd: "echo hi" },
          ],
        },
      ]),
      "the release",
    );
    expect(plan.ok).toBe(true);
    expect(plan.llmCallCount).toBe(1);
    expect(plan.agentCallCount).toBe(0);
    const judge = plan.steps.find((s) => s.stepId === "judge");
    expect(judge?.model).toBe("claude-opus-4-8");
    expect(judge?.llmProvider).toBe("anthropic");
    expect(judge?.renderedPrompt).toBe("Judge the release");
    expect(judge?.isAgentBacked).toBe(false);
  });
});

describe("callLlm transport", () => {
  function fetchStub(
    status: number,
    payload: unknown,
    capture: { url?: string; init?: RequestInit } = {},
  ): typeof fetch {
    return (async (url: unknown, init?: RequestInit) => {
      capture.url = String(url);
      capture.init = init;
      return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
        status,
      });
    }) as typeof fetch;
  }

  it("shapes an Anthropic request and parses text + usage", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const result = await callLlm(
      {
        provider: "anthropic",
        model: "claude-opus-4-8",
        prompt: "hello",
        system: "sys",
        effort: "low",
        apiKey: "sk-a",
      },
      fetchStub(
        200,
        {
          content: [
            { type: "text", text: "hi " },
            { type: "text", text: "there" },
          ],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        },
        capture,
      ),
    );
    expect(result).toEqual({
      ok: true,
      text: "hi there",
      stopReason: "end_turn",
      tokens: { input: 10, output: 4, cacheRead: 3, cacheWrite: 2 },
    });
    expect(capture.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = capture.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-a");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(String(capture.init?.body));
    expect(body).toEqual({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      system: "sys",
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("omits unset optional fields from both providers' request bodies", async () => {
    const anthropicCapture: { url?: string; init?: RequestInit } = {};
    await callLlm(
      { provider: "anthropic", model: "claude-opus-4-8", prompt: "p", apiKey: "k" },
      fetchStub(200, { content: [], usage: {} }, anthropicCapture),
    );
    const anthropicBody = JSON.parse(String(anthropicCapture.init?.body));
    for (const field of ["temperature", "system", "output_config"]) {
      expect(anthropicBody).not.toHaveProperty(field);
    }

    const openaiCapture: { url?: string; init?: RequestInit } = {};
    await callLlm(
      { provider: "openai", model: "gpt-5", prompt: "p", apiKey: "k" },
      fetchStub(200, { choices: [{ message: { content: "x" } }] }, openaiCapture),
    );
    const openaiBody = JSON.parse(String(openaiCapture.init?.body));
    for (const field of [
      "temperature",
      "max_completion_tokens",
      "reasoning_effort",
      "response_format",
    ]) {
      expect(openaiBody).not.toHaveProperty(field);
    }
  });

  it("shapes an OpenAI-compatible request with JSON mode and parses usage", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const result = await callLlm(
      {
        provider: "openai",
        model: "gpt-5",
        prompt: "hello",
        system: "sys",
        maxTokens: 512,
        jsonOutput: true,
        baseUrl: "https://example.test/v1/",
        apiKey: "sk-o",
      },
      fetchStub(
        200,
        {
          choices: [{ message: { content: '{"a":1}' }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 30,
            completion_tokens: 8,
            prompt_tokens_details: { cached_tokens: 12 },
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        },
        capture,
      ),
    );
    expect(result).toEqual({
      ok: true,
      text: '{"a":1}',
      stopReason: "stop",
      tokens: { input: 18, output: 8, cacheRead: 12, reasoning: 5 },
    });
    expect(capture.url).toBe("https://example.test/v1/chat/completions");
    const headers = capture.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-o");
    const body = JSON.parse(String(capture.init?.body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_completion_tokens).toBe(512);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
  });

  it("tolerates an Anthropic baseUrl that already ends in /v1", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await callLlm(
      {
        provider: "anthropic",
        model: "claude-opus-4-8",
        prompt: "p",
        apiKey: "k",
        baseUrl: "https://proxy.test/v1",
      },
      fetchStub(200, { content: [], usage: {} }, capture),
    );
    expect(capture.url).toBe("https://proxy.test/v1/messages");
  });

  it("classifies HTTP failures as retryable or not", async () => {
    const rateLimited = await callLlm(
      { provider: "anthropic", model: "m", prompt: "p", apiKey: "k" },
      fetchStub(429, { error: { message: "slow down" } }),
    );
    expect(rateLimited.ok).toBe(false);
    if (!rateLimited.ok) {
      expect(rateLimited.retryable).toBe(true);
      expect(rateLimited.status).toBe(429);
    }

    const badRequest = await callLlm(
      { provider: "anthropic", model: "m", prompt: "p", apiKey: "k" },
      fetchStub(400, { error: { message: "nope" } }),
    );
    expect(badRequest.ok).toBe(false);
    if (!badRequest.ok) expect(badRequest.retryable).toBe(false);
  });

  it("treats network errors as retryable and refusals as permanent", async () => {
    const network = await callLlm(
      { provider: "openai", model: "m", prompt: "p", apiKey: "k" },
      (async () => {
        throw new Error("ECONNRESET");
      }) as typeof fetch,
    );
    expect(network.ok).toBe(false);
    if (!network.ok) expect(network.retryable).toBe(true);

    const refusal = await callLlm(
      { provider: "anthropic", model: "m", prompt: "p", apiKey: "k" },
      fetchStub(200, { content: [], stop_reason: "refusal", usage: {} }),
    );
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      expect(refusal.retryable).toBe(false);
      expect(refusal.error).toContain("refused");
    }
  });

  it("resolves providers, key env names, and base URLs", () => {
    expect(resolveLlmProvider({ model: "claude-opus-4-8" })).toBe("anthropic");
    expect(resolveLlmProvider({ model: "gpt-5" })).toBe("openai");
    expect(resolveLlmProvider({ model: "claude-x", provider: "openai" })).toBe("openai");
    expect(llmApiKeyEnvName("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(llmApiKeyEnvName("openai")).toBe("OPENAI_API_KEY");
    expect(llmApiKeyEnvName("openai", "GROQ_API_KEY")).toBe("GROQ_API_KEY");
    expect(resolveLlmBaseUrl("anthropic", undefined, {})).toBe("https://api.anthropic.com");
    expect(resolveLlmBaseUrl("openai", undefined, {})).toBe("https://api.openai.com/v1");
    expect(resolveLlmBaseUrl("openai", "https://x.test/v1///", {})).toBe("https://x.test/v1");
    expect(
      resolveLlmBaseUrl("openai", undefined, { OPENAI_BASE_URL: "https://proxy.test/v1" }),
    ).toBe("https://proxy.test/v1");
  });
});
