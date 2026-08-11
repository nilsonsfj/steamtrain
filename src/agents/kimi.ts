import type { AgentEvent, AgentId, AgentInstanceId, EventMapper } from "../types/events";
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

  run(opts: AgentRunOptions): AsyncIterable<AgentEvent> {
    return runAgentProcess({
      id: this.id,
      binary: this.binary,
      args: buildKimiRunArgs(opts),
      opts: { ...opts, env: buildKimiRunEnv(opts) },
      map: createKimiMapper(opts.agentId ?? this.id),
      // Prompt travels in argv (`-p`); stdin stays closed.
    });
  }
}
