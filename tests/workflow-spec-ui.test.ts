import { describe, expect, it } from "vitest";
import {
  blockSummary,
  flattenSpecSteps,
  formatGateCondition,
  phaseStepOffsets,
  specDetailLines,
  specStepRowMeta,
  subWorkflowDetailLines,
} from "../src/tui/workflow-spec-ui";
import {
  BUNDLED_WORKFLOWS,
  type WorkflowCallStep,
  type WorkflowSpec,
  describeSubWorkflow,
} from "../src/workflow";

describe("workflow-spec-ui", () => {
  it("computes phase step offsets", () => {
    const spec = BUNDLED_WORKFLOWS["bug-hunt"]!;
    const offsets = phaseStepOffsets(spec.phases);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(spec.phases.slice(0, -1).reduce((n, p) => n + p.steps.length, 0));
  });

  it("assigns stable flat indices while flattening", () => {
    const spec = BUNDLED_WORKFLOWS["bug-hunt"]!;
    const flat = flattenSpecSteps(spec);
    flat.forEach((entry, i) => expect(entry.flatIndex).toBe(i));
  });

  it("summarizes block kinds", () => {
    const spec = BUNDLED_WORKFLOWS["bug-hunt"]!;
    expect(blockSummary(spec)).toContain("worker:3");
    expect(blockSummary(spec)).toContain("consolidator:2");
  });

  it("formats gate conditions", () => {
    expect(formatGateCondition({ step: "gate", ok: true })).toBe("step=gate ok=true");
    expect(formatGateCondition({ contains: "error", not: true })).toBe('contains="error" not');
  });

  it("handles empty phases", () => {
    const spec = { name: "empty", phases: [] };
    expect(flattenSpecSteps(spec)).toEqual([]);
    expect(phaseStepOffsets(spec.phases)).toEqual([]);
    expect(blockSummary(spec)).toBe("");
  });

  describe("sub-workflow visualization", () => {
    const child: WorkflowSpec = {
      name: "bug-hunt",
      phases: [
        {
          id: "p",
          title: "P",
          steps: [
            { id: "scan", agent: "claude", model: "sonnet", prompt: "scan" },
            { id: "verify", dependsOn: ["scan"], agent: "codex", model: "gpt-5", prompt: "verify" },
          ],
        },
      ],
    };
    const resolve = (name: string) => (name === "bug-hunt" ? child : undefined);
    const callStep: WorkflowCallStep = { id: "call", kind: "workflow", workflow: "bug-hunt" };

    it("row meta shows a resolved rollup instead of the bare name", () => {
      const meta = specStepRowMeta(callStep, {}, resolve);
      expect(meta).toContain("bug-hunt");
      expect(meta).toContain("2 steps");
      expect(meta).toContain("claude/sonnet");
    });

    it("row meta falls back to the bare name without a resolver", () => {
      expect(specStepRowMeta(callStep)).toContain("bug-hunt");
    });

    it("detail lines unfold the child's steps and their run targets", () => {
      const lines = specDetailLines(callStep, {}, resolve);
      const joined = lines.join("\n");
      expect(joined).toContain("contains 2 steps");
      expect(joined).toContain("scan");
      expect(joined).toContain("claude/sonnet");
      expect(joined).toContain("verify");
      expect(joined).toContain("codex/gpt-5");
    });

    it("marks overridden steps in the detail breakdown", () => {
      const overridden: WorkflowCallStep = {
        ...callStep,
        overrides: { scan: { agent: "codex", model: "gpt-5" } },
      };
      const lines = subWorkflowDetailLines(describeSubWorkflow(overridden, resolve));
      const scanLine = lines.find((l) => l.includes("scan"));
      expect(scanLine).toContain("codex/gpt-5");
      expect(scanLine).toContain("*");
    });
  });
});
