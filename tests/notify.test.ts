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
    expect(bells).toEqual(["\u0007"]);
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
    expect(out[0]!.url).toBe("http://localhost:4600/#run-r/step/gate");
    expect(out[1]!.detail).toContain("what color?");
    expect(out[1]!.url).toBe("http://localhost:4600/#run-r");
    expect(out[3]!.costUsd).toBeCloseTo(0.5);
    expect(out[3]!.url).toBe("http://localhost:4600/#run-r");
  });

  it("labels agent questions distinctly from human-step asks", () => {
    const out = collectNotifications([
      {
        kind: "human_input_pending",
        phaseId: "p",
        stepId: "impl",
        attempt: 1,
        prompt: "which auth flow?",
        origin: "agent-question",
        ts: 1,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.detail).toBe("agent question at 'impl': which auth flow?");
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

  it("uses step-specific deep link for approval-pending when meta.url is set", () => {
    const out: NotifyEvent[] = [];
    const notifier = {
      wants: () => true,
      notify: (e: NotifyEvent) => {
        out.push(e);
      },
    };
    const meta = { workflow: "ci", runId: "abc-123", url: "http://myhost:4317/#run-abc-123" };
    notifyWorkflowEvent(notifier, meta, {
      kind: "approval_pending",
      phaseId: "deploy",
      stepId: "review-gate",
      onReject: "fail",
      ts: 99,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe("http://myhost:4317/#run-abc-123/step/review-gate");
  });

  it("leaves url undefined for approval-pending when meta.url is not set", () => {
    const out: NotifyEvent[] = [];
    const notifier = {
      wants: () => true,
      notify: (e: NotifyEvent) => {
        out.push(e);
      },
    };
    const meta = { workflow: "ci", runId: "abc-123" };
    notifyWorkflowEvent(notifier, meta, {
      kind: "approval_pending",
      phaseId: "deploy",
      stepId: "review-gate",
      onReject: "fail",
      ts: 99,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBeUndefined();
  });
});

describe("createNotifier with webhookFormat", () => {
  it("posts Slack Block Kit payload when webhookFormat is 'slack'", () => {
    const { posts, options } = harness();
    const notifier = createNotifier(
      { webhook: "https://hooks.slack.example/x", webhookFormat: "slack" },
      options,
    );
    notifier.notify(event);
    expect(posts).toHaveLength(1);
    const body = posts[0]!.body as { attachments?: { color: string; blocks: unknown[] }[] };
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments![0]!.color).toBe("#36a64f");
    expect(body.attachments![0]!.blocks.length).toBeGreaterThanOrEqual(3);
    expect((body as Record<string, unknown>).kind).toBeUndefined();
  });

  it("posts Discord embed payload when webhookFormat is 'discord'", () => {
    const { posts, options } = harness();
    const notifier = createNotifier(
      { webhook: "https://discord.example/hook", webhookFormat: "discord" },
      options,
    );
    notifier.notify(event);
    expect(posts).toHaveLength(1);
    const body = posts[0]!.body as { embeds?: { color: number; title: string }[] };
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds![0]!.color).toBe(0x36a64f);
    expect(body.embeds![0]!.title).toContain("bug-hunt");
  });

  it("posts Teams Adaptive Card payload when webhookFormat is 'teams'", () => {
    const { posts, options } = harness();
    const notifier = createNotifier(
      { webhook: "https://teams.example/hook", webhookFormat: "teams" },
      options,
    );
    notifier.notify(event);
    expect(posts).toHaveLength(1);
    const body = posts[0]!.body as {
      type?: string;
      attachments?: { contentType: string; content: { type: string } }[];
    };
    expect(body.type).toBe("message");
    expect(body.attachments![0]!.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(body.attachments![0]!.content.type).toBe("AdaptiveCard");
  });

  it("posts raw NotifyEvent when webhookFormat is 'raw'", () => {
    const { posts, options } = harness();
    const notifier = createNotifier(
      { webhook: "https://hooks.example/x", webhookFormat: "raw" },
      options,
    );
    notifier.notify(event);
    expect(posts[0]!.body).toMatchObject({ kind: "run-completed", workflow: "bug-hunt" });
  });

  it("posts raw NotifyEvent when webhookFormat is omitted", () => {
    const { posts, options } = harness();
    const notifier = createNotifier({ webhook: "https://hooks.example/x" }, options);
    notifier.notify(event);
    expect(posts[0]!.body).toMatchObject({ kind: "run-completed", workflow: "bug-hunt" });
  });
});

describe("approval-pending webhook payloads include step-specific URL", () => {
  const approvalEvent: NotifyEvent = {
    kind: "approval-pending",
    workflow: "deploy",
    runId: "r1",
    detail: "waiting for approval at 'review-gate'",
    url: "http://host:4317/#run-r1/step/review-gate",
    ts: 1,
  };

  it("raw payload carries the step-specific url", () => {
    const { posts, options } = harness();
    const notifier = createNotifier(
      { webhook: "https://hooks.example/x", webhookFormat: "raw" },
      options,
    );
    notifier.notify(approvalEvent);
    expect(posts[0]!.body).toMatchObject({ url: "http://host:4317/#run-r1/step/review-gate" });
  });

  it("Slack payload includes the step-specific url in action button", () => {
    const { posts, options } = harness();
    const notifier = createNotifier(
      { webhook: "https://hooks.slack.example/x", webhookFormat: "slack" },
      options,
    );
    notifier.notify(approvalEvent);
    const body = posts[0]!.body as { attachments?: { blocks: unknown[] }[] };
    const blocks = body.attachments![0]!.blocks;
    const json = JSON.stringify(blocks);
    expect(json).toContain("http://host:4317/#run-r1/step/review-gate");
  });

  it("Discord payload includes the step-specific url", () => {
    const { posts, options } = harness();
    const notifier = createNotifier(
      { webhook: "https://discord.example/hook", webhookFormat: "discord" },
      options,
    );
    notifier.notify(approvalEvent);
    const body = posts[0]!.body as { embeds?: { url?: string }[] };
    expect(body.embeds![0]!.url).toBe("http://host:4317/#run-r1/step/review-gate");
  });

  it("Teams payload includes the step-specific url in action", () => {
    const { posts, options } = harness();
    const notifier = createNotifier(
      { webhook: "https://teams.example/hook", webhookFormat: "teams" },
      options,
    );
    notifier.notify(approvalEvent);
    const json = JSON.stringify(posts[0]!.body);
    expect(json).toContain("http://host:4317/#run-r1/step/review-gate");
  });
});
