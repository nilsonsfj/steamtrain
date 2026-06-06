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
      { agent: "claude", status: "ok", binary: "claude", message: "ready" },
      {
        agent: "opencode",
        status: "binary_missing",
        binary: "opencode",
        message: "'opencode' not found on PATH",
      },
    ];
    const { lastFrame } = render(
      <StatusBar
        doctor={doctor}
        configSource="built-in defaults"
        workspaceSource="built-in workspace defaults"
        running={false}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("claude");
    expect(frame).toContain("ready");
    expect(frame).toContain("opencode");
    expect(frame).toContain("missing");
  });
});
