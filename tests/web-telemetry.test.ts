import { describe, expect, it } from "vitest";
import { createThroughputMeter, projectCost } from "../src/web/telemetry";

describe("projectCost", () => {
  it("scales spend by the ratio of total to completed steps", () => {
    expect(projectCost({ spentUsd: 0.04, completedSteps: 3, totalSteps: 6 })).toBeCloseTo(0.08, 6);
  });

  it("returns the spend itself once every step is done", () => {
    expect(projectCost({ spentUsd: 0.0714, completedSteps: 6, totalSteps: 6 })).toBeCloseTo(
      0.0714,
      6,
    );
  });

  it("returns null before any step completes", () => {
    expect(projectCost({ spentUsd: 0, completedSteps: 0, totalSteps: 6 })).toBeNull();
  });

  it("returns null when there are no steps at all", () => {
    expect(projectCost({ spentUsd: 0, completedSteps: 0, totalSteps: 0 })).toBeNull();
  });

  it("never projects below what has already been spent", () => {
    expect(projectCost({ spentUsd: 0.5, completedSteps: 8, totalSteps: 6 })).toBeCloseTo(0.5, 6);
  });
});

describe("createThroughputMeter", () => {
  it("reports no throughput from a single sample", () => {
    const meter = createThroughputMeter(60_000);
    meter.sample(1000, 0);
    expect(meter.bars(4)).toEqual([0, 0, 0, 0]);
  });

  it("normalises bars against the busiest interval", () => {
    const meter = createThroughputMeter(60_000);
    meter.sample(0, 0);
    meter.sample(100, 1000);
    meter.sample(300, 2000);
    const bars = meter.bars(2);
    expect(bars).toHaveLength(2);
    expect(bars[1]).toBeCloseTo(1, 6);
    expect(bars[0]).toBeCloseTo(0.5, 6);
  });

  it("drops samples older than the window", () => {
    const meter = createThroughputMeter(10_000);
    meter.sample(0, 0);
    meter.sample(500, 1000);
    meter.sample(600, 100_000);
    expect(meter.bars(2).every((b) => b >= 0 && b <= 1)).toBe(true);
  });

  it("pads with leading zeros when there is less history than bars", () => {
    const meter = createThroughputMeter(60_000);
    meter.sample(0, 0);
    meter.sample(50, 1000);
    const bars = meter.bars(5);
    expect(bars).toHaveLength(5);
    expect(bars.slice(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it("ignores a token total that goes backwards", () => {
    const meter = createThroughputMeter(60_000);
    meter.sample(500, 0);
    meter.sample(100, 1000);
    expect(meter.bars(2).every((b) => b >= 0)).toBe(true);
  });
});
