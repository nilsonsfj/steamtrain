import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { SteamtrainConfig } from "../src/config";
import { WorkflowStepEditor } from "../src/tui/WorkflowStepEditor";
import {
  EDITOR_EFFORT_NONE,
  agentChangePatch,
  cycleOption,
  editorFieldsFor,
  effortChangePatch,
  modelChangePatch,
  stepEditorTarget,
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

  it("cycles the model with ←/→ and stages a patch", async () => {
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

  it("cycles the agent with ←/→ from the first field", async () => {
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
});
