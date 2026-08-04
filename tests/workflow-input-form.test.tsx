import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WorkflowInputForm } from "../src/tui/WorkflowInputForm";
import type { WorkflowSpec } from "../src/workflow";
import { tick, type } from "./helpers/ink-input";

const ESC = "\u001b";

function makeSpec(inputs: WorkflowSpec["inputs"]): WorkflowSpec {
  return {
    name: "test-wf",
    phases: [
      {
        id: "p1",
        title: "Phase 1",
        steps: [{ id: "s1", kind: "worker", agent: "claude", model: "sonnet", prompt: "do stuff" }],
      },
    ],
    inputs,
  };
}

describe("WorkflowInputForm", () => {
  it("renders fields for each declared input", () => {
    const spec = makeSpec({
      version: { type: "string", description: "Release version" },
      dryRun: { type: "boolean", default: false },
    });
    const { lastFrame } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("version");
    expect(frame).toContain("Release version");
    expect(frame).toContain("dryRun");
    expect(frame).toContain("(y/n)");
    expect(frame).toContain("input parameters · test-wf");
  });

  it("shows required indicator for required fields", () => {
    const spec = makeSpec({
      name: { type: "string", required: true },
      opt: { type: "string", required: false },
    });
    const { lastFrame } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("name");
    expect(frame).toContain("opt");
  });

  it("shows default values", () => {
    const spec = makeSpec({
      count: { type: "number", default: 42 },
      flag: { type: "boolean", default: true },
    });
    const { lastFrame } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("count");
    expect(frame).toContain("42");
    expect(frame).toContain("flag");
  });

  it("renders empty form when no inputs", () => {
    const spec = makeSpec(undefined);
    const { lastFrame } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("0 parameters");
  });

  it("calls onCancel when Escape is pressed", async () => {
    const onCancel = vi.fn();
    const spec = makeSpec({ x: { type: "string" } });
    const { stdin } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={() => {}}
        onCancel={onCancel}
      />,
    );
    await type(stdin, ESC);
    expect(onCancel).toHaveBeenCalled();
  });

  it("submits with resolveInputs validation on Enter", async () => {
    const onSubmit = vi.fn();
    const spec = makeSpec({
      name: { type: "string", default: "hello" },
    });
    const { stdin } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    // Press Enter to submit (field has default value "hello")
    await type(stdin, "\r");
    expect(onSubmit).toHaveBeenCalledWith({ name: "hello" });
  });

  it("shows error for required field missing value on submit", async () => {
    const onSubmit = vi.fn();
    const spec = makeSpec({
      req: { type: "string", required: true },
    });
    const { stdin, lastFrame } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    // Press Enter to submit with empty value
    await type(stdin, "\r");
    expect(onSubmit).not.toHaveBeenCalled();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("req");
  });

  it("navigates between fields with Tab", async () => {
    const spec = makeSpec({
      a: { type: "string", default: "val-a" },
      b: { type: "string", default: "val-b" },
    });
    const { stdin, lastFrame } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    await tick();
    let frame = lastFrame() ?? "";
    // First field (a) should be focused initially
    expect(frame).toContain("▶");

    // Tab to next field
    await type(stdin, "\t");
    frame = lastFrame() ?? "";
    // Focus indicator should still be present (on field b now)
    expect(frame).toContain("▶");
  });

  it("allows typing into string fields", async () => {
    const onSubmit = vi.fn();
    const spec = makeSpec({
      name: { type: "string" },
    });
    const { stdin, lastFrame } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    // Type characters
    await type(stdin, "h", "e", "l", "l", "o");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello");

    // Submit
    await type(stdin, "\r");
    expect(onSubmit).toHaveBeenCalledWith({ name: "hello" });
  });

  it("filters non-numeric characters in number fields", async () => {
    const spec = makeSpec({
      count: { type: "number" },
    });
    const { stdin, lastFrame } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    // Type valid number characters
    await type(stdin, "1", "2", "3");
    let frame = lastFrame() ?? "";
    expect(frame).toContain("123");

    // Type letter — should be filtered out
    await type(stdin, "a");
    frame = lastFrame() ?? "";
    expect(frame).toContain("123");
    expect(frame).not.toContain("123a");
  });

  it("toggles boolean with y/n in edit mode", async () => {
    const onSubmit = vi.fn();
    const spec = makeSpec({
      flag: { type: "boolean" },
    });
    const { stdin, lastFrame } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    // Press Enter to enter boolean edit mode
    await type(stdin, "\r");
    let frame = lastFrame() ?? "";
    expect(frame).toContain("y/n");

    // Press y to set true
    await type(stdin, "y");
    frame = lastFrame() ?? "";
    expect(frame).toContain("[true]");
  });

  it("toggles boolean to false with n", async () => {
    const onSubmit = vi.fn();
    const spec = makeSpec({
      flag: { type: "boolean" },
    });
    const { stdin, lastFrame } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    // Enter edit mode
    await type(stdin, "\r");
    // Press n to set false
    await type(stdin, "n");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[false]");
  });

  it("deletes characters with Backspace", async () => {
    const spec = makeSpec({
      name: { type: "string" },
    });
    const { stdin, lastFrame } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    await type(stdin, "h", "i");
    let frame = lastFrame() ?? "";
    expect(frame).toContain("hi");

    // Backspace to delete
    await type(stdin, "\x7f");
    frame = lastFrame() ?? "";
    expect(frame).toContain("h");
    expect(frame).not.toContain("hi");
  });

  it("shows validation error content for required field", async () => {
    const spec = makeSpec({
      req: { type: "string", required: true },
    });
    const { stdin, lastFrame } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    // Submit with empty value
    await type(stdin, "\r");
    const frame = lastFrame() ?? "";
    // The error from resolveInputs should be displayed
    expect(frame).toContain("missing required input");
  });

  it("navigates backward with Shift+Tab", async () => {
    const spec = makeSpec({
      a: { type: "string", default: "val-a" },
      b: { type: "string", default: "val-b" },
      c: { type: "string", default: "val-c" },
    });
    const { stdin, lastFrame } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    // Tab forward to field b
    await type(stdin, "\t");
    // Shift+Tab back to field a
    await type(stdin, "\u001b[Z");
    const frame = lastFrame() ?? "";
    // Should still have focus indicator
    expect(frame).toContain("▶");
  });

  it("labels model and enum fields and shows fallback hint", async () => {
    const spec = makeSpec({
      coderModel: {
        type: "model",
        description: "Primary coder",
        default: "mimo",
        fallbackModels: ["flash", "north"],
      },
      timing: {
        type: "enum",
        choices: ["live", "end"],
        default: "end",
      },
    });
    const { stdin, lastFrame } = render(
      <WorkflowInputForm
        spec={spec}
        width={100}
        height={24}
        modelSuggestions={["mimo", "flash", "north", "opus 4.8"]}
        agentSuggestions={["claude", "opencode"]}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    await tick();
    let frame = lastFrame() ?? "";
    expect(frame).toContain("(model)");
    expect(frame).toContain("(enum)");
    expect(frame).toContain("fallback: flash → north");
    // Move focus to the enum field to surface its choices.
    await type(stdin, "\t");
    frame = lastFrame() ?? "";
    expect(frame).toContain("1:live");
    expect(frame).toContain("2:end");
  });

  it("submits a filled boolean with Enter without re-entering edit mode", async () => {
    const onSubmit = vi.fn();
    const spec = makeSpec({
      flag: { type: "boolean", default: true },
    });
    const { stdin } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await type(stdin, "\r");
    expect(onSubmit).toHaveBeenCalledWith({ flag: true });
  });

  it("cycles string inputs that declare choices", async () => {
    const onSubmit = vi.fn();
    const spec = makeSpec({
      mode: { type: "string", choices: ["report", "github"], default: "report" },
    });
    const { stdin } = render(
      <WorkflowInputForm
        spec={spec}
        width={80}
        height={20}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    await tick();
    await type(stdin, "\u001b[C"); // right arrow
    await type(stdin, "\r");
    expect(onSubmit).toHaveBeenCalledWith({ mode: "github" });
  });
});
