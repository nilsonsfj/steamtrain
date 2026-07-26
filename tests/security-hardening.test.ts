import { describe, expect, it } from "vitest";
import { isAllowedApiBaseUrl } from "../src/config/validate";
import { redactSecrets } from "../src/util/redact";
import { compileSafeRegex, isSafeRegexPattern, safeRegexTest } from "../src/util/safe-regex";
import {
  assertSafeOutboundUrl,
  isAllowedOutboundUrl,
  isBlockedHostname,
  isBlockedIp,
} from "../src/util/safe-url";
import { shellQuote } from "../src/util/shell-quote";
import { isOutside, isValidPathId, sanitizePathComponent } from "../src/workflow/fs-util";
import { isAllowedWebhookUrl } from "../src/workflow/notify";
import { renderCmd, renderPrompt } from "../src/workflow/template";

describe("shellQuote / renderCmd", () => {
  it("quotes metacharacters for POSIX shells", () => {
    expect(shellQuote("hello", "linux")).toBe("hello");
    expect(shellQuote("a; rm -rf /", "linux")).toBe("'a; rm -rf /'");
    expect(shellQuote("it's", "linux")).toBe(`'it'\\''s'`);
  });

  it("shell-quotes interpolated cmd values by default", () => {
    const cmd = renderCmd("echo {{input}}", {
      input: "hi; curl evil.test",
      outputs: new Map(),
    });
    expect(cmd).toBe("echo 'hi; curl evil.test'");
  });

  it("leaves values raw when allowShellTemplates is set", () => {
    const cmd = renderCmd(
      "{{input}}",
      { input: "npm test", outputs: new Map() },
      { allowShellTemplates: true },
    );
    expect(cmd).toBe("npm test");
  });
});

describe("redactSecrets / renderPrompt", () => {
  it("redacts API-key-like shapes in prompt templates", () => {
    const out = renderPrompt("key={{input}}", {
      input: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
      outputs: new Map(),
    });
    expect(out).toBe("key=[REDACTED]");
    expect(redactSecrets("Bearer abcdefghijklmnopqrstuvwxyz")).toContain("[REDACTED]");
  });
});

describe("safe-regex", () => {
  it("accepts ordinary patterns and rejects nested quantifiers", () => {
    expect(isSafeRegexPattern("^clean$")).toBe(true);
    expect(isSafeRegexPattern("(a+)+$")).toBe(false);
    expect(compileSafeRegex("(a+)+").ok).toBe(false);
    expect(safeRegexTest("^ok$", "ok")).toEqual(
      expect.objectContaining({ ok: true, matched: true }),
    );
  });
});

describe("SSRF denylist", () => {
  it("blocks private / metadata IPs and hostnames", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("10.0.0.5")).toBe(true);
    expect(isBlockedIp("169.254.169.254")).toBe(true);
    expect(isBlockedIp("8.8.8.8")).toBe(false);
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
    expect(isBlockedHostname("api.openai.com")).toBe(false);
  });

  it("allows loopback for API base URLs but not webhooks", () => {
    expect(isAllowedApiBaseUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isAllowedApiBaseUrl("http://169.254.169.254/")).toBe(false);
    expect(isAllowedWebhookUrl("https://hooks.example.com/x")).toBe(true);
    expect(isAllowedWebhookUrl("http://127.0.0.1/hook")).toBe(false);
    expect(isAllowedOutboundUrl("http://10.0.0.1/x")).toBe(false);
  });

  it("assertSafeOutboundUrl resolves and rejects private addresses", async () => {
    const blocked = await assertSafeOutboundUrl("https://evil.test/x", {
      resolveHostname: async () => ["10.0.0.1"],
    });
    expect(blocked.ok).toBe(false);

    const ok = await assertSafeOutboundUrl("https://cdn.test/x", {
      resolveHostname: async () => ["93.184.216.34"],
    });
    expect(ok.ok).toBe(true);
  });
});

describe("fs-util path guards", () => {
  it("isOutside rejects both slash styles", () => {
    expect(isOutside("..")).toBe(true);
    expect(isOutside("../foo")).toBe(true);
    expect(isOutside("..\\foo")).toBe(true);
    expect(isOutside("foo/bar")).toBe(false);
  });

  it("sanitizePathComponent truncates and isValidPathId caps length", () => {
    expect(sanitizePathComponent("../a")).toBe(".._a");
    expect(sanitizePathComponent("x".repeat(300)).length).toBe(256);
    expect(isValidPathId("x".repeat(256))).toBe(true);
    expect(isValidPathId("x".repeat(257))).toBe(false);
  });
});
