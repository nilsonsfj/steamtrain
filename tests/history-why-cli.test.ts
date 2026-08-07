import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import {
  WORKFLOW_HISTORY_DIR,
  computeRunTotals,
  createWorkflowHistoryStore,
} from "../src/workflow";
import type { HistoryPhase, RunRecord } from "../src/workflow/history";

const KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
];

function clearApiKeys(): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const name of KEY_ENV_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  return () => {
    for (const name of KEY_ENV_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  };
}

interface Captured {
  cwd: string;
  stdout: string;
  stderr: string;
  io: { cwd: string; home: string; stdout: (t: string) => void; stderr: (t: string) => void };
}

/** Isolated capture: a temp home keeps the machine's user config out of the test. */
function capture(cwd: string): Captured {
  let stdout = "";
  let stderr = "";
  return {
    cwd,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    io: {
      cwd,
      home: mkdtempSync(join(tmpdir(), "steamtrain-why-home-")),
      stdout: (t: string) => {
        stdout += t;
      },
      stderr: (t: string) => {
        stderr += t;
      },
    },
  };
}

function failedPhase(): HistoryPhase[] {
  return [
    {
      phaseId: "p1",
      title: "Phase 1",
      index: 0,
      stepCount: 1,
      done: true,
      ok: false,
      steps: [
        {
          stepId: "check",
          blockKind: "command",
          status: "error",
          text: "boom",
          cached: false,
          result: {
            stepId: "check",
            ok: false,
            output: "boom",
            error: "exit 1",
            exitCode: 1,
            durationMs: 2,
          },
        },
      ],
    },
  ];
}

function failedRecord(id: string, cwd: string): RunRecord {
  const phases = failedPhase();
  return {
    version: 1,
    id,
    workflow: "demo",
    input: "task",
    cwd,
    status: "error",
    ok: false,
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    durationMs: 1000,
    phases,
    totals: computeRunTotals(phases),
  };
}

/** Temp project with a 'demo' workflow and one recorded failed run. */
async function makeProject(
  runId = "11111111-1111-4111-8111-111111111111",
): Promise<{ cwd: string; runId: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "steamtrain-why-cli-"));
  writeFileSync(
    join(cwd, "steamtrain.json"),
    JSON.stringify({
      workflows: {
        demo: {
          phases: [
            {
              id: "p1",
              title: "Phase 1",
              steps: [{ id: "check", kind: "command", cmd: "npm test" }],
            },
          ],
        },
      },
    }),
  );
  const store = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));
  await store.save(failedRecord(runId, cwd));
  return { cwd, runId };
}

describe("workflow history why", () => {
  const restorers: Array<() => void> = [];
  afterEach(() => {
    for (const restore of restorers.splice(0)) restore();
  });

  it("prints usage when no run id is given", async () => {
    const c = capture(mkdtempSync(join(tmpdir(), "steamtrain-why-cli-")));
    const code = await runCli(["workflow", "history", "why"], c.io);
    expect(code).toBe(1);
    expect(c.stderr).toContain("usage: steamtrain workflow history why");
  });

  it("errors on an unknown run id", async () => {
    const { cwd } = await makeProject();
    const c = capture(cwd);
    const code = await runCli(["workflow", "history", "why", "no-such-run"], c.io);
    expect(code).toBe(1);
    expect(c.stderr).toContain("unknown run 'no-such-run'");
  });

  it("rejects ambiguous id prefixes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-why-cli-"));
    writeFileSync(join(cwd, "steamtrain.json"), JSON.stringify({ workflows: {} }));
    const store = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));
    await store.save(failedRecord("aaaaaaa1-1111-4111-8111-111111111111", cwd));
    await store.save(failedRecord("aaaaaaa1-2222-4222-8222-222222222222", cwd));
    const c = capture(cwd);
    const code = await runCli(["workflow", "history", "why", "aaaaaaa1"], c.io);
    expect(code).toBe(1);
    expect(c.stderr).toContain("matches 2 runs");
  });

  it("rejects prefixes shorter than 8 characters", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "steamtrain-why-cli-"));
    writeFileSync(join(cwd, "steamtrain.json"), JSON.stringify({ workflows: {} }));
    const c = capture(cwd);
    const code = await runCli(["workflow", "history", "why", "short"], c.io);
    expect(code).toBe(1);
    expect(c.stderr).toContain("too short");
  });

  it("fails cleanly when the requested api has no key", async () => {
    restorers.push(clearApiKeys());
    const { cwd, runId } = await makeProject();
    const c = capture(cwd);
    const code = await runCli(
      ["workflow", "history", "why", runId, "--api", "anthropic", "--model", "claude-sonnet-5"],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.stderr).toContain("diagnosing run");
    expect(c.stderr).toContain("ANTHROPIC_API_KEY");
  });

  it("emits the failure as JSON with --json", async () => {
    restorers.push(clearApiKeys());
    const { cwd, runId } = await makeProject();
    const c = capture(cwd);
    const code = await runCli(
      [
        "workflow",
        "history",
        "why",
        runId,
        "--api",
        "anthropic",
        "--model",
        "claude-sonnet-5",
        "--json",
      ],
      c.io,
    );
    expect(code).toBe(1);
    const parsed = JSON.parse(c.stdout) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("ANTHROPIC_API_KEY");
  });

  it("resolves a unique id prefix", async () => {
    restorers.push(clearApiKeys());
    const { cwd, runId } = await makeProject();
    const c = capture(cwd);
    const code = await runCli(
      [
        "workflow",
        "history",
        "why",
        runId.slice(0, 8),
        "--api",
        "anthropic",
        "--model",
        "claude-sonnet-5",
      ],
      c.io,
    );
    expect(code).toBe(1);
    // The record was found via prefix; the failure is the missing API key.
    expect(c.stderr).toContain(`diagnosing run '${runId}'`);
    expect(c.stderr).toContain("ANTHROPIC_API_KEY");
  });
});
