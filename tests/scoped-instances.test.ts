import { describe, expect, it } from "vitest";
import {
  defaultInstanceScope,
  parseScopedInstancePayload,
  partitionAgentsByScope,
  partitionApisByScope,
  resolveInstanceScope,
  tagAgentsWithScope,
  tagApisWithScope,
} from "../src/config/scoped-instances";

describe("scoped instance helpers", () => {
  it("defaults new entries to user when the global layer is available", () => {
    expect(defaultInstanceScope(true)).toBe("user");
    expect(defaultInstanceScope(false)).toBe("project");
  });

  it("resolves missing scope to the default and coerces user→project without a global layer", () => {
    expect(resolveInstanceScope(undefined, true)).toBe("user");
    expect(resolveInstanceScope("project", true)).toBe("project");
    expect(resolveInstanceScope("user", false)).toBe("project");
    expect(resolveInstanceScope("nope", true)).toBe("user");
  });

  it("partitions agents by scope and drops the transport-only scope field", () => {
    const partitioned = partitionAgentsByScope(
      [
        { id: "mimocode", provider: "opencode", scope: "user" },
        { id: "team-claude", provider: "claude", scope: "project" },
        { id: "implicit", provider: "codex" },
      ],
      true,
    );
    expect(partitioned.user).toEqual([
      { id: "mimocode", provider: "opencode" },
      { id: "implicit", provider: "codex" },
    ]);
    expect(partitioned.project).toEqual([{ id: "team-claude", provider: "claude" }]);
  });

  it("folds every agent into project when the global layer is unavailable", () => {
    const partitioned = partitionAgentsByScope(
      [
        { id: "a", provider: "claude", scope: "user" },
        { id: "b", provider: "codex", scope: "project" },
      ],
      false,
    );
    expect(partitioned.user).toEqual([]);
    expect(partitioned.project.map((a) => a.id).sort()).toEqual(["a", "b"]);
  });

  it("partitions APIs the same way (default user)", () => {
    const partitioned = partitionApisByScope(
      [
        { id: "groq", provider: "openai", scope: "user" },
        { id: "corp", provider: "anthropic", scope: "project" },
      ],
      true,
    );
    expect(partitioned.user).toEqual([{ id: "groq", provider: "openai" }]);
    expect(partitioned.project).toEqual([{ id: "corp", provider: "anthropic" }]);
  });

  it("tags raw layers for the config editor (user first)", () => {
    expect(
      tagAgentsWithScope({
        userAgents: [{ id: "u", provider: "claude" }],
        projectAgents: [{ id: "p", provider: "codex" }],
      }),
    ).toEqual([
      { id: "u", provider: "claude", scope: "user" },
      { id: "p", provider: "codex", scope: "project" },
    ]);
    expect(
      tagApisWithScope({
        userApis: [{ id: "groq", provider: "openai" }],
        projectApis: [],
      }),
    ).toEqual([{ id: "groq", provider: "openai", scope: "user" }]);
  });

  it("parseScopedInstancePayload validates each scope separately", () => {
    const identity = (entries: unknown) => entries as { id: string }[];
    const result = parseScopedInstancePayload(
      [
        { id: "claude", scope: "user" },
        { id: "claude", scope: "project" },
      ],
      true,
      identity,
      "agents",
    );
    expect(result.user).toEqual([{ id: "claude" }]);
    expect(result.project).toEqual([{ id: "claude" }]);
  });
});
