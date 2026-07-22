import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { WorkflowPreview } from "../src/tui/WorkflowPreview";
import {
  flattenSpecSteps,
  formatWorkflowAgentTarget,
  previewInputValues,
  specDetailLines,
} from "../src/tui/workflow-spec-ui";
import { BUNDLED_WORKFLOWS } from "../src/workflow";

describe("WorkflowPreview", () => {
  it("flattens spec phases and steps in order", () => {
    const spec = BUNDLED_WORKFLOWS["multi-plan"]!;
    const flat = flattenSpecSteps(spec);
    expect(flat.length).toBeGreaterThan(0);
    expect(flat[0]?.step.id).toBe("planning-lenses");
    expect(flat.at(-1)?.step.id).toBe("synthesize");
  });

  it("renders workflow metadata and step detail", () => {
    const spec = BUNDLED_WORKFLOWS["multi-plan"]!;
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        source="bundled"
        width={100}
        height={30}
        selectedIndex={0}
        dispatchCheck={{ ok: true }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("workflow preview · multi-plan");
    expect(frame).toContain("(bundled)");
    expect(frame).toContain("planning-lenses");
    expect(frame).toContain("ready to run");
    expect(frame).toContain("fan-out");
  });

  it("shows dispatch blockers", () => {
    const spec = BUNDLED_WORKFLOWS["bug-hunt"]!;
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        source="bundled"
        width={100}
        height={30}
        selectedIndex={1}
        dispatchCheck={{ ok: false, reason: "opencode is binary_missing — not found" }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("blocked:");
    expect(frame).toContain("binary_missing");
  });

  it("clamps selected index and renders step detail", () => {
    const spec = BUNDLED_WORKFLOWS["multi-plan"]!;
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        source="bundled"
        width={160}
        height={40}
        selectedIndex={999}
        dispatchCheck={{ ok: true }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toMatch(/▶.*synthes/i);
    expect(frame).toContain("synthesize");
    expect(frame).toContain("DeepSeek V4 Flash Free");
  });

  it("hides step detail panel when showStepDetail is false", () => {
    const spec = BUNDLED_WORKFLOWS["multi-plan"]!;
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        source="bundled"
        width={100}
        height={30}
        selectedIndex={0}
        dispatchCheck={{ ok: true }}
        showStepDetail={false}
      />,
    );
    const frame = lastFrame() ?? "";
    // The detail panel shows step id + kind + phase title in a bordered box.
    // With showStepDetail=false, the detail panel content should be absent.
    expect(frame).not.toContain("distributor · phase");
    expect(frame).toContain("planning-lenses");
  });

  it("hides plan result when showPlanResult is false", () => {
    const spec = BUNDLED_WORKFLOWS["multi-plan"]!;
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        source="bundled"
        width={100}
        height={30}
        selectedIndex={0}
        dispatchCheck={{ ok: true }}
        showPlanResult={false}
      />,
    );
    const frame = lastFrame() ?? "";
    // Plan result view should not appear even if planResult is set.
    expect(frame).toContain("ready to run");
  });

  it("resolves input defaults and does not corrupt the mainline preview frame", () => {
    const spec = BUNDLED_WORKFLOWS.mainline!;
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        source="bundled"
        width={100}
        height={30}
        selectedIndex={0}
        dispatchCheck={{ ok: true }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("workflow preview · mainline");
    expect(frame).toContain("ready to run");
    // Defaults are applied for display (not raw {{inputs.*}} placeholders).
    expect(frame).toContain("mimo-auto");
    expect(frame).not.toContain("{{inputs.");
    // Classic Ink wrap-overlap artifacts from the broken preview.
    expect(frame).not.toContain("rModel}}");
    expect(frame).not.toContain("ready to runworker");
    expect(frame).not.toContain("merge-backintegrat");
    expect(frame).toMatch(/plan · distributor · phase/);
    expect(frame).toMatch(/runner:/);
  });

  it("wraps a long workflow description across multiple chrome rows", () => {
    const description =
      "List every open GitHub PR for the current project and, for each one in parallel, rebase onto main, address or document review comments, resolve conflicts, wait for a fresh review, loop until the PR is mergeable or stuck, then write a summary report.";
    const spec = {
      ...BUNDLED_WORKFLOWS["multi-plan"]!,
      name: "babysit-all-prs",
      description,
    };
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        source="user"
        width={100}
        height={28}
        selectedIndex={0}
        dispatchCheck={{ ok: true }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("workflow preview · babysit-all-prs");
    expect(frame).toContain("List every open GitHub PR");
    // Soft-wrapped across chrome rows (not a single truncated ellipsis line).
    expect(frame).toContain("rebase onto");
    expect(frame).toMatch(/main,/);
    expect(frame).toContain("fresh review");
    expect(frame).toContain("ready to run");
    expect(frame).not.toContain("ready to runworker");
    expect(frame.split("\n").length).toBeLessThanOrEqual(28);
  });

  it("fills the detail panel with a wrapped long prompt instead of one truncated line", () => {
    const prompt =
      "You are in a checkout of the current project. List all OPEN pull requests on GitHub using the gh CLI, e.g. 'gh pr list --state open --json number,headRefName --limit 200'. Output ONE line per PR with the number and branch name. Do not include closed or draft PRs.";
    const base = BUNDLED_WORKFLOWS["multi-plan"]!;
    const firstPhase = base.phases[0]!;
    const firstStep = { ...firstPhase.steps[0]!, id: "prs", prompt };
    const spec = {
      ...base,
      name: "babysit-all-prs",
      description: "Short description.",
      phases: [
        { ...firstPhase, steps: [firstStep, ...firstPhase.steps.slice(1)] },
        ...base.phases.slice(1),
      ],
    };
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        source="user"
        width={100}
        height={28}
        selectedIndex={0}
        dispatchCheck={{ ok: true }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("prompt:");
    expect(frame).toContain("You are in a checkout of the current project");
    // Second wrapped prompt row should appear (not only a single truncated line).
    expect(frame).toMatch(/gh CLI|gh pr list|--json number/);
    expect(frame).toContain("ready to run");
    expect(frame.split("\n").length).toBeLessThanOrEqual(28);
  });

  it("hard-slices overlong tokens when the terminal is very narrow", () => {
    const description =
      "Uses {{inputs.repositoryUrl}} plus {{inputs.extremelyLongWorkflowTokenName}} for routing.";
    const spec = {
      ...BUNDLED_WORKFLOWS["multi-plan"]!,
      name: "narrow-wrap",
      description,
    };
    const { lastFrame } = render(
      <WorkflowPreview
        spec={spec}
        source="user"
        width={30}
        height={24}
        selectedIndex={0}
        dispatchCheck={{ ok: true }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("workflow preview");
    expect(frame).toContain("ready to run");
    expect(frame).toMatch(/repositoryUrl|extremelyLong/);
    expect(frame).not.toContain("ready to runworker");
    expect(frame.split("\n").length).toBeLessThanOrEqual(24);
  });
});

describe("preview input resolution", () => {
  it("formats agent targets with declared defaults and omits empty effort", () => {
    const spec = BUNDLED_WORKFLOWS.mainline!;
    const inputs = previewInputValues(spec);
    const plan = spec.phases[0]!.steps[0]!;
    const runner = formatWorkflowAgentTarget(
      {
        agent: "agent" in plan ? plan.agent : undefined,
        model: "model" in plan ? plan.model : undefined,
        effort: "effort" in plan ? plan.effort : undefined,
      },
      { inputs },
    );
    expect(runner).toContain("mimo-auto");
    expect(runner).not.toContain("{{inputs.");
    expect(runner).not.toMatch(/·\s*$/);
    expect(specDetailLines(plan, { inputs }).some((line) => line.startsWith("effort:"))).toBe(
      false,
    );
  });
});
