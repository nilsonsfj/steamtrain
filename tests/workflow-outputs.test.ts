import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import {
  RunRecordBuilder,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  lintTemplateRefs,
  runTimestamp,
  runWorkflow,
  validateWorkflow,
  workflowReducer,
  workflowStateFromSpec,
  writeWorkflowOutputs,
} from "../src/workflow";
import { arrivalOutputLines, buildArrivalReport } from "../src/workflow/arrival-report";
import { BUNDLED_WORKFLOWS } from "../src/workflow/bundled";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "steamtrain-outputs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(extra: Partial<WorkflowDeps> = {}): WorkflowDeps {
  return {
    createAdapter: () => {
      throw new Error("this workflow must not create agent adapters");
    },
    maxConcurrency: 2,
    cwd: dir,
    ...extra,
  };
}

/** An agentless workflow whose `report` step renders its prompt as its output. */
function reportSpec(outputs: WorkflowSpec["outputs"], cmd = "true"): WorkflowSpec {
  return {
    name: "hunt",
    inputs: { scope: { default: "src" } },
    outputs,
    phases: [
      { id: "check", title: "Check", steps: [{ id: "check", kind: "command", cmd }] },
      {
        id: "report",
        title: "Report",
        steps: [
          {
            id: "report",
            kind: "consolidator",
            dependsOn: ["check"],
            prompt: "Findings for {{input}}",
          },
        ],
      },
    ],
  };
}

async function run(
  spec: WorkflowSpec,
  ctx: { outputPaths?: Record<string, string> } = {},
  extra: Partial<WorkflowDeps> = {},
  signal?: AbortSignal,
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const event of runWorkflow(
    spec,
    { input: "the parser", ...ctx },
    deps(extra),
    signal,
  )) {
    events.push(event);
  }
  return events;
}

function done(events: WorkflowEvent[]) {
  const last = events.at(-1);
  if (last?.kind !== "workflow_done") throw new Error("run did not finish");
  return last;
}

describe("workflow outputs: validation", () => {
  const withOutput = (output: NonNullable<WorkflowSpec["outputs"]>[string], name = "report") =>
    validateWorkflow(reportSpec({ [name]: output }));

  it("accepts an output with a value, and one with a templated relative path", () => {
    expect(withOutput({ value: "{{steps.report.output}}" }).ok).toBe(true);
    expect(
      withOutput({
        value: "{{steps.report.output}}",
        path: "reports/{{workflow}}/{{inputs.scope}}-{{run.timestamp}}.md",
      }).ok,
    ).toBe(true);
  });

  it.each([
    ["an absolute path", "/tmp/report.md", "must be relative"],
    ["a Windows drive path", "C:\\reports\\x.md", "must be relative"],
    ["a path that climbs out", "reports/../../x.md", "must not climb out"],
    ["a path into .git", ".git/hooks/pre-commit", "must not write into .git"],
    ["a step placeholder", "reports/{{steps.report.output}}.md", "uses '{{steps.report.output}}'"],
    ["an undeclared input", "reports/{{inputs.nope}}.md", "uses '{{inputs.nope}}'"],
  ])("rejects %s", (_name, path, message) => {
    const result = withOutput({ value: "x", path });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain(message);
  });

  it("rejects an output name that is not an identifier, and an empty value", () => {
    const named = withOutput({ value: "x" }, "my report");
    expect(named.ok ? "" : named.error).toContain("output name 'my report'");
    expect(withOutput({ value: "" }).ok).toBe(false);
  });

  it("warns about an output that reads an unknown step, an undeclared input or a fan-out item", () => {
    const warnings = lintTemplateRefs(
      reportSpec({
        a: { value: "{{steps.nope.output}}" },
        b: { value: "{{inputs.missing}}" },
        c: { value: "{{item}}" },
        d: { value: "{{steps.report.output}} for {{inputs.scope}}" },
      }),
    );
    expect(warnings).toEqual([
      "output 'a' references unknown step 'nope'",
      "output 'b' references undeclared input 'missing'",
      "output 'c' uses '{{item}}', which has no value once the run ends",
    ]);
  });
});

describe("workflow outputs: a run writes them", () => {
  it("writes an output to the default directory and reports where", async () => {
    const events = await run(reportSpec({ report: { value: "{{steps.report.output}}" } }));
    const { outputs } = done(events);
    const started = events[0]?.kind === "workflow_start" ? events[0].ts : 0;
    expect(outputs).toHaveLength(1);
    const [report] = outputs ?? [];
    expect(report?.written).toBe(true);
    expect(report?.path).toBe(
      join(
        dir,
        ".steamtrain/outputs/hunt",
        runTimestamp(new Date(report ? started : 0)),
        "report.md",
      ),
    );
    expect(await readFile(report?.path ?? "", "utf8")).toBe("Findings for the parser\n");
    expect(report?.bytes).toBe("Findings for the parser\n".length);
  });

  it("writes to a spec path, with each input filling one segment", async () => {
    const spec = reportSpec({
      report: { value: "{{steps.report.output}}", path: "reports/{{inputs.scope}}.md" },
    });
    const events: WorkflowEvent[] = [];
    for await (const event of runWorkflow(
      spec,
      { input: "x", inputs: { scope: "../../etc/passwd" } },
      deps(),
    )) {
      events.push(event);
    }
    const [report] = done(events).outputs ?? [];
    expect(report?.written).toBe(true);
    expect(report?.path).toBe(join(dir, "reports", ".._.._etc_passwd.md"));
  });

  it("writes to the path a run chose, even outside the directory", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "steamtrain-outputs-elsewhere-"));
    try {
      const target = join(elsewhere, "bugs.md");
      const events = await run(reportSpec({ report: { value: "{{steps.report.output}}" } }), {
        outputPaths: { report: target },
      });
      expect(done(events).outputs?.[0]).toMatchObject({ written: true, path: target });
      expect(await readFile(target, "utf8")).toBe("Findings for the parser\n");
      // Nothing was claimed in the default directory for it.
      await expect(readdir(join(dir, ".steamtrain"))).rejects.toThrow();
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("does not write an output whose step failed, and says which step", async () => {
    const events = await run(
      reportSpec({ log: { value: "{{steps.check.output}}" }, report: { value: "done" } }, "exit 3"),
    );
    const outputs = done(events).outputs ?? [];
    expect(outputs[0]).toMatchObject({ key: "log", written: false, error: "step 'check' failed" });
    // An output that reads no step is still written.
    expect(outputs[1]).toMatchObject({ key: "report", written: true });
  });

  it("writes nothing for a canceled run", async () => {
    const ac = new AbortController();
    ac.abort();
    const events = await run(
      reportSpec({ report: { value: "{{steps.report.output}}" } }),
      {},
      {},
      ac.signal,
    );
    expect(done(events).outputs).toEqual([
      { key: "report", written: false, error: "the run was canceled" },
    ]);
    await expect(readdir(join(dir, ".steamtrain"))).rejects.toThrow();
  });

  it("does not write a sub-workflow's outputs, only the outer run's", async () => {
    const child = reportSpec({ childReport: { value: "{{steps.report.output}}" } });
    const parent: WorkflowSpec = {
      name: "outer",
      outputs: { summary: { value: "{{steps.call.output}}" } },
      phases: [
        { id: "p", title: "P", steps: [{ id: "call", kind: "workflow", workflow: "hunt" }] },
      ],
    };
    const events = await run(
      parent,
      {},
      { resolveWorkflow: (name) => (name === "hunt" ? child : undefined) },
    );
    expect(done(events).outputs?.map((o) => o.key)).toEqual(["summary"]);
    expect(await readdir(join(dir, ".steamtrain/outputs"))).toEqual(["outer"]);
  });

  it("omits outputs from a workflow that declares none", async () => {
    expect(done(await run(reportSpec(undefined))).outputs).toBeUndefined();
  });
});

describe("workflow outputs: writing", () => {
  const context = { input: "x", outputs: new Map([["report", "body"]]) };
  const results = new Map([["report", { ok: true }]]);
  const spec = (path?: string): WorkflowSpec => ({
    name: "hunt",
    outputs: { report: { value: "{{steps.report.output}}", path } },
    phases: [],
  });

  it("gives a second run that starts in the same second its own directory", async () => {
    const startedAt = Date.now();
    const first = await writeWorkflowOutputs(spec(), { cwd: dir, startedAt, context, results });
    const second = await writeWorkflowOutputs(spec(), { cwd: dir, startedAt, context, results });
    expect(second[0]?.path).toBe(
      `${(first[0]?.path ?? "").replace(/[/\\]report\.md$/, "")}-2/report.md`,
    );
  });

  it("refuses a spec path that a symlinked directory would carry out", async () => {
    const outside = await mkdtemp(join(tmpdir(), "steamtrain-outputs-outside-"));
    try {
      await symlink(outside, join(dir, "reports"));
      const [report] = await writeWorkflowOutputs(spec("reports/x.md"), {
        cwd: dir,
        startedAt: Date.now(),
        context,
        results,
      });
      expect(report?.written).toBe(false);
      expect(report?.error).toContain("refusing to write outside");
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses to write through a symlink at the file itself", async () => {
    const outside = join(await mkdtemp(join(tmpdir(), "steamtrain-outputs-outside-")), "target");
    try {
      await writeFile(outside, "keep");
      await mkdir(join(dir, "reports"));
      await symlink(outside, join(dir, "reports", "x.md"));
      const [report] = await writeWorkflowOutputs(spec("reports/x.md"), {
        cwd: dir,
        startedAt: Date.now(),
        context,
        results,
      });
      expect(report?.written).toBe(false);
      expect(await readFile(outside, "utf8")).toBe("keep");
    } finally {
      await rm(join(outside, ".."), { recursive: true, force: true });
    }
  });

  it("reports a skipped or missing step by name", async () => {
    const skipped = await writeWorkflowOutputs(spec(), {
      cwd: dir,
      startedAt: Date.now(),
      context,
      results: new Map([["report", { ok: true, skipped: true }]]),
    });
    expect(skipped[0]?.error).toBe("step 'report' was skipped");
    const missing = await writeWorkflowOutputs(spec(), {
      cwd: dir,
      startedAt: Date.now(),
      context,
      results: new Map(),
    });
    expect(missing[0]?.error).toBe("step 'report' did not run");
  });
});

describe("workflow outputs: the CLI", () => {
  const spec = {
    outputs: { report: { value: "{{steps.report.output}}" } },
    phases: [
      { id: "split", title: "Split", steps: [{ id: "split", kind: "distributor", items: ["a"] }] },
      {
        id: "report",
        title: "Report",
        steps: [
          {
            id: "report",
            kind: "consolidator",
            dependsOn: ["split"],
            prompt: "Report on {{input}}",
          },
        ],
      },
    ],
  };

  async function cli(args: string[]) {
    let stdout = "";
    let stderr = "";
    await writeFile(join(dir, "steamtrain.json"), JSON.stringify({ workflows: { outs: spec } }));
    const code = await runCli(["workflow", "run", "outs", "--input", "the parser", ...args], {
      cwd: dir,
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    });
    return { code, stdout, stderr };
  }

  it("says where each output was saved, and records it in history", async () => {
    const { code, stdout } = await cli([]);
    expect(code).toBe(0);
    const saved = /saved report → (\S+)/.exec(stdout)?.[1] ?? "";
    expect(saved).toMatch(/^\.steamtrain\/outputs\/outs\/[\d_-]+\/report\.md$/);
    expect(await readFile(join(dir, saved), "utf8")).toBe("Report on the parser\n");

    const history = await runCliText(["workflow", "history"]);
    const id = /\b([0-9a-f-]{36})\b/.exec(history)?.[1] ?? "";
    const shown = await runCliText(["workflow", "history", "show", id]);
    expect(shown).toContain(`output:   report → ${join(dir, saved)}`);
  });

  it("writes an output where --out sends it", async () => {
    const { code, stdout } = await cli(["--out", "report=notes/bugs.md"]);
    expect(code).toBe(0);
    expect(stdout).toContain("saved report → notes/bugs.md");
    expect(await readFile(join(dir, "notes/bugs.md"), "utf8")).toBe("Report on the parser\n");
  });

  it("refuses --out for an output the workflow does not declare", async () => {
    const { code, stderr } = await cli(["--out", "summary=x.md"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--out: 'outs' declares no output 'summary' (outputs: report)");
  });

  async function runCliText(args: string[]): Promise<string> {
    let stdout = "";
    await runCli(args, {
      cwd: dir,
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: () => {},
    });
    return stdout;
  }
});

describe("workflow outputs: where they show up", () => {
  it("lands in the run record, the reducer state and the arrival report", async () => {
    const spec = reportSpec({ report: { value: "{{steps.report.output}}" } });
    const events = await run(spec);
    const recorder = new RunRecordBuilder({
      id: "r1",
      workflow: "hunt",
      input: "the parser",
      cwd: dir,
    });
    for (const event of events) recorder.handle(event);
    const record = recorder.build({ status: "done" });
    expect(record.outputs?.[0]?.written).toBe(true);

    const state = events.reduce(
      (acc, event) => workflowReducer(acc, { type: "event", event }),
      workflowStateFromSpec(spec),
    );
    const report = buildArrivalReport(state);
    expect(report?.outputs).toEqual(record.outputs);
    const [line] = arrivalOutputLines(report?.outputs ?? [], dir);
    expect(line).toMatch(/^saved report → \.steamtrain\/outputs\/hunt\/[\d_-]+\/report\.md$/);
  });

  it("says why an output was not saved", () => {
    expect(
      arrivalOutputLines([{ key: "report", written: false, error: "step 'report' failed" }]),
    ).toEqual(["not saved report: step 'report' failed"]);
  });

  it("is declared on the bundled read-only workflows' reports", () => {
    for (const name of ["bug-hunt", "code-review"]) {
      const spec = BUNDLED_WORKFLOWS[name];
      expect(spec?.outputs?.report?.value).toBe("{{steps.report.output}}");
      expect(spec && lintTemplateRefs(spec).filter((w) => w.startsWith("output"))).toEqual([]);
    }
  });
});
