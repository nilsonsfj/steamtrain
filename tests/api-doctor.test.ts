import { describe, expect, it } from "vitest";
import { defaultApiInstance, resolveApiInstance } from "../src/apis";
import type { SteamtrainConfig } from "../src/config";
import { checkApi, runApiDoctor } from "../src/doctor";

const ENV = { ANTHROPIC_API_KEY: "sk-ant-test", GROQ_API_KEY: "gsk-test" };

function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body?: string },
): { fetchFn: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const out = handler(url, init);
    return new Response(out.body ?? "{}", { status: out.status });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("api doctor", () => {
  it("reports key_missing without touching the network", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200 }));
    const result = await checkApi(defaultApiInstance("openai"), { fetchFn, env: {} });
    expect(result.status).toBe("key_missing");
    expect(result.keyEnv).toBe("OPENAI_API_KEY");
    expect(result.detail).toContain("OPENAI_API_KEY");
    expect(calls).toHaveLength(0);
  });

  it("probes the anthropic models endpoint with the key headers and reports ok", async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200 }));
    const result = await checkApi(defaultApiInstance("anthropic"), { fetchFn, env: ENV });
    expect(result.status).toBe("ok");
    expect(result.message).toBe("ready");
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBeDefined();
  });

  it("probes an OpenAI-compatible instance at its configured base URL", async () => {
    const config: SteamtrainConfig = {
      apis: [
        {
          id: "groq",
          provider: "openai",
          baseUrl: "https://api.groq.com/openai/v1",
          apiKeyEnv: "GROQ_API_KEY",
        },
      ],
    };
    const instance = resolveApiInstance(config, "groq");
    expect(instance).toBeDefined();
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200 }));
    const result = await checkApi(instance!, { fetchFn, env: ENV });
    expect(result.status).toBe("ok");
    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/models");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer gsk-test");
  });

  it("classifies 401/403 as not_authenticated with an actionable hint", async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 401 }));
    const result = await checkApi(defaultApiInstance("anthropic"), { fetchFn, env: ENV });
    expect(result.status).toBe("not_authenticated");
    expect(result.detail).toContain("ANTHROPIC_API_KEY");
  });

  it("treats a missing models endpoint and rate limits as ready", async () => {
    const notFound = fakeFetch(() => ({ status: 404 }));
    expect(
      (await checkApi(defaultApiInstance("anthropic"), { fetchFn: notFound.fetchFn, env: ENV }))
        .status,
    ).toBe("ok");
    const limited = fakeFetch(() => ({ status: 429 }));
    const result = await checkApi(defaultApiInstance("anthropic"), {
      fetchFn: limited.fetchFn,
      env: ENV,
    });
    expect(result.status).toBe("ok");
    expect(result.message).toContain("rate limited");
  });

  it("classifies network failures as unreachable and 5xx as unknown_error", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const down = await checkApi(defaultApiInstance("anthropic"), { fetchFn: failing, env: ENV });
    expect(down.status).toBe("unreachable");
    expect(down.detail).toContain("ECONNREFUSED");

    const broken = fakeFetch(() => ({ status: 500, body: "internal error" }));
    const errored = await checkApi(defaultApiInstance("anthropic"), {
      fetchFn: broken.fetchFn,
      env: ENV,
    });
    expect(errored.status).toBe("unknown_error");
    expect(errored.message).toContain("500");
  });

  it("checks every enabled instance (and skips disabled ones)", async () => {
    const config: SteamtrainConfig = {
      apis: [
        { id: "openai", provider: "openai", enabled: false },
        { id: "groq", provider: "openai", apiKeyEnv: "GROQ_API_KEY" },
      ],
    };
    const { fetchFn } = fakeFetch(() => ({ status: 200 }));
    const results = await runApiDoctor(config, { fetchFn, env: ENV });
    expect(results.map((r) => r.api)).toEqual(["anthropic", "groq"]);
    expect(results.every((r) => r.status === "ok")).toBe(true);
  });
});
