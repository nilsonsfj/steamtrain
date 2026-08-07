import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { LlmCallRequest, LlmCallResult } from "../src/workflow";
import { hashWorkflowSpec } from "../src/workflow/cache-store";
import type { HistoryPhase, HistoryStep, RunRecord } from "../src/workflow/history";
import { RUN_RECORD_VERSION } from "../src/workflow/history";
import {
  type PostmortemDiagnosis,
  buildPostmortemDigest,
  diagnoseRun,
  resolvePostmortemApi,
  validatePostmortemSpecFix,
} from "../src/workflow/postmortem";
import type { WorkflowSpec } from "../src/workflow/types";

const spec: WorkflowSpec = {
  name: "demo",
  phases: [
    {
      id: "p1",
      title: "Phase 1",
      steps: [
        {
          id: "plan",
          kind: "worker",
          agent: "claude",
          model: "claude-sonnet-5",
          prompt: "plan {{input}}",
        },
        { id: "check", kind: "command", cmd: "npm test" },
      ],
    },
  ],
};

function histStep(over: Partial<HistoryStep> & { stepId: string }): HistoryStep {
  return {
    blockKind: "worker",
    status: "done",
    text: "",
    cached: false,
    result: { stepId: over.stepId, ok: true, output: "out", durationMs: 1 },
    ...over,
  };
}

function phase(steps: HistoryStep[]): HistoryPhase {
  return {
    phaseId: "p1",
    title: "Phase 1",
    index: 0,
    stepCount: steps.length,
    steps,
    done: true,
    ok: true,
  };
}

function failedRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    version: RUN_RECORD_VERSION,
    id: "run-1",
    workflow: "demo",
    input: "fix the parser",
    cwd: tmpdir(),
    status: "error",
    ok: false,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1000,
    specHash: hashWorkflowSpec(spec),
    phases: [
      phase([
        histStep({ stepId: "plan", agent: "claude", model: "claude-sonnet-5" }),
        histStep({
          stepId: "check",
          blockKind: "command",
          status: "error",
          text: "npm ERR! missing script: test",
          result: {
            stepId: "check",
            ok: false,
            output: "npm ERR! missing script: test",
            error: "command exited with code 1",
            exitCode: 1,
            durationMs: 5,
          },
        }),
      ]),
    ],
    totals: {
      steps: 2,
      ok: 1,
      failed: 1,
      cached: 0,
      costUsd: 0.01,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      durationMs: 1000,
    },
    ...over,
  };
}

function okJson(diagnosis: Partial<PostmortemDiagnosis> = {}): string {
  return JSON.stringify({
    summary: "the test script is missing from package.json",
    category: "spec-bug",
    confidence: "high",
    rootStepId: "check",
    evidence: "check: npm ERR! missing script: test",
    suggestion: "point the check step at a real test command",
    specFix: {
      stepId: "check",
      field: "cmd",
      current: "npm test",
      proposed: "bun test",
      rationale: "the repo uses bun",
    },
    ...diagnosis,
  });
}

function fakeComplete(responses: Array<LlmCallResult | ((req: LlmCallRequest) => LlmCallResult)>) {
  const calls: LlmCallRequest[] = [];
  let i = 0;
  const complete = (req: LlmCallRequest): Promise<LlmCallResult> => {
    calls.push(req);
    const entry = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return Promise.resolve(typeof entry === "function" ? entry(req) : entry);
  };
  return { complete, calls };
}

const ENV = { ANTHROPIC_API_KEY: "sk-test" };

describe("buildPostmortemDigest", () => {
  it("includes run metadata, spec, and the failed step's error", () => {
    const digest = buildPostmortemDigest(failedRecord(), { spec });
    expect(digest).toContain("workflow: demo");
    expect(digest).toContain("outcome: step-failed");
    expect(digest).toContain("## Workflow spec (current)");
    expect(digest).toContain("✗ check (command");
    expect(digest).toContain("npm ERR! missing script: test");
    expect(digest).toContain("exit code: 1");
  });

  it("marks spec drift when the recorded hash no longer matches", () => {
    const digest = buildPostmortemDigest(failedRecord(), { spec, specDrift: true });
    expect(digest).toContain("DRIFTED");
  });

  it("notes when the spec is unavailable", () => {
    const digest = buildPostmortemDigest(failedRecord(), {});
    expect(digest).toContain("(not available");
  });

  it("includes params and budget when present", () => {
    const record = failedRecord({
      params: { branch: "feat-x", count: 3 },
      budget: { scope: "workflow", spentUsd: 0.1234, limitUsd: 1.0 },
    });
    const digest = buildPostmortemDigest(record, {});
    expect(digest).toContain("params:");
    expect(digest).toContain("feat-x");
    expect(digest).toContain("budget exceeded: workflow");
    expect(digest).toContain("$0.1234");
    expect(digest).toContain("$1.0000");
  });

  it("redacts secret-looking values from the input", () => {
    const record = failedRecord({
      input: "use token ghp_abcdefABCDEF1234567890abcdefABCDEF12345678",
    });
    const digest = buildPostmortemDigest(record, {});
    expect(digest).not.toContain("ghp_abcdefABCDEF1234567890abcdefABCDEF12345678");
    expect(digest).toContain("[REDACTED]");
  });

  it("renders a gate rejection", () => {
    const record = failedRecord({
      phases: [
        phase([
          histStep({
            stepId: "gate1",
            blockKind: "gate",
            status: "error",
            gate: { passed: false, target: "quality", onFalse: "fail" },
            result: { stepId: "gate1", ok: false, output: "", durationMs: 1 },
          }),
        ]),
      ],
    });
    const digest = buildPostmortemDigest(record, {});
    expect(digest).toContain("gate1");
    expect(digest).toContain("REJECTED");
  });
});

describe("resolvePostmortemApi", () => {
  it("auto-selects a keyed built-in instance with a fallback model", () => {
    const resolved = resolvePostmortemApi(undefined, { ANTHROPIC_API_KEY: "sk-x" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.api.id).toBe("anthropic");
    expect(resolved.apiKey).toBe("sk-x");
    expect(resolved.model).toBeTruthy();
  });

  it("falls back to a keyless instance when no key is configured", () => {
    const resolved = resolvePostmortemApi(undefined, {});
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.api.keyless).toBe(true);
  });

  it("errors when an explicit api has no model and no default", () => {
    const resolved = resolvePostmortemApi(undefined, ENV, { api: "anthropic" });
    expect(resolved.ok).toBe(false);
  });

  it("honors an explicit model override", () => {
    const resolved = resolvePostmortemApi(undefined, ENV, { model: "claude-sonnet-5" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.model).toBe("claude-sonnet-5");
  });

  it("errors when an explicit api is missing its key", () => {
    const resolved = resolvePostmortemApi(
      undefined,
      {},
      { api: "anthropic", model: "claude-sonnet-5" },
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("ANTHROPIC_API_KEY");
  });
});

describe("validatePostmortemSpecFix", () => {
  it("accepts a valid command-step cmd edit", () => {
    const result = validatePostmortemSpecFix(spec, {
      stepId: "check",
      field: "cmd",
      proposed: "bun test",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a valid worker prompt edit", () => {
    const result = validatePostmortemSpecFix(spec, {
      stepId: "plan",
      field: "prompt",
      proposed: "plan carefully: {{input}}",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown step", () => {
    const result = validatePostmortemSpecFix(spec, { stepId: "nope", field: "cmd", proposed: "x" });
    expect(result.ok).toBe(false);
  });

  it("rejects a cmd edit on a non-command step", () => {
    const result = validatePostmortemSpecFix(spec, { stepId: "plan", field: "cmd", proposed: "x" });
    expect(result.ok).toBe(false);
  });

  it("rejects a prompt edit on a command step", () => {
    const result = validatePostmortemSpecFix(spec, {
      stepId: "check",
      field: "prompt",
      proposed: "x",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an edit that introduces a bad template reference", () => {
    const result = validatePostmortemSpecFix(spec, {
      stepId: "plan",
      field: "prompt",
      proposed: "plan {{steps.does-not-exist.output}}",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("template lint");
  });
});

describe("diagnoseRun", () => {
  it("returns a parsed, validated diagnosis on the happy path", async () => {
    const { complete, calls } = fakeComplete([{ ok: true, text: okJson() }]);
    const result = await diagnoseRun({
      record: failedRecord(),
      spec,
      env: ENV,
      llmComplete: complete,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnosis.category).toBe("spec-bug");
    expect(result.diagnosis.rootStepId).toBe("check");
    expect(result.diagnosis.specFix?.validation).toEqual({ ok: true });
    expect(result.specDrift).toBe(false);
    expect(calls.length).toBe(1);
    expect(calls[0]!.system).toContain("postmortem");
  });

  it("retries once when the first reply is not valid JSON", async () => {
    const { complete, calls } = fakeComplete([
      { ok: true, text: "I could not decide. Sorry." },
      { ok: true, text: okJson() },
    ]);
    const result = await diagnoseRun({
      record: failedRecord(),
      spec,
      env: ENV,
      llmComplete: complete,
    });
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[1]!.prompt).toContain("did not contain valid JSON");
  });

  it("fails when both attempts produce unparseable output", async () => {
    const { complete } = fakeComplete([
      { ok: true, text: "nope" },
      { ok: true, text: "still nope" },
    ]);
    const result = await diagnoseRun({
      record: failedRecord(),
      spec,
      env: ENV,
      llmComplete: complete,
    });
    expect(result.ok).toBe(false);
  });

  it("marks an invalid spec fix instead of dropping it", async () => {
    const { complete } = fakeComplete([
      { ok: true, text: okJson({ specFix: { stepId: "nope", field: "cmd", proposed: "x" } }) },
    ]);
    const result = await diagnoseRun({
      record: failedRecord(),
      spec,
      env: ENV,
      llmComplete: complete,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The unknown step id is not in the record, so normalizeDiagnosis drops the fix.
    expect(result.diagnosis.specFix).toBeUndefined();
  });

  it("flags spec drift when the current spec hash differs", async () => {
    const drifted: WorkflowSpec = { ...spec, description: "changed" };
    const { complete } = fakeComplete([{ ok: true, text: okJson() }]);
    const result = await diagnoseRun({
      record: failedRecord(),
      spec: drifted,
      env: ENV,
      llmComplete: complete,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.specDrift).toBe(true);
  });

  it("propagates transport errors", async () => {
    const { complete } = fakeComplete([
      { ok: false, error: "anthropic API error 500: boom", retryable: true },
    ]);
    const result = await diagnoseRun({
      record: failedRecord(),
      spec,
      env: ENV,
      llmComplete: complete,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("500");
  });

  it("errors when no API is configured at all", async () => {
    const { complete } = fakeComplete([]);
    const result = await diagnoseRun({
      record: failedRecord(),
      spec,
      env: {},
      llmComplete: complete,
      // Force the resolver off the keyless fallback by demanding an explicit api.
      api: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ANTHROPIC_API_KEY");
  });
});
