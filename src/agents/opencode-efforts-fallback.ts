/** Static OpenCode effort heuristics when `opencode models --verbose` is unavailable. */

const OPENAI_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
const ANTHROPIC_VARIANT_EFFORTS = ["high", "max"] as const;
const GEMINI_EFFORTS = ["low", "high"] as const;
const STANDARD_REASONING_EFFORTS = ["low", "medium", "high"] as const;
const DEEPSEEK_V4_EFFORTS = ["low", "medium", "high", "max"] as const;

function parseOpencodeModel(model: string): { provider: string; id: string } | null {
  const slash = model.indexOf("/");
  if (slash === -1) return null;
  return {
    provider: model.slice(0, slash).toLowerCase(),
    id: model.slice(slash + 1).toLowerCase(),
  };
}

function effortsForOpencodeModelId(id: string): readonly string[] {
  if (id.startsWith("gpt-")) return OPENAI_REASONING_EFFORTS;
  if (id.startsWith("claude-")) return ANTHROPIC_VARIANT_EFFORTS;
  if (id.startsWith("gemini-")) return GEMINI_EFFORTS;
  if (id.includes("deepseek-v4")) return DEEPSEEK_V4_EFFORTS;
  if (
    id.includes("deepseek") ||
    id.startsWith("glm-") ||
    id.startsWith("kimi-") ||
    id.startsWith("minimax-") ||
    id.startsWith("mimo-") ||
    id.startsWith("hy3-")
  ) {
    return STANDARD_REASONING_EFFORTS;
  }
  if (id.startsWith("grok-")) return ["low", "high"];
  return [];
}

/** Fallback effort levels derived from model id patterns and provider family. */
export function fallbackOpencodeEfforts(model: string): readonly string[] {
  const parsed = parseOpencodeModel(model);
  if (!parsed) return [];

  if (parsed.provider === "openai") return OPENAI_REASONING_EFFORTS;
  if (parsed.provider === "anthropic") return ANTHROPIC_VARIANT_EFFORTS;
  if (parsed.provider === "google") return GEMINI_EFFORTS;

  if (parsed.id.startsWith("qwen")) {
    return parsed.provider === "opencode" ? ANTHROPIC_VARIANT_EFFORTS : STANDARD_REASONING_EFFORTS;
  }

  return effortsForOpencodeModelId(parsed.id);
}
