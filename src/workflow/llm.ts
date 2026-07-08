import type { ApiProviderId, TokenUsage } from "../types/events";

/**
 * Direct LLM inference for `llm` workflow steps: one stateless HTTP call to an
 * Anthropic or OpenAI-compatible chat-completions endpoint. This is the
 * middle tier between a deterministic `command` step and a full coding-agent
 * subprocess — no worktree, no agent CLI, no doctor preflight, near-zero
 * startup, and exact token accounting straight from the API's `usage` block.
 *
 * Deliberately dependency-free (plain `fetch`, built into Node 20+/Bun) and
 * transport-injectable: the engine calls through `WorkflowDeps.llmComplete`,
 * which defaults to {@link callLlm}, so unit tests never touch the network.
 */

export type LlmProviderId = ApiProviderId;

/**
 * Default Anthropic `max_tokens` when the step doesn't set one. The Anthropic
 * Messages API requires the field; 16k keeps non-streaming requests safely
 * under HTTP timeouts while leaving ample room for judge/consolidate outputs.
 * OpenAI-compatible endpoints get no cap unless the step sets `maxTokens`
 * (their field is optional, and reasoning models reject small caps).
 */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 16000;

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** OpenAI convention: the base URL includes the `/v1` path segment. */
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Cap on the response-body excerpt echoed into error messages. */
const ERROR_BODY_CAP = 600;

export interface LlmCallRequest {
  provider: LlmProviderId;
  /** Model id in the provider's own format (`claude-…`, `gpt-…`, `llama-…`). */
  model: string;
  /** Fully rendered user prompt (templates already resolved). */
  prompt: string;
  /** Optional system prompt. */
  system?: string;
  /** Output-token cap. Anthropic defaults to {@link DEFAULT_ANTHROPIC_MAX_TOKENS}; OpenAI omits the field when unset. */
  maxTokens?: number;
  /** Sampling temperature. Only sent when set (recent Anthropic models reject it). */
  temperature?: number;
  /** Reasoning effort: Anthropic `output_config.effort`, OpenAI `reasoning_effort`. */
  effort?: string;
  /** Endpoint override for proxies / OpenAI-compatible providers. */
  baseUrl?: string;
  apiKey: string;
  /**
   * Ask the endpoint for JSON-only output where the API supports it (OpenAI
   * `response_format: {type: "json_object"}`). Set when the step declares an
   * `output` schema; the engine still validates locally against the schema.
   */
  jsonOutput?: boolean;
  /** Wall-clock limit for the HTTP call. */
  timeoutMs?: number;
  /** Run-level cancellation. */
  signal?: AbortSignal;
}

export type LlmCallResult =
  | { ok: true; text: string; tokens?: TokenUsage; stopReason?: string }
  | {
      ok: false;
      error: string;
      /** HTTP status, when the endpoint responded at all. */
      status?: number;
      /**
       * Whether the engine may retry. LLM steps are stateless (a failed call
       * changed nothing), so this is purely "is the failure plausibly
       * transient": rate limits, 5xx, network errors, timeouts.
       */
      retryable: boolean;
    };

/** The transport the engine calls; injected via `WorkflowDeps.llmComplete` in tests. */
export type LlmComplete = (request: LlmCallRequest) => Promise<LlmCallResult>;

/**
 * Resolve a step's provider: explicit `provider` wins; otherwise `claude-*`
 * models default to Anthropic and everything else to the OpenAI-compatible
 * wire format (which is what Groq / Together / Ollama / vLLM etc. all speak).
 * Steps that name neither (possible only with an `api` reference, whose
 * instance then supplies the provider) fall back to the OpenAI wire format.
 */
export function resolveLlmProvider(step: {
  provider?: LlmProviderId;
  model?: string;
}): LlmProviderId {
  if (step.provider) return step.provider;
  return step.model?.startsWith("claude") ? "anthropic" : "openai";
}

/**
 * The API instance id an `llm` step is attributed to, without needing config:
 * its explicit `api` reference, else the built-in id for its inferred
 * provider. Used for usage/cost attribution and static plan/preview display,
 * where the merged config may not be at hand — for steps that resolve
 * successfully this matches `resolveLlmStepApi(...).api.id`. Lives here (not
 * in `src/apis`) so the browser-bundled reducer can import it without pulling
 * in the config machinery.
 */
export function llmStepApiId(step: {
  api?: string;
  provider?: LlmProviderId;
  model?: string;
}): string {
  return step.api ?? resolveLlmProvider(step);
}

/** Env var the API key is read from: step override, else the provider's convention. */
export function llmApiKeyEnvName(provider: LlmProviderId, override?: string): string {
  if (override) return override;
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
}

/**
 * Effective endpoint base: step `baseUrl`, else the provider's conventional
 * env override (`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`), else the public API.
 */
export function resolveLlmBaseUrl(
  provider: LlmProviderId,
  override: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = provider === "anthropic" ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL;
  const base =
    override ??
    fromEnv ??
    (provider === "anthropic" ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL);
  return base.replace(/\/+$/, "");
}

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
    // OpenAI's prompt_tokens INCLUDES cached tokens; split them out so the
    // categories match steamtrain's convention (input = uncached).
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
    // Tolerate a base URL that already ends in /v1 (the OpenAI convention,
    // and what LiteLLM-style proxies expose) — appending /v1/messages to it
    // would produce a /v1/v1/messages 404.
    const root = base.replace(/\/v1$/, "");
    return {
      url: `${root}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": request.apiKey,
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
      authorization: `Bearer ${request.apiKey}`,
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
    // A refusal is a definitive answer from the model, not a transport
    // failure — retrying the identical request would just refuse again.
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
): Promise<LlmCallResult> {
  const { url, headers, body } = buildRequestBody(request);

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
    // A request that never reached the endpoint (DNS, connect reset, …)
    // changed nothing on the other side — always safe to retry.
    return { ok: false, error: `llm call failed: ${message}`, retryable: true };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    request.signal?.removeEventListener("abort", onOuterAbort);
  }
}
