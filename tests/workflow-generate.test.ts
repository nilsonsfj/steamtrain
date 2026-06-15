import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  buildWorkflowGenerationPrompt,
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
});
