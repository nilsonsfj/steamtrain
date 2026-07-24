import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { DoctorResult } from "../src/doctor";
import type { ProjectIdentity } from "../src/project";
import { StatusBar } from "../src/tui/StatusBar";
import { Banner } from "../src/tui/banner";

const DEMO_PROJECT: ProjectIdentity = {
  cwd: "/home/dev/code/demo",
  name: "demo",
  displayPath: "~/code/demo",
  nameSource: "directory",
};

describe("TUI components", () => {
  it("renders the startup banner art with project identity", () => {
    const { lastFrame } = render(<Banner project={DEMO_PROJECT} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("orchestrator");
    expect(frame).toContain("(O)");
    expect(frame).toContain("demo");
    expect(frame).toContain("~/code/demo");
    expect(frame).toContain("project ready");
  });

  it("renders the banner art without a project prop", () => {
    const { lastFrame } = render(<Banner />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("orchestrator");
    expect(frame).toContain("(O)");
    expect(frame).not.toContain("project ready");
  });

  it("leads with ready agents and omits not-installed ones", () => {
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
      {
        agent: "amp",
        provider: "amp",
        status: "binary_missing",
        binary: "amp",
        message: "'amp' not found on PATH",
      },
    ];
    const { lastFrame } = render(
      <StatusBar
        doctor={doctor}
        apiDoctor={null}
        project={DEMO_PROJECT}
        configSource="defaults"
        workspaceLabel="user"
        running={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("claude");
    expect(frame).toContain("ready");
    // Auth problems on installed agents stay visible — they're actionable.
    expect(frame).toContain("codex");
    // Not-installed agents are omitted entirely (no tally, no chips).
    expect(frame).not.toContain("opencode");
    expect(frame).not.toContain("missing");
    expect(frame).not.toContain("not installed");
    // Project identity is always on screen.
    expect(frame).toContain("demo");
    expect(frame).toContain("~/code/demo");
    expect(frame).toContain("ws:");
  });

  it("shows a setup nudge when no agent is installed at all", () => {
    const doctor: DoctorResult[] = ["claude", "opencode"].map(
      (agent) =>
        ({
          agent,
          provider: "claude",
          status: "binary_missing",
          binary: agent,
          message: "not found",
        }) as DoctorResult,
    );
    const { lastFrame } = render(
      <StatusBar
        doctor={doctor}
        apiDoctor={null}
        project={DEMO_PROJECT}
        configSource="defaults"
        workspaceLabel="user"
        running={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("no agents installed — Ctrl+A to set up");
    expect(frame).not.toContain("claude");
  });

  it("renders ready APIs and collapses unset keys into a summary", () => {
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
        project={DEMO_PROJECT}
        configSource="defaults"
        workspaceLabel="user"
        running={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("anthropic");
    expect(frame).toContain("ready");
    // Unset keys are the normal state — collapsed, not itemized.
    expect(frame).not.toContain("openai");
    expect(frame).toContain("1 without keys");
  });

  it("splits agents and APIs onto their own lines and hides the overflow", () => {
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
        status: "ok" as const,
        keyEnv: "KEY",
        baseUrl: "https://x",
        message: "ready",
      }),
    );
    const { lastFrame } = render(
      <StatusBar
        doctor={doctor}
        apiDoctor={apiDoctor}
        project={DEMO_PROJECT}
        configSource="user+project"
        workspaceLabel="user"
        running={false}
      />,
    );
    // Strip ANSI, keep only the bordered content rows (drop the top/bottom rules).
    const rows = (lastFrame() ?? "")
      .replace(/\[[0-9;]*m/g, "")
      .split("\n")
      .filter((line) => line.startsWith("│"));
    // Exactly two status lines: one for agents, one for APIs.
    expect(rows.length).toBe(2);
    const [agentRow, apiRow] = rows as [string, string];
    // Agents live on the first line, APIs on the second — no intermixing.
    expect(agentRow).toContain("opencode");
    expect(agentRow).not.toContain("anthropic");
    expect(apiRow).toContain("anthropic");
    expect(apiRow).not.toContain("opencode ready");
    // Each overcrowded line drops its own overflow behind a "+N" marker.
    expect(agentRow).toMatch(/\+\d+/);
    expect(apiRow).toMatch(/\+\d+/);
    // Overflow items are hidden entirely, not split across the line boundary.
    expect(rows.join("\n")).not.toContain("together");
  });
});
