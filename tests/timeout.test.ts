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
} from "../src/workflow/timeout";
import type { WorkflowSpec } from "../src/workflow/types";

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
