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
      {
        category: "agent",
        agent: "claude",
        provider: "claude",
        status: "ok",
        binary: "claude",
        message: "ready",
      },
      {
        category: "agent",
        agent: "opencode",
        provider: "opencode",
        status: "binary_missing",
        binary: "opencode",
        message: "'opencode' not found on PATH",
      },
      {
        category: "agent",
        agent: "codex",
        provider: "codex",
        status: "not_authenticated",
        binary: "codex",
        message: "not authenticated",
      },
    ];
    const { lastFrame } = render(
      <StatusBar doctor={doctor} configSource="defaults" workspaceLabel="user" running={false} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("claude");
    expect(frame).toContain("ready");
    expect(frame).toContain("opencode");
    expect(frame).toContain("codex");
    expect(frame).toContain("missing");
  });

  it("renders llm-key doctor entries with env var name", () => {
    const doctor: DoctorResult[] = [
      {
        category: "llm-key",
        provider: "anthropic",
        requirement: "ANTHROPIC_API_KEY",
        status: "api_key_missing",
        message: "ANTHROPIC_API_KEY not set",
        detail: "Set ANTHROPIC_API_KEY in the environment.",
      },
      {
        category: "llm-key",
        provider: "openai",
        requirement: "OPENAI_API_KEY",
        status: "ok",
        message: "OPENAI_API_KEY set",
      },
    ];
    const { lastFrame } = render(
      <StatusBar doctor={doctor} configSource="defaults" workspaceLabel="user" running={false} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ANTHROPIC_API_KEY");
    expect(frame).toContain("OPENAI_API_KEY");
    expect(frame).toContain("no key");
  });
});
