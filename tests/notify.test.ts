import { describe, expect, it } from "vitest";
import {
  type NotifyEvent,
  type WorkflowEvent,
  createNotifier,
  notifyWorkflowEvent,
} from "../src/workflow";

interface SpawnCall {
  binary: string;
  args: string[];
}

function harness(platform: NodeJS.Platform = "linux") {
  const bells: string[] = [];
  const spawns: SpawnCall[] = [];
  const posts: { url: string; body: unknown }[] = [];
  const options = {
    bellStream: { write: (chunk: string) => bells.push(chunk) },
    spawnFn: ((binary: string, args: string[]) => {
      spawns.push({ binary, args });
      return { once: () => {}, unref: () => {} };
    }) as unknown as typeof import("node:child_process").spawn,
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("ok");
    }) as typeof fetch,
    platform,
  };
  return { bells, spawns, posts, options };
}

const event: NotifyEvent = {
  kind: "run-completed",
  workflow: "bug-hunt",
  runId: "r1",
  detail: "run done · $0.4200",
  costUsd: 0.42,
  ts: 1,
};

describe("createNotifier", () => {
  it("is a no-op without config or channels", () => {
    const { bells, spawns, posts, options } = harness();
    createNotifier(undefined, options).notify(event);
    createNotifier({}, options).notify(event);
    expect(bells).toHaveLength(0);
    expect(spawns).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(createNotifier(undefined, options).wants("run-completed")).toBe(false);
  });

  it("rings the bell, spawns notify-send on linux, and posts the webhook", () => {
    const { bells, spawns, posts, options } = harness("linux");
    const notifier = createNotifier(
      { bell: true, desktop: true, webhook: "https://hooks.example/x" },
      options,
    );
    expect(notifier.wants("run-completed")).toBe(true);
    notifier.notify(event);
    expect(bells).toEqual([""]);
    expect(spawns[0]).toMatchObject({ binary: "notify-send" });
    expect(spawns[0]!.args[0]).toContain("bug-hunt");
    expect(posts[0]!.url).toBe("https://hooks.example/x");
    expect(posts[0]!.body).toMatchObject({ kind: "run-completed", workflow: "bug-hunt" });
  });

  it("uses osascript on darwin and skips desktop on other platforms", () => {
    const mac = harness("darwin");
    createNotifier({ desktop: true }, mac.options).notify(event);
    expect(mac.spawns[0]!.binary).toBe("osascript");

    const win = harness("win32");
    createNotifier({ desktop: true, bell: true }, win.options).notify(event);
    expect(win.spawns).toHaveLength(0);
    expect(win.bells).toHaveLength(1); // the bell still fires
  });

  it("honors the events allowlist", () => {
    const { bells, options } = harness();
    const notifier = createNotifier({ bell: true, events: ["run-failed"] }, options);
    expect(notifier.wants("run-completed")).toBe(false);
    expect(notifier.wants("run-failed")).toBe(true);
    notifier.notify(event);
    expect(bells).toHaveLength(0);
    notifier.notify({ ...event, kind: "run-failed" });
    expect(bells).toHaveLength(1);
  });
});

describe("notifyWorkflowEvent", () => {
  function collectNotifications(events: WorkflowEvent[]): NotifyEvent[] {
    const out: NotifyEvent[] = [];
    const notifier = {
      wants: () => true,
      notify: (e: NotifyEvent) => {
        out.push(e);
      },
    };
    const meta = { workflow: "w", runId: "r", url: "http://localhost:4600/#run-r" };
    for (const event of events) notifyWorkflowEvent(notifier, meta, event);
    return out;
  }

  it("maps HITL waits, budget breaches, and run completion", () => {
    const out = collectNotifications([
      {
        kind: "approval_pending",
        phaseId: "p",
        stepId: "gate",
        onReject: "fail",
        ts: 1,
      },
      {
        kind: "human_input_pending",
        phaseId: "p",
        stepId: "ask",
        attempt: 1,
        prompt: "what color?",
        origin: "human-step",
        ts: 2,
      },
      // A re-ask must NOT re-ping — the user is already present.
      {
        kind: "human_input_pending",
        phaseId: "p",
        stepId: "ask",
        attempt: 2,
        prompt: "what color?",
        origin: "human-step",
        ts: 3,
      },
      { kind: "budget_exceeded", scope: "workflow", limitUsd: 1, spentUsd: 1.2, ts: 4 },
      {
        kind: "workflow_done",
        ok: true,
        results: [{ stepId: "a", ok: true, output: "", durationMs: 1, costUsd: 0.5 }],
        ts: 5,
      },
    ]);
    expect(out.map((e) => e.kind)).toEqual([
      "approval-pending",
      "input-pending",
      "budget-exceeded",
      "run-completed",
    ]);
    expect(out[0]!.detail).toContain("gate");
    expect(out[1]!.detail).toContain("what color?");
    expect(out[3]!.costUsd).toBeCloseTo(0.5);
    expect(out[3]!.url).toBe("http://localhost:4600/#run-r");
  });

  it("maps a failed run to run-failed and ignores stream chatter", () => {
    const out = collectNotifications([
      {
        kind: "step_start",
        phaseId: "p",
        stepId: "s",
        ts: 1,
      },
      { kind: "workflow_done", ok: false, results: [], ts: 2 },
    ]);
    expect(out.map((e) => e.kind)).toEqual(["run-failed"]);
  });
});
