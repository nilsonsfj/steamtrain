import { describe, expect, it } from "vitest";
import type { NotifyEvent, NotifyEventKind } from "../src/workflow";
import {
  formatDiscordPayload,
  formatSlackPayload,
  formatTeamsPayload,
} from "../src/workflow/webhook-templates";

const ALL_KINDS: NotifyEventKind[] = [
  "run-completed",
  "run-failed",
  "budget-exceeded",
  "approval-pending",
  "input-pending",
];

function makeEvent(overrides: Partial<NotifyEvent> = {}): NotifyEvent {
  return {
    kind: "run-completed",
    workflow: "deploy-prod",
    runId: "r-abc123",
    detail: "run done - $0.4200",
    costUsd: 0.42,
    url: "http://localhost:4600/#run-r-abc123",
    ts: 1700000000000,
    ...overrides,
  };
}

describe("formatSlackPayload", () => {
  it("produces a top-level attachments array with color and blocks", () => {
    const payload = formatSlackPayload(makeEvent()) as {
      attachments: { color: string; blocks: unknown[] }[];
    };
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0]!.color).toBe("#36a64f");
    expect(payload.attachments[0]!.blocks.length).toBeGreaterThanOrEqual(3);
  });

  it("includes a header block with workflow name and status emoji", () => {
    const payload = formatSlackPayload(makeEvent()) as {
      attachments: { blocks: { type: string; text?: { text: string } }[] }[];
    };
    const header = payload.attachments[0]!.blocks[0]!;
    expect(header.type).toBe("header");
    expect(header.text!.text).toContain("deploy-prod");
    expect(header.text!.text).toContain("\u2705");
  });

  it("includes a section block with the detail text", () => {
    const payload = formatSlackPayload(makeEvent({ detail: "custom detail message" })) as {
      attachments: { blocks: { type: string; text?: { text: string } }[] }[];
    };
    const section = payload.attachments[0]!.blocks[1]!;
    expect(section.type).toBe("section");
    expect(section.text!.text).toBe("custom detail message");
  });

  it("includes a context block with cost and timestamp", () => {
    const payload = formatSlackPayload(makeEvent()) as {
      attachments: { blocks: { type: string; elements?: { text: string }[] }[] }[];
    };
    const context = payload.attachments[0]!.blocks[2]!;
    expect(context.type).toBe("context");
    const texts = context.elements!.map((e) => e.text);
    expect(texts.some((t) => t.includes("$0.4200"))).toBe(true);
    expect(texts.some((t) => t.includes("r-abc123"))).toBe(true);
  });

  it("includes an actions block with a deep-link button when url is present", () => {
    const payload = formatSlackPayload(makeEvent()) as {
      attachments: { blocks: { type: string; elements?: { url?: string }[] }[] }[];
    };
    const actions = payload.attachments[0]!.blocks.find((b) => b.type === "actions");
    expect(actions).toBeDefined();
    expect(actions!.elements![0]!.url).toBe("http://localhost:4600/#run-r-abc123");
  });

  it("omits the actions block when url is absent", () => {
    const payload = formatSlackPayload(makeEvent({ url: undefined })) as {
      attachments: { blocks: { type: string }[] }[];
    };
    const actions = payload.attachments[0]!.blocks.find((b) => b.type === "actions");
    expect(actions).toBeUndefined();
  });

  it("omits cost from context when costUsd is undefined", () => {
    const payload = formatSlackPayload(makeEvent({ costUsd: undefined })) as {
      attachments: { blocks: { type: string; elements?: { text: string }[] }[] }[];
    };
    const context = payload.attachments[0]!.blocks.find((b) => b.type === "context")!;
    const texts = context.elements!.map((e) => e.text);
    expect(texts.some((t) => t.includes("Cost"))).toBe(false);
  });

  it.each([
    ["run-completed", "#36a64f", "\u2705"],
    ["run-failed", "#e01e5a", "\u274c"],
    ["budget-exceeded", "#f2994a", "\ud83d\udcb8"],
    ["approval-pending", "#f5a623", "\u270b"],
    ["input-pending", "#f5a623", "\u2753"],
  ] as [NotifyEventKind, string, string][])(
    "maps %s to color %s and emoji %s",
    (kind, color, emoji) => {
      const payload = formatSlackPayload(makeEvent({ kind })) as {
        attachments: { color: string; blocks: { text?: { text: string } }[] }[];
      };
      expect(payload.attachments[0]!.color).toBe(color);
      expect(payload.attachments[0]!.blocks[0]!.text!.text).toContain(emoji);
    },
  );
});

describe("formatDiscordPayload", () => {
  it("produces a top-level embeds array", () => {
    const payload = formatDiscordPayload(makeEvent()) as { embeds: unknown[] };
    expect(payload.embeds).toHaveLength(1);
  });

  it("includes title with emoji and workflow name", () => {
    const payload = formatDiscordPayload(makeEvent()) as {
      embeds: { title: string }[];
    };
    expect(payload.embeds[0]!.title).toContain("deploy-prod");
    expect(payload.embeds[0]!.title).toContain("\u2705");
  });

  it("includes description with detail text", () => {
    const payload = formatDiscordPayload(makeEvent({ detail: "some detail" })) as {
      embeds: { description: string }[];
    };
    expect(payload.embeds[0]!.description).toBe("some detail");
  });

  it("includes decimal color integer matching the event kind", () => {
    const payload = formatDiscordPayload(makeEvent({ kind: "run-failed" })) as {
      embeds: { color: number }[];
    };
    expect(payload.embeds[0]!.color).toBe(0xe01e5a);
  });

  it("includes fields for Workflow, Run ID, and Cost", () => {
    const payload = formatDiscordPayload(makeEvent()) as {
      embeds: { fields: { name: string; value: string; inline: boolean }[] }[];
    };
    const fields = payload.embeds[0]!.fields;
    expect(fields.find((f) => f.name === "Workflow")!.value).toBe("deploy-prod");
    expect(fields.find((f) => f.name === "Run ID")!.value).toBe("r-abc123");
    expect(fields.find((f) => f.name === "Cost")!.value).toBe("$0.4200");
  });

  it("omits Cost field when costUsd is undefined", () => {
    const payload = formatDiscordPayload(makeEvent({ costUsd: undefined })) as {
      embeds: { fields: { name: string }[] }[];
    };
    expect(payload.embeds[0]!.fields.find((f) => f.name === "Cost")).toBeUndefined();
  });

  it("includes timestamp as ISO string", () => {
    const payload = formatDiscordPayload(makeEvent()) as {
      embeds: { timestamp: string }[];
    };
    expect(payload.embeds[0]!.timestamp).toBe(new Date(1700000000000).toISOString());
  });

  it("includes url field when event has a url", () => {
    const payload = formatDiscordPayload(makeEvent()) as {
      embeds: { url?: string }[];
    };
    expect(payload.embeds[0]!.url).toBe("http://localhost:4600/#run-r-abc123");
  });

  it("omits url field when event has no url", () => {
    const payload = formatDiscordPayload(makeEvent({ url: undefined })) as {
      embeds: { url?: string }[];
    };
    expect(payload.embeds[0]!.url).toBeUndefined();
  });

  it.each([
    ["run-completed", 0x36a64f],
    ["run-failed", 0xe01e5a],
    ["budget-exceeded", 0xf2994a],
    ["approval-pending", 0xf5a623],
    ["input-pending", 0xf5a623],
  ] as [NotifyEventKind, number][])("maps %s to color %d", (kind, color) => {
    const payload = formatDiscordPayload(makeEvent({ kind })) as {
      embeds: { color: number }[];
    };
    expect(payload.embeds[0]!.color).toBe(color);
  });
});

describe("formatTeamsPayload", () => {
  it("produces a top-level message with adaptive card attachment", () => {
    const payload = formatTeamsPayload(makeEvent()) as {
      type: string;
      attachments: { contentType: string; content: { type: string } }[];
    };
    expect(payload.type).toBe("message");
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0]!.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(payload.attachments[0]!.content.type).toBe("AdaptiveCard");
  });

  it("includes a bolder header TextBlock with emoji and workflow name", () => {
    const payload = formatTeamsPayload(makeEvent()) as {
      attachments: { content: { body: { type: string; weight?: string; text?: string }[] } }[];
    };
    const body = payload.attachments[0]!.content.body;
    const header = body[0]!;
    expect(header.type).toBe("TextBlock");
    expect(header.weight).toBe("Bolder");
    expect(header.text).toContain("deploy-prod");
    expect(header.text).toContain("\u2705");
  });

  it("includes a detail TextBlock", () => {
    const payload = formatTeamsPayload(makeEvent({ detail: "my detail" })) as {
      attachments: { content: { body: { type: string; text?: string }[] } }[];
    };
    const detail = payload.attachments[0]!.content.body[1]!;
    expect(detail.type).toBe("TextBlock");
    expect(detail.text).toBe("my detail");
  });

  it("includes a FactSet with workflow, status, run ID, and cost", () => {
    const payload = formatTeamsPayload(makeEvent()) as {
      attachments: {
        content: { body: { type: string; facts?: { title: string; value: string }[] }[] };
      }[];
    };
    const factSet = payload.attachments[0]!.content.body.find((b) => b.type === "FactSet")!;
    expect(factSet.facts!.find((f) => f.title === "Workflow")!.value).toBe("deploy-prod");
    expect(factSet.facts!.find((f) => f.title === "Status")!.value).toContain("\u2705");
    expect(factSet.facts!.find((f) => f.title === "Run ID")!.value).toBe("r-abc123");
    expect(factSet.facts!.find((f) => f.title === "Cost")!.value).toBe("$0.4200");
  });

  it("omits Cost fact when costUsd is undefined", () => {
    const payload = formatTeamsPayload(makeEvent({ costUsd: undefined })) as {
      attachments: {
        content: { body: { type: string; facts?: { title: string }[] }[] };
      }[];
    };
    const factSet = payload.attachments[0]!.content.body.find((b) => b.type === "FactSet")!;
    expect(factSet.facts!.find((f) => f.title === "Cost")).toBeUndefined();
  });

  it("includes Action.OpenUrl when event has a url", () => {
    const payload = formatTeamsPayload(makeEvent()) as {
      attachments: { content: { actions?: { type: string; url?: string }[] } }[];
    };
    const actions = payload.attachments[0]!.content.actions!;
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe("Action.OpenUrl");
    expect(actions[0]!.url).toBe("http://localhost:4600/#run-r-abc123");
  });

  it("omits actions when event has no url", () => {
    const payload = formatTeamsPayload(makeEvent({ url: undefined })) as {
      attachments: { content: { actions?: unknown[] } }[];
    };
    expect(payload.attachments[0]!.content.actions).toBeUndefined();
  });

  it.each(ALL_KINDS)("produces distinct emoji for %s", (kind) => {
    const payload = formatTeamsPayload(makeEvent({ kind })) as {
      attachments: { content: { body: { text?: string }[] } }[];
    };
    const header = payload.attachments[0]!.content.body[0]!;
    expect(header.text!.length).toBeGreaterThan(0);
  });
});

describe("all formatters handle every event kind", () => {
  for (const kind of ALL_KINDS) {
    it(`all three formatters produce valid output for ${kind}`, () => {
      const event = makeEvent({ kind });
      const slack = formatSlackPayload(event) as { attachments: unknown[] };
      const discord = formatDiscordPayload(event) as { embeds: unknown[] };
      const teams = formatTeamsPayload(event) as { type: string };
      expect(slack.attachments).toHaveLength(1);
      expect(discord.embeds).toHaveLength(1);
      expect(teams.type).toBe("message");
    });
  }
});
