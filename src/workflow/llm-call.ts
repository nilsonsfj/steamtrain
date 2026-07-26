/**
 * Node-side LLM HTTP transport ({@link callLlm}). Kept separate from
 * `llm.ts` so the browser-bundled reducer can import {@link llmStepApiId}
 * without pulling in `node:dns` SSRF checks.
 */

import type { TokenUsage } from "../types/events";
import { type SafeUrlOptions, assertSafeOutboundUrl } from "../util/safe-url";
import {
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  type LlmCallRequest,
  type LlmCallResult,
  resolveLlmBaseUrl,
} from "./llm";

/** Cap on the response-body excerpt echoed into error messages. */
const ERROR_BODY_CAP = 600;

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > ERROR_BODY_CAP ? `${trimmed.slice(0, ERROR_BODY_CAP)}…` : trimmed;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function tokensFromAnthropicUsage(usage: AnthropicUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

function tokensFromOpenAiUsage(usage: OpenAiUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
    output: usage.completion_tokens ?? 0,
    cacheRead: cached,
    reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

function buildRequestBody(request: LlmCallRequest): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const base = resolveLlmBaseUrl(request.provider, request.baseUrl);
  if (request.provider === "anthropic") {
    const root = base.replace(/\/v1$/, "");
    return {
      url: `${root}/v1/messages`,
      headers: {
        "content-type": "application/json",
        ...(request.apiKey ? { "x-api-key": request.apiKey } : {}),
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: request.model,
        max_tokens: request.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
        ...(request.system ? { system: request.system } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.effort ? { output_config: { effort: request.effort } } : {}),
        messages: [{ role: "user", content: request.prompt }],
      },
    };
  }
  return {
    url: `${base}/chat/completions`,
    headers: {
      "content-type": "application/json",
      ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}),
    },
    body: {
      model: request.model,
      ...(request.maxTokens !== undefined ? { max_completion_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.effort ? { reasoning_effort: request.effort } : {}),
      ...(request.jsonOutput ? { response_format: { type: "json_object" } } : {}),
      messages: [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        { role: "user", content: request.prompt },
      ],
    },
  };
}

function parseAnthropicResponse(payload: Record<string, unknown>): LlmCallResult {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
  const stopReason = typeof payload.stop_reason === "string" ? payload.stop_reason : undefined;
  const tokens = tokensFromAnthropicUsage(payload.usage as AnthropicUsage | undefined);
  if (stopReason === "refusal") {
    return {
      ok: false,
      error: "the model refused the request (stop_reason: refusal)",
      retryable: false,
    };
  }
  return { ok: true, text, tokens, stopReason };
}

function parseOpenAiResponse(payload: Record<string, unknown>): LlmCallResult {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices[0] as
    | { message?: { content?: unknown; refusal?: unknown }; finish_reason?: unknown }
    | undefined;
  const tokens = tokensFromOpenAiUsage(payload.usage as OpenAiUsage | undefined);
  const refusal = first?.message?.refusal;
  if (typeof refusal === "string" && refusal.length > 0) {
    return {
      ok: false,
      error: `the model refused the request: ${excerpt(refusal)}`,
      retryable: false,
    };
  }
  const content = first?.message?.content;
  const text = typeof content === "string" ? content : "";
  const stopReason = typeof first?.finish_reason === "string" ? first.finish_reason : undefined;
  return { ok: true, text, tokens, stopReason };
}

/**
 * Perform one stateless completion call. Never throws: every failure mode is
 * captured as `{ok: false}` with a `retryable` classification, mirroring how
 * agent attempts report transient vs. permanent failures to the engine.
 */
export async function callLlm(
  request: LlmCallRequest,
  fetchFn: typeof fetch = fetch,
  safeUrl: SafeUrlOptions = {},
): Promise<LlmCallResult> {
  let url: string;
  let headers: Record<string, string>;
  let body: Record<string, unknown>;
  try {
    ({ url, headers, body } = buildRequestBody(request));
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      retryable: false,
    };
  }

  // SSRF: allow loopback/LAN for local proxies, but never metadata/link-local.
  const safe = await assertSafeOutboundUrl(url, {
    allowLoopback: true,
    allowPrivateLan: true,
    ...safeUrl,
  });
  if (!safe.ok) {
    return { ok: false, error: `llm base URL blocked: ${safe.error}`, retryable: false };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer =
    request.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, request.timeoutMs)
      : undefined;
  const onOuterAbort = (): void => controller.abort();
  if (request.signal) {
    if (request.signal.aborted) controller.abort();
    else request.signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    const response = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        error: `${request.provider} API error ${response.status}: ${excerpt(raw) || response.statusText}`,
        status: response.status,
        retryable: retryableStatus(response.status),
      };
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        error: `${request.provider} API returned unparseable JSON: ${excerpt(raw)}`,
        retryable: false,
      };
    }
    return request.provider === "anthropic"
      ? parseAnthropicResponse(payload)
      : parseOpenAiResponse(payload);
  } catch (err) {
    if (request.signal?.aborted && !timedOut) {
      return { ok: false, error: "cancelled", retryable: false };
    }
    if (timedOut) {
      return {
        ok: false,
        error: `llm call timed out after ${Math.round((request.timeoutMs ?? 0) / 1000)}s`,
        retryable: true,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `llm call failed: ${message}`, retryable: true };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    request.signal?.removeEventListener("abort", onOuterAbort);
  }
}
