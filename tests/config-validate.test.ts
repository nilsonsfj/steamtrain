import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isAllowedApiBaseUrl,
  isValidApiKeyEnvName,
  resolveBinarySync,
} from "../src/config/validate";

describe("isAllowedApiBaseUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isAllowedApiBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(isAllowedApiBaseUrl("http://127.0.0.1:11434/v1")).toBe(true);
  });

  it("rejects non-http schemes and malformed URLs", () => {
    expect(isAllowedApiBaseUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedApiBaseUrl("data:text/plain,hi")).toBe(false);
    expect(isAllowedApiBaseUrl("not a url")).toBe(false);
    expect(isAllowedApiBaseUrl("")).toBe(false);
  });
});

describe("isValidApiKeyEnvName", () => {
  it("accepts standard env var names including API key vars", () => {
    expect(isValidApiKeyEnvName("ANTHROPIC_API_KEY")).toBe(true);
    expect(isValidApiKeyEnvName("GROQ_API_KEY")).toBe(true);
    expect(isValidApiKeyEnvName("_PRIVATE")).toBe(true);
  });

  it("rejects invalid env var names", () => {
    expect(isValidApiKeyEnvName("")).toBe(false);
    expect(isValidApiKeyEnvName("lowercase")).toBe(false);
    expect(isValidApiKeyEnvName("MixedCase")).toBe(false);
    expect(isValidApiKeyEnvName("1BAD")).toBe(false);
    expect(isValidApiKeyEnvName("HAS=EQ")).toBe(false);
    expect(isValidApiKeyEnvName("HAS SPACE")).toBe(false);
    expect(isValidApiKeyEnvName("path/../SECRET")).toBe(false);
  });
});

describe("resolveBinarySync", () => {
  it("resolves an absolute executable path", () => {
    const dir = mkdtempSync(join(tmpdir(), "steamtrain-bin-"));
    const bin = join(dir, "tool");
    writeFileSync(bin, "#!/bin/sh\necho ok\n");
    chmodSync(bin, 0o755);
    expect(resolveBinarySync(bin)).toBe(bin);
  });

  it("returns undefined for a missing absolute path", () => {
    expect(resolveBinarySync("/tmp/steamtrain-definitely-missing-binary")).toBeUndefined();
  });
});
