import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agents";
import type { SteamtrainConfig } from "../src/config";
import type { AgentEvent, AgentId } from "../src/types/events";
import { type WorkflowHost, WorkflowRunManager } from "../src/web/runs";
import { createWebServer } from "../src/web/server";
import {
  type LoadedWorkflowCatalog,
  type StepResult,
  WorkflowAuthor,
  type WorkflowCacheStore,
  type WorkflowEvent,
  type WorkflowSourceKind,
  type WorkflowSpec,
  loadWorkflowCatalog,
} from "../src/workflow";

const VALID_SPEC = {
  description: "Echo the input.",
  phases: [
    {
      id: "p1",
      title: "Phase 1",
      steps: [
        {
          id: "s1",
          kind: "worker",
          agent: "opencode",
          model: "opencode/mimo-v2.5-free",
          prompt: "Do {{input}}",
        },
      ],
    },
  ],
};

function userFileSpec(name: string): WorkflowSpec {
  return { name, ...VALID_SPEC } as WorkflowSpec;
}

/** First step of a spec as a loose record (the union type hides `model`/`prompt`). */
function firstStep(spec: WorkflowSpec | undefined): Record<string, unknown> {
  return (spec?.phases[0]?.steps[0] ?? {}) as Record<string, unknown>;
}

/** Adapter that emits a fenced JSON workflow then a clean result. */
function jsonAdapter(spec: unknown): (id: AgentId) => AgentAdapter {
  const events: AgentEvent[] = [
    { kind: "text_delta", agent: "opencode", ts: 0, text: "```json\n" },
    { kind: "text_delta", agent: "opencode", ts: 0, text: JSON.stringify(spec) },
    { kind: "text_delta", agent: "opencode", ts: 0, text: "\n```" },
    { kind: "result", agent: "opencode", ts: 0, isError: false, text: "" },
  ];
  return (id: AgentId) => ({
    id,
    binary: "fake",
    run(_opts: AgentRunOptions): AsyncIterable<AgentEvent> {
      return (async function* () {
        for (const e of events) {
          await Promise.resolve();
          yield e;
        }
      })();
    },
  });
}

/** A host that is both a WorkflowHost (runs) and an AuthoringHost. */
class FakeHost implements WorkflowHost {
  private catalog: LoadedWorkflowCatalog;
  constructor(
    private readonly home: string,
    private readonly projectWorkflows?: Record<string, WorkflowSpec>,
    public healthy = true,
  ) {
    this.catalog = loadWorkflowCatalog({ home, projectWorkflows });
  }
  listWorkflows(): Record<string, WorkflowSpec> {
    return this.catalog.workflows;
  }
  workflowSource(name: string): WorkflowSourceKind | undefined {
    return this.catalog.sources[name];
  }
  isAgentHealthy(): boolean {
    return this.healthy;
  }
  setCatalog(catalog: LoadedWorkflowCatalog): void {
    this.catalog = catalog;
  }
  canDispatchWorkflowSpec(): { ok: true } | { ok: false; reason: string } {
    return { ok: true };
  }
  runWorkflow(): AsyncIterable<WorkflowEvent> {
    return (async function* () {})();
  }
}

const config: SteamtrainConfig = { timeoutMs: 1000 };

const noopStore: WorkflowCacheStore = {
  rootDir: "/tmp/none",
  async load() {
    return new Map<string, StepResult>();
  },
  async save() {},
  async clear() {},
  async clearAll() {},
};

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "steamtrain-author-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function makeAuthor(host: FakeHost, adapter?: (id: AgentId) => AgentAdapter) {
  return new WorkflowAuthor({
    host,
    config,
    home,
    cwd: home,
    createAdapter: adapter ?? jsonAdapter(VALID_SPEC),
  });
}

describe("WorkflowAuthor", () => {
  it("exposes agent metadata with models, efforts, and health", () => {
    const host = new FakeHost(home);
    const meta = makeAuthor(host).agentMeta();
    const opencode = meta.find((m) => m.id === "opencode");
    expect(opencode).toBeTruthy();
    expect(opencode!.models.length).toBeGreaterThan(0);
    expect(opencode!.defaultModel).toContain("opencode/");
    expect(opencode!.healthy).toBe(true);
    // Claude models carry effort levels.
    const claude = meta.find((m) => m.id === "claude");
    expect(claude!.models.some((m) => m.efforts.length > 0)).toBe(true);
  });

  it("saves a hand-edited spec to the user file and live catalog", () => {
    const host = new FakeHost(home);
    const author = makeAuthor(host);
    const result = author.save("My Flow", userFileSpec("My Flow"));
    expect(result.ok).toBe(true);
    expect(result.name).toBe("my-flow");
    expect(host.workflowSource("my-flow")).toBe("user");
    const onDisk = JSON.parse(readFileSync(join(home, ".steamtrain", "workflows.json"), "utf8"));
    expect(onDisk.workflows["my-flow"]).toBeTruthy();
  });

  it("rejects an invalid spec", () => {
    const host = new FakeHost(home);
    const result = makeAuthor(host).save("broken", { name: "broken", phases: [] } as WorkflowSpec);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("generates, validates, and persists a workflow via the agent", async () => {
    const host = new FakeHost(home);
    const author = makeAuthor(host);
    const deltas: string[] = [];
    const result = await author.generate(
      {
        description: "echo things",
        agent: "opencode",
        model: "opencode/mimo-v2.5-free",
        name: "Echo",
      },
      (t) => deltas.push(t),
    );
    expect(result.ok).toBe(true);
    expect(result.name).toBe("echo");
    expect(deltas.join("")).toContain("phases");
    expect(host.workflowSource("echo")).toBe("user");
  });

  it("refuses to generate with an unhealthy agent", async () => {
    const host = new FakeHost(home, undefined, false);
    const result = await makeAuthor(host).generate({
      description: "x",
      agent: "opencode",
      model: "opencode/mimo-v2.5-free",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not available/i);
  });

  it("removes a user workflow but refuses bundled ones", () => {
    const host = new FakeHost(home);
    const author = makeAuthor(host);
    author.save("temp", userFileSpec("temp"));
    expect(host.workflowSource("temp")).toBe("user");

    const removed = author.remove("temp");
    expect(removed.ok).toBe(true);
    expect(removed.removed).toBe(true);
    expect(host.workflowSource("temp")).toBeUndefined();

    const bundled = author.remove("bug-hunt");
    expect(bundled.ok).toBe(false);
    expect(bundled.error).toMatch(/cannot be deleted/i);
  });

  it("renames by dropping the previous user entry", () => {
    const host = new FakeHost(home);
    const author = makeAuthor(host);
    author.save("old-name", userFileSpec("old-name"));
    const result = author.save("new-name", userFileSpec("new-name"), "old-name");
    expect(result.ok).toBe(true);
    expect(host.workflowSource("new-name")).toBe("user");
    expect(host.workflowSource("old-name")).toBeUndefined();
  });

  it("clones a bundled workflow into a user copy, leaving the source intact", () => {
    const host = new FakeHost(home);
    const author = makeAuthor(host);
    const result = author.clone("bug-hunt", "My Bug Hunt");
    expect(result.ok).toBe(true);
    expect(result.name).toBe("my-bug-hunt");
    expect(host.workflowSource("my-bug-hunt")).toBe("user");
    // Original is untouched.
    expect(host.workflowSource("bug-hunt")).toBe("bundled");
  });

  it("refuses to clone an unknown workflow or onto the same name", () => {
    const host = new FakeHost(home);
    const author = makeAuthor(host);
    expect(author.clone("nope", "x").ok).toBe(false);
    expect(author.clone("bug-hunt", "bug-hunt").error).toMatch(/different name/i);
  });

  it("refuses to clone onto an existing workflow rather than clobbering it", () => {
    const host = new FakeHost(home);
    const author = makeAuthor(host);
    author.save("keep-me", userFileSpec("keep-me"));
    // Cloning onto an existing user workflow must fail...
    const ontoUser = author.clone("bug-hunt", "keep-me");
    expect(ontoUser.ok).toBe(false);
    expect(ontoUser.error).toMatch(/already exists/i);
    // ...and the existing workflow is left intact.
    expect(host.workflowSource("keep-me")).toBe("user");
    // Cloning onto a bundled name is likewise refused (no silent shadow).
    const ontoBundled = author.clone("keep-me", "bug-hunt");
    expect(ontoBundled.ok).toBe(false);
    expect(ontoBundled.error).toMatch(/already exists/i);
    expect(host.workflowSource("bug-hunt")).toBe("bundled");
  });

  it("saves a hand-edited spec to the project layer (steamtrain.json)", () => {
    const host = new FakeHost(home);
    const author = makeAuthor(host);
    const result = author.save("Proj Flow", userFileSpec("Proj Flow"), undefined, "project");
    expect(result.ok).toBe(true);
    expect(result.source).toBe("project");
    expect(host.workflowSource("proj-flow")).toBe("project");
    // cwd is `home` in the fake, so the project config lives there.
    const cfg = JSON.parse(readFileSync(join(home, "steamtrain.json"), "utf8"));
    expect(cfg.workflows["proj-flow"]).toBeTruthy();
  });

  it("generates into the project layer when scoped to project", async () => {
    const host = new FakeHost(home);
    const result = await makeAuthor(host).generate({
      description: "echo things",
      agent: "opencode",
      model: "opencode/mimo-v2.5-free",
      name: "ProjEcho",
      scope: "project",
    });
    expect(result.ok).toBe(true);
    expect(result.source).toBe("project");
    expect(host.workflowSource("projecho")).toBe("project");
  });

  it("clones into the project layer and removes a project workflow", () => {
    const host = new FakeHost(home);
    const author = makeAuthor(host);
    const cloned = author.clone("bug-hunt", "Team Bug Hunt", "project");
    expect(cloned.ok).toBe(true);
    expect(host.workflowSource("team-bug-hunt")).toBe("project");
    expect(host.workflowSource("bug-hunt")).toBe("bundled");

    const removed = author.remove("team-bug-hunt");
    expect(removed.ok).toBe(true);
    expect(removed.removed).toBe(true);
    expect(host.workflowSource("team-bug-hunt")).toBeUndefined();
  });

  it("writes project workflows to an explicit projectConfigPath (honors --config-file)", () => {
    const host = new FakeHost(home);
    // A config path that is NOT <cwd>/steamtrain.json, mirroring `--config-file`.
    const customPath = join(home, "nested", "custom.steamtrain.json");
    const author = new WorkflowAuthor({
      host,
      config,
      home,
      cwd: home,
      projectConfigPath: customPath,
      createAdapter: jsonAdapter(VALID_SPEC),
    });

    const result = author.save("custom-proj", userFileSpec("custom-proj"), undefined, "project");
    expect(result.ok).toBe(true);
    expect(result.savedPath).toBe(customPath);
    expect(host.workflowSource("custom-proj")).toBe("project");
    // The default cwd location was NOT touched.
    expect(existsSync(join(home, "steamtrain.json"))).toBe(false);
    const onDisk = JSON.parse(readFileSync(customPath, "utf8"));
    expect(onDisk.workflows["custom-proj"]).toBeTruthy();
  });

  it("renaming a project workflow drops the old project entry (no duplicate)", () => {
    const host = new FakeHost(home);
    const author = makeAuthor(host);
    author.save("proj-old", userFileSpec("proj-old"), undefined, "project");
    expect(host.workflowSource("proj-old")).toBe("project");

    const renamed = author.save("proj-new", userFileSpec("proj-new"), "proj-old", "project");
    expect(renamed.ok).toBe(true);
    expect(host.workflowSource("proj-new")).toBe("project");
    expect(host.workflowSource("proj-old")).toBeUndefined();
  });

  it("removing the last project workflow leaves zero project entries after reload", () => {
    const host = new FakeHost(home);
    const author = makeAuthor(host);
    author.save("only-proj", userFileSpec("only-proj"), undefined, "project");
    expect(host.workflowSource("only-proj")).toBe("project");

    // remove() reloads from disk; the steamtrain.json still exists (now with an
    // empty workflows map), so the deletion must not be resurrected.
    const removed = author.remove("only-proj");
    expect(removed.ok).toBe(true);
    expect(host.workflowSource("only-proj")).toBeUndefined();
    // No catalog entry remains project-sourced.
    const projectNames = Object.keys(host.listWorkflows()).filter(
      (name) => host.workflowSource(name) === "project",
    );
    expect(projectNames).toEqual([]);
  });

  it("previews a workflow with staged step overrides without saving", () => {
    const host = new FakeHost(home);
    const author = makeAuthor(host);
    author.save("flow", userFileSpec("flow"));
    const preview = author.previewWithOverrides("flow", { s1: { model: "opencode/other" } });
    expect(firstStep(preview).model).toBe("opencode/other");
    // Disk is unchanged: re-reading still has the original model.
    const onDisk = JSON.parse(
      readFileSync(join(home, ".steamtrain", "workflows.json"), "utf8"),
    ) as { workflows: Record<string, WorkflowSpec> };
    expect(firstStep(onDisk.workflows.flow).model).toBe("opencode/mimo-v2.5-free");
  });

  it("flushes staged overrides, reporting saved and unchanged", () => {
    const host = new FakeHost(home);
    const author = makeAuthor(host);
    author.save("flow", userFileSpec("flow"));

    const saved = author.flushSessionOverrides({ flow: { s1: { model: "opencode/changed" } } });
    expect(saved.saved).toEqual(["flow"]);
    expect(firstStep(host.listWorkflows().flow).model).toBe("opencode/changed");

    // Re-flushing the identical override is a no-op (unchanged).
    const again = author.flushSessionOverrides({ flow: { s1: { model: "opencode/changed" } } });
    expect(again.saved).toEqual([]);
    expect(again.unchanged).toEqual(["flow"]);
  });
});

// ---- HTTP routes ----------------------------------------------------------

const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function makeServer(host: FakeHost, adapter?: (id: AgentId) => AgentAdapter): Server {
  const runs = new WorkflowRunManager({ host, cacheStore: noopStore, cwd: home });
  const server = createWebServer({
    host,
    runs,
    author: makeAuthor(host, adapter),
    workflowSource: (name) => host.workflowSource(name),
    doctor: () => [{ agent: "opencode", status: "ok", message: "ready" }] as never,
  });
  servers.push(server);
  return server;
}

async function start(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function readSse(res: Response): Promise<Record<string, unknown>[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames: Record<string, unknown>[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard SSE split
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) frames.push(JSON.parse(line.slice(6)));
    }
  }
  return frames;
}

describe("authoring HTTP routes", () => {
  it("serves agent metadata", async () => {
    const base = await start(makeServer(new FakeHost(home)));
    const res = await fetch(`${base}/api/meta`);
    const body = (await res.json()) as { agents: { id: string }[] };
    expect(body.agents.map((a) => a.id)).toContain("opencode");
  });

  it("streams generation and persists the workflow", async () => {
    const host = new FakeHost(home);
    const base = await start(makeServer(host));
    const res = await fetch(`${base}/api/workflows/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "echo", agent: "opencode", name: "Echo" }),
    });
    const frames = await readSse(res);
    expect(frames.some((f) => f.type === "delta")).toBe(true);
    const done = frames.find((f) => f.type === "done") as { ok: boolean; name: string };
    expect(done.ok).toBe(true);
    expect(done.name).toBe("echo");

    const list = await (await fetch(`${base}/api/workflows/echo`)).json();
    expect((list as { spec: { name: string } }).spec.name).toBe("echo");
  });

  it("saves edits via PUT and deletes via DELETE", async () => {
    const host = new FakeHost(home);
    const base = await start(makeServer(host));

    const put = await fetch(`${base}/api/workflows/edited`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec: userFileSpec("edited") }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { ok: boolean }).ok).toBe(true);
    expect(host.workflowSource("edited")).toBe("user");

    const del = await fetch(`${base}/api/workflows/edited`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(host.workflowSource("edited")).toBeUndefined();
  });

  it("round-trips a loop gate's loopTo/maxIterations through PUT and GET", async () => {
    const host = new FakeHost(home);
    const base = await start(makeServer(host));

    const loopSpec: WorkflowSpec = {
      name: "review-loop",
      phases: [
        {
          id: "review",
          title: "review",
          steps: [{ id: "r", agent: "opencode", model: "m", prompt: "review {{input}}" }],
        },
        {
          id: "fix",
          title: "fix",
          steps: [{ id: "f", agent: "opencode", model: "m", prompt: "fix {{steps.r.output}}" }],
        },
        {
          id: "check",
          title: "check",
          steps: [
            {
              id: "g",
              kind: "gate",
              dependsOn: ["f"],
              condition: { step: "f", contains: "DONE" },
              loopTo: "review",
              maxIterations: 4,
              onFalse: "fail",
            },
          ],
        },
      ],
    } as WorkflowSpec;

    const put = await fetch(`${base}/api/workflows/review-loop`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec: loopSpec }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { ok: boolean }).ok).toBe(true);

    const get = await fetch(`${base}/api/workflows/review-loop`);
    expect(get.status).toBe(200);
    const { spec } = (await get.json()) as { spec: WorkflowSpec };
    const gate = firstStep({ ...spec, phases: [spec.phases[2]!] } as WorkflowSpec);
    expect(gate.loopTo).toBe("review");
    expect(gate.maxIterations).toBe(4);
  });

  it("rejects deleting a bundled workflow", async () => {
    const base = await start(makeServer(new FakeHost(home)));
    const del = await fetch(`${base}/api/workflows/bug-hunt`, { method: "DELETE" });
    expect(del.status).toBe(400);
    expect(((await del.json()) as { error: string }).error).toMatch(/cannot be deleted/i);
  });

  it("501s authoring routes when no author is configured", async () => {
    const host = new FakeHost(home);
    const runs = new WorkflowRunManager({ host, cacheStore: noopStore, cwd: home });
    const server = createWebServer({ host, runs, workflowSource: (n) => host.workflowSource(n) });
    servers.push(server);
    const base = await start(server);
    const del = await fetch(`${base}/api/workflows/anything`, { method: "DELETE" });
    expect(del.status).toBe(501);
  });
});
