/** Small helpers shared by the adapters and their mappers. */

import type { ClaudeAssistant } from "../types/raw-claude";

/** Coerce a CLI "content" value (string | block[] | object) into display text. */
export function stringifyContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c) {
          const t = (c as { text?: unknown }).text;
          if (typeof t === "string") return t;
        }
        return safeJson(c);
      })
      .join("\n");
  }
  if (typeof content === "object" && "text" in content) {
    const t = (content as { text?: unknown }).text;
    if (typeof t === "string") return t;
  }
  return safeJson(content);
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return (idx === -1 ? text : text.slice(0, idx)).trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function humanizeAssistantError(a: ClaudeAssistant): string {
  const firstText = a.message.content?.find((b) => b.type === "text")?.text;
  const code = a.error;
  if (firstText && code) return `${firstText} (${code})`;
  return firstText ?? code ?? "assistant error";
}
