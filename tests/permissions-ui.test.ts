import { describe, expect, it } from "vitest";
import { permissionsCommand } from "../src/commands/builtins/permissions";
import type { SlashCommandContext } from "../src/commands/types";
import { specDetailLines, specStepRowMeta } from "../src/tui/workflow-spec-ui";
import {
  BUNDLED_WORKFLOWS,
  type WorkflowSpec,
  workflowPermissionVerdicts,
  workflowReducer,
  workflowStateFromSpec,
} from "../src/workflow";

const spec: WorkflowSpec = {
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
          permissions: { profile: "read-only", allow: ["Bash(ls:*)"] },
        },
        { id: "sweep", agent: "amp", model: "smart", prompt: "hm", permissions: "read-only" },
      ],
    },
  ],
};

const verdictMap = (target: WorkflowSpec = spec) =>
  Object.fromEntries(workflowPermissionVerdicts(target).map((v) => [v.stepId, v]));

describe("TUI spec chrome", () => {
  it("badges each step row with its profile", () => {
    const ctx = { permissions: verdictMap() };
    const rows = spec.phases[0]!.steps.map((step) => specStepRowMeta(step, ctx));
    expect(rows[0]).toContain("full");
    expect(rows[1]).toContain("read-only");
    expect(rows[1]).toContain("+1 allow");
    // An unenforceable restriction is called out in the row itself.
    expect(rows[2]).toContain("⚠ unenforceable");
  });

  it("explains the profile and its enforcement in the drill-in", () => {
    const ctx = { permissions: verdictMap() };
    const lines = specDetailLines(spec.phases[0]!.steps[1]!, ctx).join("\n");
    expect(lines).toMatch(/permissions: .*read-only/);
    expect(lines).toContain("enforced by claude");
    expect(lines).toContain("also allowed: Bash(ls:*)");
    expect(lines).toMatch(/verified after the run/);

    const blocked = specDetailLines(spec.phases[0]!.steps[2]!, ctx).join("\n");
    expect(blocked).toContain("NOT enforceable by amp");
  });

  it("falls back to the step's own declaration without verdicts", () => {
    const lines = specDetailLines(spec.phases[0]!.steps[1]!).join("\n");
    expect(lines).toMatch(/permissions: .*read-only/);
    expect(lines).not.toContain("enforced by");
  });

  it("says nothing about permissions for a step that declares none", () => {
    const plain: WorkflowSpec = {
      name: "plain",
      phases: [
        { id: "p", title: "P", steps: [{ id: "a", agent: "claude", model: "opus", prompt: "x" }] },
      ],
    };
    expect(specDetailLines(plain.phases[0]!.steps[0]!).join("\n")).not.toContain("permissions");
    expect(specStepRowMeta(plain.phases[0]!.steps[0]!)).not.toContain("read-only");
  });
});

describe("reducer preview state", () => {
  it("carries the effective profile onto each agent step, and skips the rest", () => {
    const bugHunt = BUNDLED_WORKFLOWS["bug-hunt"]!;
    const state = workflowStateFromSpec(bugHunt);
    const steps = state.phases.flatMap((phase) => phase.steps);
    const scan = steps.find((s) => s.stepId === "scan-logic");
    const gate = steps.find((s) => s.stepId === "findings-ready");
    // bug-hunt declares read-only at the workflow level: every agent step
    // inherits it, the gate step inherits nothing (it spawns no agent).
    expect(scan?.permissions?.profile).toBe("read-only");
    expect(gate?.permissions).toBeUndefined();
  });
});

describe("reducer: mid-run clamp", () => {
  const clampSpec: WorkflowSpec = {
    name: "wf",
    phases: [
      {
        id: "p",
        title: "P",
        steps: [{ id: "impl", agent: "claude", model: "opus", prompt: "go", permissions: "full" }],
      },
    ],
  };

  const clamp = (permissions: string) =>
    workflowReducer(workflowStateFromSpec(clampSpec), {
      type: "event",
      event: {
        kind: "step_edited",
        stepId: "impl",
        patch: { permissions },
        by: "human:test",
        ts: 1,
      },
    });

  it("badges a still-pending step the moment it is clamped", () => {
    const state = clamp("read-only");
    const step = state.phases[0]!.steps[0]!;
    expect(step.permissions).toEqual({ profile: "read-only", verify: true });
    expect(step.edited).toBe(true);
    // The accepted patch is also tracked at run level for the step editor.
    expect(state.editedSteps?.impl).toMatchObject({ permissions: "read-only" });
  });

  it("drops the badge when the profile is cleared (step_start re-establishes it)", () => {
    expect(clamp("").phases[0]!.steps[0]!.permissions).toBeUndefined();
  });

  it("leaves the badge alone for an edit that does not touch permissions", () => {
    const state = workflowReducer(workflowStateFromSpec(clampSpec), {
      type: "event",
      event: { kind: "step_edited", stepId: "impl", patch: { prompt: "new" }, ts: 1 },
    });
    expect(state.phases[0]!.steps[0]!.permissions?.profile).toBe("full");
  });
});

function ctxFor(overrides: Partial<SlashCommandContext> = {}): {
  ctx: SlashCommandContext;
  patches: { stepId: string; patch: Record<string, unknown> }[];
} {
  const patches: { stepId: string; patch: Record<string, unknown> }[] = [];
  const ctx = {
    mode: "workflow",
    modes: ["workflow"],
    workspaces: { workspaces: [] },
    workspaceMap: new Map(),
    updateWorkspace: () => undefined,
    setMode: () => undefined,
    version: "test",
    workflowSpec: spec,
    updateWorkflowStep: (stepId: string, patch: Record<string, unknown>) => {
      patches.push({ stepId, patch });
    },
    ...overrides,
  } as unknown as SlashCommandContext;
  return { ctx, patches };
}

describe("/permissions", () => {
  it("reports the whole workflow's posture with no argument", () => {
    const { ctx } = ctxFor();
    const result = permissionsCommand.execute([], ctx);
    const texts = (result as { notices: { text: string; level: string }[] }).notices.map(
      (n) => n.text,
    );
    expect(texts[0]).toContain("2 read-only · 1 full");
    expect(texts.join("\n")).toContain("review:");
    // The unenforceable step is escalated, not buried.
    const sweep = (result as { notices: { text: string; level: string }[] }).notices.find((n) =>
      n.text.includes("sweep:"),
    );
    expect(sweep?.level).toBe("error");
  });

  it("sets the selected step's profile", () => {
    const { ctx, patches } = ctxFor({
      workflowStep: { workflowName: "wf", stepId: "review", agent: "claude", model: "opus" },
    });
    permissionsCommand.execute(["read-only"], ctx);
    expect(patches).toEqual([{ stepId: "review", patch: { permissions: "read-only" } }]);
  });

  it("clears a profile", () => {
    const { ctx, patches } = ctxFor({
      workflowStep: { workflowName: "wf", stepId: "review", agent: "claude", model: "opus" },
    });
    permissionsCommand.execute(["clear"], ctx);
    expect(patches).toEqual([{ stepId: "review", patch: { permissions: undefined } }]);
  });

  it("--all locks down every agent step in the pipeline", () => {
    const { ctx, patches } = ctxFor();
    permissionsCommand.execute(["read-only", "--all"], ctx);
    expect(patches.map((p) => p.stepId).sort()).toEqual(["impl", "review", "sweep"]);
    expect(patches.every((p) => p.patch.permissions === "read-only")).toBe(true);
  });

  it("--all skips merge steps when locking down (a resolver must write)", () => {
    const withMerge: WorkflowSpec = {
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
            },
          ],
        },
      ],
    };
    const { ctx, patches } = ctxFor({ workflowSpec: withMerge });
    const result = permissionsCommand.execute(["read-only", "--all"], ctx);
    expect(patches.map((p) => p.stepId)).toEqual(["impl"]);
    expect((result as { notices: { text: string }[] }).notices[0]!.text).toContain(
      "merge step(s) skipped",
    );
  });

  it("rejects an unknown profile with the valid list", () => {
    const { ctx, patches } = ctxFor();
    const result = permissionsCommand.execute(["readonly"], ctx);
    expect(patches).toHaveLength(0);
    const notice = (result as { notices: { level: string; text: string }[] }).notices[0]!;
    expect(notice.level).toBe("error");
    expect(notice.text).toContain("read-only");
  });

  it("completes profiles, then --all", () => {
    expect(permissionsCommand.complete?.([], ctxFor().ctx)).toEqual([
      "read-only",
      "edit",
      "full",
      "clear",
    ]);
    expect(permissionsCommand.complete?.(["read-only", ""], ctxFor().ctx)).toEqual(["--all"]);
  });
});
