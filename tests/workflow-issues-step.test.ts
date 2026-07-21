import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { AgentEvent, AgentId } from "../src/types/events";
import {
  type StepResult,
  type WorkflowDeps,
  type WorkflowEvent,
  type WorkflowSpec,
  narrateEvent,
  runWorkflow,
  validateWorkflow,
  workflowStateFromSpec,
} from "../src/workflow";

/**
 * Building block 6 — the `issues` step: collects out-of-scope findings from
 * earlier steps' structured `json` output, dedupes them, and either renders a
 * report or files GitHub issues via a stubbed `gh`. Sources here are
 * deterministic `command`/`worker` steps (agentless where possible), matching
 * the repo's existing agentless test patterns.
 */

// ---------------------------------------------------------------------------
// Fake adapter plumbing (mirrors workflow-structured-output.test.ts)
// ---------------------------------------------------------------------------

type Script = (opts: AgentRunOptions) => AgentEvent[];

function makeDeps(script: Script, cwd = process.cwd()): WorkflowDeps {
  return {
    createAdapter: (id: AgentId): AgentAdapter => ({
      id,
      binary: "fake",
      defaultModel: "test",
      run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
        return (async function* () {
          for (const event of script(opts)) {
            await Promise.resolve();
            yield event;
          }
        })();
      },
    }),
    maxConcurrency: 4,
    cwd,
  };
}

async function collect(
  spec: WorkflowSpec,
  deps: WorkflowDeps,
  inputs?: Record<string, string | number | boolean>,
): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const ev of runWorkflow(spec, { input: "go", inputs }, deps)) events.push(ev);
  return events;
}

function doneResult(events: WorkflowEvent[], stepId: string): StepResult | undefined {
  const done = events.find((e) => e.kind === "step_done" && e.stepId === stepId);
  return done && done.kind === "step_done" ? done.result : undefined;
}

function workflowOk(events: WorkflowEvent[]): boolean {
  const done = events.find((ev) => ev.kind === "workflow_done");
  return done?.kind === "workflow_done" ? done.ok : false;
}

/** A `command` step that echoes fixed JSON as its structured output. */
function jsonCommandStep(id: string, json: unknown, dependsOn?: string[]) {
  return {
    id,
    kind: "command" as const,
    cmd: `echo '${JSON.stringify(json)}'`,
    dependsOn,
    output: { type: "object" as const },
  };
}

describe("issues step collection (report mode)", () => {
  it("collects findings from a single source's structured output", async () => {
    const spec: WorkflowSpec = {
      name: "single-source",
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [
            jsonCommandStep("scan", {
              findings: [{ title: "Leftover TODO", severity: "low", file: "src/a.ts", line: 12 }],
            }),
          ],
        },
        {
          id: "report",
          title: "Report",
          steps: [{ id: "report", kind: "issues", from: ["scan"], mode: "report" }],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
    );
    expect(workflowOk(events)).toBe(true);
    const result = doneResult(events, "report");
    expect(result?.ok).toBe(true);
    expect(result?.output).toContain("Leftover TODO");
    expect(result?.output).toContain("src/a.ts:12");
    expect((result?.json as { findings: unknown[] }).findings).toHaveLength(1);
  });

  it("collects findings from forEach fan-out children (descends into childResults)", async () => {
    const spec: WorkflowSpec = {
      name: "fan-out-source",
      phases: [
        {
          id: "plan",
          title: "Plan",
          steps: [{ id: "plan", kind: "distributor", items: ["a", "b"] }],
        },
        {
          id: "streams",
          title: "Streams",
          steps: [
            {
              id: "streams",
              agent: "claude",
              model: "m",
              prompt: "go {{item}}",
              forEach: "steps.plan.items",
              output: { type: "object" as const },
            },
          ],
        },
        {
          id: "report",
          title: "Report",
          steps: [{ id: "report", kind: "issues", from: ["streams"], mode: "report" }],
        },
      ],
    };
    const script: Script = (opts) => {
      const item = /^go (\S)/.exec(opts.prompt)?.[1] ?? "?";
      return [
        {
          kind: "result",
          agent: "claude",
          ts: 0,
          isError: false,
          text: JSON.stringify({ findings: [{ title: `issue in ${item}` }] }),
        },
      ];
    };
    const events = await collect(spec, makeDeps(script));
    expect(workflowOk(events)).toBe(true);
    const result = doneResult(events, "report");
    const findings = (result?.json as { findings: { title: string; sourceStepId?: string }[] })
      .findings;
    expect(findings).toHaveLength(2);
    expect(result?.output).toContain("streams[0]");
    expect(result?.output).toContain("streams[1]");
  });

  it("treats plain strings in the findings array as titles", async () => {
    const spec: WorkflowSpec = {
      name: "string-findings",
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [jsonCommandStep("scan", { findings: ["Just a title", "Another title"] })],
        },
        {
          id: "report",
          title: "Report",
          steps: [{ id: "report", kind: "issues", from: ["scan"], mode: "report" }],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
    );
    const result = doneResult(events, "report");
    const findings = (result?.json as { findings: { title: string }[] }).findings;
    expect(findings.map((f) => f.title).sort()).toEqual(["Another title", "Just a title"]);
  });

  it("counts malformed finding items without failing the step", async () => {
    const spec: WorkflowSpec = {
      name: "malformed",
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [
            jsonCommandStep("scan", {
              findings: [{ body: "no title here" }, 123, null, { title: "ok" }],
            }),
          ],
        },
        {
          id: "report",
          title: "Report",
          steps: [{ id: "report", kind: "issues", from: ["scan"], mode: "report" }],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
    );
    const result = doneResult(events, "report");
    expect(result?.ok).toBe(true);
    const findings = (result?.json as { findings: { title: string }[] }).findings;
    expect(findings).toHaveLength(1);
    expect(result?.output).toContain("malformed");
  });

  it("reads a custom findingsPath", async () => {
    const spec: WorkflowSpec = {
      name: "custom-path",
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [jsonCommandStep("scan", { report: { items: [{ title: "nested finding" }] } })],
        },
        {
          id: "report",
          title: "Report",
          steps: [
            {
              id: "report",
              kind: "issues",
              from: ["scan"],
              findingsPath: "report.items",
              mode: "report",
            },
          ],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
    );
    const result = doneResult(events, "report");
    const findings = (result?.json as { findings: { title: string }[] }).findings;
    expect(findings).toEqual([expect.objectContaining({ title: "nested finding" })]);
  });

  it("dedupes findings across sources by normalized title + file", async () => {
    const spec: WorkflowSpec = {
      name: "dedupe",
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [
            jsonCommandStep("scan-a", {
              findings: [{ title: "Missing null check", file: "src/x.ts" }],
            }),
            jsonCommandStep("scan-b", {
              findings: [{ title: "missing NULL check", file: "SRC/X.TS" }],
            }),
          ],
        },
        {
          id: "report",
          title: "Report",
          steps: [{ id: "report", kind: "issues", from: ["scan-a", "scan-b"], mode: "report" }],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
    );
    const result = doneResult(events, "report");
    const findings = (result?.json as { findings: unknown[] }).findings;
    expect(findings).toHaveLength(1);
  });

  it("orders the report by severity: critical > high > medium > low > unknown", async () => {
    const spec: WorkflowSpec = {
      name: "severity-order",
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [
            jsonCommandStep("scan", {
              findings: [
                { title: "a low one", severity: "low" },
                { title: "a critical one", severity: "CRITICAL" },
                { title: "a weird one", severity: "wat" },
                { title: "a medium one", severity: "medium" },
                { title: "a high one", severity: "high" },
              ],
            }),
          ],
        },
        {
          id: "report",
          title: "Report",
          steps: [{ id: "report", kind: "issues", from: ["scan"], mode: "report" }],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
    );
    const output = doneResult(events, "report")?.output ?? "";
    const idx = (needle: string) => output.indexOf(needle);
    expect(idx("critical")).toBeGreaterThanOrEqual(0);
    expect(idx("critical")).toBeLessThan(idx("high"));
    expect(idx("high")).toBeLessThan(idx("medium"));
    expect(idx("medium")).toBeLessThan(idx("low"));
    expect(idx("low")).toBeLessThan(idx("wat"));
  });

  it("renders a friendly message and stays ok when there are no findings", async () => {
    const spec: WorkflowSpec = {
      name: "empty",
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [jsonCommandStep("scan", { findings: [] })],
        },
        {
          id: "report",
          title: "Report",
          steps: [{ id: "report", kind: "issues", from: ["scan"], mode: "report" }],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
    );
    const result = doneResult(events, "report");
    expect(result?.ok).toBe(true);
    expect(result?.output.toLowerCase()).toContain("no findings");
    expect((result?.json as { findings: unknown[] }).findings).toEqual([]);
  });
});

describe("issues step dependency semantics", () => {
  it("fails when a source leaf failed", async () => {
    const spec: WorkflowSpec = {
      name: "failed-source",
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [{ id: "scan", agent: "claude", model: "m", prompt: "boom" }],
        },
        {
          id: "report",
          title: "Report",
          steps: [{ id: "report", kind: "issues", from: ["scan"], mode: "report" }],
        },
      ],
    };
    const script: Script = () => [
      { kind: "result", agent: "claude", ts: 0, isError: true, text: "kaboom" },
    ];
    const events = await collect(spec, makeDeps(script));
    expect(workflowOk(events)).toBe(false);
    const result = doneResult(events, "report");
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("scan");
  });

  it("ignores a skipped source and collects from the rest", async () => {
    const spec: WorkflowSpec = {
      name: "skipped-source",
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [
            {
              ...jsonCommandStep("scan-skip", { findings: [{ title: "hidden" }] }),
              when: { value: "no", equals: "yes" },
            },
            jsonCommandStep("scan-keep", { findings: [{ title: "visible" }] }),
          ],
        },
        {
          id: "report",
          title: "Report",
          steps: [
            { id: "report", kind: "issues", from: ["scan-skip", "scan-keep"], mode: "report" },
          ],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
    );
    const result = doneResult(events, "report");
    expect(result?.ok).toBe(true);
    const findings = (result?.json as { findings: { title: string }[] }).findings;
    expect(findings.map((f) => f.title)).toEqual(["visible"]);
  });

  it("is itself skipped when every source was skipped (consolidator/merge semantics)", async () => {
    const spec: WorkflowSpec = {
      name: "all-skipped",
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [
            {
              ...jsonCommandStep("scan", { findings: [{ title: "hidden" }] }),
              when: { value: "no", equals: "yes" },
            },
          ],
        },
        {
          id: "report",
          title: "Report",
          steps: [{ id: "report", kind: "issues", from: ["scan"], mode: "report" }],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
    );
    expect(workflowOk(events)).toBe(true);
    const result = doneResult(events, "report");
    expect(result?.skipped).toBe(true);
    expect(result?.ok).toBe(true);
  });
});

describe("issues step mode template rendering", () => {
  it("renders mode from an input and validates after rendering", async () => {
    const spec: WorkflowSpec = {
      name: "templated-mode",
      inputs: { issueMode: { type: "string", default: "report" } },
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [jsonCommandStep("scan", { findings: [{ title: "x" }] })],
        },
        {
          id: "report",
          title: "Report",
          steps: [{ id: "report", kind: "issues", from: ["scan"], mode: "{{inputs.issueMode}}" }],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
      { issueMode: "report" },
    );
    expect(workflowOk(events)).toBe(true);
    expect(doneResult(events, "report")?.json).toMatchObject({ created: [], skippedExisting: [] });
  });

  it("fails clearly when the rendered mode is not report or github", async () => {
    const spec: WorkflowSpec = {
      name: "bad-mode",
      inputs: { issueMode: { type: "string", default: "bogus" } },
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [jsonCommandStep("scan", { findings: [] })],
        },
        {
          id: "report",
          title: "Report",
          steps: [{ id: "report", kind: "issues", from: ["scan"], mode: "{{inputs.issueMode}}" }],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
      { issueMode: "bogus" },
    );
    expect(workflowOk(events)).toBe(false);
    const result = doneResult(events, "report");
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("bogus");
  });
});

// ---------------------------------------------------------------------------
// GitHub mode — stubs `gh` on PATH (no real network / gh install needed)
// ---------------------------------------------------------------------------

const GH_STUB = `#!/bin/sh
if [ -n "$FAKE_GH_LOG" ]; then
  for a in "$@"; do printf '%s\\n' "$a" >> "$FAKE_GH_LOG"; done
  printf -- '--END--\\n' >> "$FAKE_GH_LOG"
fi
if [ -n "$FAKE_GH_FAIL" ]; then
  echo "\${FAKE_GH_FAIL_MSG:-gh: authentication required}" >&2
  exit 1
fi
if [ "$1" = "issue" ] && [ "$2" = "list" ]; then
  printf '%s' "\${FAKE_GH_EXISTING:-[]}"
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  N=$$
  echo "https://github.com/example/repo/issues/$N"
  exit 0
fi
exit 0
`;

interface GhStub {
  dir: string;
  logFile: string;
  originalPath: string;
  originalLog: string | undefined;
  originalExisting: string | undefined;
  originalFail: string | undefined;
  originalFailMsg: string | undefined;
}

function installGhStub(): GhStub {
  const dir = mkdtempSync(join(tmpdir(), "steamtrain-fake-gh-"));
  const binPath = join(dir, "gh");
  writeFileSync(binPath, GH_STUB);
  chmodSync(binPath, 0o755);
  const logFile = join(dir, "log.txt");
  writeFileSync(logFile, "");
  const originalPath = process.env.PATH ?? "";
  const originalLog = process.env.FAKE_GH_LOG;
  const originalExisting = process.env.FAKE_GH_EXISTING;
  const originalFail = process.env.FAKE_GH_FAIL;
  const originalFailMsg = process.env.FAKE_GH_FAIL_MSG;
  process.env.PATH = `${dir}:${originalPath}`;
  process.env.FAKE_GH_LOG = logFile;
  return {
    dir,
    logFile,
    originalPath,
    originalLog,
    originalExisting,
    originalFail,
    originalFailMsg,
  };
}

function restoreGhStub(stub: GhStub): void {
  process.env.PATH = stub.originalPath;
  setOrDelete("FAKE_GH_LOG", stub.originalLog);
  setOrDelete("FAKE_GH_EXISTING", stub.originalExisting);
  setOrDelete("FAKE_GH_FAIL", stub.originalFail);
  setOrDelete("FAKE_GH_FAIL_MSG", stub.originalFailMsg);
}

function setOrDelete(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Parse the fake gh's log into one argv array per invocation. */
function readGhCalls(logFile: string): string[][] {
  const raw = readFileSync(logFile, "utf8");
  const chunks = raw.split("--END--\n").filter((c) => c.length > 0);
  return chunks.map((c) => c.split("\n").filter((l) => l.length > 0));
}

describe("issues step (github mode)", () => {
  let stub: GhStub | undefined;

  afterEach(() => {
    if (stub) restoreGhStub(stub);
    stub = undefined;
  });

  it("creates issues with titlePrefix, labels, and repo args", async () => {
    stub = installGhStub();
    const spec: WorkflowSpec = {
      name: "github-create",
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [jsonCommandStep("scan", { findings: [{ title: "Dangling pointer" }] })],
        },
        {
          id: "file",
          title: "File",
          steps: [
            {
              id: "file",
              kind: "issues",
              from: ["scan"],
              mode: "github",
              titlePrefix: "[mainline] ",
              labels: ["from-steamtrain", "bug"],
              repo: "owner/name",
            },
          ],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
    );
    expect(workflowOk(events)).toBe(true);
    const result = doneResult(events, "file");
    expect(result?.ok).toBe(true);
    const created = (result?.json as { created: { title: string; url: string }[] }).created;
    expect(created).toHaveLength(1);
    expect(created[0]?.title).toBe("[mainline] Dangling pointer");
    expect(created[0]?.url).toMatch(/^https:\/\/github\.com\//);

    const calls = readGhCalls(stub.logFile);
    const createCall = calls.find((argv) => argv[0] === "issue" && argv[1] === "create");
    expect(createCall).toBeDefined();
    expect(createCall).toContain("--title");
    expect(createCall).toContain("[mainline] Dangling pointer");
    expect(createCall).toContain("--label");
    expect(createCall).toContain("from-steamtrain");
    expect(createCall).toContain("bug");
    expect(createCall).toContain("-R");
    expect(createCall).toContain("owner/name");
  });

  it("skips an existing issue found via gh issue list", async () => {
    stub = installGhStub();
    process.env.FAKE_GH_EXISTING = JSON.stringify([{ number: 7, title: "Already filed" }]);
    const spec: WorkflowSpec = {
      name: "github-skip-existing",
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [jsonCommandStep("scan", { findings: [{ title: "Already filed" }] })],
        },
        {
          id: "file",
          title: "File",
          steps: [{ id: "file", kind: "issues", from: ["scan"], mode: "github" }],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
    );
    const result = doneResult(events, "file");
    expect(result?.ok).toBe(true);
    const json = result?.json as { created: unknown[]; skippedExisting: { title: string }[] };
    expect(json.created).toHaveLength(0);
    expect(json.skippedExisting).toEqual([{ title: "Already filed" }]);
    const calls = readGhCalls((stub as GhStub).logFile);
    expect(calls.some((argv) => argv[0] === "issue" && argv[1] === "create")).toBe(false);
  });

  it("truncates at the limit and reports how many were skipped", async () => {
    stub = installGhStub();
    const spec: WorkflowSpec = {
      name: "github-limit",
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [
            jsonCommandStep("scan", {
              findings: [{ title: "one" }, { title: "two" }, { title: "three" }],
            }),
          ],
        },
        {
          id: "file",
          title: "File",
          steps: [{ id: "file", kind: "issues", from: ["scan"], mode: "github", limit: 1 }],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
    );
    const result = doneResult(events, "file");
    expect(result?.ok).toBe(true);
    const json = result?.json as { created: unknown[] };
    expect(json.created).toHaveLength(1);
    expect(result?.output).toContain("truncated 2");
  });

  it("fails with copy-paste guidance when gh is missing from PATH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "steamtrain-empty-path-"));
    const originalPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      const spec: WorkflowSpec = {
        name: "github-missing-gh",
        phases: [
          {
            id: "scan",
            title: "Scan",
            steps: [jsonCommandStep("scan", { findings: [{ title: "x" }] })],
          },
          {
            id: "file",
            title: "File",
            steps: [{ id: "file", kind: "issues", from: ["scan"], mode: "github" }],
          },
        ],
      };
      const events = await collect(
        spec,
        makeDeps(() => []),
      );
      const result = doneResult(events, "file");
      expect(result?.ok).toBe(false);
      expect(result?.output).toContain("GitHub CLI");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("records noCache: true on a github-mode result (report mode does not)", async () => {
    stub = installGhStub();
    const spec: WorkflowSpec = {
      name: "github-nocache",
      phases: [
        {
          id: "scan",
          title: "Scan",
          steps: [jsonCommandStep("scan", { findings: [{ title: "x" }] })],
        },
        {
          id: "report",
          title: "Report",
          steps: [{ id: "report", kind: "issues", from: ["scan"], mode: "report" }],
        },
        {
          id: "file",
          title: "File",
          steps: [{ id: "file", kind: "issues", from: ["scan"], mode: "github" }],
        },
      ],
    };
    const events = await collect(
      spec,
      makeDeps(() => []),
    );
    expect(doneResult(events, "report")?.noCache).toBeUndefined();
    expect(doneResult(events, "file")?.noCache).toBe(true);
  });
});

describe("issues step spec validation", () => {
  const base: WorkflowSpec = {
    name: "v",
    phases: [{ id: "p1", title: "p1", steps: [{ id: "scan", kind: "command", cmd: "echo hi" }] }],
  };

  it("requires from or dependsOn", () => {
    const spec: WorkflowSpec = {
      ...base,
      phases: [...base.phases, { id: "p2", title: "p2", steps: [{ id: "i", kind: "issues" }] }],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("from or dependsOn");
  });

  it("accepts dependsOn as an implicit from", () => {
    const spec: WorkflowSpec = {
      ...base,
      phases: [
        ...base.phases,
        { id: "p2", title: "p2", steps: [{ id: "i", kind: "issues", dependsOn: ["scan"] }] },
      ],
    };
    expect(validateWorkflow(spec).ok).toBe(true);
  });

  it("rejects a non-positive or non-integer limit", () => {
    const zero: WorkflowSpec = {
      ...base,
      phases: [
        ...base.phases,
        {
          id: "p2",
          title: "p2",
          steps: [{ id: "i", kind: "issues", dependsOn: ["scan"], limit: 0 }],
        },
      ],
    };
    expect(validateWorkflow(zero).ok).toBe(false);

    const fractional: WorkflowSpec = {
      ...base,
      phases: [
        ...base.phases,
        {
          id: "p2",
          title: "p2",
          steps: [{ id: "i", kind: "issues", dependsOn: ["scan"], limit: 1.5 }],
        },
      ],
    };
    expect(validateWorkflow(fractional).ok).toBe(false);
  });

  it("rejects a from reference to a step in the same or a later phase", () => {
    const spec: WorkflowSpec = {
      name: "v",
      phases: [
        {
          id: "p1",
          title: "p1",
          steps: [{ id: "i", kind: "issues", from: ["later"] }],
        },
        { id: "p2", title: "p2", steps: [{ id: "later", kind: "command", cmd: "echo hi" }] },
      ],
    };
    const result = validateWorkflow(spec);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("issues step");
  });
});

describe("issues step does not crash generic step-kind surfaces", () => {
  const spec: WorkflowSpec = {
    name: "generic-surfaces",
    phases: [
      { id: "p1", title: "p1", steps: [{ id: "scan", kind: "command", cmd: "echo hi" }] },
      {
        id: "p2",
        title: "p2",
        steps: [{ id: "file-issues", kind: "issues", dependsOn: ["scan"], mode: "report" }],
      },
    ],
  };

  it("builds initial reducer state without crashing", () => {
    const state = workflowStateFromSpec(spec);
    const step = state.phases[1]?.steps[0];
    expect(step?.blockKind).toBe("issues");
  });

  it("narrateEvent produces text for an issues step_start without throwing", () => {
    const line = narrateEvent({
      kind: "step_start",
      phaseId: "p2",
      stepId: "file-issues",
      blockKind: "issues",
      dependsOn: ["scan"],
      iteration: 1,
      ts: 1,
    });
    expect(line?.text).toBeTruthy();
  });
});
