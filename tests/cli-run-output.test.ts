import { describe, expect, it } from "vitest";
import { printHumanEvent } from "../src/run-cli";
import { describeIssue } from "../src/util/zod-issue";
import type { WorkflowEvent } from "../src/workflow";

function capture() {
  let text = "";
  const out = (chunk: string) => {
    text += chunk;
  };
  return { out, text: () => text };
}

const ts = 0;
const delta = (text: string): WorkflowEvent => ({
  kind: "step_event",
  phaseId: "a",
  stepId: "s1",
  event: { kind: "text_delta", agent: "opencode", ts, text },
  ts,
});
const done = (ok: boolean, error?: string): WorkflowEvent => ({
  kind: "step_done",
  phaseId: "a",
  stepId: "s1",
  result: { stepId: "s1", ok, output: "", error, durationMs: 1 },
  cached: false,
  ts,
});

describe("printHumanEvent", () => {
  it("starts a status line on a fresh line after streamed agent text", () => {
    const { out, text } = capture();
    printHumanEvent(delta("noted"), out);
    printHumanEvent(done(true), out);
    expect(text()).toBe("noted\n  done s1\n");
  });

  it("adds no blank line when the agent text already ended its line", () => {
    const { out, text } = capture();
    printHumanEvent(delta("noted\n"), out);
    printHumanEvent(done(true), out);
    expect(text()).toBe("noted\n  done s1\n");
  });

  it("says why a step failed", () => {
    const { out, text } = capture();
    printHumanEvent(done(false, "'opencode' exited with code 1: boom\nmore detail"), out);
    expect(text()).toBe("  fail s1\n     'opencode' exited with code 1: boom\n");
  });

  it("reports a canceled run as canceled, without blaming its interrupted steps", () => {
    const { out, text } = capture();
    printHumanEvent(done(false, "cancelled"), out, { canceled: true });
    printHumanEvent({ kind: "workflow_done", ok: false, results: [], ts }, out, { canceled: true });
    expect(text()).toBe("  fail s1\n\nworkflow canceled\n");
  });
});

describe("describeIssue", () => {
  it("names the field a schema issue is about", () => {
    expect(
      describeIssue({ path: ["workflows", "x", "phases", 0, "title"], message: "Required" }),
    ).toBe("workflows.x.phases.0.title: Required");
    expect(describeIssue({ path: [], message: "Expected object" })).toBe("config: Expected object");
    expect(describeIssue(undefined)).toBe("schema error");
  });
});
