import { execFileSync } from "node:child_process";
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

  it("escapes a value sitting inside double quotes instead of wrapping it", () => {
    const cmd = renderCmd(
      'echo "{{input}}"',
      { input: 'x"; rm -rf /; echo "', outputs: new Map() },
      { platform: "linux" },
    );
    expect(cmd).toBe('echo "x\\"; rm -rf /; echo \\""');
  });

  it("escapes a value sitting inside single quotes", () => {
    const cmd = renderCmd(
      "echo '{{input}}'",
      { input: "it's", outputs: new Map() },
      { platform: "linux" },
    );
    expect(cmd).toBe(`echo 'it'\\''s'`);
  });

  it("does not treat a backslash-escaped quote as opening a quoted string", () => {
    const cmd = renderCmd(
      'printf %s \\"{{input}}\\"',
      { input: "x; printf INJECTED", outputs: new Map() },
      { platform: "linux" },
    );
    const out = execFileSync("sh", ["-c", cmd], { encoding: "utf8" });
    // Injection runs a second printf and concatenates to `"xINJECTED"`.
    expect(out).toBe('"x; printf INJECTED"');
  });

  it("quotes placeholders inside $(...) for the inner quoting context", () => {
    const cmd = renderCmd(
      "printf %s \"$(printf '{{input}}')\"",
      { input: "x'; printf INJECTED; printf '", outputs: new Map() },
      { platform: "linux" },
    );
    const out = execFileSync("sh", ["-c", cmd], { encoding: "utf8" });
    expect(out).toBe("x'; printf INJECTED; printf '");
  });

  it("preserves newlines inside double quotes", () => {
    const cmd = renderCmd(
      'printf %s "{{input}}"',
      { input: "a\nb", outputs: new Map() },
      { platform: "linux" },
    );
    expect(execFileSync("sh", ["-c", cmd], { encoding: "utf8" })).toBe("a\nb");
  });

  it("does not treat a quote inside a shell comment as opening a quoted string", () => {
    if (process.platform === "win32") return;
    const cmd = renderCmd(
      "# ' ignored by sh\nprintf %s {{input}}",
      { input: "x; printf INJECTED", outputs: new Map() },
      { platform: "linux" },
    );
    const out = execFileSync("sh", ["-c", cmd], { encoding: "utf8" });
    expect(out).toBe("x; printf INJECTED");
  });

  it("does not execute later lines of a multiline value interpolated in a comment", () => {
    if (process.platform === "win32") return;
    const cmd = renderCmd(
      "# {{input}}\nprintf SAFE",
      { input: "x\nprintf INJECTED\n#", outputs: new Map() },
      { platform: "linux" },
    );
    const out = execFileSync("sh", ["-c", cmd], { encoding: "utf8" });
    expect(out).toBe("SAFE");
  });

  it("does not treat an escaped space before # as starting a comment", () => {
    if (process.platform === "win32") return;
    const cmd = renderCmd(
      "printf %s foo\\ # ' text\n'; printf %s {{input}}",
      { input: "x; printf INJECTED", outputs: new Map() },
      { platform: "linux" },
    );
    const out = execFileSync("sh", ["-c", cmd], { encoding: "utf8" });
    expect(out).toBe("foo # text\nx; printf INJECTED");
  });

  it("does not treat ${#parameter} as starting a shell comment", () => {
    if (process.platform === "win32") return;
    const cmd = renderCmd(
      'printf %s ${#} "{{input}}"',
      { input: 'x"; printf INJECTED; echo "', outputs: new Map() },
      { platform: "linux" },
    );
    expect(cmd).toBe('printf %s ${#} "x\\"; printf INJECTED; echo \\""');
    const out = execFileSync("sh", ["-c", cmd], { encoding: "utf8" });
    expect(out).toBe('0x"; printf INJECTED; echo "');
  });

  it("does not let a here-document body close early via interpolated input", () => {
    if (process.platform === "win32") return;
    const cmd = renderCmd(
      "cat <<END\n{{input}}\nEND",
      { input: "x\nEND\nprintf INJECTED\n#", outputs: new Map() },
      { platform: "linux" },
    );
    const out = execFileSync("sh", ["-c", cmd], { encoding: "utf8" });
    expect(out).toBe("x\nEND\nprintf INJECTED\n#\n");
  });

  it("does not let template text before a placeholder complete a here-document delimiter", () => {
    if (process.platform === "win32") return;
    const cmd = renderCmd(
      "cat <<END\nE{{input}}\nEND",
      { input: "ND\nprintf INJECTED\n#", outputs: new Map() },
      { platform: "linux" },
    );
    const out = execFileSync("sh", ["-c", cmd], { encoding: "utf8" });
    expect(out).toBe("END\nprintf INJECTED\n#\n");
  });

  it("does not let template text after a placeholder complete a here-document delimiter", () => {
    if (process.platform === "win32") return;
    const cmd = renderCmd(
      "cat <<END\n{{input}}D\nprintf INJECTED\nEND",
      { input: "EN", outputs: new Map() },
      { platform: "linux" },
    );
    const out = execFileSync("sh", ["-c", cmd], { encoding: "utf8" });
    expect(out).toBe("END\nprintf INJECTED\n");
  });

  it("preserves dollar signs, backticks, and backslashes in unquoted here-documents", () => {
    if (process.platform === "win32") return;
    const run = (input: string): string => {
      const cmd = renderCmd(
        "cat <<END\n{{input}}\nEND",
        { input, outputs: new Map() },
        { platform: "linux" },
      );
      return execFileSync("sh", ["-c", cmd], { encoding: "utf8" });
    };
    expect(run("price $5")).toBe("price $5\n");
    expect(run("a`b")).toBe("a`b\n");
    expect(run("a\\b")).toBe("a\\b\n");
  });

  it("keeps unquoted here-document expansions on other body lines", () => {
    if (process.platform === "win32") return;
    const cmd = renderCmd(
      "cat <<END\n$HOME\n{{input}}\nEND",
      { input: "hello", outputs: new Map() },
      { platform: "linux" },
    );
    const out = execFileSync("sh", ["-c", cmd], {
      encoding: "utf8",
      env: { ...process.env, HOME: "/tmp/st-home" },
    });
    expect(out).toBe("/tmp/st-home\nhello\n");
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

  it("rejects quantified alternations with three or more branches", () => {
    expect(isSafeRegexPattern("(a|b|a)+")).toBe(false);
    expect(isSafeRegexPattern("(foo|bar|foo)*")).toBe(false);
  });

  it("reuses a compiled regex across repeated safeRegexTest calls", () => {
    const first = compileSafeRegex("^lap-\\d+$");
    const second = compileSafeRegex("^lap-\\d+$");
    expect(first.ok && second.ok && first.regex === second.regex).toBe(true);
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
