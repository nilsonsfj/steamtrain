import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
