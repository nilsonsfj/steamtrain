import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type WorkflowDeps,
  type WorkflowEvent,
  createGitWorktreeManager,
  runWorkflow,
  validateWorkflow,
} from "../src/workflow";
import { BUNDLED_WORKFLOWS } from "../src/workflow/bundled";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

function writingAdapter(): (id: AgentId) => AgentAdapter {
  return (id: AgentId): AgentAdapter => ({
    id,
    binary: "fake",
    defaultModel: "test",
    run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        const match = /WRITE (\S+)\n([\s\S]*)/.exec(opts.prompt);
        if (match) {
          await writeFile(join(opts.cwd ?? ".", match[1] as string), match[2] as string);
        }
        yield {
          kind: "result",
          agent: id,
          ts: 0,
          isError: false,
          text: opts.prompt.includes("Review ONLY") ? "DONE" : "done",
          costUsd: 0.01,
        };
      })();
    },
  });
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-bundled-loop-test-"));
  tempRoots.push(dir);
  return dir;
}

async function makeRepo(): Promise<{ repo: string; worktrees: string }> {
  const root = await tempDir();
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repo });
  await writeFile(join(repo, "README.md"), "hello\n");
  await execFileAsync("git", ["add", "."], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repo });
  return { repo, worktrees: join(root, "worktrees") };
}

async function runReviewLoop(repo: string, worktrees: string): Promise<WorkflowEvent[]> {
  const wf = BUNDLED_WORKFLOWS["review-loop"]!;
  const deps: WorkflowDeps = {
    createAdapter: writingAdapter(),
    maxConcurrency: 4,
    cwd: repo,
    agentWorkspace: createGitWorktreeManager({ baseDir: worktrees, runId: "bundled-loop-test" }),
  };
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(wf, { input: "WRITE feature.txt\nthe feature\n" }, deps))
    events.push(ev);
  return events;
}

function doneResults(events: WorkflowEvent[]): Map<string, { ok: boolean; output: string }> {
  const map = new Map<string, { ok: boolean; output: string }>();
  for (const ev of events) {
    if (ev.kind === "step_done") map.set(ev.stepId, { ok: ev.result.ok, output: ev.result.output });
  }
  return map;
}

function workflowOk(events: WorkflowEvent[]): boolean {
  const done = events.find((ev) => ev.kind === "workflow_done");
  return done?.kind === "workflow_done" ? done.ok : false;
}

describe("bundled loop workflow", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("ships a valid review-loop using a loop-back gate", () => {
    const wf = BUNDLED_WORKFLOWS["review-loop"];
    expect(wf).toBeDefined();
    expect(validateWorkflow(wf!)).toEqual({ ok: true });
  });

  it("review-loop implements, reviews, and merges the result", async () => {
    const { repo, worktrees } = await makeRepo();
    const events = await runReviewLoop(repo, worktrees);

    expect(workflowOk(events)).toBe(true);

    const results = doneResults(events);
    expect(results.get("impl")?.ok).toBe(true);
    expect(results.get("review")?.ok).toBe(true);
    expect(results.get("fix")?.ok).toBe(true);

    // The merge step must have run and produced output.
    const merge = results.get("merge");
    expect(merge?.ok).toBe(true);
    expect(merge?.output).toContain("merged");

    // The file must have landed in the user's checkout.
    const content = await readFile(join(repo, "feature.txt"), "utf8");
    expect(content).toContain("the feature");
  });
});
