import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type HistoryStep,
  type RunRecord,
  createWorkflowHistoryStore,
  findRecordedStep,
  formatTakeoverCommand,
  planTakeover,
  recordTakeover,
} from "../src/workflow";

function step(overrides: Partial<HistoryStep> & { stepId: string }): HistoryStep {
  return {
    blockKind: "worker",
    status: "done",
    text: "",
    cached: false,
    ...overrides,
  };
}

function record(steps: HistoryStep[]): RunRecord {
  return {
    version: 1,
    id: "run-1",
    workflow: "w",
    input: "go",
    cwd: "/repo",
    status: "done",
    ok: true,
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    phases: [
      { phaseId: "p", title: "P", index: 0, stepCount: steps.length, steps, done: true, ok: true },
    ],
    totals: {
      steps: steps.length,
      ok: steps.length,
      failed: 0,
      cached: 0,
      costUsd: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      durationMs: 1,
    },
  };
}

const worktree = {
  originalCwd: "/repo",
  cwd: "/tmp/wt/impl",
  root: "/tmp/wt/impl",
  branch: "steamtrain/impl",
};

describe("planTakeover", () => {
  it("plans a native session resume for a claude step with a live worktree", () => {
    const rec = record([
      step({
        stepId: "impl",
        agent: "claude",
        worktree,
        result: { stepId: "impl", ok: true, output: "", durationMs: 1, sessionId: "ses-42" },
      }),
    ]);
    const planned = planTakeover(rec, "impl", undefined, { fsExists: () => true });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.binary).toBe("claude");
    expect(planned.plan.args).toEqual(["--resume", "ses-42"]);
    expect(planned.plan.cwd).toBe("/tmp/wt/impl");
    expect(planned.plan.resumed).toBe(true);
    expect(planned.plan.notes).toHaveLength(0);
    expect(formatTakeoverCommand(planned.plan)).toBe("cd /tmp/wt/impl && claude --resume ses-42");
  });

  it("plans a fresh session (with a note) when no session id was recorded", () => {
    const rec = record([
      step({
        stepId: "impl",
        agent: "claude",
        worktree,
        result: { stepId: "impl", ok: true, output: "", durationMs: 1 },
      }),
    ]);
    const planned = planTakeover(rec, "impl", undefined, { fsExists: () => true });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.args).toEqual([]);
    expect(planned.plan.resumed).toBe(false);
    expect(planned.plan.notes[0]).toContain("no session id");
  });

  it("notes non-resumable providers instead of failing", () => {
    const rec = record([
      step({
        stepId: "impl",
        agent: "codex",
        worktree,
        result: { stepId: "impl", ok: true, output: "", durationMs: 1, sessionId: "ses-9" },
      }),
    ]);
    const planned = planTakeover(rec, "impl", undefined, { fsExists: () => true });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.resumed).toBe(false);
    expect(planned.plan.notes[0]).toContain("codex");
  });

  it("fails clearly when the worktree was pruned", () => {
    const rec = record([
      step({
        stepId: "impl",
        agent: "claude",
        worktree,
        result: { stepId: "impl", ok: true, output: "", durationMs: 1, sessionId: "s" },
      }),
    ]);
    const planned = planTakeover(rec, "impl", undefined, { fsExists: () => false });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.error).toContain("worktree is gone");
  });

  it("rejects non-agent steps and unknown step ids with the step list", () => {
    const rec = record([
      step({ stepId: "gatekeeper", blockKind: "gate" }),
      step({ stepId: "impl", agent: "claude", worktree }),
    ]);
    const gate = planTakeover(rec, "gatekeeper", undefined, { fsExists: () => true });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toContain("agent-backed");
    const missing = planTakeover(rec, "nope", undefined, { fsExists: () => true });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("gatekeeper, impl");
  });

  it("finds namespaced sub-workflow steps by their local id (last instance wins)", () => {
    const rec = record([
      step({ stepId: "call::impl", agent: "claude", worktree }),
      step({ stepId: "call::impl", agent: "claude", worktree: { ...worktree, cwd: "/tmp/wt/2" } }),
    ]);
    const found = findRecordedStep(rec, "impl");
    expect(found?.step.worktree?.cwd).toBe("/tmp/wt/2");
  });
});

describe("recordTakeover", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("appends a takeover intervention to the saved record", async () => {
    dir = mkdtempSync(join(tmpdir(), "steamtrain-takeover-"));
    const store = createWorkflowHistoryStore(dir);
    await store.save(record([step({ stepId: "impl", agent: "claude" })]));
    const ok = await recordTakeover(store, "run-1", {
      stepId: "impl",
      sessionId: "ses-42",
      resumed: true,
      startedAt: 10,
      endedAt: 20,
      exitCode: 0,
    });
    expect(ok).toBe(true);
    const saved = await store.get("run-1");
    expect(saved?.interventions).toHaveLength(1);
    expect(saved?.interventions?.[0]).toMatchObject({
      kind: "takeover",
      stepId: "impl",
      by: "human:cli",
      takeover: { sessionId: "ses-42", resumed: true, endedAt: 20, exitCode: 0 },
    });
    expect(
      await recordTakeover(store, "missing", {
        stepId: "impl",
        resumed: false,
        startedAt: 1,
        endedAt: 2,
      }),
    ).toBe(false);
  });
});
