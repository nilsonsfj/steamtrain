import { describe, expect, it } from "vitest";
import { parseRunOptions } from "../src/run-cli";

describe("parseRunOptions retarget flags", () => {
  it("parses --retarget-agent, --retarget-model, and repeatable --step", () => {
    const opts = parseRunOptions([
      "--from",
      "r1",
      "--retry-failed",
      "--retarget-agent",
      "claude",
      "--retarget-model",
      "claude-sonnet-5",
      "--step",
      "cross-check",
      "--step",
      "report",
    ]);
    expect(opts).toMatchObject({
      from: "r1",
      retryFailed: true,
      retargetAgent: "claude",
      retargetModel: "claude-sonnet-5",
      steps: ["cross-check", "report"],
    });
  });

  it("defaults steps to an empty array", () => {
    expect(parseRunOptions(["--input", "x"])?.steps).toEqual([]);
  });
});
