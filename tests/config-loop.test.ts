import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults";
import { configFileSchema } from "../src/config/types";
import { DEFAULT_LOOP_MAX_ITERATIONS } from "../src/workflow/types";

describe("loopMaxIterations config", () => {
  it("defaults to DEFAULT_LOOP_MAX_ITERATIONS", () => {
    expect(DEFAULT_CONFIG.loopMaxIterations).toBe(DEFAULT_LOOP_MAX_ITERATIONS);
  });

  it("accepts a valid override", () => {
    const r = configFileSchema.safeParse({ loopMaxIterations: 25 });
    expect(r.success).toBe(true);
  });

  it("rejects values above the ceiling", () => {
    const r = configFileSchema.safeParse({ loopMaxIterations: 101 });
    expect(r.success).toBe(false);
  });

  it("rejects zero / negatives", () => {
    expect(configFileSchema.safeParse({ loopMaxIterations: 0 }).success).toBe(false);
  });
});

describe("maxConcurrency config", () => {
  it("defaults to 5", () => {
    expect(DEFAULT_CONFIG.maxConcurrency).toBe(5);
  });
});
