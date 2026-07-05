import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedAgentInstance } from "../src/agents";
import type { AgentConfigScope } from "../src/config";
import { AgentManager } from "../src/tui/AgentManager";

const ESC = "\u001b";

/** Frames carry ANSI color codes; strip them so text assertions see plain words. */
function plain(frame: string | undefined): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return (frame ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}

/** useInput subscribes in an effect; yield to the event loop before/after writes. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

async function type(stdin: { write: (data: string) => void }, ...inputs: string[]): Promise<void> {
  await tick();
  for (const input of inputs) {
    stdin.write(input);
    await tick();
  }
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
});
