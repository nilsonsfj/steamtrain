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
import { parseGlobalArgs, runCli } from "../src/cli";
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
});

describe("runCli", () => {
  it("lists workflows as the primary CLI surface", async () => {
    const c = capture();
    const code = await runCli(["workflows"], c.io);

    expect(code).toBe(0);
    expect(c.stdout).toContain("workflows");
    expect(c.stdout).toContain("multi-plan");
    expect(c.stdout).toContain("distributor");
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
