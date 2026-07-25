import { describe, expect, it } from "vitest";
import type { SteamtrainConfig } from "../src/config/types";
import {
  type WorkflowSpec,
  applyWorkflowStepOverrides,
  formatPermissionSummary,
  parseSessionOverrides,
  stepEffectivePermissions,
  validateWorkflow,
  workflowPermissionPreflight,
  workflowPermissionSummary,
  workflowPermissionVerdicts,
} from "../src/workflow";

function spec(overrides: Partial<WorkflowSpec> = {}, stepExtras: Record<string, unknown> = {}) {
  return {
    name: "wf",
    phases: [
      {
        id: "p",
        title: "P",
        steps: [{ id: "review", agent: "claude", model: "opus", prompt: "review", ...stepExtras }],
      },
    ],
    ...overrides,
  } as WorkflowSpec;
}

describe("permissions validation", () => {
  it("accepts the string shorthand and the object form", () => {
    expect(validateWorkflow(spec({}, { permissions: "read-only" })).ok).toBe(true);
    expect(
      validateWorkflow(
        spec(
          {},
          {
            permissions: {
              profile: "edit",
              allow: ["Bash(npm test:*)"],
              deny: ["WebFetch"],
              onUnsupported: "warn",
              verify: false,
            },
          },
        ),
      ).ok,
    ).toBe(true);
  });

  it("rejects an unknown profile and unknown object keys", () => {
    expect(validateWorkflow(spec({}, { permissions: "readonly" })).ok).toBe(false);
    expect(
      validateWorkflow(spec({}, { permissions: { profile: "read-only", onUnsupportedd: "warn" } }))
        .ok,
    ).toBe(false);
  });

  it("rejects an empty allow/deny list — an empty restriction promises nothing", () => {
    expect(validateWorkflow(spec({}, { permissions: { profile: "full", deny: [] } })).ok).toBe(
      false,
    );
  });

  it("accepts a workflow-level default", () => {
    expect(validateWorkflow(spec({ permissions: "read-only" })).ok).toBe(true);
  });

  it("rejects permissions on a step with no agent to restrict", () => {
    const bad: WorkflowSpec = {
      name: "wf",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [
            { id: "build", kind: "command", cmd: "echo hi", permissions: "read-only" },
          ] as never,
        },
      ],
    };
    const result = validateWorkflow(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/command step runs the shell command you wrote/);
  });

  it("accepts permissions on agent-backed distributors and consolidators", () => {
    // These use the `optionalAgentRunShape` zod shape rather than the worker's,
    // so they are a second schema path worth pinning: an agent-backed splitter
    // or merger is exactly the kind of step that should be able to say it only
    // reads.
    const spec: WorkflowSpec = {
      name: "wf",
      phases: [
        {
          id: "a",
          title: "A",
          steps: [
            {
              id: "split",
              kind: "distributor",
              agent: "claude",
              model: "opus",
              prompt: "list targets",
              permissions: "read-only",
            },
          ],
        },
        {
          id: "b",
          title: "B",
          steps: [
            {
              id: "merge-text",
              kind: "consolidator",
              agent: "claude",
              model: "opus",
              dependsOn: ["split"],
              prompt: "merge",
              permissions: { profile: "read-only", deny: ["WebFetch"] },
            },
          ],
        },
      ],
    };
    expect(validateWorkflow(spec).ok).toBe(true);
    const verdicts = workflowPermissionVerdicts(spec);
    expect(verdicts.map((v) => v.stepId)).toEqual(["split", "merge-text"]);
    expect(verdicts.every((v) => v.permissions.profile === "read-only")).toBe(true);
  });

  it("rejects permissions on a distributor with no agent binding", () => {
    const bad: WorkflowSpec = {
      name: "wf",
      phases: [
        {
          id: "a",
          title: "A",
          steps: [
            {
              id: "split",
              kind: "distributor",
              items: ["one", "two"],
              permissions: "read-only",
            },
          ] as never,
        },
      ],
    };
    const result = validateWorkflow(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/spawns no agent/);
  });

  it("rejects permissions on an llm step, which has no CLI to restrict", () => {
    const bad: WorkflowSpec = {
      name: "wf",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [
            {
              id: "judge",
              kind: "llm",
              model: "claude-sonnet-5",
              prompt: "verdict?",
              permissions: "read-only",
            },
          ] as never,
        },
      ],
    };
    const result = validateWorkflow(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/single stateless API call/);
  });

  it("rejects read-only combined with artifacts", () => {
    const result = validateWorkflow(
      spec({}, { permissions: "read-only", artifacts: ["report.md"] }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot produce the files it promises/);
  });

  it("rejects read-only on a merge step whose resolver must write", () => {
    const bad: WorkflowSpec = {
      name: "wf",
      phases: [
        {
          id: "a",
          title: "A",
          steps: [{ id: "impl", agent: "claude", model: "opus", prompt: "go" }],
        },
        {
          id: "b",
          title: "B",
          steps: [
            {
              id: "land",
              kind: "merge",
              dependsOn: ["impl"],
              onConflict: "agent",
              agent: "claude",
              model: "opus",
              permissions: "read-only",
            },
          ],
        },
      ],
    };
    const result = validateWorkflow(bad);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/conflict-resolution agent has to edit/);
  });

  it("allows edit on a merge step", () => {
    const good: WorkflowSpec = {
      name: "wf",
      phases: [
        {
          id: "a",
          title: "A",
          steps: [{ id: "impl", agent: "claude", model: "opus", prompt: "go" }],
        },
        {
          id: "b",
          title: "B",
          steps: [
            {
              id: "land",
              kind: "merge",
              dependsOn: ["impl"],
              onConflict: "agent",
              agent: "claude",
              model: "opus",
              permissions: "edit",
            },
          ],
        },
      ],
    };
    expect(validateWorkflow(good).ok).toBe(true);
  });
});

describe("effective permissions layering", () => {
  const config: SteamtrainConfig = { permissions: "read-only" };

  it("prefers the step, then the workflow, then the config", () => {
    const stepWins = spec({ permissions: "edit" }, { permissions: "full" });
    expect(stepEffectivePermissions(stepWins.phases[0]!.steps[0]!, stepWins, config)?.profile).toBe(
      "full",
    );

    const workflowWins = spec({ permissions: "edit" });
    expect(
      stepEffectivePermissions(workflowWins.phases[0]!.steps[0]!, workflowWins, config)?.profile,
    ).toBe("edit");

    const configWins = spec();
    expect(
      stepEffectivePermissions(configWins.phases[0]!.steps[0]!, configWins, config)?.profile,
    ).toBe("read-only");
    expect(stepEffectivePermissions(configWins.phases[0]!.steps[0]!, configWins)).toBeUndefined();
  });

  it("never applies a default to a step with no agent", () => {
    const withGate: WorkflowSpec = {
      name: "wf",
      permissions: "read-only",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [{ id: "impl", agent: "claude", model: "opus", prompt: "go" }],
        },
        {
          id: "q",
          title: "Q",
          steps: [
            { id: "g", kind: "gate", dependsOn: ["impl"], condition: { step: "impl", ok: true } },
          ],
        },
      ],
    };
    expect(stepEffectivePermissions(withGate.phases[1]!.steps[0]!, withGate)).toBeUndefined();
  });
});

describe("preflight", () => {
  it("blocks a restricted profile the pinned agent cannot enforce", () => {
    const blocked = spec({}, { agent: "amp", permissions: "read-only" });
    const { errors, warnings } = workflowPermissionPreflight(blocked);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/cannot enforce it/);
    expect(warnings).toHaveLength(0);
  });

  it("warns instead when the author opted into running unenforced", () => {
    const warned = spec(
      {},
      { agent: "amp", permissions: { profile: "read-only", onUnsupported: "warn" } },
    );
    const { errors, warnings } = workflowPermissionPreflight(warned);
    expect(errors).toHaveLength(0);
    expect(warnings[0]).toMatch(/UNENFORCED/);
  });

  it("warns about partial enforcement (codex has no tool lists)", () => {
    const partial = spec({}, { agent: "codex", permissions: { profile: "edit", deny: ["Bash"] } });
    const { errors, warnings } = workflowPermissionPreflight(partial);
    expect(errors).toHaveLength(0);
    expect(warnings[0]).toMatch(/partially enforced/);
  });

  it("says nothing at all when a workflow declares no profiles", () => {
    expect(workflowPermissionPreflight(spec())).toEqual({ errors: [], warnings: [] });
    expect(workflowPermissionVerdicts(spec())).toHaveLength(0);
  });

  it("leaves enforcement unknown for an unpinned agent binding", () => {
    const unpinned: WorkflowSpec = {
      name: "wf",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [{ id: "review", model: "sonnet 5", prompt: "x", permissions: "read-only" }],
        },
      ],
    };
    const [verdict] = workflowPermissionVerdicts(unpinned);
    expect(verdict?.enforcement).toBe("unknown");
    expect(verdict?.blocking).toBe(false);
    expect(workflowPermissionPreflight(unpinned).errors).toHaveLength(0);
  });
});

describe("summary", () => {
  it("counts profiles and unrestricted agent steps", () => {
    const mixed: WorkflowSpec = {
      name: "wf",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [
            { id: "impl", agent: "claude", model: "opus", prompt: "go", permissions: "full" },
            {
              id: "review",
              agent: "claude",
              model: "opus",
              prompt: "look",
              permissions: "read-only",
            },
            { id: "extra", agent: "claude", model: "opus", prompt: "hm" },
          ],
        },
      ],
    };
    const summary = workflowPermissionSummary(mixed);
    expect(summary.agentSteps).toBe(3);
    expect(summary.counts["read-only"]).toBe(1);
    expect(summary.counts.full).toBe(1);
    expect(summary.unrestricted).toBe(1);
    expect(formatPermissionSummary(summary)).toBe("1 read-only · 1 full · 1 unrestricted");
  });

  it("flags unenforceable steps in the formatted line", () => {
    const blocked = spec({}, { agent: "amp", permissions: "read-only" });
    const summary = workflowPermissionSummary(blocked);
    expect(summary.blocking).toBe(1);
    expect(formatPermissionSummary(summary)).toMatch(/⚠ 1 unenforceable/);
  });

  it("renders nothing for an agentless workflow", () => {
    const agentless: WorkflowSpec = {
      name: "wf",
      phases: [{ id: "p", title: "P", steps: [{ id: "c", kind: "command", cmd: "true" }] }],
    };
    expect(formatPermissionSummary(workflowPermissionSummary(agentless))).toBeUndefined();
  });
});

describe("session overrides", () => {
  it("accepts permissions as a per-step override field", () => {
    const parsed = parseSessionOverrides({ steps: { review: { permissions: "read-only" } } });
    expect(parsed.ok).toBe(true);
  });

  it("applies and clears a permissions override on a step", () => {
    const base = spec({}, { permissions: "full" });
    const locked = applyWorkflowStepOverrides(base, { review: { permissions: "read-only" } });
    expect((locked.phases[0]!.steps[0]! as { permissions?: unknown }).permissions).toBe(
      "read-only",
    );

    const cleared = applyWorkflowStepOverrides(base, { review: { permissions: null } });
    expect("permissions" in (cleared.phases[0]!.steps[0]! as object)).toBe(false);
  });
});
