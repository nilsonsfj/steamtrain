import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults";
import { mergeConfig } from "../src/config/load";
import {
  DEFAULT_STEP_TIMEOUT_MS,
  countStaticWorkflowSteps,
  formatDurationMs,
  parseDurationMs,
  resolveStepTimeoutMs,
  resolveWorkflowTimeoutMs,
  workflowTimeoutStepBudget,
} from "../src/workflow/timeout";
import type { WorkflowSpec } from "../src/workflow/types";

/** A 4-phase implement→review→fix→gate spec whose gate loops back to "review". */
const loopSpec = (maxIterations?: number): WorkflowSpec => ({
  name: "loop",
  phases: [
    {
      id: "implement",
      title: "Implement",
      steps: [{ id: "impl", agent: "opencode", model: "m", prompt: "go" }],
    },
    {
      id: "review",
      title: "Review",
      steps: [{ id: "rev", agent: "opencode", model: "m", prompt: "go" }],
    },
    {
      id: "fix",
      title: "Fix",
      steps: [{ id: "fix", agent: "opencode", model: "m", prompt: "go" }],
    },
    {
      id: "gate",
      title: "Converged?",
      steps: [
        {
          id: "g",
          kind: "gate",
          condition: { step: "rev", contains: "DONE" },
          loopTo: "review",
          ...(maxIterations !== undefined ? { maxIterations } : {}),
          onFalse: "continue",
        },
      ],
    },
  ],
});

const demoSpec = (steps = 2): WorkflowSpec => ({
  name: "demo",
  phases: [
    {
      id: "p",
      title: "P",
      steps: Array.from({ length: steps }, (_, i) => ({
        id: `s${i}`,
        agent: "opencode",
        model: "m",
        prompt: "go",
      })),
    },
  ],
});

describe("timeout resolution", () => {
  it("defaults step timeout to 15 minutes", () => {
    expect(resolveStepTimeoutMs(undefined, undefined, {})).toBe(DEFAULT_STEP_TIMEOUT_MS);
    expect(DEFAULT_CONFIG.stepTimeoutMs).toBe(DEFAULT_STEP_TIMEOUT_MS);
  });

  it("defaults workflow timeout to stepCount × step timeout", () => {
    const spec = demoSpec(4);
    expect(resolveWorkflowTimeoutMs(spec, {})).toBe(4 * DEFAULT_STEP_TIMEOUT_MS);
    expect(countStaticWorkflowSteps(spec)).toBe(4);
  });

  it("honors per-layer overrides", () => {
    const spec = demoSpec(2);
    spec.stepTimeoutMs = 60_000;
    spec.workflowTimeoutMs = 120_000;
    expect(resolveStepTimeoutMs({ stepTimeoutMs: 30_000 }, spec, {})).toBe(30_000);
    expect(resolveStepTimeoutMs(undefined, spec, {})).toBe(60_000);
    expect(resolveWorkflowTimeoutMs(spec, {})).toBe(120_000);
  });

  it("budgets loop re-runs into the auto workflow timeout", () => {
    // 4 static steps; the gate loops the 3-step body (review+fix+gate) up to 5×.
    // worst case = 4 + (5-1)*3 = 16 steps, not the naive 4.
    const spec = loopSpec(5);
    expect(countStaticWorkflowSteps(spec)).toBe(4);
    expect(workflowTimeoutStepBudget(spec, 5)).toBe(16);
    expect(resolveWorkflowTimeoutMs(spec, {})).toBe(16 * DEFAULT_STEP_TIMEOUT_MS);
  });

  it("falls back to the config loop cap when a loop gate omits maxIterations", () => {
    const spec = loopSpec();
    // config loopMaxIterations 3 → body (3 steps) runs 3× → 4 + (3-1)*3 = 10.
    expect(workflowTimeoutStepBudget(spec, 3)).toBe(10);
    expect(resolveWorkflowTimeoutMs(spec, { loopMaxIterations: 3 })).toBe(
      10 * DEFAULT_STEP_TIMEOUT_MS,
    );
    // default loop cap (10) → 4 + (10-1)*3 = 31.
    expect(workflowTimeoutStepBudget(spec)).toBe(31);
  });

  it("explicit workflowTimeoutMs still overrides the loop-aware default", () => {
    const spec = loopSpec(5);
    spec.workflowTimeoutMs = 120_000;
    expect(resolveWorkflowTimeoutMs(spec, {})).toBe(120_000);
  });

  it("migrates legacy timeoutMs in config merge", () => {
    const { config } = mergeConfig(DEFAULT_CONFIG, { timeoutMs: 250_000 });
    expect(config.stepTimeoutMs).toBe(250_000);
    expect(config.workflowTimeoutMs).toBe(250_000);
    expect(config.timeoutMs).toBe(250_000);
  });

  it("parses human duration tokens", () => {
    expect(parseDurationMs("900000")).toBe(900_000);
    expect(parseDurationMs("15m")).toBe(15 * 60 * 1000);
    expect(parseDurationMs("1h")).toBe(60 * 60 * 1000);
    expect(parseDurationMs("bad")).toBeUndefined();
  });

  it("formats durations readably", () => {
    expect(formatDurationMs(900_000)).toBe("15m");
    expect(formatDurationMs(3_600_000)).toBe("1h");
  });
});
