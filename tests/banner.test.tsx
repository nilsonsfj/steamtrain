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
});
