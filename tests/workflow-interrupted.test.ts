import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type WorkflowEvent, type WorkflowSpec, runWorkflow } from "../src/workflow";

/**
 * A step the run's cancel takes down did not fail on its own. Its error is
 * whatever the process said as it died (an exit code, a signal), so UIs used
 * to name it the run's root cause; the engine now says so explicitly.
 */
describe("a step taken down by a canceled run", () => {
  it("is marked interrupted, and the run stops before the next step starts", async () => {
    const spec: WorkflowSpec = {
      name: "interrupted",
      phases: [
        { id: "p1", title: "Slow", steps: [{ id: "slow", kind: "command", cmd: "sleep 5" }] },
        { id: "p2", title: "Next", steps: [{ id: "next", kind: "command", cmd: "echo next" }] },
      ],
    };
    const ac = new AbortController();
    const events: WorkflowEvent[] = [];
    for await (const ev of runWorkflow(
      spec,
      { input: "task" },
      {
        createAdapter: () => {
          throw new Error("no agents");
        },
        maxConcurrency: 2,
        cwd: process.cwd(),
      },
      ac.signal,
    )) {
      events.push(ev);
      if (ev.kind === "step_start" && ev.stepId === "slow") setTimeout(() => ac.abort(), 100);
    }
    const slow = events.find((e) => e.kind === "step_done" && e.stepId === "slow");
    expect(slow?.kind === "step_done" && slow.result).toMatchObject({
      ok: false,
      interrupted: true,
    });
    // The cancel stops the run before `next` starts, so it has no result to mark.
    expect(events.some((e) => e.kind === "step_start" && e.stepId === "next")).toBe(false);
    expect(events.some((e) => e.kind === "step_done" && e.stepId === "next")).toBe(false);
  });
});

describe("a step that failed on its own just before the cancel", () => {
  it("keeps its failure, while the sibling the cancel cut short is interrupted", async () => {
    process.env.STEAMTRAIN_TEST_LLM_KEY = "sk-test";
    const spec: WorkflowSpec = {
      name: "race",
      phases: [
        {
          id: "list",
          title: "List",
          steps: [{ id: "items", kind: "command", cmd: "printf 'fails\\nslow\\n'" }],
        },
        {
          id: "work",
          title: "Work",
          steps: [
            {
              id: "each",
              kind: "llm",
              model: "claude-opus-4-8",
              apiKeyEnv: "STEAMTRAIN_TEST_LLM_KEY",
              dependsOn: ["items"],
              forEach: "steps.items.items",
              prompt: "{{item}}",
            },
          ],
        },
      ],
    };
    const ac = new AbortController();
    const events: WorkflowEvent[] = [];
    try {
      for await (const ev of runWorkflow(
        spec,
        { input: "task" },
        {
          createAdapter: () => {
            throw new Error("no agents");
          },
          maxConcurrency: 2,
          cwd: process.cwd(),
          llmComplete: async (req) => {
            if (req.prompt.includes("fails")) {
              // The real failure lands first; the cancel follows while the
              // sibling is still running, so the fan-out settles after it.
              setTimeout(() => ac.abort(), 50);
              return { ok: false, error: "HTTP 400: bad request", retryable: false };
            }
            await new Promise((resolve) => {
              if (req.signal?.aborted) resolve(undefined);
              else req.signal?.addEventListener("abort", resolve);
            });
            return { ok: false, error: "aborted", retryable: false };
          },
        },
        ac.signal,
      )) {
        events.push(ev);
      }
    } finally {
      process.env.STEAMTRAIN_TEST_LLM_KEY = undefined;
    }
    const done = events.find((e) => e.kind === "workflow_done");
    const results = done?.kind === "workflow_done" ? done.results : [];
    const parent = results.find((r) => r.stepId === "each");
    const children = parent?.childResults ?? results.filter((r) => r.parentStepId === "each");
    const failed = children.find((r) => r.output.includes("bad request"));
    const cut = children.find((r) => r !== failed);
    expect(failed).toMatchObject({ ok: false, error: "HTTP 400: bad request" });
    expect(failed?.interrupted).toBeUndefined();
    expect(cut).toMatchObject({ ok: false, interrupted: true });
  });
});

describe("closing the workflow generator", () => {
  it("aborts in-flight commands so worktrees are not reclaimed under a live process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steamtrain-gen-close-"));
    const pidFile = join(dir, "pid");
    const spec: WorkflowSpec = {
      name: "close",
      phases: [
        {
          id: "p1",
          title: "Slow",
          steps: [{ id: "slow", kind: "command", cmd: `echo $$ > "${pidFile}"; sleep 30` }],
        },
      ],
    };
    const gen = runWorkflow(
      spec,
      { input: "task" },
      {
        createAdapter: () => {
          throw new Error("no agents");
        },
        maxConcurrency: 1,
        cwd: dir,
      },
    );
    for await (const ev of gen) {
      if (ev.kind === "step_start" && ev.stepId === "slow") {
        await vi.waitFor(() => readFileSync(pidFile, "utf8").trim().length > 0);
        break;
      }
    }
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    try {
      process.kill(pid, 0);
      expect.fail("command still alive after the generator closed");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ESRCH");
    }
  });
});
