import { type ResolvedApiInstance, resolveApiInstances } from "../apis/config";
import type { SteamtrainConfig } from "../config/types";
import type { ApiInstanceId, ApiProviderId } from "../types/events";
import { resolveLlmBaseUrl } from "../workflow/llm";

/**
 * Readiness checks for configured LLM API endpoint instances — the
 * direct-inference analog of the agent doctor. Where the agent doctor resolves
 * a binary and runs `--version`, the API doctor checks the instance's key env
 * var and probes the endpoint's models listing with a short timeout, so the
 * status surfaces (TUI status bar, web health chips, `/api/doctor`) can show
 * "ready / no key / auth rejected / unreachable" per instance.
 */

export type ApiDoctorStatus =
  | "ok"
  | "key_missing"
  | "not_authenticated"
  | "unreachable"
  | "unknown_error";

export interface ApiDoctorResult {
  api: ApiInstanceId;
  provider: ApiProviderId;
  label?: string;
  status: ApiDoctorStatus;
  /** Env var the key was looked up in. */
  keyEnv: string;
  /** Effective endpoint base the probe targeted. */
  baseUrl: string;
  /** Short status line for the panel. */
  message: string;
  /** Actionable fix-it hint when not ok. */
  detail?: string;
  /**
   * A copyable shell command that resolves `detail` when one exists — for
   * `key_missing`, the `export <ENV>=…` scaffold. Structured (not scraped from
   * `detail`) so the TUI and web setup panel can offer a one-click copy.
   */
  fixCommand?: string;
}

const PROBE_TIMEOUT_MS = 5000;
/** Cap on the response-body excerpt echoed into error details. */
const PROBE_BODY_CAP = 200;

function excerpt(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > PROBE_BODY_CAP ? `${trimmed.slice(0, PROBE_BODY_CAP)}…` : trimmed;
}

/**
 * The provider's model-listing URL + auth headers: a cheap authenticated GET
 * every major provider (and most OpenAI-compatible proxies) supports. The
 * Anthropic base tolerates a `/v1` suffix exactly like the completion path
 * builder in `workflow/llm.ts` does.
 */
function probeRequest(
  instance: ResolvedApiInstance,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  const base = resolveLlmBaseUrl(instance.provider, instance.baseUrl);
  if (instance.provider === "anthropic") {
    const root = base.replace(/\/v1$/, "");
    return {
      url: `${root}/v1/models`,
      headers: {
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        "anthropic-version": "2023-06-01",
      },
    };
  }
  return {
    url: `${base}/models`,
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  };
}

/** Check one API instance: key present, then a bounded endpoint probe. */
export async function checkApi(
  instance: ResolvedApiInstance,
  options: {
    fetchFn?: typeof fetch;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<ApiDoctorResult> {
  const env = options.env ?? process.env;
  const fetchFn = options.fetchFn ?? fetch;
  const base = {
    api: instance.id,
    provider: instance.provider,
    label: instance.configured ? instance.label : undefined,
    keyEnv: instance.apiKeyEnv,
    baseUrl: resolveLlmBaseUrl(instance.provider, instance.baseUrl, env),
  };

  const apiKey = env[instance.apiKeyEnv];
  if (!apiKey) {
    if (instance.keyless) {
      // A keyless instance is ready without a key; don't ping the third-party
      // endpoint unsolicited on every save/startup. Setting the key opts into
      // the auth-validating probe below (and higher rate limits at the gateway).
      return { ...base, status: "ok", message: "ready (keyless)" };
    }
    return {
      ...base,
      status: "key_missing",
      message: `${instance.apiKeyEnv} not set`,
      detail: `Set ${instance.apiKeyEnv} (or point apiKeyEnv at another variable) to enable llm steps on '${instance.id}'.`,
      fixCommand: `export ${instance.apiKeyEnv}=…`,
    };
  }

  const { url, headers } = probeRequest(instance, apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  timer.unref?.();
  let response: Response;
  try {
    response = await fetchFn(url, { method: "GET", headers, signal: controller.signal });
  } catch (err) {
    const reason = controller.signal.aborted
      ? `probe timed out after ${Math.round(PROBE_TIMEOUT_MS / 1000)}s`
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      ...base,
      status: "unreachable",
      message: "endpoint unreachable",
      detail: `GET ${url} failed: ${reason}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ...base,
      status: "not_authenticated",
      message: "key rejected",
      detail: `The key in ${instance.apiKeyEnv} was rejected by ${base.baseUrl} (HTTP ${response.status}).`,
    };
  }
  if (response.ok) {
    return { ...base, status: "ok", message: "ready" };
  }
  if (response.status === 404 || response.status === 405 || response.status === 429) {
    // Reachable and the key was not rejected: proxies without a models
    // listing (404/405) and rate limits (429) are not readiness failures.
    return {
      ...base,
      status: "ok",
      message: response.status === 429 ? "ready (rate limited)" : "ready (no models endpoint)",
    };
  }
  const body = await response.text().catch(() => "");
  return {
    ...base,
    status: "unknown_error",
    message: `endpoint error ${response.status}`,
    detail: excerpt(body) || `GET ${url} returned HTTP ${response.status}.`,
  };
}

/** Run readiness checks for all enabled API instances (honoring config overrides). */
export function runApiDoctor(
  config: SteamtrainConfig | undefined,
  options: { fetchFn?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<ApiDoctorResult[]> {
  return Promise.all(resolveApiInstances(config).map((instance) => checkApi(instance, options)));
}
