import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AntigravityTranscriptRecovery {
  conversationId: string;
  text: string;
}

export interface RecoverAntigravityTranscriptOptions {
  cwd: string;
  /** Override for tests — parsed last_conversations.json contents. */
  lastConversations?: Record<string, string>;
  /** Override for tests — returns transcript.jsonl body for a conversation id. */
  readTranscript?: (conversationId: string) => string | undefined;
  /** App data root; defaults to ~/.gemini/antigravity-cli. */
  appDataDir?: string;
}

/** Default Antigravity CLI app-data directory. */
export function antigravityAppDataDir(): string {
  return join(homedir(), ".gemini", "antigravity-cli");
}

/**
 * Extract the last MODEL PLANNER_RESPONSE content from a transcript.jsonl body.
 */
export function parseAntigravityPlannerResponse(jsonl: string): string | undefined {
  let last: string | undefined;
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as {
        source?: string;
        type?: string;
        content?: unknown;
      };
      if (
        row.source === "MODEL" &&
        row.type === "PLANNER_RESPONSE" &&
        typeof row.content === "string" &&
        row.content.length > 0
      ) {
        last = row.content;
      }
    } catch {
      // skip malformed lines
    }
  }
  return last;
}

function readLastConversations(appDataDir: string): Record<string, string> {
  try {
    const raw = readFileSync(join(appDataDir, "cache", "last_conversations.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function readTranscriptFile(appDataDir: string, conversationId: string): string | undefined {
  const path = join(
    appDataDir,
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Recover print-mode output when stdout was dropped (known agy non-TTY issue)
 * by reading the on-disk transcript for the cwd's last conversation.
 */
export function recoverAntigravityTranscriptText(
  options: RecoverAntigravityTranscriptOptions,
): AntigravityTranscriptRecovery | undefined {
  const appDataDir = options.appDataDir ?? antigravityAppDataDir();
  const last = options.lastConversations ?? readLastConversations(appDataDir);
  const conversationId = last[options.cwd];
  if (!conversationId) return undefined;

  const jsonl =
    options.readTranscript?.(conversationId) ?? readTranscriptFile(appDataDir, conversationId);
  if (!jsonl) return undefined;

  const text = parseAntigravityPlannerResponse(jsonl);
  if (!text) return undefined;
  return { conversationId, text };
}
