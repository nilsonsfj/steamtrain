import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  buildWorkflowGenerationPrompt,
  buildWorkflowRepairPrompt,
  extractWorkflowSpec,
  generateWorkflow,
  slugifyWorkflowName,
} from "../src/workflow";

const VALID_SPEC = {
  name: "ignored-by-name-hint",
  description: "Two-phase echo flow.",
  phases: [
    {
      id: "split",
      title: "Split",
      steps: [{ id: "areas", kind: "distributor", items: ["a: {{input}}", "b: {{input}}"] }],
    },
    {
      id: "report",
      title: "Report",
      steps: [
        {
          id: "report",
          kind: "consolidator",
          agent: "opencode",
          model: "opencode/qwen3.6-plus-free",
          dependsOn: ["areas"],
          prompt: "Summarize {{steps.areas.items}} for {{input}}",
        },
      ],
    },
  ],
};

function makeAdapter(events: AgentEvent[]): (id: AgentId) => AgentAdapter {
  return (id: AgentId) => ({
    id,
    binary: "fake",
    defaultModel: "test",
    run(_opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        for (const event of events) {
          await Promise.resolve();
          yield event;
        }
      })();
    },
  });
}

/** A single `result` event carrying `obj` as JSON — the common model reply shape. */
function resultEvents(obj: unknown): AgentEvent[] {
  return [{ kind: "result", agent: "opencode", ts: 0, isError: false, text: JSON.stringify(obj) }];
}

/**
 * An adapter whose Nth run yields the Nth response set (the last set repeats),
 * recording every prompt it was given so tests can assert the repair re-prompt.
 */
function makeSequencedAdapter(responses: AgentEvent[][]) {
  const prompts: string[] = [];
  let calls = 0;
  const createAdapter = (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      prompts.push(opts.prompt);
      const events = responses[Math.min(calls, responses.length - 1)] ?? [];
      calls += 1;
      return (async function* () {
        for (const event of events) {
          await Promise.resolve();
          yield event;
        }
      })();
    },
  });
  return {
    createAdapter,
    prompts,
    get calls() {
      return calls;
    },
  };
}

// Parses fine but fails the cross-phase rule: `b` depends on same-phase `a`.
const SAME_PHASE_SPEC = {
  description: "Two steps in one phase with a dependency (invalid).",
  phases: [
    {
      id: "p",
      title: "P",
      steps: [
        {
          id: "a",
          kind: "worker",
          agent: "opencode",
          model: "opencode/mimo-v2.5-free",
          prompt: "x {{input}}",
        },
        {
          id: "b",
          kind: "worker",
          agent: "opencode",
          model: "opencode/mimo-v2.5-free",
          dependsOn: ["a"],
          prompt: "y {{steps.a.output}}",
        },
      ],
    },
  ],
};

describe("slugifyWorkflowName", () => {
  it("kebab-cases free text and trims junk", () => {
    expect(slugifyWorkflowName("Review my API changes!")).toBe("review-my-api-changes");
    expect(slugifyWorkflowName("  multiple   spaces  ")).toBe("multiple-spaces");
    expect(slugifyWorkflowName("already-kebab")).toBe("already-kebab");
  });

  it("falls back to a default when nothing usable remains", () => {
    expect(slugifyWorkflowName("***")).toBe("workflow");
    expect(slugifyWorkflowName("")).toBe("workflow");
  });

  it("caps very long names", () => {
    const long = slugifyWorkflowName("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith("-")).toBe(false);
  });
});

describe("buildWorkflowGenerationPrompt", () => {
  it("embeds the description and demands JSON output", () => {
    const prompt = buildWorkflowGenerationPrompt("audit the auth module");
    expect(prompt).toContain("audit the auth module");
    expect(prompt).toContain("JSON");
    // It should teach the block kinds so the model produces a valid spec.
    expect(prompt).toContain("distributor");
    expect(prompt).toContain("consolidator");
    expect(prompt).toContain("phases");
  });

  it("teaches the same-phase dependency rule and loop-back gates", () => {
    const prompt = buildWorkflowGenerationPrompt("anything");
    expect(prompt).toContain("DIFFERENT phases");
    expect(prompt).toContain("loopTo");
    expect(prompt).not.toContain("UNROLL");
  });

  it("teaches agent-backed distributors and forbids hardcoded task indices", () => {
    const prompt = buildWorkflowGenerationPrompt("anything");
    expect(prompt).toContain("Agent-backed (PREFERRED for backlogs");
    expect(prompt).toContain("One task per line only");
    expect(prompt).not.toContain("Task 1 from backlog");
    expect(prompt).toContain("NEVER hardcode");
    expect(prompt).toContain("forEach");
    expect(prompt).toContain("FULL aggregate of ALL items");
    const example = prompt.slice(
      prompt.indexOf("# Worked example: parallel backlog implement"),
      prompt.indexOf("# Worked example: a bounded review/fix loop"),
    );
    expect(example).toContain('"agent": "opencode"');
    expect(example).not.toContain('"items":');
    expect(example).not.toContain("review-each");
  });

  it("embeds a worked example that passes the engine's own validation", () => {
    // The example is what the model imitates; if it ever stops validating, the
    // prompt is teaching an invalid shape. Extract + validate it for real.
    const prompt = buildWorkflowGenerationPrompt("anything");
    const example = prompt.slice(prompt.indexOf("# Worked example"));
    const result = extractWorkflowSpec(example);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.phases.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("embeds a bounded loop example that passes validation", () => {
    const prompt = buildWorkflowGenerationPrompt("anything");
    const loopExample = prompt.slice(
      prompt.indexOf("# Worked example: a bounded review/fix loop"),
      prompt.indexOf("# Output format"),
    );
    const result = extractWorkflowSpec(loopExample);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.name).toBe("bounded-review-loop");
      expect(result.spec.phases.some((p) => p.steps.some((s) => s.kind === "gate"))).toBe(true);
    }
  });

  it("teaches sub-workflow composition with a valid worked example", () => {
    const prompt = buildWorkflowGenerationPrompt("anything");
    expect(prompt).toContain('"workflow": invoke another named workflow');
    expect(prompt).toContain('"kind": "workflow"');

    const example = prompt.slice(
      prompt.indexOf("# Worked example: compose a sub-workflow"),
      prompt.indexOf("# Output format"),
    );
    const result = extractWorkflowSpec(example);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.name).toBe("release-checks");
      expect(result.spec.phases[0]?.steps[0]).toMatchObject({
        kind: "workflow",
        workflow: "bug-hunt",
      });
      expect(result.spec.phases[1]?.steps[0]).toMatchObject({
        kind: "gate",
        dependsOn: ["bug-sweep"],
        condition: { step: "bug-sweep", ok: true },
      });
    }
  });
});

describe("extractWorkflowSpec", () => {
  it("parses a bare JSON object", () => {
    const result = extractWorkflowSpec(JSON.stringify(VALID_SPEC), { name: "my flow" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.name).toBe("my-flow");
      expect(result.spec.phases).toHaveLength(2);
    }
  });

  it("parses JSON inside a fenced code block with prose around it", () => {
    const text = `Sure! Here is your workflow:\n\n\`\`\`json\n${JSON.stringify(
      VALID_SPEC,
      null,
      2,
    )}\n\`\`\`\n\nLet me know if you want changes.`;
    const result = extractWorkflowSpec(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.phases[1]?.steps[0]?.id).toBe("report");
  });

  it("parses a JSON object embedded in prose without fences", () => {
    const text = `Here you go: ${JSON.stringify(VALID_SPEC)} — enjoy.`;
    const result = extractWorkflowSpec(text);
    expect(result.ok).toBe(true);
  });

  it("derives a name from the hint over the model's own name", () => {
    const result = extractWorkflowSpec(JSON.stringify(VALID_SPEC), { name: "Cache Migration" });
    expect(result.ok && result.spec.name).toBe("cache-migration");
  });

  it("derives a name from the spec name if hint is absent", () => {
    const spec = { ...VALID_SPEC, name: "Spec Name" };
    const result = extractWorkflowSpec(JSON.stringify(spec));
    expect(result.ok && result.spec.name).toBe("spec-name");
  });

  it("derives a name from fallbackName if hint and spec name are absent", () => {
    const { name, ...spec } = VALID_SPEC;
    const result = extractWorkflowSpec(JSON.stringify(spec), { fallbackName: "Fallback Name" });
    expect(result.ok && result.spec.name).toBe("fallback-name");
  });

  it("derives a name from spec description if hint, spec name, and fallbackName are absent", () => {
    const { name, ...spec } = { ...VALID_SPEC, description: "Description Name" };
    const result = extractWorkflowSpec(JSON.stringify(spec));
    expect(result.ok && result.spec.name).toBe("description-name");
  });

  it("falls back to DEFAULT_NAME if all name sources are absent or resolve to empty", () => {
    const { name, description, ...spec } = VALID_SPEC;
    const result = extractWorkflowSpec(JSON.stringify(spec));
    expect(result.ok && result.spec.name).toBe("workflow");
  });

  it("rejects text with no JSON object", () => {
    const result = extractWorkflowSpec("I cannot help with that.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no JSON/i);
  });

  it("rejects malformed JSON", () => {
    const result = extractWorkflowSpec('```json\n{ "phases": [ }\n```');
    expect(result.ok).toBe(false);
  });

  it("rejects JSON that is structurally not a workflow", () => {
    const result = extractWorkflowSpec(JSON.stringify({ phases: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeTruthy();
  });

  it("rejects a workflow whose dependsOn points forward (cross-phase rule)", () => {
    const bad = {
      phases: [
        {
          id: "p1",
          title: "One",
          steps: [
            {
              id: "a",
              kind: "consolidator",
              dependsOn: ["b"],
              agent: "opencode",
              model: "opencode/qwen3.6-plus-free",
              prompt: "x {{steps.b.output}}",
            },
          ],
        },
        {
          id: "p2",
          title: "Two",
          steps: [
            {
              id: "b",
              agent: "opencode",
              model: "opencode/qwen3.6-plus-free",
              prompt: "y {{input}}",
            },
          ],
        },
      ],
    };
    const result = extractWorkflowSpec(JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });
});

describe("generateWorkflow", () => {
  it("delegates to the agent and returns a validated spec", async () => {
    const adapter = makeAdapter([
      { kind: "session_start", agent: "opencode", ts: 0 },
      { kind: "text_delta", agent: "opencode", ts: 0, text: "```json\n" },
      { kind: "text_delta", agent: "opencode", ts: 0, text: JSON.stringify(VALID_SPEC) },
      { kind: "text_delta", agent: "opencode", ts: 0, text: "\n```" },
      { kind: "result", agent: "opencode", ts: 0, isError: false, text: "" },
    ]);
    const seen: AgentEvent[] = [];
    const result = await generateWorkflow(
      {
        description: "summarize areas",
        agent: "opencode",
        model: "opencode/qwen3.6-plus-free",
        name: "Area Summary",
        onEvent: (e) => seen.push(e),
      },
      { createAdapter: adapter },
    );

    expect(result.ok).toBe(true);
    expect(result.spec?.name).toBe("area-summary");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("honors binaries override when agentConfig is omitted", async () => {
    let seenBinary: string | undefined;
    const createAdapter = (id: AgentId, binary?: string) => {
      seenBinary = binary;
      return makeAdapter(resultEvents(VALID_SPEC))(id);
    };
    const result = await generateWorkflow(
      {
        description: "summarize areas",
        agent: "opencode",
        model: "opencode/qwen3.6-plus-free",
      },
      { createAdapter, binaries: { opencode: "opencode-fork" } },
    );

    expect(result.ok).toBe(true);
    expect(seenBinary).toBe("opencode-fork");
  });

  it("prefers the final result text over streamed deltas", async () => {
    const adapter = makeAdapter([
      { kind: "text_delta", agent: "opencode", ts: 0, text: "thinking out loud, ignore me" },
      {
        kind: "result",
        agent: "opencode",
        ts: 0,
        isError: false,
        text: JSON.stringify(VALID_SPEC),
      },
    ]);
    const result = await generateWorkflow(
      {
        description: "summarize areas",
        agent: "opencode",
        model: "opencode/qwen3.6-plus-free",
      },
      { createAdapter: adapter },
    );
    expect(result.ok).toBe(true);
  });

  it("reports a failure when the agent errors", async () => {
    const adapter = makeAdapter([{ kind: "error", agent: "opencode", ts: 0, message: "boom" }]);
    const result = await generateWorkflow(
      { description: "x", agent: "opencode", model: "opencode/qwen3.6-plus-free" },
      { createAdapter: adapter },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/boom/);
  });

  it("recovers when a non-fatal error event is followed by a successful result", async () => {
    // Regression: Codex logs a `type: "error"` event when an org-managed policy
    // overrides a requested config value (e.g. `approval_policy`), then falls
    // back and completes the turn normally. That earlier event must not sink
    // an otherwise-successful draft.
    const adapter = makeAdapter([
      {
        kind: "error",
        agent: "opencode",
        ts: 0,
        message:
          "Configured value for 'approval_policy' is disallowed by requirements; falling back to required value OnRequest.",
      },
      {
        kind: "result",
        agent: "opencode",
        ts: 0,
        isError: false,
        text: JSON.stringify(VALID_SPEC),
      },
    ]);
    const result = await generateWorkflow(
      { description: "x", agent: "opencode", model: "opencode/qwen3.6-plus-free" },
      { createAdapter: adapter },
    );
    expect(result.ok).toBe(true);
    expect(result.spec).toBeDefined();
  });

  it("reports a failure when the model returns no parseable workflow", async () => {
    const adapter = makeAdapter([
      { kind: "result", agent: "opencode", ts: 0, isError: false, text: "no json here" },
    ]);
    const result = await generateWorkflow(
      { description: "x", agent: "opencode", model: "opencode/qwen3.6-plus-free" },
      { createAdapter: adapter },
    );
    expect(result.ok).toBe(false);
    expect(result.raw).toContain("no json here");
  });

  it("reports attempts === 1 when the first draft is valid", async () => {
    const adapter = makeAdapter(resultEvents(VALID_SPEC));
    const result = await generateWorkflow(
      { description: "x", agent: "opencode", model: "opencode/qwen3.6-plus-free" },
      { createAdapter: adapter },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
  });
});

describe("generateWorkflow auto-repair", () => {
  it("re-prompts with the validation error and recovers on the second attempt", async () => {
    const seq = makeSequencedAdapter([resultEvents(SAME_PHASE_SPEC), resultEvents(VALID_SPEC)]);
    const result = await generateWorkflow(
      { description: "summarize areas", agent: "opencode", model: "opencode/qwen3.6-plus-free" },
      { createAdapter: seq.createAdapter },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(seq.calls).toBe(2);
    // The second run is a repair prompt carrying the concrete validation error.
    expect(seq.prompts[1]).toContain("previous attempt was INVALID");
    expect(seq.prompts[1]).toContain("not in an earlier phase");
  });

  it("gives up after 2 retries (3 runs total) and returns the last error", async () => {
    const seq = makeSequencedAdapter([resultEvents(SAME_PHASE_SPEC)]); // always invalid
    const result = await generateWorkflow(
      { description: "x", agent: "opencode", model: "opencode/qwen3.6-plus-free" },
      { createAdapter: seq.createAdapter },
    );
    expect(result.ok).toBe(false);
    expect(seq.calls).toBe(3); // default: 1 draft + 2 repairs
    expect(result.attempts).toBe(3);
    expect(result.error).toContain("not in an earlier phase");
  });

  it("falls back to the default when maxRepairAttempts is not a finite number", async () => {
    const seq = makeSequencedAdapter([resultEvents(SAME_PHASE_SPEC)]);
    const result = await generateWorkflow(
      { description: "x", agent: "opencode", model: "opencode/qwen3.6-plus-free" },
      { createAdapter: seq.createAdapter, maxRepairAttempts: Number.NaN },
    );
    expect(result.ok).toBe(false);
    expect(seq.calls).toBe(3); // NaN must not collapse the loop; default 2 retries
  });

  it("does not repair when maxRepairAttempts is 0", async () => {
    const seq = makeSequencedAdapter([resultEvents(SAME_PHASE_SPEC)]);
    const result = await generateWorkflow(
      { description: "x", agent: "opencode", model: "opencode/qwen3.6-plus-free" },
      { createAdapter: seq.createAdapter, maxRepairAttempts: 0 },
    );
    expect(result.ok).toBe(false);
    expect(seq.calls).toBe(1);
    expect(result.attempts).toBe(1);
  });

  it("does not repair (or accept) when the agent flags an error but the spec is valid", async () => {
    // Legacy behavior: a valid spec accompanied by an agent error is surfaced as
    // a failure, and we must NOT spend a repair attempt re-running it.
    const seq = makeSequencedAdapter([
      [
        {
          kind: "result",
          agent: "opencode",
          ts: 0,
          isError: true,
          text: JSON.stringify(VALID_SPEC),
        },
      ],
    ]);
    const result = await generateWorkflow(
      { description: "x", agent: "opencode", model: "opencode/qwen3.6-plus-free" },
      { createAdapter: seq.createAdapter },
    );
    expect(result.ok).toBe(false);
    expect(result.spec).toBeDefined();
    expect(seq.calls).toBe(1);
    expect(result.attempts).toBe(1);
  });

  it("clears the live buffer between attempts via onAttemptStart", async () => {
    const seq = makeSequencedAdapter([resultEvents(SAME_PHASE_SPEC), resultEvents(VALID_SPEC)]);
    const attemptStarts: number[] = [];
    const result = await generateWorkflow(
      {
        description: "x",
        agent: "opencode",
        model: "opencode/qwen3.6-plus-free",
        onAttemptStart: (n) => attemptStarts.push(n),
      },
      { createAdapter: seq.createAdapter },
    );
    expect(result.ok).toBe(true);
    expect(attemptStarts).toEqual([1, 2]);
  });

  it("never starts an agent run when aborted before the first attempt", async () => {
    const seq = makeSequencedAdapter([resultEvents(VALID_SPEC)]);
    const result = await generateWorkflow(
      {
        description: "x",
        agent: "opencode",
        model: "opencode/qwen3.6-plus-free",
        signal: AbortSignal.abort(),
      },
      { createAdapter: seq.createAdapter },
    );
    expect(result.ok).toBe(false);
    expect(seq.calls).toBe(0);
    expect(result.attempts).toBe(0);
  });

  it("does not waste a repair when the agent errors with no output", async () => {
    const seq = makeSequencedAdapter([
      [{ kind: "error", agent: "opencode", ts: 0, message: "boom" }],
    ]);
    const result = await generateWorkflow(
      { description: "x", agent: "opencode", model: "opencode/qwen3.6-plus-free" },
      { createAdapter: seq.createAdapter },
    );
    expect(result.ok).toBe(false);
    expect(seq.calls).toBe(1);
    expect(result.error).toMatch(/boom/);
  });
});

describe("buildWorkflowRepairPrompt", () => {
  it("includes the base prompt, the prior output, and the exact error", () => {
    const prompt = buildWorkflowRepairPrompt(
      "do the thing",
      '{ "phases": [] }',
      "step 'b' dependsOn 'a', which is not in an earlier phase",
    );
    expect(prompt).toContain("do the thing"); // base generation prompt embedded
    expect(prompt).toContain("previous attempt was INVALID");
    expect(prompt).toContain('{ "phases": [] }');
    expect(prompt).toContain("not in an earlier phase");
  });

  it("truncates a very long previous output", () => {
    const huge = "x".repeat(10000);
    const prompt = buildWorkflowRepairPrompt("d", huge, "err");
    expect(prompt).toContain("…(truncated)");
    // The previous output itself is capped at MAX_REPAIR_OUTPUT_CHARS (4000); the
    // rest of the prompt is the base generation prompt plus a small amount of
    // repair scaffolding — not proportional to `huge`.
    expect(prompt.length).toBeLessThan(buildWorkflowGenerationPrompt("d").length + 4000 + 1000);
  });
});

describe("extractWorkflowSpec findJsonObject (M19)", () => {
  it("finds JSON after unbalanced braces in explanatory text", () => {
    const text = `Here is some text with { braces that confuse things.
The real JSON is: {"name":"test","description":"x","phases":[{"id":"p","title":"P","steps":[{"id":"s","kind":"worker","agent":"opencode","model":"m","prompt":"hi"}]}]}`;
    const result = extractWorkflowSpec(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.name).toBe("test");
  });

  it("finds JSON when fenced block has prose before the object", () => {
    const text = `Here is the output:
Some explanation with { braces.
\`\`\`json
{"name":"fenced","description":"y","phases":[{"id":"p","title":"P","steps":[{"id":"s","kind":"worker","agent":"opencode","model":"m","prompt":"hi"}]}]}
\`\`\``;
    const result = extractWorkflowSpec(text);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.name).toBe("fenced");
  });
});

describe("opencode-variants JSON parser (M41)", () => {
  it("correctly parses JSON with braces inside string values", async () => {
    const { parseOpencodeModelsVerbose } = await import("../src/agents/opencode-variants");
    const output = `opencode/mimo-v2.5-pro
{
  "name": "Mimo V2.5 Pro",
  "variants": {
    "low": {"reasoning_effort": "low"},
    "high": {"reasoning_effort": "high", "hint": "use { for JSON"}
  }
}`;
    const models = parseOpencodeModelsVerbose(output);
    expect(models.size).toBe(1);
    const info = models.get("opencode/mimo-v2.5-pro");
    expect(info).toBeDefined();
    expect(info?.efforts).toEqual(["high", "low"]);
  });
});
