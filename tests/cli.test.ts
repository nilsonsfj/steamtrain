import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGlobalArgs, runCli, splitDryRunArgs } from "../src/cli";
import { BUNDLED_WORKFLOWS } from "../src/workflow/bundled";
import {
  WORKFLOW_CACHE_DIR,
  saveWorkflowCache,
  workflowCacheFileName,
  workflowCacheKey,
} from "../src/workflow/cache-store";
import { WORKFLOW_HISTORY_DIR } from "../src/workflow/history-store";

/** Read the id of the newest run record written under `cwd`. */
function latestRecordId(cwd: string): string {
  const dir = join(cwd, WORKFLOW_HISTORY_DIR);
  const records = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map(
      (f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as { id: string; startedAt: number },
    );
  records.sort((a, b) => b.startedAt - a.startedAt);
  return records[0]!.id;
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd: mkdtempSync(join(tmpdir(), "steamtrain-cli-")),
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

describe("parseGlobalArgs", () => {
  it("extracts -w/--workspace before subcommands", () => {
    expect(parseGlobalArgs(["-w", "./ws.json", "workflow", "list"])).toEqual({
      args: ["workflow", "list"],
      workspacePath: "./ws.json",
    });
    expect(parseGlobalArgs(["workflow", "list", "--workspace", "/tmp/ws.json"])).toEqual({
      args: ["workflow", "list"],
      workspacePath: "/tmp/ws.json",
    });
  });

  it("reports a missing workspace path", () => {
    expect(parseGlobalArgs(["-w"])).toEqual({
      args: [],
      error: "-w requires a path argument",
    });
  });

  it("extracts --config-file before subcommands", () => {
    expect(parseGlobalArgs(["--config-file", "./cfg.json", "workflow", "list"])).toEqual({
      args: ["workflow", "list"],
      configPath: "./cfg.json",
    });
    expect(parseGlobalArgs(["--config-file"])).toEqual({
      args: [],
      error: "--config-file requires a path argument",
    });
  });

  it("extracts --project-dir / --cwd before subcommands", () => {
    expect(parseGlobalArgs(["--project-dir", "/tmp/app", "workflow", "list"])).toEqual({
      args: ["workflow", "list"],
      projectDir: "/tmp/app",
    });
    expect(parseGlobalArgs(["--cwd", "../other", "workflow", "list"])).toEqual({
      args: ["workflow", "list"],
      projectDir: "../other",
    });
    expect(parseGlobalArgs(["--project-dir"])).toEqual({
      args: [],
      error: "--project-dir requires a path argument",
    });
    expect(parseGlobalArgs(["--cwd", "--web-ui"])).toEqual({
      args: [],
      error: "--cwd requires a path argument",
    });
  });

  it("parses --web-ui with optional --port and --host", () => {
    expect(parseGlobalArgs(["--web-ui"])).toEqual({ args: [], webUi: true });
    expect(parseGlobalArgs(["--web-ui", "--port", "8080", "--host", "0.0.0.0"])).toEqual({
      args: [],
      webUi: true,
      port: 8080,
      host: "0.0.0.0",
    });
  });

  it("rejects an invalid --port", () => {
    expect(parseGlobalArgs(["--web-ui", "--port", "notanumber"])).toEqual({
      args: [],
      error: "--port requires an integer 0-65535",
    });
  });

  it("parses --auth-token and --no-auth", () => {
    expect(parseGlobalArgs(["--web-ui", "--auth-token", "s3cret"])).toEqual({
      args: [],
      webUi: true,
      authToken: "s3cret",
    });
    expect(parseGlobalArgs(["--web-ui", "--host", "0.0.0.0", "--no-auth"])).toEqual({
      args: [],
      webUi: true,
      host: "0.0.0.0",
      noAuth: true,
    });
  });

  it("parses --trust-proxy", () => {
    expect(
      parseGlobalArgs(["--web-ui", "--host", "0.0.0.0", "--auth-token", "s", "--trust-proxy"]),
    ).toEqual({
      args: [],
      webUi: true,
      host: "0.0.0.0",
      authToken: "s",
      trustProxy: true,
    });
  });

  it("rejects --no-auth combined with --auth-token", () => {
    expect(parseGlobalArgs(["--web-ui", "--auth-token", "s3cret", "--no-auth"])).toEqual({
      args: [],
      error: "--no-auth cannot be combined with --auth-token",
    });
  });

  it("parses --read-token and --read-only", () => {
    expect(parseGlobalArgs(["--web-ui", "--read-token", "viewer", "--read-only"])).toEqual({
      args: [],
      webUi: true,
      readToken: "viewer",
      readOnly: true,
    });
    expect(parseGlobalArgs(["--web-ui", "--auth-token", "full", "--read-token", "viewer"])).toEqual(
      {
        args: [],
        webUi: true,
        authToken: "full",
        readToken: "viewer",
      },
    );
  });

  it("rejects --no-auth with --read-token or --read-only", () => {
    expect(parseGlobalArgs(["--web-ui", "--read-token", "v", "--no-auth"])).toEqual({
      args: [],
      error: "--no-auth cannot be combined with --read-token",
    });
    expect(parseGlobalArgs(["--web-ui", "--read-only", "--no-auth"])).toEqual({
      args: [],
      error: "--no-auth cannot be combined with --read-only",
    });
  });

  it("rejects identical --auth-token and --read-token values", () => {
    expect(parseGlobalArgs(["--web-ui", "--auth-token", "same", "--read-token", "same"])).toEqual({
      args: [],
      error: "--auth-token and --read-token must be different values",
    });
  });

  it("parses --version and -v", () => {
    expect(parseGlobalArgs(["--version"])).toEqual({ args: [], version: true });
    expect(parseGlobalArgs(["-v"])).toEqual({ args: [], version: true });
  });

  it("documents --project-dir in help", async () => {
    const c = capture();
    const code = await runCli(["help"], c.io);
    expect(code).toBe(0);
    expect(c.stdout).toContain("--project-dir");
    expect(c.stdout).toContain("--cwd");
  });
});

describe("runCli", () => {
  it("lists workflows as the primary CLI surface", async () => {
    const c = capture();
    const code = await runCli(["workflows"], c.io);

    expect(code).toBe(0);
    expect(c.stdout).toContain("project ");
    expect(c.stdout).toContain("workflows");
    expect(c.stdout).toContain("multi-plan");
    expect(c.stdout).toContain("distributor");
  });

  it("lists workflows against --project-dir state root via io.cwd", async () => {
    const c = capture();
    writeFileSync(
      join(c.io.cwd!, "steamtrain.json"),
      JSON.stringify({ name: "alt-project", stepTimeoutSec: 60 }),
    );
    const code = await runCli(["workflow", "list"], c.io);
    expect(code).toBe(0);
    expect(c.stdout).toContain("alt-project");
  });

  it("validates bundled workflows", async () => {
    const c = capture();
    const code = await runCli(["workflow", "validate", "multi-plan"], c.io);

    expect(code).toBe(0);
    expect(c.stdout).toContain("ok  multi-plan");
    expect(c.stderr).toBe("");
  });

  it("reports unknown workflow validation failures", async () => {
    const c = capture();
    const code = await runCli(["workflow", "validate", "missing"], c.io);

    expect(code).toBe(1);
    expect(c.stderr).toContain("unknown workflow 'missing'");
    expect(c.stderr).toContain("workflow list");
  });

  it("suggests the nearest workflow name for a typo", async () => {
    const c = capture();
    const code = await runCli(["workflow", "run", "tuor", "--input", "hi"], c.io);

    expect(code).toBe(1);
    expect(c.stderr).toContain("unknown workflow 'tuor'");
    expect(c.stderr).toContain("did you mean 'tour'?");
  });

  it("suggests a prefix completion for a partial workflow name", async () => {
    const c = capture();
    const code = await runCli(["workflow", "plan", "bug", "--input", "hi"], c.io);

    expect(code).toBe(1);
    expect(c.stderr).toContain("did you mean 'bug-hunt'?");
  });

  it("plans a bundled workflow with --input", async () => {
    const c = capture();
    const code = await runCli(["workflow", "plan", "multi-plan", "--input", "add feature X"], c.io);

    expect(code).toBe(0);
    expect(c.stdout).toContain("plan: multi-plan");
    expect(c.stdout).toContain("phases");
    expect(c.stdout).toContain("steps");
    expect(c.stdout).toContain("planning-lenses");
  });

  it("plans a workflow with --json output", async () => {
    const c = capture();
    const code = await runCli(
      ["workflow", "plan", "multi-plan", "--input", "add feature X", "--json"],
      c.io,
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.phaseCount).toBeGreaterThan(0);
    expect(parsed.steps.length).toBeGreaterThan(0);
  });

  it("reports unknown workflow for plan", async () => {
    const c = capture();
    const code = await runCli(["workflow", "plan", "missing", "--input", "test"], c.io);

    expect(code).toBe(1);
    expect(c.stderr).toContain("unknown workflow 'missing'");
  });

  it("requires input for plan", async () => {
    const c = capture();
    const code = await runCli(["workflow", "plan", "multi-plan"], c.io);

    expect(code).toBe(1);
    expect(c.stderr).toContain("requires --input");
  });

  it("shows recorded-run cost context in the plan once history exists", async () => {
    const c = capture();
    await runCli(["workflow", "run", "tour", "--input", "all aboard"], c.io);
    const planned = capture();
    planned.io.cwd = c.io.cwd; // same repo → same .steamtrain/history
    const code = await runCli(["workflow", "plan", "tour", "--input", "all aboard"], planned.io);

    expect(code).toBe(0);
    expect(planned.stdout).toMatch(/history: 1 completed run · avg cost \$\d/);

    const json = capture();
    json.io.cwd = c.io.cwd;
    await runCli(["workflow", "plan", "tour", "--input", "all aboard", "--json"], json.io);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.history.runs).toBe(1);
  });

  it("treats run --dry-run as a plan (nothing executes, no history)", async () => {
    const c = capture();
    const code = await runCli(
      ["workflow", "run", "tour", "--input", "all aboard", "--dry-run", "--fresh"],
      c.io,
    );

    expect(code).toBe(0);
    expect(c.stdout).toContain("plan: tour");
    expect(c.stdout).not.toContain("workflow done");
    expect(existsSync(join(c.io.cwd, WORKFLOW_HISTORY_DIR))).toBe(false);
  });

  it("drops --on-approval and its value from a --dry-run", async () => {
    const c = capture();
    const code = await runCli(
      ["workflow", "run", "tour", "--input", "hi", "--dry-run", "--on-approval", "fail"],
      c.io,
    );

    expect(code).toBe(0);
    expect(c.stdout).toContain("plan: tour");
  });

  it("splitDryRunArgs walks flag/value pairs", () => {
    expect(splitDryRunArgs(["tour", "--input", "hi", "--dry-run", "--fresh", "--json"])).toEqual({
      isDryRun: true,
      planArgs: ["tour", "--input", "hi", "--json"],
    });
    // a value that looks like a flag stays a value
    expect(splitDryRunArgs(["tour", "--input", "--dry-run"])).toEqual({
      isDryRun: false,
      planArgs: ["tour", "--input", "--dry-run"],
    });
    // --param values that look like flags pass through; --on-approval is dropped with its value
    expect(
      splitDryRunArgs(["t", "--param", "k=--detach", "--on-approval", "fail", "--dry-run"]),
    ).toEqual({ isDryRun: true, planArgs: ["t", "--param", "k=--detach"] });
    // --agent passes THROUGH to the plan so the dry-run preview reflects the
    // re-route the real run would apply (it would otherwise show the blocked agent).
    expect(splitDryRunArgs(["t", "--input", "hi", "--agent", "claude", "--dry-run"])).toEqual({
      isDryRun: true,
      planArgs: ["t", "--input", "hi", "--agent", "claude"],
    });
  });

  it("treats flag-looking --input values as text in a --dry-run", async () => {
    const c = capture();
    const code = await runCli(
      ["workflow", "run", "tour", "--input", "--fresh", "--dry-run", "--json"],
      c.io,
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(c.stdout);
    expect(parsed.ok).toBe(true); // --json survived; input was "--fresh", not eaten
  });

  it("does not misread an --input value of '--dry-run' as the dry-run flag", async () => {
    const c = capture();
    const code = await runCli(["workflow", "run", "tour", "--input", "--dry-run"], c.io);

    expect(code).toBe(0);
    expect(c.stdout).toContain("workflow done"); // it really ran
    expect(c.stdout).not.toContain("plan: tour");
  });

  it("accepts --dry-run as alias for plan", async () => {
    const c = capture();
    const code = await runCli(
      ["workflow", "dry-run", "multi-plan", "--input", "add feature X"],
      c.io,
    );

    expect(code).toBe(0);
    expect(c.stdout).toContain("plan: multi-plan");
  });

  it("returns non-zero when a headless workflow run fails", async () => {
    const c = capture();
    writeFileSync(
      join(c.io.cwd, "steamtrain.json"),
      JSON.stringify({
        binaries: {
          claude: "/definitely/missing/claude",
          opencode: "/definitely/missing/opencode",
        },
        workflows: {
          "fail-gate": {
            phases: [
              {
                id: "gate",
                title: "Gate",
                steps: [
                  {
                    id: "gate",
                    kind: "gate",
                    condition: { contains: "pass" },
                    onFalse: "fail",
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    const code = await runCli(["workflow", "run", "fail-gate", "--input", "nope"], c.io);

    expect(code).toBe(1);
    expect(c.stdout).toContain("workflow failed");
  });

  const approveFlow = {
    name: "approve-flow",
    phases: [
      {
        id: "p1",
        title: "Split",
        steps: [{ id: "split", kind: "distributor", items: ["a", "b"] }],
      },
      {
        id: "p2",
        title: "Approve",
        steps: [{ id: "chk", kind: "approval", step: "split", dependsOn: ["split"] }],
      },
      {
        id: "p3",
        title: "Merge",
        steps: [
          {
            id: "out",
            kind: "consolidator",
            dependsOn: ["chk", "split"],
            prompt: "done: {{steps.split.output}}",
          },
        ],
      },
    ],
  };

  function writeApproveFlow(cwd: string): void {
    writeFileSync(
      join(cwd, "steamtrain.json"),
      JSON.stringify({ workflows: { "approve-flow": approveFlow } }),
    );
  }

  it("--approve-all approves every checkpoint and runs to completion", async () => {
    const c = capture();
    writeApproveFlow(c.io.cwd);
    const code = await runCli(
      ["workflow", "run", "approve-flow", "--input", "task", "--approve-all"],
      c.io,
    );
    expect(code).toBe(0);
    expect(c.stdout).toContain("approved");
    expect(c.stdout).toContain("done out");
  });

  it("--on-approval fail rejects and fails the run", async () => {
    const c = capture();
    writeApproveFlow(c.io.cwd);
    const code = await runCli(
      ["workflow", "run", "approve-flow", "--input", "task", "--on-approval", "fail"],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.stdout).toContain("rejected");
    expect(c.stdout).toContain("workflow failed");
  });

  it("warns and auto-rejects when no approval flag is passed", async () => {
    const c = capture();
    writeApproveFlow(c.io.cwd);
    await runCli(["workflow", "run", "approve-flow", "--input", "task"], c.io);
    expect(c.stderr).toContain("approval checkpoints");
    expect(c.stdout).toContain("rejected");
  });

  it("warns when a checkpoint is nested in a sub-workflow", async () => {
    const c = capture();
    // The parent has no top-level checkpoint; the advisory must still fire by
    // recursing into the named sub-workflow it calls.
    writeFileSync(
      join(c.io.cwd, "steamtrain.json"),
      JSON.stringify({
        workflows: {
          "approve-flow": approveFlow,
          parent: {
            name: "parent",
            phases: [
              {
                id: "p1",
                title: "Call",
                steps: [{ id: "child", kind: "workflow", workflow: "approve-flow" }],
              },
            ],
          },
        },
      }),
    );
    await runCli(["workflow", "run", "parent", "--input", "task"], c.io);
    expect(c.stderr).toContain("approval checkpoints");
  });

  it("rejects mutually exclusive --approve-all and --on-approval", async () => {
    const c = capture();
    writeApproveFlow(c.io.cwd);
    const code = await runCli(
      [
        "workflow",
        "run",
        "approve-flow",
        "--input",
        "task",
        "--approve-all",
        "--on-approval",
        "fail",
      ],
      c.io,
    );
    expect(code).toBe(1);
    expect(c.stderr).toContain("usage:");
  });

  it("clears all workflow caches", async () => {
    const c = capture();
    const cacheDir = join(c.io.cwd, WORKFLOW_CACHE_DIR);
    const key = workflowCacheKey(
      "multi-plan",
      "cached",
      c.io.cwd,
      BUNDLED_WORKFLOWS["multi-plan"]!,
    );
    await saveWorkflowCache(cacheDir, key, new Map());

    const code = await runCli(["workflow", "cache", "clear"], c.io);

    expect(code).toBe(0);
    expect(c.stdout).toContain("cleared all workflow caches");
    expect(existsSync(join(cacheDir, workflowCacheFileName(key)))).toBe(false);
  });

  it("clears a single workflow cache entry", async () => {
    const c = capture();
    const cacheDir = join(c.io.cwd, WORKFLOW_CACHE_DIR);
    const key = workflowCacheKey("multi-plan", "one", c.io.cwd, BUNDLED_WORKFLOWS["multi-plan"]!);
    const other = workflowCacheKey("bug-hunt", "two", c.io.cwd, BUNDLED_WORKFLOWS["bug-hunt"]!);
    await saveWorkflowCache(cacheDir, key, new Map());
    await saveWorkflowCache(cacheDir, other, new Map());

    const code = await runCli(["workflow", "cache", "clear", "multi-plan", "--input", "one"], c.io);

    expect(code).toBe(0);
    expect(c.stdout).toContain("cleared cache for workflow 'multi-plan'");
    expect(existsSync(join(cacheDir, workflowCacheFileName(key)))).toBe(false);
    expect(existsSync(join(cacheDir, workflowCacheFileName(other)))).toBe(true);
  });

  it("resumes a headless workflow run from disk cache", async () => {
    const c = capture();
    const agentless = {
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "split", kind: "distributor", items: ["alpha"] }],
        },
        {
          id: "gate",
          title: "Gate",
          steps: [
            {
              id: "gate",
              kind: "gate",
              dependsOn: ["split"],
              condition: { step: "split", contains: "alpha" },
            },
          ],
        },
        {
          id: "tail",
          title: "Tail",
          steps: [{ id: "tail", kind: "distributor", items: ["beta"] }],
        },
      ],
    };
    writeFileSync(
      join(c.io.cwd, "steamtrain.json"),
      JSON.stringify({ workflows: { agentless: agentless } }),
    );

    const first = await runCli(["workflow", "run", "agentless", "--input", "task"], c.io);
    expect(first).toBe(0);
    const afterFirst = c.stdout.length;

    const resumed = await runCli(["workflow", "run", "agentless", "--input", "task"], c.io);
    expect(resumed).toBe(0);
    expect(c.stdout.slice(afterFirst)).toContain("(cached)");
  });

  it("runs fresh after --fresh deletes the on-disk cache", async () => {
    const c = capture();
    const agentless = {
      name: "agentless",
      phases: [
        {
          id: "only",
          title: "Only",
          steps: [{ id: "split", kind: "distributor", items: ["one"] }],
        },
      ],
    };
    writeFileSync(
      join(c.io.cwd, "steamtrain.json"),
      JSON.stringify({ workflows: { agentless: agentless } }),
    );

    await runCli(["workflow", "run", "agentless", "--input", "task"], c.io);
    const cacheDir = join(c.io.cwd, WORKFLOW_CACHE_DIR);
    const key = workflowCacheKey("agentless", "task", c.io.cwd, agentless as never);
    expect(existsSync(join(cacheDir, workflowCacheFileName(key)))).toBe(true);

    const afterFirst = c.stdout.length;
    const code = await runCli(["workflow", "run", "agentless", "--input", "task", "--fresh"], c.io);
    expect(code).toBe(0);
    expect(c.stdout.slice(afterFirst)).not.toContain("(cached)");
  });

  it("prints a status summary at the end of an agentless run", async () => {
    const c = capture();
    const agentless = {
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "areas", kind: "distributor", items: ["a: {{input}}", "b"] }],
        },
        {
          id: "gate",
          title: "Gate",
          steps: [
            {
              id: "ready",
              kind: "gate",
              dependsOn: ["areas"],
              condition: { step: "areas", contains: "a:" },
              onFalse: "fail",
            },
          ],
        },
      ],
    };
    writeFileSync(
      join(c.io.cwd, "steamtrain.json"),
      JSON.stringify({ workflows: { agentless: agentless } }),
    );

    const code = await runCli(["workflow", "run", "agentless", "--input", "task"], c.io);
    expect(code).toBe(0);
    expect(c.stdout).toContain("summary");
    expect(c.stdout).toContain("ok   areas");
    expect(c.stdout).toContain("gate:passed");
    expect(c.stdout).toContain("2 ok");
  });

  it("records a run and lists/shows/clears it via workflow history", async () => {
    const c = capture();
    const agentless = {
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "areas", kind: "distributor", items: ["a: {{input}}", "b"] }],
        },
      ],
    };
    writeFileSync(
      join(c.io.cwd, "steamtrain.json"),
      JSON.stringify({ workflows: { agentless: agentless } }),
    );

    expect(await runCli(["workflow", "run", "agentless", "--input", "task"], c.io)).toBe(0);

    const list = capture();
    list.io.cwd = c.io.cwd;
    expect(await runCli(["workflow", "history"], list.io)).toBe(0);
    expect(list.stdout).toContain("run history (1)");
    expect(list.stdout).toContain("agentless");

    // Extract the run id from the list output and show it.
    const id = list.stdout.match(/ok\s+([0-9a-f-]{36})/)?.[1];
    expect(id).toBeTruthy();
    const show = capture();
    show.io.cwd = c.io.cwd;
    expect(await runCli(["workflow", "history", "show", id!], show.io)).toBe(0);
    expect(show.stdout).toContain("workflow: agentless");
    expect(show.stdout).toContain("phase 1: Split");

    const clear = capture();
    clear.io.cwd = c.io.cwd;
    expect(await runCli(["workflow", "history", "clear"], clear.io)).toBe(0);
    const empty = capture();
    empty.io.cwd = c.io.cwd;
    expect(await runCli(["workflow", "history"], empty.io)).toBe(0);
    expect(empty.stdout).toContain("no recorded runs");
  });

  it("re-runs a recorded run with --from (fresh, defaulting the input)", async () => {
    const c = capture();
    const agentless = {
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "areas", kind: "distributor", items: ["a: {{input}}", "b"] }],
        },
      ],
    };
    writeFileSync(
      join(c.io.cwd, "steamtrain.json"),
      JSON.stringify({ workflows: { agentless: agentless } }),
    );

    expect(await runCli(["workflow", "run", "agentless", "--input", "task"], c.io)).toBe(0);
    const id = latestRecordId(c.io.cwd);

    const rerun = capture();
    rerun.io.cwd = c.io.cwd;
    expect(await runCli(["workflow", "run", "--from", id], rerun.io)).toBe(0);
    // Ran the same workflow with the recorded input, and fresh (no cache replay).
    expect(rerun.stdout).toContain("workflow agentless started");
    expect(rerun.stdout).toContain("ok   areas");
    expect(rerun.stdout).not.toContain("(cached)");
  });

  it("retry-failed seeds succeeded steps from the record (replays as cached)", async () => {
    const c = capture();
    const agentless = {
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "areas", kind: "distributor", items: ["a: {{input}}", "b"] }],
        },
      ],
    };
    writeFileSync(
      join(c.io.cwd, "steamtrain.json"),
      JSON.stringify({ workflows: { agentless: agentless } }),
    );

    expect(await runCli(["workflow", "run", "agentless", "--input", "task"], c.io)).toBe(0);
    const id = latestRecordId(c.io.cwd);

    const retry = capture();
    retry.io.cwd = c.io.cwd;
    expect(await runCli(["workflow", "run", "--from", id, "--retry-failed"], retry.io)).toBe(0);
    // The successful step was seeded from the record, so it replays as cached.
    expect(retry.stdout).toContain("(cached)");
  });

  it("errors on --from with an unknown run id", async () => {
    const c = capture();
    writeFileSync(join(c.io.cwd, "steamtrain.json"), JSON.stringify({ workflows: {} }));
    const code = await runCli(["workflow", "run", "--from", "does-not-exist"], c.io);
    expect(code).toBe(1);
    expect(c.stderr).toContain("unknown run 'does-not-exist'");
  });

  it("rejects a positional name combined with --from", async () => {
    const c = capture();
    writeFileSync(join(c.io.cwd, "steamtrain.json"), JSON.stringify({ workflows: {} }));
    const code = await runCli(["workflow", "run", "agentless", "--from", "abc"], c.io);
    expect(code).toBe(1);
    expect(c.stderr).toContain("not both");
  });

  it("rejects --retry-failed without --from", async () => {
    const c = capture();
    writeFileSync(join(c.io.cwd, "steamtrain.json"), JSON.stringify({ workflows: {} }));
    const code = await runCli(["workflow", "run", "x", "--input", "y", "--retry-failed"], c.io);
    expect(code).toBe(1);
    expect(c.stderr).toContain("--retry-failed only applies with --from");
  });

  it("retry-failed with a changed --input downgrades to a fresh run (no stale replay)", async () => {
    const c = capture();
    const agentless = {
      phases: [
        {
          id: "split",
          title: "Split",
          steps: [{ id: "areas", kind: "distributor", items: ["a: {{input}}", "b"] }],
        },
      ],
    };
    writeFileSync(
      join(c.io.cwd, "steamtrain.json"),
      JSON.stringify({ workflows: { agentless: agentless } }),
    );

    expect(await runCli(["workflow", "run", "agentless", "--input", "task"], c.io)).toBe(0);
    const id = latestRecordId(c.io.cwd);

    const retry = capture();
    retry.io.cwd = c.io.cwd;
    const code = await runCli(
      ["workflow", "run", "--from", id, "--retry-failed", "--input", "different"],
      retry.io,
    );
    expect(code).toBe(0);
    // The input differs from the record, so the seed (computed for the old
    // input) must NOT be replayed — run fresh under the new input instead.
    expect(retry.stderr).toContain("input differs from the recorded run");
    expect(retry.stdout).not.toContain("(cached)");
  });

  it("requires a description for workflow create", async () => {
    const c = capture();
    const code = await runCli(["workflow", "create"], c.io);
    expect(code).toBe(1);
    expect(c.stderr).toContain("requires --input");
  });

  it("rejects an unknown agent for workflow create", async () => {
    const c = capture();
    const code = await runCli(["workflow", "create", "--input", "x", "--agent", "bogus"], c.io);
    expect(code).toBe(1);
    expect(c.stderr).toContain("usage: steamtrain workflow create");
  });

  it("tolerates corrupt on-disk cache files", async () => {
    const c = capture();
    const agentless = {
      phases: [
        {
          id: "only",
          title: "Only",
          steps: [{ id: "split", kind: "distributor", items: ["one"] }],
        },
      ],
    };
    writeFileSync(
      join(c.io.cwd, "steamtrain.json"),
      JSON.stringify({ workflows: { agentless: agentless } }),
    );
    const cacheDir = join(c.io.cwd, WORKFLOW_CACHE_DIR);
    const key = workflowCacheKey("agentless", "task", c.io.cwd, agentless as never);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, workflowCacheFileName(key)), "{ corrupt", "utf8");

    const code = await runCli(["workflow", "run", "agentless", "--input", "task"], c.io);
    expect(code).toBe(0);
    expect(c.stdout).not.toContain("(cached)");
  });
});
