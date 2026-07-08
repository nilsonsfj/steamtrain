import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { DoctorResult } from "../src/doctor";
import { runInitCommand } from "../src/init";
import { validateWorkflow, workflowAgentIds } from "../src/workflow";
import type { WorkflowSpec } from "../src/workflow";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-init-cmd-"));
  tempRoots.push(dir);
  return dir;
}

function doctorResult(overrides: Partial<DoctorResult>): DoctorResult {
  return {
    category: "agent",
    agent: "claude",
    provider: "claude",
    status: "ok",
    binary: "claude",
    version: "1.0.0",
    message: "ready",
    ...overrides,
  };
}

interface RunResult {
  code: number;
  out: string;
  err: string;
}

async function runInit(
  cwd: string,
  args: string[],
  doctor: DoctorResult[],
  options: { stdin?: PassThrough; interactive?: boolean } = {},
): Promise<RunResult> {
  let out = "";
  let err = "";
  const code = await runInitCommand(
    args,
    {
      cwd,
      stdin: options.stdin,
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
    },
    { doctor: async () => doctor, interactive: options.interactive ?? false },
  );
  return { code, out, err };
}

async function readConfig(cwd: string): Promise<{ workflows?: Record<string, WorkflowSpec> }> {
  return JSON.parse(await readFile(join(cwd, "steamtrain.json"), "utf8"));
}

describe("steamtrain init", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("rejects unknown flags with usage", async () => {
    const cwd = await tempDir();
    const result = await runInit(cwd, ["--bogus"], []);
    expect(result.code).toBe(1);
    expect(result.err).toContain("usage: steamtrain init");
  });

  it("prints init-specific help for --help", async () => {
    const cwd = await tempDir();
    const result = await runInit(cwd, ["--help"], []);
    expect(result.code).toBe(0);
    expect(result.out).toContain("steamtrain init — get this repo ride-ready");
    expect(result.out).toContain("--yes");
    expect(result.out).toContain("workflow run tour");
  });

  it("reports agent readiness with fix hints and writes nothing for an empty repo", async () => {
    const cwd = await tempDir();
    const result = await runInit(
      cwd,
      [],
      [
        doctorResult({ agent: "claude", status: "ok", version: "2.1.0" }),
        doctorResult({
          agent: "opencode",
          provider: "opencode",
          status: "binary_missing",
          binary: "opencode",
          message: "'opencode' not found on PATH",
          detail: "Install OpenCode and ensure `opencode` is on PATH.",
          version: undefined,
        }),
      ],
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain("✓ claude");
    expect(result.out).toContain("ready (2.1.0)");
    expect(result.out).toContain("✗ opencode");
    expect(result.out).toContain("fix: Install OpenCode");
    expect(result.out).toContain("no test/lint commands detected");
    expect(result.out).toContain("workflow run tour");
    await expect(readFile(join(cwd, "steamtrain.json"), "utf8")).rejects.toThrow();
  });

  it("writes valid verify and implement-verified starters wired to detected commands", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", lint: "biome check" } }),
    );
    const result = await runInit(cwd, ["--yes"], [doctorResult({})]);
    expect(result.code).toBe(0);

    const config = await readConfig(cwd);
    const verify = { ...config.workflows?.verify, name: "verify" } as WorkflowSpec;
    const implement = {
      ...config.workflows?.["implement-verified"],
      name: "implement-verified",
    } as WorkflowSpec;

    expect(validateWorkflow(verify).ok).toBe(true);
    expect(workflowAgentIds(verify)).toEqual([]); // verify is agentless ($0)
    const verifyCmds = verify.phases[0]!.steps.map((step) => ("cmd" in step ? step.cmd : ""));
    expect(verifyCmds).toEqual(["npm run test", "npm run lint"]);

    expect(validateWorkflow(implement).ok).toBe(true);
    const testStep = implement.phases[1]!.steps[0]!;
    expect("cmd" in testStep && testStep.cmd).toBe("npm run test");
    expect("workspace" in testStep && testStep.workspace).toBe("inherit:impl");
    expect(workflowAgentIds(implement)).toEqual(["claude"]);
    expect(result.out).toContain("wrote 'verify', 'implement-verified'");
  });

  it("offers only the agentless verify starter when no agent is ready", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const result = await runInit(
      cwd,
      ["--yes"],
      [
        doctorResult({
          status: "not_authenticated",
          message: "not authenticated",
          detail: "Run /login.",
        }),
      ],
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain("No agent is ready yet");
    const config = await readConfig(cwd);
    expect(Object.keys(config.workflows ?? {})).toEqual(["verify"]);
  });

  it("merges into an existing steamtrain.json without touching other keys or same-named workflows", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const existing = {
      maxConcurrency: 3,
      workflows: {
        verify: {
          phases: [{ id: "p", title: "mine", steps: [{ id: "s", kind: "command", cmd: "true" }] }],
        },
      },
    };
    await writeFile(join(cwd, "steamtrain.json"), JSON.stringify(existing));

    const result = await runInit(cwd, ["--yes"], [doctorResult({})]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("'verify' already exists");

    const config = JSON.parse(await readFile(join(cwd, "steamtrain.json"), "utf8"));
    expect(config.maxConcurrency).toBe(3);
    expect(config.workflows.verify.phases[0].title).toBe("mine"); // untouched
    expect(config.workflows["implement-verified"]).toBeDefined();
  });

  it("refuses to touch a config file it cannot parse", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    await writeFile(join(cwd, "steamtrain.json"), "{ broken");
    const result = await runInit(cwd, ["--yes"], [doctorResult({})]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("could not update");
    expect(await readFile(join(cwd, "steamtrain.json"), "utf8")).toBe("{ broken");
  });

  it("prompts per starter when interactive, honoring y/n answers", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const stdin = new PassThrough();
    // Answer each prompt as it is printed (accept verify, decline
    // implement-verified) — no timers, so the test can't race the prompts.
    const answers: Record<string, string> = { verify: "y\n", "implement-verified": "n\n" };
    let out = "";
    const code = await runInitCommand(
      [],
      {
        cwd,
        stdin,
        stdout: (text) => {
          out += text;
          for (const [name, answer] of Object.entries(answers)) {
            if (text.includes(`add '${name}'`)) {
              delete answers[name];
              stdin.write(answer);
            }
          }
        },
        stderr: () => {},
      },
      { doctor: async () => [doctorResult({})], interactive: true },
    );
    expect(code).toBe(0);
    expect(out).toContain("add 'verify'");
    expect(out).toContain("add 'implement-verified'");
    const config = await readConfig(cwd);
    expect(Object.keys(config.workflows ?? {})).toEqual(["verify"]);
  });

  it("declines all offers in a non-interactive session without --yes", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    // interactive: false (the runInit default) models piped/CI stdin.
    const result = await runInit(cwd, [], [doctorResult({})]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("non-interactive session without --yes — nothing written");
    expect(result.out).toContain("re-run with --yes");
    await expect(readFile(join(cwd, "steamtrain.json"), "utf8")).rejects.toThrow();
  });

  it("answers both prompts from a single pre-written stdin chunk", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const stdin = new PassThrough();
    // Both answers pasted ahead in ONE chunk, before any prompt is printed:
    // accept verify, decline implement-verified. Line buffering must hand one
    // line to each question instead of misreading "y\nn" as a single answer.
    stdin.write("y\nn\n");
    const result = await runInit(cwd, [], [doctorResult({})], { stdin, interactive: true });
    expect(result.code).toBe(0);
    const config = await readConfig(cwd);
    expect(Object.keys(config.workflows ?? {})).toEqual(["verify"]);
  });

  it("reassembles an answer split across stdin chunks", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const stdin = new PassThrough();
    let sentFragments = false;
    let out = "";
    const code = await runInitCommand(
      [],
      {
        cwd,
        stdin,
        stdout: (text) => {
          out += text;
          if (text.includes("add 'verify'") && !sentFragments) {
            sentFragments = true;
            // "yes<Enter>" arrives one keystroke-ish fragment at a time.
            stdin.write("ye");
            setImmediate(() => stdin.write("s\nn\n"));
          }
        },
        stderr: () => {},
      },
      { doctor: async () => [doctorResult({})], interactive: true },
    );
    expect(code).toBe(0);
    expect(out).toContain("add 'implement-verified'");
    const config = await readConfig(cwd);
    expect(Object.keys(config.workflows ?? {})).toEqual(["verify"]);
  });

  it("writes nothing when every offer is declined", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const stdin = new PassThrough();
    let out = "";
    const code = await runInitCommand(
      [],
      {
        cwd,
        stdin,
        stdout: (text) => {
          out += text;
          if (text.includes("add '")) stdin.write("n\n");
        },
        stderr: () => {},
      },
      { doctor: async () => [doctorResult({})], interactive: true },
    );
    expect(code).toBe(0);
    expect(out).toContain("no starters added");
    await expect(readFile(join(cwd, "steamtrain.json"), "utf8")).rejects.toThrow();
  });

  it("declines a pending prompt instead of hanging when stdin closes", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const stdin = new PassThrough();
    const runPromise = runInit(cwd, [], [doctorResult({})], { stdin, interactive: true });
    stdin.destroy(); // stdin goes away before any answer arrives
    const result = await runPromise;
    expect(result.code).toBe(0);
    expect(result.out).toContain("no starters added");
    await expect(readFile(join(cwd, "steamtrain.json"), "utf8")).rejects.toThrow();
  });

  it("refuses to merge into a config whose 'workflows' key is not an object", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const broken = JSON.stringify({ maxConcurrency: 3, workflows: ["not", "a", "map"] });
    await writeFile(join(cwd, "steamtrain.json"), broken);
    const result = await runInit(cwd, ["--yes"], [doctorResult({})]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("'workflows' is not an object");
    expect(await readFile(join(cwd, "steamtrain.json"), "utf8")).toBe(broken); // untouched
  });
});
