import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentEvent,
  AgentId,
  AgentInstanceId,
  EventMapper,
  TokenUsage,
} from "../types/events";
import { kimiEnvelope, kimiMessage } from "../types/raw-kimi";
import type { AgentAdapter, AgentRunOptions } from "./adapter";
import { runAgentProcess } from "./adapter";
import type { AgentModel } from "./agent-model";
import { permissionArgs } from "./permissions";
import { stringifyContent } from "./util";

const AGENT: AgentId = "kimi";

/**
 * Known Kimi Code models (`kimi provider list --json`). Live installs refresh
 * via the variant cache; aliases are `<provider>/<model>` under the managed
 * `kimi-code` provider.
 *
 * Verified against Kimi Code CLI 0.34.0 (`kimi provider list --json`):
 *   kimi-code/kimi-for-coding           — K2.7 Coding (default)
 *   kimi-code/kimi-for-coding-highspeed — K2.7 Coding Highspeed
 *   kimi-code/k3                        — K3 (efforts: low/high/max)
 *   kimi-code/k3-256k                   — K3-256k (efforts: low/high/max)
 */
export const KIMI_MODELS: readonly AgentModel[] = [
  { id: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
  { id: "kimi-code/kimi-for-coding-highspeed", name: "K2.7 Coding Highspeed" },
  { id: "kimi-code/k3", name: "K3" },
  { id: "kimi-code/k3-256k", name: "K3-256k" },
];

/**
 * Tool-call `arguments` arrive as a JSON-encoded string; parse when possible.
 * Non-string inputs (and unparseable strings) pass through unchanged.
 */
function parseToolArguments(args: unknown): unknown {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/**
 * Build a mapper for one Kimi Code run.
 *
 * Streaming model (from real `stream-json` output):
 *  - `meta` `session.resume_hint` → session_start (once; carries the session id)
 *  - `assistant` `content`        → text_delta (whole messages — kimi emits no
 *                                   partial deltas, so each line is one chunk)
 *  - `assistant` `tool_calls`     → tool_use per call
 *  - `tool`                       → tool_result (matched to its call by id)
 *  - anything else                → unknown passthrough
 *
 * Tool names are remembered per call id so `tool_result` lines (which carry no
 * name of their own) stay attributed. Create a fresh mapper per run so this
 * state never leaks between tasks.
 */
export function createKimiMapper(agent: AgentInstanceId = AGENT): EventMapper {
  let sessionStarted = false;
  const toolNames = new Map<string, string>();

  return (raw: unknown): AgentEvent[] => {
    const ts = Date.now();
    const parsed = kimiMessage.safeParse(raw);
    if (!parsed.success) {
      const env = kimiEnvelope.safeParse(raw);
      return [
        { kind: "unknown", agent, ts, rawType: env.success ? env.data.role : undefined, raw },
      ];
    }

    const e = parsed.data;
    const out: AgentEvent[] = [];

    switch (e.role) {
      case "meta": {
        if (e.type === "session.resume_hint" && e.session_id) {
          if (!sessionStarted) {
            sessionStarted = true;
            out.push({ kind: "session_start", agent, ts, sessionId: e.session_id });
          }
          return out;
        }
        return [{ kind: "unknown", agent, ts, rawType: e.type ?? "meta", raw }];
      }
      case "assistant": {
        for (const call of e.tool_calls ?? []) {
          const id = call.id ?? "tool";
          const name = call.function?.name ?? "tool";
          toolNames.set(id, name);
          out.push({
            kind: "tool_use",
            agent,
            ts,
            id,
            name,
            input: parseToolArguments(call.function?.arguments),
          });
        }
        if (typeof e.content === "string" && e.content.length > 0) {
          out.push({ kind: "text_delta", agent, ts, text: `${e.content}\n` });
        }
        if (out.length === 0) out.push({ kind: "unknown", agent, ts, rawType: "assistant", raw });
        return out;
      }
      case "tool": {
        const id = e.tool_call_id ?? "tool";
        out.push({
          kind: "tool_result",
          agent,
          ts,
          id,
          name: toolNames.get(id),
          output: stringifyContent(e.content),
          isError: e.is_error ?? false,
        });
        return out;
      }
      default:
        return [{ kind: "unknown", agent, ts, rawType: e.role, raw }];
    }
  };
}

/**
 * CLI args for one headless `kimi -p` run.
 * NOTE: `-p` consumes the next token as the prompt, so it stays the final flag
 * pair. `--session <sessionId>` continues a recorded session.
 */
export function buildKimiRunArgs(opts: AgentRunOptions): string[] {
  return [
    ...(opts.resumeSessionId ? ["--session", opts.resumeSessionId] : []),
    "-m",
    opts.model,
    "--output-format",
    "stream-json",
    ...permissionArgs(AGENT, opts.permissions),
    ...(opts.extraArgs ?? []),
    "-p",
    opts.prompt,
  ];
}

/**
 * Extra env for one run. Kimi Code has no effort CLI flag, but honors
 * `KIMI_MODEL_THINKING_EFFORT` per process (forces the thinking effort on the
 * wire; kimi provider only, while thinking is on) — that is how `opts.effort`
 * is forwarded. Steamtrain only offers efforts from the model's declared
 * `support_efforts`, so the bypass of that list here is safe.
 */
export function buildKimiRunEnv(opts: AgentRunOptions): Record<string, string> | undefined {
  if (!opts.effort) return opts.env;
  return { ...opts.env, KIMI_MODEL_THINKING_EFFORT: opts.effort };
}

/** Kimi Code's data root: `$KIMI_CODE_HOME`, else `~/.kimi-code` (as the CLI resolves it). */
function kimiHome(env: Record<string, string | undefined>): string {
  return env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
}

/**
 * Tokens one run billed, read back from the session's wire logs. Kimi's
 * `stream-json` output carries no usage at all, but every model call appends a
 * `{"type":"usage.record","usage":{inputOther, output, inputCacheRead,
 * inputCacheCreation},"time":<ms>}` line to
 * `sessions/<workdir>/<sessionId>/agents/<agent>/wire.jsonl` — one file for the
 * main loop and one per subagent. Records before `since` belong to earlier runs
 * of a resumed session and are skipped. `undefined` when nothing was found.
 * Kimi Code is subscription-billed, so there is no cost to report.
 */
export async function readKimiRunUsage(
  sessionId: string,
  since: number,
  home: string,
): Promise<TokenUsage | undefined> {
  const sessionsDir = path.join(home, "sessions");
  let workdirs: string[];
  try {
    workdirs = await fs.readdir(sessionsDir);
  } catch {
    return undefined;
  }
  let tokens: TokenUsage | undefined;
  const add = (key: keyof TokenUsage, n: unknown) => {
    if (typeof n !== "number") return;
    tokens ??= {};
    tokens[key] = (tokens[key] ?? 0) + n;
  };
  for (const workdir of workdirs) {
    const agentsDir = path.join(sessionsDir, workdir, sessionId, "agents");
    let agents: string[];
    try {
      agents = await fs.readdir(agentsDir);
    } catch {
      continue;
    }
    for (const agent of agents) {
      let text: string;
      try {
        text = await fs.readFile(path.join(agentsDir, agent, "wire.jsonl"), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.includes('"usage.record"')) continue;
        let record: { type?: unknown; time?: unknown; usage?: Record<string, unknown> };
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.type !== "usage.record" || !record.usage) continue;
        if (typeof record.time === "number" && record.time < since) continue;
        add("input", record.usage.inputOther);
        add("output", record.usage.output);
        add("cacheRead", record.usage.inputCacheRead);
        add("cacheWrite", record.usage.inputCacheCreation);
      }
    }
    // Session ids are unique; the first workdir holding it is the one.
    return tokens;
  }
  return undefined;
}

/** Runs the real `kimi` CLI in streaming JSON mode. */
export class KimiAdapter implements AgentAdapter {
  readonly id: AgentId = AGENT;
  readonly binary: string;
  readonly defaultModel = "kimi-code/kimi-for-coding";
  /** `kimi --session <sessionId>` continues a recorded session headlessly. */
  readonly supportsResume = true;

  constructor(binary = "kimi") {
    this.binary = binary;
  }

  async *run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    const agent = opts.agentId ?? this.id;
    const startedAt = Date.now();
    let sessionId: string | undefined;
    for await (const event of runAgentProcess({
      id: this.id,
      binary: this.binary,
      args: buildKimiRunArgs(opts),
      opts: { ...opts, env: buildKimiRunEnv(opts) },
      map: createKimiMapper(agent),
      // Prompt travels in argv (`-p`); stdin stays closed.
    })) {
      if (event.kind === "session_start" && event.sessionId) sessionId = event.sessionId;
      yield event;
    }
    // Usage never reaches stdout; read what this run billed from the session
    // logs once the process is done writing them.
    if (!sessionId) return;
    const tokens = await readKimiRunUsage(
      sessionId,
      startedAt,
      kimiHome({ ...process.env, ...opts.env }),
    );
    if (tokens) yield { kind: "usage", agent, ts: Date.now(), tokens };
  }
}
