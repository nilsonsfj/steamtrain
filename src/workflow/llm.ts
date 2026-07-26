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
 * which defaults to {@link callLlm} in `llm-call.ts`, so unit tests never touch the network.
 * Browser-safe: this module has no Node builtins so the web reducer can import
 * {@link llmStepApiId} without pulling in DNS/SSRF machinery.
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
  /** API key; an empty string means keyless (no auth header sent), for gateways like opencode-zen. */
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
 * Does not perform DNS/SSRF checks — {@link callLlm} validates before fetch.
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
