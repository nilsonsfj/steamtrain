import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { DoctorResult } from "../src/doctor";
import { StatusBar } from "../src/tui/StatusBar";
import { Banner } from "../src/tui/banner";

describe("TUI components", () => {
  it("renders the startup banner art", () => {
    const { lastFrame } = render(<Banner />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("orchestrator");
    expect(frame).toContain("(O)");
  });

  it("renders per-agent doctor status in the status bar", () => {
    const doctor: DoctorResult[] = [
      { agent: "claude", provider: "claude", status: "ok", binary: "claude", message: "ready" },
      {
        agent: "opencode",
        provider: "opencode",
        status: "binary_missing",
        binary: "opencode",
        message: "'opencode' not found on PATH",
      },
      {
        agent: "codex",
        provider: "codex",
        status: "not_authenticated",
        binary: "codex",
        message: "not authenticated",
      },
    ];
    const { lastFrame } = render(
      <StatusBar
        doctor={doctor}
        apiDoctor={null}
        configSource="defaults"
        workspaceLabel="user"
        running={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("claude");
    expect(frame).toContain("ready");
    expect(frame).toContain("opencode");
    expect(frame).toContain("codex");
    expect(frame).toContain("missing");
  });

  it("renders api readiness after the agents", () => {
    const { lastFrame } = render(
      <StatusBar
        doctor={[]}
        apiDoctor={[
          {
            api: "anthropic",
            provider: "anthropic",
            status: "ok",
            keyEnv: "ANTHROPIC_API_KEY",
            baseUrl: "https://api.anthropic.com",
            message: "ready",
          },
          {
            api: "openai",
            provider: "openai",
            status: "key_missing",
            keyEnv: "OPENAI_API_KEY",
            baseUrl: "https://api.openai.com/v1",
            message: "OPENAI_API_KEY not set",
          },
        ]}
        configSource="defaults"
        workspaceLabel="user"
        running={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("anthropic");
    expect(frame).toContain("ready");
    expect(frame).toContain("openai");
    expect(frame).toContain("no key");
  });

  it("wraps a crowded status bar to two lines and hides the overflow", () => {
    const doctor = ["opencode", "codex", "amp", "kiro", "gemini", "cursor"].map(
      (agent) =>
        ({
          agent,
          provider: "claude",
          status: "ok",
          binary: agent,
          message: "ready",
        }) as DoctorResult,
    );
    const apiDoctor = ["anthropic", "openai", "openrouter", "opencode-zen", "groq", "together"].map(
      (api) => ({
        api,
        provider: "openai" as const,
        status: "key_missing" as const,
        keyEnv: "KEY",
        baseUrl: "https://x",
        message: "no key",
      }),
    );
    const { lastFrame } = render(
      <StatusBar
        doctor={doctor}
        apiDoctor={apiDoctor}
        configSource="user+project"
        workspaceLabel="user"
        running={false}
      />,
    );
    // Strip ANSI, keep only the bordered content rows (drop the top/bottom rules).
    const rows = (lastFrame() ?? "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
      .replace(/\[[0-9;]*m/g, "")
      .split("\n")
      .filter((line) => line.startsWith("│"));
    // Never more than two status lines — overflow is dropped, not wrapped onto a third.
    expect(rows.length).toBe(2);
    // The dropped items are summarized by a "+N" marker rather than silently vanishing.
    expect(rows.join("\n")).toMatch(/\+\d+/);
    // Overflow items are hidden entirely, not split across the line boundary.
    expect(rows.join("\n")).not.toContain("together");
  });
});
