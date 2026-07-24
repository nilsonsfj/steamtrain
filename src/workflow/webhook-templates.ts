import type { NotifyEvent, NotifyEventKind } from "./notify";

type KindColor = { hex: string; decimal: number; emoji: string; label: string };

const KIND_COLORS: Record<NotifyEventKind, KindColor> = {
  "run-completed": { hex: "#36a64f", decimal: 0x36a64f, emoji: "\u2705", label: "Completed" },
  "run-failed": { hex: "#e01e5a", decimal: 0xe01e5a, emoji: "\u274c", label: "Failed" },
  "budget-exceeded": {
    hex: "#f2994a",
    decimal: 0xf2994a,
    emoji: "\ud83d\udcb8",
    label: "Budget Exceeded",
  },
  "approval-pending": {
    hex: "#f5a623",
    decimal: 0xf5a623,
    emoji: "\u270b",
    label: "Approval Needed",
  },
  "input-pending": { hex: "#f5a623", decimal: 0xf5a623, emoji: "\u2753", label: "Input Needed" },
};

export function formatSlackPayload(event: NotifyEvent): object {
  const { hex, emoji, label } = KIND_COLORS[event.kind];

  const blocks: object[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} ${event.workflow} \u2014 ${label}`, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: event.detail },
    },
  ];

  const contextElements: object[] = [];
  if (event.costUsd !== undefined) {
    contextElements.push({
      type: "mrkdwn",
      text: `*Cost:* $${event.costUsd.toFixed(4)}`,
    });
  }
  contextElements.push({
    type: "mrkdwn",
    text: `*Run:* ${event.runId}`,
  });
  contextElements.push({
    type: "mrkdwn",
    text: `*Time:* <!date^${Math.floor(event.ts / 1000)}^{date_short_pretty} {time}|${new Date(event.ts).toISOString()}>`,
  });
  blocks.push({ type: "context", elements: contextElements });

  if (event.url) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View Run", emoji: true },
          url: event.url,
          action_id: "view_run",
        },
      ],
    });
  }

  return {
    attachments: [{ color: hex, blocks }],
  };
}

export function formatDiscordPayload(event: NotifyEvent): object {
  const { decimal, emoji, label } = KIND_COLORS[event.kind];

  const fields: object[] = [
    { name: "Workflow", value: event.workflow, inline: true },
    { name: "Run ID", value: event.runId, inline: true },
  ];
  if (event.costUsd !== undefined) {
    fields.push({ name: "Cost", value: `$${event.costUsd.toFixed(4)}`, inline: true });
  }

  const embed: Record<string, unknown> = {
    title: `${emoji} ${label}: ${event.workflow}`,
    description: event.detail,
    color: decimal,
    fields,
    timestamp: new Date(event.ts).toISOString(),
  };
  if (event.url) {
    embed.url = event.url;
  }

  return { embeds: [embed] };
}

export function formatTeamsPayload(event: NotifyEvent): object {
  const { emoji, label } = KIND_COLORS[event.kind];

  const facts: object[] = [
    { title: "Workflow", value: event.workflow },
    { title: "Status", value: `${emoji} ${label}` },
    { title: "Run ID", value: event.runId },
  ];
  if (event.costUsd !== undefined) {
    facts.push({ title: "Cost", value: `$${event.costUsd.toFixed(4)}` });
  }

  const body: object[] = [
    {
      type: "TextBlock",
      size: "Medium",
      weight: "Bolder",
      text: `${emoji} ${event.workflow} \u2014 ${label}`,
    },
    {
      type: "TextBlock",
      text: event.detail,
      wrap: true,
    },
    {
      type: "FactSet",
      facts,
    },
  ];

  const actions: object[] = [];
  if (event.url) {
    actions.push({
      type: "Action.OpenUrl",
      title: "View Run",
      url: event.url,
    });
  }

  const card: Record<string, unknown> = {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body,
  };
  if (actions.length > 0) {
    card.actions = actions;
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: card,
      },
    ],
  };
}
