import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedApiInstance } from "../src/apis";
import type { ApiConfigScope } from "../src/config";
import { ApiManager } from "../src/tui/ApiManager";

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

const apis: ResolvedApiInstance[] = [
  {
    id: "anthropic",
    provider: "anthropic",
    label: "anthropic",
    enabled: true,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    configured: false,
  },
  {
    id: "groq",
    provider: "openai",
    label: "groq",
    enabled: true,
    baseUrl: "https://g.local",
    apiKeyEnv: "GROQ_API_KEY",
    defaultModel: "llama",
    configured: true,
  },
  {
    id: "openai",
    provider: "openai",
    label: "openai",
    enabled: false,
    apiKeyEnv: "OPENAI_API_KEY",
    configured: true,
  },
];

const scopes = new Map<string, ApiConfigScope>([
  ["groq", "user"],
  ["openai", "project"],
]);

function renderManager(overrides: Partial<Parameters<typeof ApiManager>[0]> = {}) {
  const ok = vi.fn().mockReturnValue({ ok: true });
  return render(
    <ApiManager
      apis={apis}
      scopes={scopes}
      canGlobal={true}
      width={120}
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

describe("ApiManager", () => {
  it("lists apis with scope, enabled state, key env, and endpoint", () => {
    const { lastFrame } = renderManager();
    const frame = plain(lastFrame());
    expect(frame).toContain("apis");
    expect(frame).toMatch(/anthropic\s+builtin/);
    expect(frame).toMatch(/groq\s+global/);
    expect(frame).toMatch(/openai\s+project disabled/);
    expect(frame).toContain("key=GROQ_API_KEY");
    expect(frame).toContain("baseUrl=https://g.local");
    expect(frame).toContain("model=llama");
  });

  it("toggles the selected api on Enter", async () => {
    const onToggle = vi.fn().mockReturnValue({ ok: true, text: "anthropic disabled (global)" });
    const { stdin, lastFrame } = renderManager({ onToggle });
    await type(stdin, "\r");
    expect(onToggle).toHaveBeenCalledWith("anthropic");
    expect(plain(lastFrame())).toContain("anthropic disabled (global)");
  });

  it("submits the add form with typed fields and default scope", async () => {
    const onAdd = vi.fn().mockReturnValue({ ok: true, text: "vllm added (global)" });
    const { stdin, lastFrame } = renderManager({ onAdd });
    // id "vllm", provider anthropic → openai, baseUrl + keyEnv + model left empty.
    await type(stdin, "a", "v", "l", "l", "m", "\r", `${ESC}[C`, "\r", "\r", "\r", "\r", "\r");
    expect(onAdd).toHaveBeenCalledWith({ id: "vllm", provider: "openai", scope: "user" });
    expect(plain(lastFrame())).toContain("vllm added (global)");
  });

  it("passes optional fields through when typed", async () => {
    const onAdd = vi.fn().mockReturnValue({ ok: true });
    const { stdin } = renderManager({ onAdd });
    await type(stdin, "a", "g", "\r", "\r", "u", "\r", "K", "\r", "m", "\r", "\r");
    expect(onAdd).toHaveBeenCalledWith({
      id: "g",
      provider: "anthropic",
      baseUrl: "u",
      apiKeyEnv: "K",
      defaultModel: "m",
      scope: "user",
    });
  });

  it("rejects an empty id and refuses to delete an unconfigured built-in", async () => {
    const onAdd = vi.fn();
    const onDelete = vi.fn();
    const { stdin, lastFrame } = renderManager({ onAdd, onDelete });
    await type(stdin, "a", "\r");
    expect(onAdd).not.toHaveBeenCalled();
    expect(plain(lastFrame())).toContain("api id must not be empty");
    await type(stdin, ESC, "d"); // close the form; selection is on 'anthropic' (builtin)
    expect(onDelete).not.toHaveBeenCalled();
    expect(plain(lastFrame())).toContain("built-in default");
  });

  it("deletes a configured api after confirmation", async () => {
    const onDelete = vi.fn().mockReturnValue({ ok: true, text: "groq removed (global)" });
    const { stdin, lastFrame } = renderManager({ onDelete });
    await type(stdin, `${ESC}[B`, "d"); // down to groq, then delete
    expect(plain(lastFrame())).toContain("delete 'groq'? y/n");
    await type(stdin, "y");
    expect(onDelete).toHaveBeenCalledWith("groq");
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    const { stdin } = renderManager({ onClose });
    await type(stdin, ESC);
    expect(onClose).toHaveBeenCalled();
  });

  it("shows readiness per row and the fix for the selected not-ready api", () => {
    const { lastFrame } = renderManager({
      apiDoctor: [
        {
          api: "anthropic",
          provider: "anthropic",
          status: "key_missing",
          keyEnv: "ANTHROPIC_API_KEY",
          baseUrl: "https://api.anthropic.com",
          message: "ANTHROPIC_API_KEY not set",
          detail:
            "Set ANTHROPIC_API_KEY (or point apiKeyEnv at another variable) to enable llm steps on 'anthropic'.",
          fixCommand: "export ANTHROPIC_API_KEY=…",
        },
        {
          api: "groq",
          provider: "openai",
          status: "ok",
          keyEnv: "GROQ_API_KEY",
          baseUrl: "https://g.local",
          message: "ready",
        },
      ],
      onRecheck: vi.fn(),
    });
    const frame = plain(lastFrame());
    expect(frame).toContain("no key");
    expect(frame).toMatch(/groq\s+ready/);
    // The selected (anthropic) instance's fix and copyable command.
    expect(frame).toContain("fix anthropic:");
    expect(frame).toContain("$ export ANTHROPIC_API_KEY=…");
    expect(frame).toContain("1/2 ready");
    expect(frame).toContain("r recheck");
  });

  it("re-runs the probes on 'r'", async () => {
    const onRecheck = vi.fn();
    const { stdin } = renderManager({ onRecheck });
    await type(stdin, "r");
    expect(onRecheck).toHaveBeenCalled();
  });
});
