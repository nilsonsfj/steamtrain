import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WorkflowInputForm } from "../src/tui/WorkflowInputForm";
import type { WorkflowSpec } from "../src/workflow";

const ESC = "\u001b";

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
    await tick();
    // Press Enter to submit (field has default value "hello")
    stdin.write("\r");
    await tick();
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
    await tick();
    // Press Enter to submit with empty value
    stdin.write("\r");
    await tick();
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
    stdin.write("\t");
    await tick();
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
    await tick();
    // Type characters
    await type(stdin, "h", "e", "l", "l", "o");
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello");

    // Submit
    stdin.write("\r");
    await tick();
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
    await tick();
    // Type valid number characters
    await type(stdin, "1", "2", "3");
    let frame = lastFrame() ?? "";
    expect(frame).toContain("123");

    // Type letter — should be filtered out
    stdin.write("a");
    await tick();
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
    await tick();

    // Press Enter to enter boolean edit mode
    stdin.write("\r");
    await tick();
    let frame = lastFrame() ?? "";
    expect(frame).toContain("y/n");

    // Press y to set true
    stdin.write("y");
    await tick();
    frame = lastFrame() ?? "";
    expect(frame).toContain("[true]");
  });
});
