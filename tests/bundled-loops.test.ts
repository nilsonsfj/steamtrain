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
        let text = "done";
        if (opts.prompt.includes("Implement ONLY this stream")) {
          text = 'Implemented the feature.\n{"summary":"wrote feature.txt","findings":[]}';
        } else if (opts.prompt.includes("Review the diff from the base commit")) {
          text = '{"verdict":"clean","issues":[],"findings":[]}';
        } else if (opts.prompt.includes("Apply exactly the issues")) {
          text = "NO-OP";
        }
        yield {
          kind: "result",
          agent: id,
          ts: 0,
          isError: false,
          text,
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

async function runMainlineStream(repo: string, worktrees: string): Promise<WorkflowEvent[]> {
  const wf = BUNDLED_WORKFLOWS["mainline-stream"]!;
  const deps: WorkflowDeps = {
    createAdapter: writingAdapter(),
    maxConcurrency: 4,
    cwd: repo,
    agentWorkspace: createGitWorktreeManager({ baseDir: worktrees, runId: "bundled-loop-test" }),
    agentConfig: {
      agents: [
        { id: "mimo", provider: "mimo", enabled: true },
        { id: "opencode", provider: "opencode", enabled: true },
      ],
    },
  };
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(
    wf,
    {
      input: "WRITE feature.txt\nthe feature\n",
      inputs: {
        coderModel: "mimo/mimo-auto",
        reviewerModel: "opencode/nemotron-3-ultra-free",
        reviewerEffort: "",
        testCmd: "true",
        issueTiming: "end",
        issueMode: "report",
      },
    },
    deps,
  ))
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

  it("ships a valid mainline-stream using loop-back gates", () => {
    const wf = BUNDLED_WORKFLOWS["mainline-stream"];
    expect(wf).toBeDefined();
    const result = validateWorkflow(wf!);
    expect(result.ok).toBe(true);
  });

  it("mainline-stream declares loop-back gates that target the review phase", () => {
    const wf = BUNDLED_WORKFLOWS["mainline-stream"]!;
    const gates = wf.phases.flatMap((p) => p.steps).filter((s) => s.kind === "gate");
    expect(gates.length).toBeGreaterThanOrEqual(2);
    for (const gate of gates) {
      expect(gate).toHaveProperty("loopTo", "review");
    }
  });

  it("mainline-stream converges end-to-end in a real git repo", async () => {
    const { repo, worktrees } = await makeRepo();
    const events = await runMainlineStream(repo, worktrees);

    expect(workflowOk(events)).toBe(true);

    const results = doneResults(events);
    expect(results.get("implement")?.ok).toBe(true);
    expect(results.get("review")?.ok).toBe(true);
    expect(results.get("test")?.ok).toBe(true);
  });
});
