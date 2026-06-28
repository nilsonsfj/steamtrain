import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults";
import { mergeConfig } from "../src/config/load";
import {
  DEFAULT_STEP_TIMEOUT_SEC,
  countStaticWorkflowSteps,
  formatDurationSec,
  parseDurationSec,
  resolveStepTimeoutSec,
  resolveWorkflowTimeoutSec,
  timeoutMsFromSec,
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
  it("defaults step timeout to 15 minutes in seconds", () => {
    expect(resolveStepTimeoutSec(undefined, undefined, {})).toBe(DEFAULT_STEP_TIMEOUT_SEC);
    expect(DEFAULT_CONFIG.stepTimeoutSec).toBe(DEFAULT_STEP_TIMEOUT_SEC);
    expect(timeoutMsFromSec(900)).toBe(900_000);
  });

  it("defaults workflow timeout to stepCount × step timeout", () => {
    const spec = demoSpec(4);
    expect(resolveWorkflowTimeoutSec(spec, {})).toBe(4 * DEFAULT_STEP_TIMEOUT_SEC);
    expect(countStaticWorkflowSteps(spec)).toBe(4);
  });

  it("honors per-layer overrides in seconds", () => {
    const spec = demoSpec(2);
    spec.stepTimeoutSec = 60;
    spec.workflowTimeoutSec = 120;
    expect(resolveStepTimeoutSec({ stepTimeoutSec: 30 }, spec, {})).toBe(30);
    expect(resolveStepTimeoutSec(undefined, spec, {})).toBe(60);
    expect(resolveWorkflowTimeoutSec(spec, {})).toBe(120);
  });

  it("migrates legacy millisecond fields at resolve time", () => {
    expect(resolveStepTimeoutSec({ stepTimeoutMs: 30_000 }, undefined, {})).toBe(30);
    const spec = demoSpec(1);
    spec.workflowTimeoutMs = 120_000;
    expect(resolveWorkflowTimeoutSec(spec, {})).toBe(120);
  });

  it("budgets loop re-runs into the auto workflow timeout", () => {
    // 4 static steps; the gate loops the 3-step body (review+fix+gate) up to 5×.
    // worst case = 4 + (5-1)*3 = 16 steps, not the naive 4.
    const spec = loopSpec(5);
    expect(countStaticWorkflowSteps(spec)).toBe(4);
    expect(workflowTimeoutStepBudget(spec, 5)).toBe(16);
    expect(resolveWorkflowTimeoutSec(spec, {})).toBe(16 * DEFAULT_STEP_TIMEOUT_SEC);
  });

  it("falls back to the config loop cap when a loop gate omits maxIterations", () => {
    const spec = loopSpec();
    // config loopMaxIterations 3 → body (3 steps) runs 3× → 4 + (3-1)*3 = 10.
    expect(workflowTimeoutStepBudget(spec, 3)).toBe(10);
    expect(resolveWorkflowTimeoutSec(spec, { loopMaxIterations: 3 })).toBe(
      10 * DEFAULT_STEP_TIMEOUT_SEC,
    );
    // default loop cap (10) → 4 + (10-1)*3 = 31.
    expect(workflowTimeoutStepBudget(spec)).toBe(31);
  });

  it("explicit workflowTimeoutSec still overrides the loop-aware default", () => {
    const spec = demoSpec(2);
    spec.workflowTimeoutSec = 120;
    expect(resolveWorkflowTimeoutSec(spec, {})).toBe(120);
  });

  it("migrates legacy timeoutMs in config merge to stepTimeoutSec only", () => {
    const { config } = mergeConfig(DEFAULT_CONFIG, { timeoutMs: 250_000 });
    expect(config.stepTimeoutSec).toBe(250);
    expect(config.workflowTimeoutSec).toBeUndefined();
    expect("timeoutMs" in config).toBe(false);
  });

  it("uses auto workflow timeout when legacy timeoutMs is present without workflowTimeoutSec", () => {
    const spec = demoSpec(2);
    const { config } = mergeConfig(DEFAULT_CONFIG, { timeoutMs: 250_000 });
    expect(resolveWorkflowTimeoutSec(spec, config)).toBe(2 * 250);
  });

  it("budgets static forEach fan-out into the auto workflow timeout", () => {
    const spec: WorkflowSpec = {
      name: "fanout",
      phases: [
        {
          id: "dist",
          title: "Dist",
          steps: [
            {
              id: "tasks",
              kind: "distributor",
              items: ["a", "b", "c"],
            },
          ],
        },
        {
          id: "work",
          title: "Work",
          steps: [
            {
              id: "each",
              agent: "opencode",
              model: "m",
              prompt: "go",
              forEach: "steps.tasks.items",
            },
          ],
        },
      ],
    };
    expect(workflowTimeoutStepBudget(spec)).toBe(5);
    expect(resolveWorkflowTimeoutSec(spec, {})).toBe(5 * DEFAULT_STEP_TIMEOUT_SEC);
  });

  it("parses human duration tokens into seconds", () => {
    expect(parseDurationSec("900")).toBe(900);
    expect(parseDurationSec("15m")).toBe(15 * 60);
    expect(parseDurationSec("1h")).toBe(60 * 60);
    expect(parseDurationSec("500ms")).toBe(0.5);
    expect(parseDurationSec("bad")).toBeUndefined();
  });

  it("formats durations readably from seconds", () => {
    expect(formatDurationSec(900)).toBe("15m");
    expect(formatDurationSec(3600)).toBe("1h");
    expect(formatDurationSec(0.5)).toBe("500ms");
  });
});
