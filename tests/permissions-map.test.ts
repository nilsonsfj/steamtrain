import { describe, expect, it } from "vitest";
import {
  PERMISSION_PROFILES,
  buildAmpExecArgs,
  buildClaudeRunArgs,
  buildCodexExecArgs,
  buildCursorRunArgs,
  buildKiroExecArgs,
  buildOpenCodeRunArgs,
  effectivePermissions,
  permissionArgs,
  permissionPlan,
  permissionsBadge,
  permissionsDescription,
  permissionsLabel,
  providerPermissionSupport,
  resolvePermissions,
} from "../src/agents";
import { buildAntigravityRunArgs } from "../src/agents/antigravity";
import { buildKimiRunArgs } from "../src/agents/kimi";
import type { AgentProviderId } from "../src/types/events";

const run = (extra: Record<string, unknown> = {}) => ({
  prompt: "hi",
  model: "m",
  ...extra,
});

describe("resolvePermissions", () => {
  it("expands the string shorthand with defaults", () => {
    expect(resolvePermissions("read-only")).toEqual({
      profile: "read-only",
      allow: [],
      deny: [],
      onUnsupported: "fail",
      verify: true,
    });
  });

  it("arms verification only for read-only by default", () => {
    expect(resolvePermissions("edit")?.verify).toBe(false);
    expect(resolvePermissions("full")?.verify).toBe(false);
    expect(resolvePermissions({ profile: "read-only", verify: false })?.verify).toBe(false);
  });

  it("distinguishes absent from full — absent is not a profile", () => {
    expect(resolvePermissions(undefined)).toBeUndefined();
    expect(resolvePermissions("full")?.profile).toBe("full");
  });

  it("keeps allow/deny lists and the unsupported policy", () => {
    expect(
      resolvePermissions({
        profile: "edit",
        allow: ["Bash(npm test:*)"],
        deny: ["WebFetch"],
        onUnsupported: "warn",
      }),
    ).toEqual({
      profile: "edit",
      allow: ["Bash(npm test:*)"],
      deny: ["WebFetch"],
      onUnsupported: "warn",
      verify: false,
    });
  });
});

describe("effectivePermissions (layering)", () => {
  it("takes the first declared layer wholesale — layers never merge", () => {
    const perms = effectivePermissions([{ profile: "edit", allow: ["Read"] }, "read-only", "full"]);
    expect(perms?.profile).toBe("edit");
    expect(perms?.allow).toEqual(["Read"]);
  });

  it("resolves to nothing when there is nothing to resolve", () => {
    expect(effectivePermissions([])).toBeUndefined();
  });

  it("falls through undefined layers", () => {
    expect(effectivePermissions([undefined, undefined, "read-only"])?.profile).toBe("read-only");
    expect(effectivePermissions([undefined, undefined, undefined])).toBeUndefined();
  });
});

describe("claude mapping", () => {
  const plan = (spec: Parameters<typeof resolvePermissions>[0]) =>
    permissionPlan("claude", resolvePermissions(spec)!);

  it("read-only allows read tools and denies writes, shell, and network", () => {
    const { args, enforcement, verify } = plan("read-only");
    const allowed = args[args.indexOf("--allowedTools") + 1]!;
    const denied = args[args.indexOf("--disallowedTools") + 1]!;
    expect(allowed.split(",")).toContain("Read");
    expect(allowed.split(",")).toContain("Grep");
    expect(allowed.split(",")).not.toContain("Write");
    for (const tool of ["Write", "Edit", "Bash", "WebFetch"]) {
      expect(denied.split(",")).toContain(tool);
    }
    // Headless `--print` needs an explicit mode so Claude does not stall on
    // tool-use prompts; `plan` backs the deny list.
    expect(args.slice(0, 2)).toEqual(["--permission-mode", "plan"]);
    expect(enforcement).toBe("native");
    expect(verify).toBe(true);
  });

  it("edit auto-approves file edits but keeps shell and network denied", () => {
    const { args, enforcement, gaps } = plan("edit");
    expect(args.slice(0, 2)).toEqual(["--permission-mode", "acceptEdits"]);
    const allowed = args[args.indexOf("--allowedTools") + 1]!.split(",");
    const denied = args[args.indexOf("--disallowedTools") + 1]!.split(",");
    expect(allowed).toContain("Write");
    expect(allowed).toContain("Edit");
    expect(denied).toContain("Bash");
    expect(denied).toContain("WebFetch");
    // Honest about the one thing the CLI cannot do: confine writes itself.
    expect(enforcement).toBe("partial");
    expect(gaps.join(" ")).toMatch(/no filesystem sandbox/);
  });

  it("full pre-approves everything so a headless step never stalls", () => {
    const { args, enforcement, verify } = plan("full");
    expect(args).toEqual(["--permission-mode", "bypassPermissions"]);
    expect(enforcement).toBe("native");
    expect(verify).toBe(false);
  });

  it("an explicit allow entry wins over the profile's blanket deny", () => {
    const { args } = plan({ profile: "read-only", allow: ["Bash"] });
    const allowed = args[args.indexOf("--allowedTools") + 1]!.split(",");
    const denied = args[args.indexOf("--disallowedTools") + 1]!.split(",");
    expect(allowed).toContain("Bash");
    expect(denied).not.toContain("Bash");
    // …unless it is denied explicitly too, in which case deny still wins.
    const both = plan({ profile: "read-only", allow: ["Bash"], deny: ["Bash"] }).args;
    expect(both[both.indexOf("--disallowedTools") + 1]!.split(",")).toContain("Bash");
  });

  it("scoped allow patterns are passed through verbatim", () => {
    const { args } = plan({ profile: "read-only", allow: ["Bash(npm test:*)"] });
    expect(args[args.indexOf("--allowedTools") + 1]).toContain("Bash(npm test:*)");
  });
});

describe("codex mapping", () => {
  it("maps each profile onto a sandbox level", () => {
    expect(permissionArgs("codex", resolvePermissions("read-only"))).toEqual([
      "--sandbox",
      "read-only",
    ]);
    expect(permissionArgs("codex", resolvePermissions("edit"))).toEqual([
      "--sandbox",
      "workspace-write",
    ]);
    expect(permissionArgs("codex", resolvePermissions("full"))).toEqual([
      "--sandbox",
      "danger-full-access",
    ]);
  });

  it("reports allow/deny lists as an unenforced gap instead of ignoring them", () => {
    const plan = permissionPlan("codex", resolvePermissions({ profile: "edit", deny: ["Bash"] })!);
    expect(plan.enforcement).toBe("partial");
    expect(plan.gaps.join(" ")).toMatch(/no per-tool allow\/deny lists/);
  });
});

describe("opencode / mimo mapping", () => {
  it("uses the built-in read-only plan agent", () => {
    for (const provider of ["opencode", "mimo"] as AgentProviderId[]) {
      const plan = permissionPlan(provider, resolvePermissions("read-only")!);
      expect(plan.args).toEqual(["--agent", "plan"]);
      expect(plan.enforcement).toBe("native");
    }
  });

  it("cannot enforce edit — no built-in agent allows writes but withholds shell", () => {
    const plan = permissionPlan("opencode", resolvePermissions("edit")!);
    expect(plan.enforcement).toBe("none");
    expect(plan.args).toEqual([]);
  });

  it("satisfies full with no flags", () => {
    const plan = permissionPlan("opencode", resolvePermissions("full")!);
    expect(plan.enforcement).toBe("native");
    expect(plan.args).toEqual([]);
  });
});

describe("all-or-nothing providers", () => {
  const providers: AgentProviderId[] = ["amp", "cursor", "kimi", "kiro", "antigravity"];

  it("cannot enforce a restricted profile, and say so", () => {
    for (const provider of providers) {
      for (const profile of ["read-only", "edit"] as const) {
        const plan = permissionPlan(provider, resolvePermissions(profile)!);
        expect(plan.enforcement).toBe("none");
        expect(plan.args).toEqual([]);
        expect(plan.gaps[0]).toContain(provider);
      }
    }
  });

  it("always satisfies full (there is nothing to enforce)", () => {
    for (const provider of providers) {
      expect(permissionPlan(provider, resolvePermissions("full")!).enforcement).toBe("native");
    }
  });

  it("still arms post-run verification for read-only, as the only guard left", () => {
    for (const provider of providers) {
      expect(permissionPlan(provider, resolvePermissions("read-only")!).verify).toBe(true);
    }
  });
});

describe("unrecognized profiles fail closed", () => {
  it("becomes unenforceable rather than crashing or running unrestricted", () => {
    // A hand-built spec object bypasses the zod schema and `validateWorkflow`.
    // The mapping has no branch for a typo'd profile, so it must degrade into
    // the refusal path (which `onUnsupported: "fail"` blocks) — never into
    // "no flags, run anyway".
    const typo = { ...resolvePermissions("read-only")!, profile: "readonly" as never };
    for (const provider of ["claude", "codex", "opencode"] as AgentProviderId[]) {
      const plan = permissionPlan(provider, typo);
      expect(plan.enforcement).toBe("none");
      expect(plan.args).toEqual([]);
      expect(plan.verify).toBe(false);
      expect(plan.gaps[0]).toContain("unknown permission profile");
    }
  });
});

describe("provider capability matrix", () => {
  it("declares full as satisfiable everywhere", () => {
    for (const provider of [
      "claude",
      "codex",
      "opencode",
      "mimo",
      "amp",
      "cursor",
      "kimi",
      "kiro",
      "antigravity",
    ] as AgentProviderId[]) {
      expect(providerPermissionSupport(provider).profiles.full).not.toBe("none");
      expect(providerPermissionSupport(provider).mechanism.length).toBeGreaterThan(0);
    }
  });

  it("only claude exposes per-tool lists", () => {
    expect(providerPermissionSupport("claude").lists).toBe(true);
    expect(providerPermissionSupport("codex").lists).toBe(false);
  });
});

describe("adapter arg builders", () => {
  it("claude splices permission flags before extraArgs so a hand-written flag wins", () => {
    const args = buildClaudeRunArgs(
      run({ permissions: resolvePermissions("read-only"), extraArgs: ["--permission-mode", "x"] }),
    );
    expect(args.indexOf("--allowedTools")).toBeLessThan(args.lastIndexOf("--permission-mode"));
    expect(args[args.length - 1]).toBe("x");
  });

  it("claude passes nothing when no profile is declared", () => {
    const args = buildClaudeRunArgs(run());
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--permission-mode");
  });

  it("codex keeps its historical workspace-write default and never prompts", () => {
    const args = buildCodexExecArgs(run());
    expect(args.join(" ")).toContain("--sandbox workspace-write");
    expect(args.join(" ")).toContain('approval_policy="never"');
  });

  it("codex takes the sandbox level from the profile", () => {
    const args = buildCodexExecArgs(run({ permissions: resolvePermissions("read-only") }));
    expect(args.join(" ")).toContain("--sandbox read-only");
    expect(args.join(" ")).not.toContain("workspace-write");
    expect(args.join(" ")).toContain('approval_policy="never"');
  });

  it("opencode inserts --agent plan ahead of extraArgs", () => {
    const args = buildOpenCodeRunArgs(
      run({ permissions: resolvePermissions("read-only"), extraArgs: ["--flag"] }),
    );
    expect(args.slice(-3)).toEqual(["--agent", "plan", "--flag"]);
  });

  it("providers without enforcement add no flags, and keep the prompt last", () => {
    const perms = resolvePermissions("read-only");
    expect(buildAmpExecArgs(run({ permissions: perms }))).not.toContain("--agent");
    expect(buildCursorRunArgs(run({ permissions: perms })).at(-1)).toBe("hi");
    expect(buildKimiRunArgs(run({ permissions: perms })).at(-1)).toBe("hi");
    expect(buildKiroExecArgs(run({ permissions: perms })).at(-1)).toBe("hi");
    expect(buildAntigravityRunArgs(run({ permissions: perms })).at(-1)).toBe("hi");
  });
});

describe("labels", () => {
  it("summarizes the profile with its list counts", () => {
    expect(permissionsLabel(resolvePermissions("read-only")!)).toBe("read-only");
    expect(
      permissionsLabel(resolvePermissions({ profile: "full", deny: ["Bash", "WebFetch"] })!),
    ).toBe("full -2 deny");
  });

  it("has a badge and a description for every profile", () => {
    for (const profile of PERMISSION_PROFILES) {
      expect(permissionsBadge(profile)).toContain(profile);
      expect(permissionsDescription(profile).length).toBeGreaterThan(10);
    }
  });
});
