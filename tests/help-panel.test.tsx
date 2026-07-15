import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { listSlashCommands } from "../src/commands";
import { HelpPanel } from "../src/tui/HelpPanel";

describe("HelpPanel", () => {
  it("renders keybindings and every registered slash command", () => {
    const { lastFrame } = render(<HelpPanel width={120} height={60} />);
    const frame = lastFrame() ?? "";

    expect(frame).toContain("help");
    expect(frame).toContain("Esc close");
    expect(frame).toContain("keys");
    expect(frame).toContain("Ctrl+D");
    expect(frame).toContain("dry-run");
    expect(frame).toContain("pause/resume");

    expect(frame).toContain("commands");
    for (const command of listSlashCommands()) {
      expect(frame).toContain(`/${command.name}`);
    }
  });

  it("clips on short terminals instead of overflowing", () => {
    const { lastFrame } = render(<HelpPanel width={100} height={12} />);
    const frame = lastFrame() ?? "";

    expect(frame).toContain("lines hidden");
    // The rendered frame must fit the requested height (plus nothing extra).
    expect(frame.split("\n").length).toBeLessThanOrEqual(13);
  });
});
