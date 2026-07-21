import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { SteamtrainConfig } from "../src/config";
import { WorkflowRunStepEditor } from "../src/tui/WorkflowRunStepEditor";
import { WorkflowStepEditor } from "../src/tui/WorkflowStepEditor";
import {
  EDITOR_EFFORT_NONE,
  agentChangePatch,
  buildBulkEffortPatches,
  buildBulkModelPatches,
  buildBulkRetargetPatches,
  cycleOption,
  editorFieldsFor,
  effortChangePatch,
  listRetargetableSteps,
  modelChangePatch,
  stepEditorTarget,
  summarizeBulkRetarget,
} from "../src/tui/workflow-step-editor";
import type { WorkflowStep } from "../src/workflow";

const ESC = "";
const RIGHT = "[C";
const DOWN = "[B";
const CR = "\r";

const CONFIG: SteamtrainConfig = {};

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function type(stdin: { write: (data: string) => void }, ...inputs: string[]): Promise<void> {
  await tick();
  for (const input of inputs) {
    stdin.write(input);
    await tick();
  }
}

const workerStep: WorkflowStep = {
  id: "build",
  kind: "worker",
  agent: "claude",
  model: "sonnet",
  prompt: "do the build",
};

const llmStep: WorkflowStep = {
  id: "classify",
  kind: "llm",
  model: "claude-sonnet-5",
  prompt: "classify this",
};

const gateStep: WorkflowStep = {
  id: "check",
  kind: "gate",
  condition: { step: "build", ok: true },
};

describe("stepEditorTarget", () => {
  it("builds a full target for agent-backed steps", () => {
    const t = stepEditorTarget("wf", workerStep);
    expect(t).toMatchObject({
      workflowName: "wf",
      stepId: "build",
      agentBacked: true,
      hasPrompt: true,
      agent: "claude",
      model: "sonnet",
      prompt: "do the build",
    });
  });

  it("builds a prompt-only target for llm steps", () => {
    const t = stepEditorTarget("wf", llmStep);
    expect(t?.agentBacked).toBe(false);
    expect(t?.hasPrompt).toBe(true);
    expect(t?.prompt).toBe("classify this");
  });

  it("returns undefined for steps with nothing editable", () => {
    expect(stepEditorTarget("wf", gateStep)).toBeUndefined();
  });
});

describe("editorFieldsFor", () => {
  it("lists agent/model/effort/prompt for a worker with effort levels", () => {
    const t = stepEditorTarget("wf", workerStep)!;
    expect(editorFieldsFor(t, CONFIG)).toEqual(["agent", "model", "effort", "prompt"]);
  });

  it("drops the effort field for models without effort levels", () => {
    const haiku = stepEditorTarget("wf", { ...workerStep, model: "haiku" })!;
    expect(editorFieldsFor(haiku, CONFIG)).toEqual(["agent", "model", "prompt"]);
  });

  it("lists only the prompt field for llm steps", () => {
    const t = stepEditorTarget("wf", llmStep)!;
    expect(editorFieldsFor(t, CONFIG)).toEqual(["prompt"]);
  });
});

describe("cycleOption", () => {
  it("wraps forward and backward", () => {
    expect(cycleOption(["a", "b", "c"], "a", 1)).toBe("b");
    expect(cycleOption(["a", "b", "c"], "c", 1)).toBe("a");
    expect(cycleOption(["a", "b", "c"], "a", -1)).toBe("c");
  });

  it("returns the current value for singletons/empties", () => {
    expect(cycleOption(["a"], "a", 1)).toBe("a");
    expect(cycleOption([], "a", 1)).toBe("a");
  });
});

describe("change patches", () => {
  it("agentChangePatch resets model and effort when switching agents", () => {
    const patch = agentChangePatch(
      { agent: "claude", model: "sonnet", effort: "high" },
      "codex",
      CONFIG,
    );
    expect(patch.agent).toBe("codex");
    expect(patch.effort).toBeUndefined();
    expect(patch.model).toBeTruthy();
    expect(patch.model).not.toBe("sonnet");
  });

  it("agentChangePatch keeps model/effort when the agent is unchanged", () => {
    const patch = agentChangePatch(
      { agent: "claude", model: "sonnet", effort: "high" },
      "claude",
      CONFIG,
    );
    expect(patch).toEqual({ agent: "claude", model: "sonnet", effort: "high" });
  });

  it("modelChangePatch drops effort the new model does not support", () => {
    const patch = modelChangePatch(
      { agent: "claude", model: "opus", effort: "xhigh" },
      "haiku",
      CONFIG,
    );
    expect(patch.model).toBe("haiku");
    expect(patch.effort).toBeUndefined();
  });

  it("effortChangePatch maps the sentinel to undefined", () => {
    expect(effortChangePatch(EDITOR_EFFORT_NONE)).toEqual({ effort: undefined });
    expect(effortChangePatch("high")).toEqual({ effort: "high" });
  });
});

describe("WorkflowStepEditor (interactive)", () => {
  it("renders the editable fields for a worker step", () => {
    const target = stepEditorTarget("wf", workerStep)!;
    const { lastFrame } = render(
      <WorkflowStepEditor
        target={target}
        config={CONFIG}
        width={80}
        height={20}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("edit step");
    expect(frame).toContain("build");
    expect(frame).toContain("agent");
    expect(frame).toContain("model");
    expect(frame).toContain("prompt");
    expect(frame).toContain("claude");
  });

  it("cycles the model with ↝/→ and stages a patch", async () => {
    const target = stepEditorTarget("wf", workerStep)!;
    const onApply = vi.fn();
    const { stdin } = render(
      <WorkflowStepEditor
        target={target}
        config={CONFIG}
        width={80}
        height={20}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    // Focus starts on the agent field; move down to model, then cycle.
    await type(stdin, DOWN, RIGHT);
    expect(onApply).toHaveBeenCalled();
    const patch = onApply.mock.calls.at(-1)?.[0];
    expect(patch.model).toBeTruthy();
    expect(patch.model).not.toBe("sonnet");
  });

  it("cycles the agent with ↝/→ from the first field", async () => {
    const target = stepEditorTarget("wf", workerStep)!;
    const onApply = vi.fn();
    const { stdin } = render(
      <WorkflowStepEditor
        target={target}
        config={CONFIG}
        width={80}
        height={20}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    await type(stdin, RIGHT);
    expect(onApply).toHaveBeenCalled();
    expect(onApply.mock.calls.at(-1)?.[0]).toHaveProperty("agent");
  });

  it("edits the prompt and stages each keystroke", async () => {
    const target = stepEditorTarget("wf", llmStep)!;
    const onApply = vi.fn();
    const { stdin, lastFrame } = render(
      <WorkflowStepEditor
        target={target}
        config={CONFIG}
        width={80}
        height={20}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    // Only field is prompt; Enter to edit, then type.
    await type(stdin, CR, "!", "!");
    const patch = onApply.mock.calls.at(-1)?.[0];
    expect(patch.prompt).toBe("classify this!!");
    expect(lastFrame() ?? "").toContain("classify this!!");
  });

  it("calls onClose on Escape when not editing the prompt", async () => {
    const target = stepEditorTarget("wf", workerStep)!;
    const onClose = vi.fn();
    const { stdin } = render(
      <WorkflowStepEditor
        target={target}
        config={CONFIG}
        width={80}
        height={20}
        onApply={() => {}}
        onClose={onClose}
      />,
    );
    await type(stdin, ESC);
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape leaves prompt editing before it closes the editor", async () => {
    const target = stepEditorTarget("wf", llmStep)!;
    const onClose = vi.fn();
    const { stdin } = render(
      <WorkflowStepEditor
        target={target}
        config={CONFIG}
        width={80}
        height={20}
        onApply={() => {}}
        onClose={onClose}
      />,
    );
    // Enter edit mode, first Esc exits editing (no close), second Esc closes.
    await type(stdin, CR, ESC);
    expect(onClose).not.toHaveBeenCalled();
    await type(stdin, ESC);
    expect(onClose).toHaveBeenCalled();
  });

  it("pressing A applies the current agent/model/effort to all siblings", async () => {
    const target = stepEditorTarget("wf", workerStep)!;
    const onApplyAll = vi.fn();
    const siblings = [
      { stepId: "build", kindLabel: "worker", agent: "claude", model: "sonnet" },
      { stepId: "review", kindLabel: "worker", agent: "codex", model: "gpt-5" },
    ];
    const { stdin, lastFrame } = render(
      <WorkflowStepEditor
        target={target}
        config={CONFIG}
        width={100}
        height={24}
        siblings={siblings}
        onApply={() => {}}
        onApplyAll={onApplyAll}
        onClose={() => {}}
      />,
    );
    expect(lastFrame() ?? "").toContain("press");
    expect(lastFrame() ?? "").toContain("retarget all");
    await type(stdin, "A");
    expect(onApplyAll).toHaveBeenCalled();
    const [patches, summary] = onApplyAll.mock.calls[0]!;
    expect(patches.build).toMatchObject({ agent: "claude", model: "sonnet" });
    expect(patches.review).toMatchObject({ agent: "claude", model: "sonnet" });
    expect(summary).toContain("steps");
  });
});

describe("bulk retarget helpers", () => {
  const spec = {
    name: "bulk-wf",
    phases: [
      {
        id: "p1",
        title: "P1",
        steps: [
          { id: "a", kind: "worker" as const, agent: "claude", model: "sonnet", prompt: "a" },
          { id: "b", kind: "worker" as const, agent: "codex", model: "gpt-5", prompt: "b" },
          { id: "g", kind: "gate" as const, condition: { step: "a", ok: true } },
        ],
      },
    ],
  } as import("../src/workflow").WorkflowSpec;

  it("listRetargetableSteps skips non-agent steps", () => {
    const steps = listRetargetableSteps(spec);
    expect(steps.map((s) => s.stepId)).toEqual(["a", "b"]);
  });

  it("buildBulkRetargetPatches retargets every agent step onto one triad", () => {
    const steps = listRetargetableSteps(spec);
    const patches = buildBulkRetargetPatches(steps, { agent: "claude", model: "opus" }, CONFIG);
    expect(Object.keys(patches).sort()).toEqual(["a", "b"]);
    expect(patches.a).toMatchObject({ agent: "claude", model: "opus" });
    expect(patches.b).toMatchObject({ agent: "claude", model: "opus" });
  });

  it("buildBulkRetargetPatches skips steps that already match", () => {
    const steps = listRetargetableSteps(spec);
    const patches = buildBulkRetargetPatches(steps, { agent: "claude", model: "sonnet" }, CONFIG);
    expect(patches.a).toBeUndefined();
    expect(patches.b).toMatchObject({ agent: "claude", model: "sonnet" });
  });

  it("buildBulkModelPatches only touches steps on the same agent", () => {
    const steps = listRetargetableSteps(spec);
    const patches = buildBulkModelPatches(steps, "claude", "opus", CONFIG);
    expect(Object.keys(patches)).toEqual(["a"]);
    expect(patches.a).toMatchObject({ model: "opus" });
  });

  it("summarizeBulkRetarget describes the change", () => {
    const summary = summarizeBulkRetarget(
      { a: { agent: "claude", model: "opus" }, b: { agent: "claude", model: "opus" } },
      { agent: "claude", model: "opus" },
      CONFIG,
    );
    expect(summary).toContain("2 steps");
    expect(summary).toContain("claude");
    expect(summary).toContain("opus");
  });

  it("buildBulkRetargetPatches returns empty when every step already matches", () => {
    const steps = [
      { stepId: "a", kindLabel: "worker", agent: "claude", model: "sonnet" },
      { stepId: "b", kindLabel: "worker", agent: "claude", model: "sonnet" },
    ];
    const patches = buildBulkRetargetPatches(steps, { agent: "claude", model: "sonnet" }, CONFIG);
    expect(patches).toEqual({});
    expect(summarizeBulkRetarget(patches, { agent: "claude", model: "sonnet" }, CONFIG)).toContain(
      "already matches",
    );
  });

  it("buildBulkEffortPatches sets effort only where supported", () => {
    const steps = [
      { stepId: "a", kindLabel: "worker", agent: "claude", model: "sonnet", effort: undefined },
      { stepId: "b", kindLabel: "worker", agent: "claude", model: "haiku", effort: undefined },
    ];
    const patches = buildBulkEffortPatches(steps, "high", CONFIG);
    // sonnet typically supports effort; haiku may not � only include supported steps.
    for (const [id, patch] of Object.entries(patches)) {
      expect(patch).toEqual({ effort: "high" });
      expect(id).toBe("a");
    }
  });

  it("buildBulkEffortPatches clears effort and skips already-cleared steps", () => {
    const steps = [
      { stepId: "a", kindLabel: "worker", agent: "claude", model: "sonnet", effort: "high" },
      { stepId: "b", kindLabel: "worker", agent: "claude", model: "sonnet", effort: undefined },
    ];
    const patches = buildBulkEffortPatches(steps, undefined, CONFIG);
    expect(patches.a).toEqual({ effort: undefined });
    expect(patches.b).toBeUndefined();
  });
});

describe("WorkflowRunStepEditor (interactive)", () => {
  it("renders prompt editing chrome for a pending agent step", () => {
    const { lastFrame } = render(
      <WorkflowRunStepEditor
        target={{
          stepId: "build",
          kindLabel: "worker",
          field: "prompt",
          initial: "do the build",
          modelEditable: true,
          agent: "claude",
          model: "sonnet",
        }}
        config={CONFIG}
        width={80}
        height={20}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("edit paused run");
    expect(frame).toContain("build");
    expect(frame).toContain("prompt");
    expect(frame).toContain("model");
    expect(frame).toContain("do the build");
  });

  it("commits a single prompt patch on Enter when model rows are absent", async () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    const { stdin } = render(
      <WorkflowRunStepEditor
        target={{
          stepId: "build",
          kindLabel: "command",
          field: "cmd",
          initial: "npm test",
          modelEditable: false,
        }}
        config={CONFIG}
        width={80}
        height={16}
        onApply={onApply}
        onClose={onClose}
      />,
    );
    await type(stdin, " ", "--watch", CR);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]![0]).toEqual({ cmd: "npm test --watch" });
    expect(onClose).toHaveBeenCalled();
  });

  it("Escape discards buffered edits without applying", async () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    const { stdin } = render(
      <WorkflowRunStepEditor
        target={{
          stepId: "build",
          kindLabel: "worker",
          field: "prompt",
          initial: "do the build",
          modelEditable: false,
        }}
        config={CONFIG}
        width={80}
        height={16}
        onApply={onApply}
        onClose={onClose}
      />,
    );
    await type(stdin, "!", ESC, ESC);
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("cycles model with ?/? then commits model+prompt as one patch", async () => {
    const onApply = vi.fn();
    const { stdin } = render(
      <WorkflowRunStepEditor
        target={{
          stepId: "build",
          kindLabel: "worker",
          field: "prompt",
          initial: "do the build",
          modelEditable: true,
          agent: "claude",
          model: "sonnet",
          effort: "high",
        }}
        config={CONFIG}
        width={90}
        height={22}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    // Leave text editing, move to model, cycle, then Enter to commit.
    await type(stdin, CR, DOWN, RIGHT, CR);
    expect(onApply).toHaveBeenCalled();
    const patch = onApply.mock.calls.at(-1)?.[0];
    expect(patch.model).toBeTruthy();
    expect(patch.model).not.toBe("sonnet");
  });
});
