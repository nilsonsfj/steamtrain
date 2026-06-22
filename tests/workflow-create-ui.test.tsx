import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { WorkflowCreate, type WorkflowCreateState } from "../src/tui/WorkflowCreate";
import { WorkflowView } from "../src/tui/WorkflowView";
import type { PhaseState, StepState, WorkflowState } from "../src/tui/workflow-state";

describe("WorkflowCreate panel", () => {
  it("shows the agent and a drafting status while generating", () => {
    const state: WorkflowCreateState = {
      status: "generating",
      description: "review the checkout service for bugs",
      agent: "opencode",
      model: "opencode/qwen3.6-plus-free",
      text: 'thinking...\n{ "phases":',
    };
    const { lastFrame } = render(<WorkflowCreate state={state} width={100} height={20} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("create workflow");
    expect(frame).toContain("opencode/qwen3.6-plus-free");
    expect(frame).toContain("drafting workflow");
    expect(frame).toContain("checkout service");
  });

  it("shows the created workflow summary when done", () => {
    const state: WorkflowCreateState = {
      status: "done",
      description: "review code",
      agent: "opencode",
      model: "opencode/qwen3.6-plus-free",
      text: "",
      savedPath: "/home/u/.steamtrain/workflows.json",
      spec: {
        name: "review-code",
        description: "Scan then report.",
        phases: [
          {
            id: "scan",
            title: "Scan",
            steps: [
              {
                id: "scan",
                kind: "worker",
                agent: "opencode",
                model: "opencode/qwen3.6-plus-free",
                prompt: "{{input}}",
              },
            ],
          },
        ],
      },
    };
    const { lastFrame } = render(<WorkflowCreate state={state} width={100} height={20} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("created");
    expect(frame).toContain("review-code");
    expect(frame).toContain("saved →");
  });

  it("shows the error and dismiss hint when generation fails", () => {
    const state: WorkflowCreateState = {
      status: "error",
      description: "do a thing",
      agent: "claude",
      model: "claude-sonnet-4-6",
      text: "garbled non-json output",
      error: "no JSON object found in the model output",
    };
    const { lastFrame } = render(<WorkflowCreate state={state} width={100} height={20} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("no JSON object found");
    expect(frame).toContain("Esc to dismiss");
  });
});

describe("WorkflowView data-flow", () => {
  it("renders the dependsOn inputs of the selected step", () => {
    const steps: StepState[] = [
      {
        stepId: "draft",
        blockKind: "worker",
        agent: "opencode",
        model: "opencode/qwen3.6-plus-free",
        status: "done",
        text: "a draft",
        result: { stepId: "draft", ok: true, output: "a draft", durationMs: 1000 },
        cached: false,
      },
      {
        stepId: "report",
        blockKind: "consolidator",
        agent: "opencode",
        model: "opencode/qwen3.6-plus-free",
        dependsOn: ["draft", "critique"],
        status: "running",
        text: "",
        cached: false,
      },
    ];
    const phase: PhaseState = {
      phaseId: "p",
      title: "Phase",
      index: 0,
      stepCount: 2,
      steps,
      done: false,
      ok: true,
    };
    const state: WorkflowState = {
      name: "flow",
      startedAt: 0,
      phases: [phase],
      results: [],
      started: true,
      done: false,
      ok: true,
    };
    const { lastFrame } = render(
      <WorkflowView state={state} width={100} height={16} selectedIndex={1} elapsedMs={1000} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("inputs: draft, critique");
  });
});
