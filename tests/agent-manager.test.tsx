import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedAgentInstance } from "../src/agents";
import type { AgentConfigScope } from "../src/config";
import { AgentManager } from "../src/tui/AgentManager";
import { tick, type } from "./helpers/ink-input";

const ESC = "\u001b";

/** Frames carry ANSI color codes; strip them so text assertions see plain words. */
function plain(frame: string | undefined): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return (frame ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}

const agents: ResolvedAgentInstance[] = [
  {
    id: "claude",
    provider: "claude",
    label: "claude",
    enabled: true,
    binary: "claude",
    configured: false,
  },
  {
    id: "mimocode",
    provider: "opencode",
    label: "mimocode",
    enabled: true,
    binary: "mimocode",
    configured: true,
  },
  {
    id: "codex",
    provider: "codex",
    label: "codex",
    enabled: false,
    binary: "codex",
    configured: true,
  },
];

const scopes = new Map<string, AgentConfigScope>([
  ["mimocode", "user"],
  ["codex", "project"],
]);

function renderManager(overrides: Partial<Parameters<typeof AgentManager>[0]> = {}) {
  const ok = vi.fn().mockReturnValue({ ok: true });
  return render(
    <AgentManager
      agents={agents}
      scopes={scopes}
      canGlobal={true}
      width={100}
      height={20}
      onToggle={ok}
      onAdd={ok}
      onDelete={ok}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

describe("AgentManager", () => {
  it("lists agents with scope, enabled state, and binary", () => {
    const { lastFrame } = renderManager();
    const frame = plain(lastFrame());
    expect(frame).toContain("agents");
    expect(frame).toMatch(/claude\s+builtin/);
    expect(frame).toMatch(/mimocode\s+global/);
    expect(frame).toMatch(/codex\s+project disabled/);
    expect(frame).toContain("binary=mimocode");
    expect(frame).toContain("a add");
  });

  it("toggles the selected agent on Enter", async () => {
    const onToggle = vi.fn().mockReturnValue({ ok: true, text: "claude disabled (global)" });
    const { stdin, lastFrame } = renderManager({ onToggle });
    await type(stdin, "\r");
    expect(onToggle).toHaveBeenCalledWith("claude");
    expect(plain(lastFrame())).toContain("claude disabled (global)");
  });

  it("opens the add form on 'a'", async () => {
    const { stdin, lastFrame } = renderManager();
    await type(stdin, "a");
    const frame = plain(lastFrame());
    expect(frame).toContain("add agent");
    expect(frame).toContain("instance id");
    expect(frame).toContain("Enter next/save");
  });

  it("submits the add form with typed id and default scope", async () => {
    const onAdd = vi.fn().mockReturnValue({ ok: true, text: "fork added (global)" });
    const { stdin, lastFrame } = renderManager({ onAdd });
    await type(stdin, "a", "f", "o", "r", "k", "\r", "\r", "\r", "\r");
    expect(onAdd).toHaveBeenCalledWith({ id: "fork", provider: "claude", scope: "user" });
    expect(plain(lastFrame())).toContain("fork added (global)");
  });

  it("cycles provider and scope with arrow keys in the add form", async () => {
    const onAdd = vi.fn().mockReturnValue({ ok: true });
    const { stdin } = renderManager({ onAdd });
    // id "x", then →: provider claude → opencode; on scope, →: global → project.
    await type(stdin, "a", "x", "\r", `${ESC}[C`, "\r", "\r", `${ESC}[C`, "\r");
    expect(onAdd).toHaveBeenCalledWith({ id: "x", provider: "opencode", scope: "project" });
  });

  it("keeps the scope on project when the global layer is unavailable", async () => {
    const onAdd = vi.fn().mockReturnValue({ ok: true });
    const { stdin, lastFrame } = renderManager({ onAdd, canGlobal: false });
    await type(stdin, "a", "x", "\r", "\r", "\r", `${ESC}[C`);
    expect(plain(lastFrame())).toContain("global scope unavailable with a custom --config");
    await type(stdin, "\r");
    expect(onAdd).toHaveBeenCalledWith({ id: "x", provider: "claude", scope: "project" });
  });

  it("rejects an empty id in the add form", async () => {
    const onAdd = vi.fn();
    const { stdin, lastFrame } = renderManager({ onAdd });
    await type(stdin, "a", "\r"); // open the form and submit with no id typed
    expect(onAdd).not.toHaveBeenCalled();
    expect(plain(lastFrame())).toContain("agent id must not be empty");
  });

  it("refuses to delete an unconfigured built-in", async () => {
    const onDelete = vi.fn();
    const { stdin, lastFrame } = renderManager({ onDelete });
    await type(stdin, "d"); // selection starts on 'claude' (builtin)
    expect(onDelete).not.toHaveBeenCalled();
    expect(plain(lastFrame())).toContain("built-in default");
  });

  it("deletes a configured agent after confirmation", async () => {
    const onDelete = vi.fn().mockReturnValue({ ok: true, text: "mimocode removed (global)" });
    const { stdin, lastFrame } = renderManager({ onDelete });
    await type(stdin, `${ESC}[B`, "d"); // down to mimocode, then delete
    expect(plain(lastFrame())).toContain("delete 'mimocode'? y/n");
    await type(stdin, "y");
    expect(onDelete).toHaveBeenCalledWith("mimocode");
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    const { stdin } = renderManager({ onClose });
    await type(stdin, ESC);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows readiness per row and the fix for the selected not-ready agent", () => {
    const { lastFrame } = renderManager({
      doctor: [
        {
          agent: "claude",
          provider: "claude",
          status: "binary_missing",
          binary: "claude",
          message: "'claude' not found on PATH",
          detail:
            "Install Claude Code (npm i -g @anthropic-ai/claude-code) and ensure `claude` is on PATH.",
          fixCommand: "npm i -g @anthropic-ai/claude-code",
        },
        {
          agent: "mimocode",
          provider: "opencode",
          status: "ok",
          binary: "mimocode",
          version: "opencode 1.2.3",
          message: "ready",
        },
      ],
      onRecheck: vi.fn(),
    });
    const frame = plain(lastFrame());
    // Per-row readiness labels + version for the healthy one.
    expect(frame).toContain("not installed");
    expect(frame).toMatch(/mimocode\s+ready/);
    expect(frame).toContain("v=opencode 1.2.3");
    // The selected (claude) agent's fix and copyable command.
    expect(frame).toContain("fix claude:");
    expect(frame).toContain("$ npm i -g @anthropic-ai/claude-code");
    // Readiness summary + recheck hint in the header.
    expect(frame).toContain("1/2 ready");
    expect(frame).toContain("r recheck");
  });

  it("re-runs the doctor on 'r'", async () => {
    const onRecheck = vi.fn();
    const { stdin } = renderManager({ onRecheck });
    await type(stdin, "r");
    expect(onRecheck).toHaveBeenCalled();
  });
});
