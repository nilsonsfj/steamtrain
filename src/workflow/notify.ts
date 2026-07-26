import { spawn } from "node:child_process";
import { type SafeUrlOptions, assertSafeOutboundUrl } from "../util/safe-url";
import { isAllowedOutboundUrl } from "../util/safe-url-sync";
import { approvalDeepLink } from "../web/run-deep-link";
import { costForResults } from "./cost";
import type { WorkflowEvent } from "./events";
import { formatDiscordPayload, formatSlackPayload, formatTeamsPayload } from "./webhook-templates";

/**
 * Run notifications (roadmap §1.5): once runs are long, detached, or waiting
 * on a human, the user needs to be pinged rather than poll a terminal. A
 * `notify` config block turns on up to three channels — terminal bell, OS
 * desktop notification, and a generic webhook (covers Slack/Discord/ntfy
 * without bespoke integrations) — fired on run completion, failure,
 * budget-exceeded, and human-in-the-loop waits (approval-pending,
 * input-pending).
 *
 * Everything here is strictly best-effort and fire-and-forget: a notification
 * failure must never slow down, break, or block a run. Channels:
 *
 *  - `bell`: writes BEL to stderr — works in any terminal, zero dependencies.
 *  - `desktop`: `notify-send` (Linux) / `osascript` (macOS); unsupported
 *    platforms are silently skipped (the bell still works there).
 *  - `webhook`: POSTs a JSON payload (`NotifyEvent` shape) with a short
 *    timeout. Point it at Slack/Discord/ntfy glue of your choosing.
 *
 * Only the process that OWNS a run notifies (CLI foreground/detached runner,
 * TUI, web server) — attached viewers stay quiet, so one event never pings
 * twice.
 */

export type NotifyEventKind =
  | "run-completed"
  | "run-failed"
  | "budget-exceeded"
  | "approval-pending"
  | "input-pending";

export type WebhookFormat = "raw" | "slack" | "discord" | "teams";

/** All kinds, in the order shown by config surfaces. */
export const NOTIFY_EVENT_KINDS: readonly NotifyEventKind[] = [
  "run-completed",
  "run-failed",
  "budget-exceeded",
  "approval-pending",
  "input-pending",
];

/** The `notify` block of `steamtrain.json` / `~/.steamtrain/config.json`. */
export interface NotifyConfig {
  /** Ring the terminal bell (BEL to stderr). */
  bell?: boolean;
  /** Show an OS desktop notification (Linux `notify-send`, macOS `osascript`). */
  desktop?: boolean;
  /** POST a JSON payload to this URL on each notified event. */
  webhook?: string;
  /** Payload format for the webhook: 'raw' (default), 'slack', 'discord', or 'teams'. */
  webhookFormat?: WebhookFormat;
  /** Which events notify. Omitted ⇒ all of {@link NOTIFY_EVENT_KINDS}. */
  events?: NotifyEventKind[];
}

/** One notification payload (also the webhook POST body). */
export interface NotifyEvent {
  kind: NotifyEventKind;
  workflow: string;
  runId: string;
  /** One-line human summary ("waiting for approval at 'review-gate'"). */
  detail: string;
  /** Total run cost so far, when known (terminal events). */
  costUsd?: number;
  /** Deep link to the web-UI run page, when a web server hosts the run. */
  url?: string;
  ts: number;
}

export interface Notifier {
  /** Dispatch one notification to every enabled channel. Never throws. */
  notify(event: NotifyEvent): void;
  /** Whether `kind` is enabled — lets callers skip building the payload. */
  wants(kind: NotifyEventKind): boolean;
}

/** Injection points so tests never ring bells, spawn processes, or hit the net. */
export interface CreateNotifierOptions {
  bellStream?: { write(chunk: string): unknown };
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  /** Override DNS used by the webhook SSRF check (tests). */
  resolveHostname?: SafeUrlOptions["resolveHostname"];
}

/** Cap on `detail` text posted to webhooks (limits accidental secret exfil). */
const WEBHOOK_DETAIL_CAP = 2_000;

const WEBHOOK_TIMEOUT_MS = 5_000;

/** True when a notify webhook URL is safe to POST to (no private/metadata SSRF). */
export function isAllowedWebhookUrl(value: string): boolean {
  return isAllowedOutboundUrl(value, { allowLoopback: false, allowPrivateLan: false });
}

/** A notifier over the configured channels; `undefined` config ⇒ a no-op notifier. */
export function createNotifier(
  config: NotifyConfig | undefined,
  options: CreateNotifierOptions = {},
): Notifier {
  const enabledKinds = new Set<NotifyEventKind>(config?.events ?? NOTIFY_EVENT_KINDS);
  const anyChannel = Boolean(config && (config.bell || config.desktop || config.webhook));
  const bellStream = options.bellStream ?? process.stderr;
  const spawnFn = options.spawnFn ?? spawn;
  const fetchFn = options.fetchFn ?? fetch;
  const platform = options.platform ?? process.platform;

  const desktop = (event: NotifyEvent): void => {
    const title = `steamtrain · ${event.workflow}`;
    let binary: string;
    let args: string[];
    if (platform === "linux") {
      binary = "notify-send";
      args = [title, event.detail];
    } else if (platform === "darwin") {
      binary = "osascript";
      const esc = (text: string): string => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      args = ["-e", `display notification "${esc(event.detail)}" with title "${esc(title)}"`];
    } else {
      return; // No portable native channel here; the bell/webhook still fire.
    }
    try {
      const child = spawnFn(binary, args, { stdio: "ignore", detached: false });
      child.once("error", () => {});
      child.unref?.();
    } catch {
      // Best-effort only.
    }
  };

  const webhook = (event: NotifyEvent, url: string): void => {
    // Fire-and-forget SSRF check: refuse private/metadata destinations. Cap
    // detail text so step-output snippets cannot exfiltrate unbounded secrets.
    const detail =
      event.detail.length > WEBHOOK_DETAIL_CAP
        ? `${event.detail.slice(0, WEBHOOK_DETAIL_CAP)}…`
        : event.detail;
    const capped: NotifyEvent = detail === event.detail ? event : { ...event, detail };

    const format = config?.webhookFormat;
    let body: string;
    if (format === "slack") {
      body = JSON.stringify(formatSlackPayload(capped));
    } else if (format === "discord") {
      body = JSON.stringify(formatDiscordPayload(capped));
    } else if (format === "teams") {
      body = JSON.stringify(formatTeamsPayload(capped));
    } else {
      body = JSON.stringify(capped);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    void assertSafeOutboundUrl(url, {
      allowLoopback: false,
      allowPrivateLan: false,
      resolveHostname: options.resolveHostname,
    })
      .then((safe) => {
        if (!safe.ok) return;
        return fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        });
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  };

  return {
    wants: (kind) => anyChannel && enabledKinds.has(kind),
    notify(event) {
      if (!config || !anyChannel || !enabledKinds.has(event.kind)) return;
      try {
        if (config.bell) bellStream.write("\u0007");
      } catch {
        // Best-effort only.
      }
      if (config.desktop) desktop(event);
      if (config.webhook) webhook(event, config.webhook);
    },
  };
}

export interface NotifyRunMeta {
  workflow: string;
  runId: string;
  /** Deep-link builder, when a web UI hosts the run. */
  url?: string;
}

/**
 * Map one workflow event onto a notification (or nothing) and dispatch it —
 * the single wiring point every run driver calls per event, so the CLI, TUI,
 * and web server notify identically:
 *
 *  - `approval_pending`                 → approval-pending
 *  - `human_input_pending` (attempt 1)  → input-pending (re-asks mean the
 *                                         user is already present — no re-ping)
 *  - `budget_exceeded`                  → budget-exceeded
 *  - `workflow_done`                    → run-completed / run-failed, with the
 *                                         run's total cost when recorded
 */
export function notifyWorkflowEvent(
  notifier: Notifier,
  meta: NotifyRunMeta,
  event: WorkflowEvent,
): void {
  const base = { workflow: meta.workflow, runId: meta.runId, url: meta.url, ts: Date.now() };
  switch (event.kind) {
    case "approval_pending":
      if (!notifier.wants("approval-pending")) return;
      notifier.notify({
        ...base,
        kind: "approval-pending",
        detail: `waiting for approval at '${event.stepId}'`,
        url: base.url ? `${base.url}/step/${event.stepId}` : undefined,
      });
      return;
    case "human_input_pending":
      if (event.attempt !== 1 || !notifier.wants("input-pending")) return;
      notifier.notify({
        ...base,
        kind: "input-pending",
        detail:
          event.origin === "agent-question"
            ? `agent question at '${event.stepId}': ${firstNotifyLine(event.prompt)}`
            : `waiting for input at '${event.stepId}': ${firstNotifyLine(event.prompt)}`,
      });
      return;
    case "budget_exceeded":
      if (!notifier.wants("budget-exceeded")) return;
      notifier.notify({
        ...base,
        kind: "budget-exceeded",
        detail: `cost budget $${event.limitUsd.toFixed(2)} reached (spent $${event.spentUsd.toFixed(2)})`,
        costUsd: event.spentUsd,
      });
      return;
    case "workflow_done": {
      const kind: NotifyEventKind = event.ok ? "run-completed" : "run-failed";
      if (!notifier.wants(kind)) return;
      const costUsd = costForResults(event.results);
      const status = event.budgetExceeded ? "budget-exceeded" : event.ok ? "done" : "failed";
      notifier.notify({
        ...base,
        kind,
        detail: `run ${status}${costUsd > 0 ? ` · $${costUsd.toFixed(4)}` : ""}`,
        costUsd: costUsd > 0 ? costUsd : undefined,
      });
      return;
    }
    default:
      return;
  }
}

function firstNotifyLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? text;
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}
