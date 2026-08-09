import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  createGitWorktreeManager,
  runShellCommand,
  runWorkflow,
  validateWorkflow,
} from "../src/workflow";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

/** Command-step workflows never spawn an agent; a throwing adapter proves it. */
function agentlessDeps(cwd: string, over: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return {
    createAdapter: () => {
      throw new Error("command-step workflows must not create agent adapters");
    },
    maxConcurrency: 4,
    cwd,
    ...over,
  };
}

async function runToEvents(spec: WorkflowSpec, deps: WorkflowDeps): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input: "task" }, deps)) events.push(ev);
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
  return { name: "cmd-test", phases };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-command-test-"));
  tempRoots.push(dir);
  return dir;
}

describe("command workflow step", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("captures stdout+stderr, records exit code 0, and marks the step ok", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(
      spec([
        {
          id: "run",
          title: "Run",
          steps: [{ id: "hello", kind: "command", cmd: "echo out-line && echo err-line >&2" }],
        },
      ]),
      agentlessDeps(cwd),
    );
    const result = doneResults(events).get("hello");
    expect(result?.ok).toBe(true);
    expect(result?.exitCode).toBe(0);
    expect(result?.output).toContain("out-line");
    expect(result?.output).toContain("err-line");
    expect(workflowOk(events)).toBe(true);
  });

  it("fails on a non-zero exit but keeps the output, and a gate can route on ok", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(
      spec([
        {
          id: "run",
          title: "Run",
          steps: [{ id: "tests", kind: "command", cmd: "echo 1 failing test; exit 3" }],
        },
        {
          id: "check",
          title: "Check",
          steps: [
            {
              id: "green",
              kind: "gate",
              dependsOn: ["tests"],
              condition: { step: "tests", ok: true },
              onFalse: "continue",
            },
          ],
        },
      ]),
      agentlessDeps(cwd),
    );
    const results = doneResults(events);
    const tests = results.get("tests");
    expect(tests?.ok).toBe(false);
    expect(tests?.exitCode).toBe(3);
    expect(tests?.error).toBe("command exited with code 3");
    expect(tests?.output).toContain("1 failing test");
    expect(tests?.output).toContain("[command exited with code 3]");
    expect(results.get("green")?.gate?.passed).toBe(false);
    expect(workflowOk(events)).toBe(false);
  });

  it("renders templates in cmd and exposes exitCode to downstream templates", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(
      spec([
        {
          id: "first",
          title: "First",
          steps: [{ id: "greet", kind: "command", cmd: "echo hello-{{input}}" }],
        },
        {
          id: "second",
          title: "Second",
          steps: [
            {
              id: "echoback",
              kind: "command",
              dependsOn: ["greet"],
              cmd: "echo got:{{steps.greet.output}}code:{{steps.greet.exitCode}}",
            },
          ],
        },
      ]),
      agentlessDeps(cwd),
    );
    const results = doneResults(events);
    expect(results.get("greet")?.output.trim()).toBe("hello-task");
    expect(results.get("echoback")?.output).toContain("got:hello-task");
    expect(results.get("echoback")?.output).toContain("code:0");
  });

  it("shell-quotes interpolated cmd values so metacharacters cannot inject", async () => {
    const cwd = await tempDir();
    const events: WorkflowEvent[] = [];
    for await (const ev of runWorkflow(
      spec([
        {
          id: "run",
          title: "Run",
          steps: [{ id: "safe", kind: "command", cmd: "echo {{input}}" }],
        },
      ]),
      { input: "hi; echo INJECTED" },
      agentlessDeps(cwd),
    )) {
      events.push(ev);
    }
    const output = doneResults(events).get("safe")?.output.trim() ?? "";
    expect(output).toBe("hi; echo INJECTED");
    expect(output).not.toMatch(/^hi\nINJECTED$/m);
  });

  it("allowShellTemplates runs the interpolated string as raw shell", async () => {
    const cwd = await tempDir();
    const events: WorkflowEvent[] = [];
    for await (const ev of runWorkflow(
      spec([
        {
          id: "run",
          title: "Run",
          steps: [
            {
              id: "raw",
              kind: "command",
              cmd: "{{input}}",
              allowShellTemplates: true,
            },
          ],
        },
      ]),
      { input: "echo RAW_OK" },
      agentlessDeps(cwd),
    )) {
      events.push(ev);
    }
    expect(doneResults(events).get("raw")?.output.trim()).toBe("RAW_OK");
  });

  it("templates env values without shell-quoting them", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(
      spec([
        {
          id: "run",
          title: "Run",
          steps: [
            {
              id: "env",
              kind: "command",
              env: { STEAMTRAIN_MSG: "hello-{{input}}" },
              cmd: 'echo "$STEAMTRAIN_MSG"',
            },
          ],
        },
      ]),
      agentlessDeps(cwd),
    );
    expect(doneResults(events).get("env")?.output.trim()).toBe("hello-task");
  });

  it("applies cwd and per-step env", async () => {
    const base = await tempDir();
    await mkdir(join(base, "sub"));
    const events = await runToEvents(
      spec([
        {
          id: "run",
          title: "Run",
          steps: [
            {
              id: "where",
              kind: "command",
              cwd: "sub",
              env: { STEAMTRAIN_TEST_VAR: "flag-value" },
              cmd: 'echo "$STEAMTRAIN_TEST_VAR in $(basename "$PWD")"',
            },
          ],
        },
      ]),
      agentlessDeps(base),
    );
    expect(doneResults(events).get("where")?.output.trim()).toBe("flag-value in sub");
  });

  it("kills the command on stepTimeoutSec and fails with a timeout error", async () => {
    const cwd = await tempDir();
    const started = Date.now();
    const events = await runToEvents(
      spec([
        {
          id: "run",
          title: "Run",
          steps: [{ id: "slow", kind: "command", cmd: "sleep 30", stepTimeoutSec: 0.3 }],
        },
      ]),
      agentlessDeps(cwd),
    );
    const result = doneResults(events).get("slow");
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("timed out after 0.3s");
    expect(Date.now() - started).toBeLessThan(15000);
  });

  it("streams output as text_delta step events", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(
      spec([
        {
          id: "run",
          title: "Run",
          steps: [{ id: "stream", kind: "command", cmd: "echo chunk-one; echo chunk-two" }],
        },
      ]),
      agentlessDeps(cwd),
    );
    const streamed = events
      .filter((ev) => ev.kind === "step_event" && ev.stepId === "stream")
      .map((ev) =>
        ev.kind === "step_event" && ev.event.kind === "text_delta" ? ev.event.text : "",
      )
      .join("");
    expect(streamed).toContain("chunk-one");
    expect(streamed).toContain("chunk-two");
  });

  it("parses structured output against a schema without any retry", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(
      spec([
        {
          id: "run",
          title: "Run",
          steps: [
            {
              id: "json",
              kind: "command",
              cmd: `echo '{"passed": 12, "failed": 0}'`,
              output: {
                type: "object",
                required: ["passed", "failed"],
                properties: { passed: { type: "number" }, failed: { type: "number" } },
              },
            },
            {
              id: "bad",
              kind: "command",
              cmd: "echo not-json-at-all",
              output: { type: "object", required: ["x"], properties: { x: { type: "number" } } },
            },
          ],
        },
      ]),
      agentlessDeps(cwd),
    );
    const results = doneResults(events);
    expect(results.get("json")?.ok).toBe(true);
    expect(results.get("json")?.json).toEqual({ passed: 12, failed: 0 });
    expect(results.get("bad")?.ok).toBe(false);
    expect(results.get("bad")?.error).toContain("structured output invalid");
  });

  it("is a valid forEach source via stdout line-split", async () => {
    const cwd = await tempDir();
    process.env.STEAMTRAIN_TEST_LLM_KEY = "sk-test";
    try {
      const events = await runToEvents(
        spec([
          {
            id: "list",
            title: "List",
            steps: [{ id: "prs", kind: "command", cmd: "printf 'alpha\\nbeta\\n'" }],
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
                dependsOn: ["prs"],
                forEach: "steps.prs.items",
                prompt: "touch {{item}}",
              },
            ],
          },
        ]),
        {
          ...agentlessDeps(cwd),
          llmComplete: async (req) => ({
            ok: true,
            text: `done:${req.prompt}`,
            tokens: { input: 1, output: 1 },
          }),
        },
      );
      expect(workflowOk(events)).toBe(true);
      const list = doneResults(events).get("prs");
      expect(list?.ok).toBe(true);
      const parent = doneResults(events).get("each");
      expect(parent?.ok).toBe(true);
      expect(parent?.items).toEqual(["alpha", "beta"]);
      expect(doneResults(events).get("each[0]")?.output).toContain("alpha");
      expect(doneResults(events).get("each[1]")?.output).toContain("beta");
    } finally {
      process.env.STEAMTRAIN_TEST_LLM_KEY = undefined;
    }
  });

  it("exposes a JSON-array output schema as forEach items", async () => {
    const cwd = await tempDir();
    process.env.STEAMTRAIN_TEST_LLM_KEY = "sk-test";
    try {
      const events = await runToEvents(
        spec([
          {
            id: "list",
            title: "List",
            steps: [
              {
                id: "prs",
                kind: "command",
                cmd: `printf '["one","two"]\\n'`,
                output: { type: "array", items: { type: "string" } },
              },
            ],
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
                dependsOn: ["prs"],
                forEach: "steps.prs.items",
                prompt: "{{item}}",
              },
            ],
          },
        ]),
        {
          ...agentlessDeps(cwd),
          llmComplete: async (req) => ({
            ok: true,
            text: req.prompt,
            tokens: { input: 1, output: 1 },
          }),
        },
      );
      expect(workflowOk(events)).toBe(true);
      expect(doneResults(events).get("prs")?.items).toEqual(["one", "two"]);
      expect(doneResults(events).get("each")?.items).toEqual(["one", "two"]);
    } finally {
      process.env.STEAMTRAIN_TEST_LLM_KEY = undefined;
    }
  });

  it("accepts command steps as forEach sources at validate time", () => {
    const result = validateWorkflow(
      spec([
        {
          id: "list",
          title: "List",
          steps: [{ id: "prs", kind: "command", cmd: "true" }],
        },
        {
          id: "work",
          title: "Work",
          steps: [
            {
              id: "each",
              kind: "processor",
              model: "opencode/mimo-v2.5-free",
              dependsOn: ["prs"],
              forEach: "steps.prs.items",
              prompt: "{{item}}",
            },
          ],
        },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it("treats empty command stdout as zero forEach children", async () => {
    const cwd = await tempDir();
    process.env.STEAMTRAIN_TEST_LLM_KEY = "sk-test";
    try {
      const events = await runToEvents(
        spec([
          {
            id: "list",
            title: "List",
            steps: [{ id: "prs", kind: "command", cmd: "true" }],
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
                dependsOn: ["prs"],
                forEach: "steps.prs.items",
                prompt: "{{item}}",
              },
            ],
          },
        ]),
        {
          ...agentlessDeps(cwd),
          llmComplete: async () => {
            throw new Error("should not run any children");
          },
        },
      );
      expect(workflowOk(events)).toBe(true);
      expect(doneResults(events).get("each")?.childResults).toEqual([]);
    } finally {
      process.env.STEAMTRAIN_TEST_LLM_KEY = undefined;
    }
  });

  it("runs in an isolated git worktree and records it, keeping the checkout clean", async () => {
    const root = await tempDir();
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test User");
    await writeFile(join(repo, "README.md"), "hello\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "initial");

    const events = await runToEvents(
      spec([
        {
          id: "run",
          title: "Run",
          steps: [{ id: "write", kind: "command", cmd: "echo generated > artifact.txt" }],
        },
      ]),
      agentlessDeps(repo, {
        agentWorkspace: createGitWorktreeManager({
          baseDir: join(root, "worktrees"),
          runId: "cmd-test",
        }),
      }),
    );
    const result = doneResults(events).get("write");
    expect(result?.ok).toBe(true);
    expect(result?.worktree?.root).toBeTruthy();
    // The file landed in the worktree, not the user's checkout.
    const worktreeRoot = result?.worktree?.root as string;
    expect((await readFile(join(worktreeRoot, "artifact.txt"), "utf8")).trim()).toBe("generated");
    await expect(readFile(join(repo, "artifact.txt"))).rejects.toThrow();
    expect(await git(repo, "status", "--porcelain")).toBe("");
    // The worktree was announced live too (step_workspace), not just recorded
    // on the final result.
    const ws = events.find((ev) => ev.kind === "step_workspace");
    expect(ws?.kind === "step_workspace" && ws.stepId).toBe("write");
    expect(ws?.kind === "step_workspace" && ws.worktree?.root).toBe(worktreeRoot);
  });

  it("is skipped by a false when condition without running", async () => {
    const cwd = await tempDir();
    const marker = join(cwd, "ran.txt");
    const events = await runToEvents(
      spec([
        {
          id: "first",
          title: "First",
          steps: [{ id: "probe", kind: "command", cmd: "echo frontend" }],
        },
        {
          id: "second",
          title: "Second",
          steps: [
            {
              id: "maybe",
              kind: "command",
              dependsOn: ["probe"],
              when: { step: "probe", contains: "backend" },
              cmd: `touch ${JSON.stringify(marker)}`,
            },
          ],
        },
      ]),
      agentlessDeps(cwd),
    );
    const result = doneResults(events).get("maybe");
    expect(result?.skipped).toBe(true);
    expect(result?.ok).toBe(true);
    await expect(readFile(marker)).rejects.toThrow();
  });

  it("supports 'loop until the tests pass': a converged loop ends the run ok", async () => {
    const cwd = await tempDir();
    // Fails on the first pass (creates the marker), passes on the second.
    const cmd = "if [ -f marker ]; then echo all green; else touch marker; echo boom; exit 1; fi";
    const events = await runToEvents(
      spec([
        {
          id: "verify",
          title: "Verify",
          steps: [{ id: "tests", kind: "command", cmd }],
        },
        {
          id: "check",
          title: "Check",
          steps: [
            {
              id: "converged",
              kind: "gate",
              dependsOn: ["tests"],
              condition: { step: "tests", ok: true },
              loopTo: "verify",
              maxIterations: 3,
              onFalse: "fail",
            },
          ],
        },
      ]),
      agentlessDeps(cwd),
    );
    const results = doneResults(events);
    expect(results.get("tests")?.ok).toBe(true);
    expect(results.get("tests")?.iteration).toBe(2);
    expect(results.get("converged")?.gate?.passed).toBe(true);
    // The first pass's failure is superseded by the converged re-run.
    expect(workflowOk(events)).toBe(true);
  });

  it("fails the run when the loop budget exhausts without the command passing", async () => {
    const cwd = await tempDir();
    const events = await runToEvents(
      spec([
        {
          id: "verify",
          title: "Verify",
          steps: [{ id: "tests", kind: "command", cmd: "echo still broken; exit 1" }],
        },
        {
          id: "check",
          title: "Check",
          steps: [
            {
              id: "converged",
              kind: "gate",
              dependsOn: ["tests"],
              condition: { step: "tests", ok: true },
              loopTo: "verify",
              maxIterations: 2,
              onFalse: "fail",
            },
          ],
        },
      ]),
      agentlessDeps(cwd),
    );
    const results = doneResults(events);
    expect(results.get("tests")?.ok).toBe(false);
    expect(results.get("converged")?.gate?.passed).toBe(false);
    expect(workflowOk(events)).toBe(false);
  });

  it("rejects a command step without cmd at validation time", () => {
    const invalid = {
      name: "bad",
      phases: [{ id: "p", title: "P", steps: [{ id: "c", kind: "command" }] }],
    } as unknown as WorkflowSpec;
    const result = validateWorkflow(invalid);
    expect(result.ok).toBe(false);
  });
});

describe("runShellCommand", () => {
  it("tail-truncates runaway output and flags it", async () => {
    const result = await runShellCommand(
      // ~2 MiB of output: 2048 lines × ~1 KiB.
      `i=0; while [ $i -lt 2048 ]; do printf 'line-%05d-%01000d\\n' $i 0; i=$((i+1)); done`,
      { cwd: process.cwd() },
    );
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThan(600 * 1024);
    expect(result.output).toContain("output truncated");
    expect(result.output).toContain("line-02047"); // tail survives
    expect(result.output).not.toContain("line-00000"); // head dropped
  });

  it("escalates to SIGKILL on abort when the command traps SIGTERM", async () => {
    const controller = new AbortController();
    const started = Date.now();
    // `trap '' TERM` ignores SIGTERM, and the shell exec-optimizes the trailing
    // `sleep` which inherits the ignored signal — so only SIGKILL ends it early.
    const pending = runShellCommand("trap '' TERM; sleep 30", {
      cwd: process.cwd(),
      signal: controller.signal,
      killGraceMs: 300,
    });
    // Let the shell start and install its trap before aborting.
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBeUndefined();
    // Ended via the SIGKILL escalation, not the 30s sleep running out.
    expect(Date.now() - started).toBeLessThan(10000);
  }, 15000);

  it("reports a cancelled run when the signal aborts mid-flight", async () => {
    const controller = new AbortController();
    const pending = runShellCommand("sleep 30", {
      cwd: process.cwd(),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBeUndefined();
  });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}
