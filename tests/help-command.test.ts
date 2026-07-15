import { describe, expect, it, vi } from "vitest";
import {
  executeSlashCommand,
  listSlashCommands,
  unknownSlashCommand,
} from "../src/commands/registry";
import type {
  SlashCommandContext,
  SlashCommandNotice,
  SlashCommandResult,
} from "../src/commands/types";
import { closestMatch } from "../src/util/did-you-mean";
import { workspaceById } from "../src/workspace";
import { DEFAULT_WORKSPACE_CONFIG } from "../src/workspace/defaults";

function makeCtx(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  const workspaces = DEFAULT_WORKSPACE_CONFIG;
  return {
    mode: "plan",
    modes: ["workflow", "plan", "implement", "review"],
    workspaces,
    workspaceMap: workspaceById(workspaces),
    updateWorkspace: vi.fn(),
    setMode: vi.fn(),
    version: "0.1.0-test",
    ...overrides,
  };
}

function notices(result: SlashCommandResult): SlashCommandNotice[] {
  return result.handled ? (result.notices ?? []) : [];
}

describe("closestMatch", () => {
  it("finds a near-typo", () => {
    expect(closestMatch("hlep", ["help", "history", "exit"])).toBe("help");
  });

  it("prefers a prefix match", () => {
    expect(closestMatch("hist", ["help", "history"])).toBe("history");
  });

  it("returns undefined when nothing is close", () => {
    expect(closestMatch("zzzzzz", ["help", "history"])).toBeUndefined();
  });

  it("is case-insensitive", () => {
    expect(closestMatch("HELp", ["help"])).toBe("help");
  });

  it("returns undefined for empty input", () => {
    expect(closestMatch("", ["help"])).toBeUndefined();
  });

  it("caps distance tighter for short inputs", () => {
    // "xt" is distance 2 from "at" candidates — too far for a 2-char input.
    expect(closestMatch("xz", ["ab"])).toBeUndefined();
  });
});

describe("unknownSlashCommand", () => {
  it("flags a typo'd command with a suggestion", () => {
    expect(unknownSlashCommand("/hlep")).toEqual({ name: "hlep", suggestion: "help" });
  });

  it("flags a partial command name with the completion as suggestion", () => {
    const result = unknownSlashCommand("/ver");
    expect(result?.name).toBe("ver");
    expect(result?.suggestion).toBe("version");
  });

  it("flags an unknown command without a suggestion when nothing is close", () => {
    const result = unknownSlashCommand("/zzzqqq");
    expect(result?.name).toBe("zzzqqq");
    expect(result?.suggestion).toBeUndefined();
  });

  it("ignores registered commands", () => {
    expect(unknownSlashCommand("/help")).toBeNull();
    expect(unknownSlashCommand("  /version arg  ")).toBeNull();
  });

  it("ignores path-like input", () => {
    expect(unknownSlashCommand("/home/user/project is broken")).toBeNull();
  });

  it("ignores non-slash input and bare slash", () => {
    expect(unknownSlashCommand("fix the tests")).toBeNull();
    expect(unknownSlashCommand("/")).toBeNull();
  });

  it("flags a typo'd command that carries arguments", () => {
    expect(unknownSlashCommand("/hlep me now")?.name).toBe("hlep");
  });
});

describe("/help", () => {
  it("is registered", () => {
    expect(listSlashCommands().some((c) => c.name === "help")).toBe(true);
  });

  it("opens the overlay when the host provides one", () => {
    const openHelp = vi.fn(() => ({ handled: true as const, clearInput: true }));
    const result = executeSlashCommand("/help", makeCtx({ openHelp })) as SlashCommandResult;
    expect(openHelp).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ handled: true, clearInput: true });
  });

  it("falls back to a command-list notice without an overlay host", () => {
    const result = executeSlashCommand("/help", makeCtx()) as SlashCommandResult;
    const [notice] = notices(result);
    expect(notice?.level).toBe("info");
    expect(notice?.text).toContain("/exit");
    expect(notice?.text).toContain("/history");
  });

  it("shows usage for a named command", () => {
    const result = executeSlashCommand("/help version", makeCtx()) as SlashCommandResult;
    const [notice] = notices(result);
    expect(notice?.level).toBe("info");
    expect(notice?.text).toContain("/version");
    expect(notice?.text).toContain("version");
  });

  it("accepts a leading slash on the topic", () => {
    const result = executeSlashCommand("/help /exit", makeCtx()) as SlashCommandResult;
    expect(notices(result)[0]?.text).toContain("Quit steamtrain");
  });

  it("suggests the nearest command for an unknown topic", () => {
    const result = executeSlashCommand("/help hlep", makeCtx()) as SlashCommandResult;
    const [notice] = notices(result);
    expect(notice?.level).toBe("error");
    expect(notice?.text).toContain("did you mean /help");
  });

  it("completes command names", () => {
    const help = listSlashCommands().find((c) => c.name === "help");
    const completions = help?.complete?.(["ver"], makeCtx()) ?? [];
    expect(completions).toContain("version");
  });
});
