import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  runWorkflow,
  validateWorkflow,
} from "../src/workflow";
import {
  loadWorkflowCache,
  saveWorkflowCache,
  workflowCacheKey,
} from "../src/workflow/cache-store";
import {
  extractJsonValue,
  jsonFieldText,
  jsonPathGet,
  parseJsonPath,
  parseStructuredOutput,
  validateAgainstSchema,
} from "../src/workflow/structured";
import { renderPrompt } from "../src/workflow/template";

// ---------------------------------------------------------------------------
// Fake adapter plumbing (same pattern as workflow-engine.test.ts)
// ---------------------------------------------------------------------------

interface RunRecord {
  id: AgentId;
  opts: AgentRunOptions;
}
type Script = (opts: AgentRunOptions, runIndex: number) => AgentEvent[];

const reply = (text: string): AgentEvent[] => [
  { kind: "session_start", agent: "claude", ts: 0 },
  { kind: "result", agent: "claude", ts: 0, isError: false, text, costUsd: 0.001 },
];

function makeDeps(script: Script): { deps: WorkflowDeps; runs: RunRecord[] } {
  const runs: RunRecord[] = [];
  const deps: WorkflowDeps = {
    createAdapter: (id: AgentId): AgentAdapter => ({
      id,
      binary: "fake",
      run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
        return (async function* () {
          const runIndex = runs.length;
          runs.push({ id, opts });
          for (const event of script(opts, runIndex)) {
            await Promise.resolve();
            yield event;
          }
        })();
      },
    }),
    maxConcurrency: 4,
    cwd: "/base",
  };
  return { deps, runs };
}

async function collect(
  spec: WorkflowSpec,
  input: string,
  deps: WorkflowDeps,
  cache?: Map<string, StepResult>,
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input, cache }, deps)) events.push(ev);
  return events;
}

function finalResult(events: WorkflowEvent[], stepId: string): StepResult {
  const done = events.filter((e) => e.kind === "step_done" && e.stepId === stepId).at(-1);
  if (!done || done.kind !== "step_done") throw new Error(`no step_done for '${stepId}'`);
  return done.result;
}

const verdictSchema = {
  type: "object",
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
};

// ---------------------------------------------------------------------------
// structured.ts unit tests
// ---------------------------------------------------------------------------

describe("extractJsonValue", () => {
  it("parses the whole text when it is JSON", () => {
    expect(extractJsonValue('{"a": 1}')?.value).toEqual({ a: 1 });
    expect(extractJsonValue(" [1, 2] ")?.value).toEqual([1, 2]);
    expect(extractJsonValue("false")?.value).toBe(false);
  });

  it("prefers the last fenced block that parses", () => {
    const text = 'intro\n```json\n{"draft": true}\n```\nmore prose\n```json\n{"final": true}\n```';
    expect(extractJsonValue(text)?.value).toEqual({ final: true });
  });

  it("finds a balanced JSON object embedded in prose", () => {
    const text = 'Here is my verdict: {"verdict": "pass"} — hope that helps!';
    expect(extractJsonValue(text)?.value).toEqual({ verdict: "pass" });
  });

  it("is not fooled by braces inside JSON strings", () => {
    const text = 'result {"note": "uses {braces} and \\" quotes", "n": 1} end';
    expect(extractJsonValue(text)?.value).toEqual({ note: 'uses {braces} and " quotes', n: 1 });
  });

  it("returns undefined when nothing parses", () => {
    expect(extractJsonValue("no json here")).toBeUndefined();
    expect(extractJsonValue("broken {a: b} span")).toBeUndefined();
    expect(extractJsonValue("")).toBeUndefined();
  });
});

describe("validateAgainstSchema", () => {
  it("checks type, required, and enum", () => {
    expect(validateAgainstSchema({ verdict: "pass" }, verdictSchema)).toEqual([]);
    expect(validateAgainstSchema({ verdict: "maybe" }, verdictSchema)[0]).toContain("$.verdict");
    expect(validateAgainstSchema({}, verdictSchema)[0]).toContain("missing required property");
    expect(validateAgainstSchema("pass", verdictSchema)[0]).toContain("expected object");
  });

  it("checks nested arrays and items", () => {
    const schema = {
      type: "object",
      properties: {
        targets: { type: "array", minItems: 1, items: { type: "string" } },
      },
      required: ["targets"],
    };
    expect(validateAgainstSchema({ targets: ["a"] }, schema)).toEqual([]);
    expect(validateAgainstSchema({ targets: [] }, schema)[0]).toContain("minItems");
    expect(validateAgainstSchema({ targets: ["a", 2] }, schema)[0]).toContain("$.targets[1]");
  });

  it("checks integer, bounds, and additionalProperties", () => {
    const schema = {
      type: "object",
      properties: { score: { type: "integer", minimum: 0, maximum: 10 } },
      additionalProperties: false,
    };
    expect(validateAgainstSchema({ score: 7 }, schema)).toEqual([]);
    expect(validateAgainstSchema({ score: 7.5 }, schema)[0]).toContain("expected integer");
    expect(validateAgainstSchema({ score: 11 }, schema)[0]).toContain("above maximum");
    expect(validateAgainstSchema({ extra: true }, schema)[0]).toContain("unexpected property");
  });
});

describe("json paths", () => {
  const value = { report: { targets: ["a", "b", "c"], score: 3 } };

  it("resolves dot and bracket segments", () => {
    expect(jsonPathGet(value, "report.score")).toBe(3);
    expect(jsonPathGet(value, "report.targets[2]")).toBe("c");
    expect(jsonPathGet(["x", "y"], "[1]")).toBe("y");
  });

  it("returns undefined for missing hops and malformed paths", () => {
    expect(jsonPathGet(value, "report.missing")).toBeUndefined();
    expect(jsonPathGet(value, "report.targets[9]")).toBeUndefined();
    expect(jsonPathGet(value, "report.targets[x]")).toBeUndefined();
    expect(parseJsonPath("a[1")).toBeUndefined();
  });

  it("renders fields as text: strings raw, values serialized, missing empty", () => {
    expect(jsonFieldText("pass")).toBe("pass");
    expect(jsonFieldText(3)).toBe("3");
    expect(jsonFieldText({ a: 1 })).toBe('{"a":1}');
    expect(jsonFieldText(undefined)).toBe("");
  });
});

describe("parseStructuredOutput", () => {
  it("reports schema mismatches distinctly from unparseable text", () => {
    expect(parseStructuredOutput("prose only", verdictSchema)).toEqual({
      ok: false,
      error: "no parseable JSON found in the step output",
    });
    const mismatch = parseStructuredOutput('{"verdict": "maybe"}', verdictSchema);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error).toContain("does not match the output schema");
  });
});

// ---------------------------------------------------------------------------
// Template access
// ---------------------------------------------------------------------------

describe("templates: {{steps.<id>.json…}}", () => {
  const ctx = {
    input: "task",
    outputs: new Map([["review", '{"verdict":"pass"}']]),
    results: new Map([
      ["review", { ok: true, json: { verdict: "pass", targets: ["a", "b", "c"], score: 2 } }],
      ["plain", { ok: true }],
    ]),
  };

  it("renders fields, array indices, and the whole value", () => {
    expect(renderPrompt("v={{steps.review.json.verdict}}", ctx)).toBe("v=pass");
    expect(renderPrompt("t={{steps.review.json.targets[2]}}", ctx)).toBe("t=c");
    expect(renderPrompt("s={{steps.review.json.score}}", ctx)).toBe("s=2");
    expect(renderPrompt("all={{steps.review.json}}", ctx)).toBe(
      'all={"verdict":"pass","targets":["a","b","c"],"score":2}',
    );
  });

  it("renders empty for missing json, missing fields, and unknown steps", () => {
    expect(renderPrompt("v={{steps.plain.json.verdict}}", ctx)).toBe("v=");
    expect(renderPrompt("v={{steps.review.json.nope}}", ctx)).toBe("v=");
    expect(renderPrompt("v={{steps.ghost.json}}", ctx)).toBe("v=");
  });
});

// ---------------------------------------------------------------------------
// Spec validation
// ---------------------------------------------------------------------------

describe("spec validation", () => {
  const worker = { id: "w", agent: "claude", model: "m", prompt: "p" };

  it("rejects a gate condition path without step", () => {
    const spec: WorkflowSpec = {
      name: "bad-gate",
      phases: [
        { id: "p1", title: "P1", steps: [worker] },
        {
          id: "p2",
          title: "P2",
          steps: [
            {
              id: "g",
              kind: "gate",
              condition: { path: "verdict", equals: "pass" },
            },
          ],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("path requires condition.step");
  });

  it("rejects distributor itemsPath without an output schema", () => {
    const spec: WorkflowSpec = {
      name: "bad-dist",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "d",
              kind: "distributor",
              agent: "claude",
              model: "m",
              prompt: "split",
              itemsPath: "targets",
            },
          ],
        },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("itemsPath requires");
  });

  it("accepts output schemas on workers, distributors, and consolidators", () => {
    const spec: WorkflowSpec = {
      name: "ok",
      phases: [
        {
          id: "p1",
          title: "P1",
          steps: [
            {
              id: "split",
              kind: "distributor",
              agent: "claude",
              model: "m",
              prompt: "split",
              output: { type: "object", properties: { targets: { type: "array" } } },
              itemsPath: "targets",
            },
          ],
        },
        {
          id: "p2",
          title: "P2",
          steps: [{ ...worker, output: verdictSchema }],
        },
        {
          id: "p3",
          title: "P3",
          steps: [
            {
              id: "c",
              kind: "consolidator",
              dependsOn: ["w"],
              agent: "claude",
              model: "m",
              prompt: "merge",
              output: verdictSchema,
            },
          ],
        },
      ],
    };
    expect(validateWorkflow(spec)).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Engine integration
// ---------------------------------------------------------------------------

describe("engine: structured step outputs", () => {
  const reviewSpec = (extraPhases: WorkflowSpec["phases"] = []): WorkflowSpec => ({
    name: "structured",
    phases: [
      {
        id: "review-phase",
        title: "Review",
        steps: [
          {
            id: "review",
            agent: "claude",
            model: "m",
            prompt: "Review: {{input}}",
            output: verdictSchema,
          },
        ],
      },
      ...extraPhases,
    ],
  });

  it("appends the schema contract to the prompt and parses the JSON reply", async () => {
    const { deps, runs } = makeDeps(() => reply('All good.\n\n```json\n{"verdict": "pass"}\n```'));
    const events = await collect(
      reviewSpec([
        {
          id: "report-phase",
          title: "Report",
          steps: [
            {
              id: "report",
              kind: "consolidator",
              dependsOn: ["review"],
              prompt: "verdict={{steps.review.json.verdict}}",
            },
          ],
        },
      ]),
      "the code",
      deps,
    );

    expect(runs).toHaveLength(1);
    expect(runs[0]?.opts.prompt).toContain("Review: the code");
    expect(runs[0]?.opts.prompt).toContain("## Required output format");
    expect(runs[0]?.opts.prompt).toContain('"enum"');

    const review = finalResult(events, "review");
    expect(review.ok).toBe(true);
    expect(review.json).toEqual({ verdict: "pass" });
    expect(finalResult(events, "report").output).toBe("verdict=pass");
    const done = events.at(-1);
    expect(done?.kind === "workflow_done" && done.ok).toBe(true);
  });

  it("runs one bounded fix-your-JSON retry, then succeeds", async () => {
    const { deps, runs } = makeDeps((_opts, runIndex) =>
      runIndex === 0 ? reply("the verdict is pass!") : reply('{"verdict": "pass"}'),
    );
    const events = await collect(reviewSpec(), "x", deps);

    expect(runs).toHaveLength(2);
    expect(runs[1]?.opts.prompt).toContain("did not contain valid JSON");
    expect(runs[1]?.opts.prompt).toContain("the verdict is pass!");

    const retry = events.find((e) => e.kind === "step_retry");
    expect(retry?.kind === "step_retry" && retry.reason).toContain("structured output invalid");

    const review = finalResult(events, "review");
    expect(review.ok).toBe(true);
    expect(review.json).toEqual({ verdict: "pass" });
    expect(review.attempts).toBe(2);
    expect(review.costUsd).toBeCloseTo(0.002);
  });

  it("fails the step when the fix retry still does not match", async () => {
    const { deps, runs } = makeDeps(() => reply("never json"));
    const events = await collect(reviewSpec(), "x", deps);

    expect(runs).toHaveLength(2);
    const review = finalResult(events, "review");
    expect(review.ok).toBe(false);
    expect(review.error).toContain("structured output retry failed");
    const done = events.at(-1);
    expect(done?.kind === "workflow_done" && done.ok).toBe(false);
  });

  it("gates on a JSON field instead of substring-matching prose", async () => {
    // The roadmap's motivating example: prose mentions "P0" but the typed
    // verdict is pass — a `path` gate must not trip on the prose.
    const { deps } = makeDeps(() =>
      reply('no P0 issues found, but P0 handling looks odd\n{"verdict": "pass"}'),
    );
    const events = await collect(
      reviewSpec([
        {
          id: "gate-phase",
          title: "Gate",
          steps: [
            {
              id: "check",
              kind: "gate",
              dependsOn: ["review"],
              condition: { step: "review", path: "verdict", equals: "pass" },
              onFalse: "fail",
            },
          ],
        },
      ]),
      "x",
      deps,
    );

    const gate = events.find((e) => e.kind === "gate_evaluated");
    expect(gate?.kind === "gate_evaluated" && gate.passed).toBe(true);
    const done = events.at(-1);
    expect(done?.kind === "workflow_done" && done.ok).toBe(true);
  });

  it("fails a path gate when the field does not match", async () => {
    const { deps } = makeDeps(() => reply('{"verdict": "fail"}'));
    const events = await collect(
      reviewSpec([
        {
          id: "gate-phase",
          title: "Gate",
          steps: [
            {
              id: "check",
              kind: "gate",
              dependsOn: ["review"],
              condition: { step: "review", path: "verdict", equals: "pass" },
              onFalse: "fail",
            },
          ],
        },
      ]),
      "x",
      deps,
    );

    const gate = events.find((e) => e.kind === "gate_evaluated");
    expect(gate?.kind === "gate_evaluated" && gate.passed).toBe(false);
    const done = events.at(-1);
    expect(done?.kind === "workflow_done" && done.ok).toBe(false);
  });

  it("fans a distributor out over a JSON array at itemsPath", async () => {
    const { deps, runs } = makeDeps((opts) =>
      opts.prompt.startsWith("Split")
        ? reply('Sure — here you go:\n{"targets": ["api", "web", "docs"]}')
        : reply(`done:${opts.prompt}`),
    );
    const spec: WorkflowSpec = {
      name: "fan-out",
      phases: [
        {
          id: "split-phase",
          title: "Split",
          steps: [
            {
              id: "split",
              kind: "distributor",
              agent: "claude",
              model: "m",
              prompt: "Split {{input}}",
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
          id: "work-phase",
          title: "Work",
          steps: [
            {
              id: "work",
              agent: "claude",
              model: "m",
              dependsOn: ["split"],
              forEach: "steps.split.items",
              prompt: "{{item}} ({{steps.split.json.targets[2]}})",
            },
          ],
        },
      ],
    };
    const events = await collect(spec, "x", deps);

    const split = finalResult(events, "split");
    expect(split.items).toEqual(["api", "web", "docs"]);
    const fanOut = events.find((e) => e.kind === "fan_out");
    expect(fanOut?.kind === "fan_out" && fanOut.count).toBe(3);
    const workerPrompts = runs.slice(1).map((r) => r.opts.prompt);
    expect(workerPrompts.some((p) => p.includes("api (docs)"))).toBe(true);
    const done = events.at(-1);
    expect(done?.kind === "workflow_done" && done.ok).toBe(true);
  });

  it("fans a distributor out over a top-level JSON array without itemsPath", async () => {
    const { deps } = makeDeps(() => reply('["one", "two"]'));
    const spec: WorkflowSpec = {
      name: "top-level-array",
      phases: [
        {
          id: "split-phase",
          title: "Split",
          steps: [
            {
              id: "split",
              kind: "distributor",
              agent: "claude",
              model: "m",
              prompt: "Split",
              output: { type: "array", items: { type: "string" } },
            },
          ],
        },
      ],
    };
    const events = await collect(spec, "x", deps);
    expect(finalResult(events, "split").items).toEqual(["one", "two"]);
  });

  it("serializes non-string array elements as item payloads", async () => {
    const { deps } = makeDeps(() => reply('[{"file": "a.ts"}, {"file": "b.ts"}]'));
    const spec: WorkflowSpec = {
      name: "object-items",
      phases: [
        {
          id: "split-phase",
          title: "Split",
          steps: [
            {
              id: "split",
              kind: "distributor",
              agent: "claude",
              model: "m",
              prompt: "Split",
              output: { type: "array" },
            },
          ],
        },
      ],
    };
    const events = await collect(spec, "x", deps);
    expect(finalResult(events, "split").items).toEqual(['{"file":"a.ts"}', '{"file":"b.ts"}']);
  });

  it("fails a structured distributor whose value at itemsPath is not an array", async () => {
    const { deps } = makeDeps(() => reply('{"targets": "not-an-array"}'));
    const spec: WorkflowSpec = {
      name: "bad-items",
      phases: [
        {
          id: "split-phase",
          title: "Split",
          steps: [
            {
              id: "split",
              kind: "distributor",
              agent: "claude",
              model: "m",
              prompt: "Split",
              output: { type: "object" },
              itemsPath: "targets",
            },
          ],
        },
      ],
    };
    const events = await collect(spec, "x", deps);
    const split = finalResult(events, "split");
    expect(split.ok).toBe(false);
    expect(split.error).toContain("not a JSON array");
  });

  it("skips a step via a when condition on a JSON field", async () => {
    const { deps, runs } = makeDeps(() => reply('{"verdict": "fail"}'));
    const events = await collect(
      reviewSpec([
        {
          id: "fix-phase",
          title: "Fix",
          steps: [
            {
              id: "celebrate",
              agent: "claude",
              model: "m",
              dependsOn: ["review"],
              when: { step: "review", path: "verdict", equals: "pass" },
              prompt: "celebrate",
            },
          ],
        },
      ]),
      "x",
      deps,
    );

    expect(finalResult(events, "celebrate").skipped).toBe(true);
    expect(runs).toHaveLength(1); // only the review agent ran
  });

  it("replays json from a disk round-tripped cache (resume)", async () => {
    const spec = reviewSpec([
      {
        id: "gate-phase",
        title: "Gate",
        steps: [
          {
            id: "check",
            kind: "gate",
            dependsOn: ["review"],
            condition: { step: "review", path: "verdict", equals: "pass" },
            onFalse: "fail",
          },
        ],
      },
    ]);

    // First run populates the cache; persist it through the disk store.
    const first = makeDeps(() => reply('{"verdict": "pass"}'));
    const cache = new Map<string, StepResult>();
    await collect(spec, "x", first.deps, cache);
    expect(first.runs).toHaveLength(1);
    const root = mkdtempSync(join(tmpdir(), "steamtrain-structured-"));
    const key = workflowCacheKey("structured", "x", root, spec);
    await saveWorkflowCache(root, key, cache);

    // Resume from the reloaded cache: no agent runs, and the path gate still
    // sees the parsed json rather than empty text. Drop the gate's own cached
    // result so it genuinely re-evaluates against the replayed review result.
    const reloaded = await loadWorkflowCache(root, key);
    reloaded.delete("check");
    const second = makeDeps(() => reply("must not run"));
    const events = await collect(spec, "x", second.deps, reloaded);
    expect(second.runs).toHaveLength(0);
    expect(finalResult(events, "review").json).toEqual({ verdict: "pass" });
    const gate = events.find((e) => e.kind === "gate_evaluated");
    expect(gate?.kind === "gate_evaluated" && gate.passed).toBe(true);
    const done = events.at(-1);
    expect(done?.kind === "workflow_done" && done.ok).toBe(true);
  });
});
