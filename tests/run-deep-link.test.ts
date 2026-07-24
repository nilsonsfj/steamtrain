import { describe, expect, it } from "vitest";
import {
  approvalDeepLink,
  parseDeepLink,
  parseRunDeepLink,
  runDeepLink,
} from "../src/web/run-deep-link";

const runId = "550e8400-e29b-41d4-a716-446655440000";

describe("run deep links", () => {
  it("parses a canonical run hash", () => {
    expect(parseRunDeepLink(`#run-${runId}`)).toBe(runId);
  });

  it("normalizes an uppercase UUID", () => {
    expect(parseRunDeepLink(`#RUN-${runId.toUpperCase()}`)).toBe(runId);
    expect(runDeepLink(runId.toUpperCase())).toBe(`#run-${runId}`);
  });

  it("trims whitespace around a run hash", () => {
    expect(parseRunDeepLink(`  #run-${runId}  `)).toBe(runId);
  });

  it("ignores unrelated hashes", () => {
    expect(parseRunDeepLink("")).toBeNull();
    expect(parseRunDeepLink("#workflow-tour")).toBeNull();
    expect(parseRunDeepLink("#run-")).toBeNull();
  });

  it("rejects malformed or non-UUID run ids", () => {
    expect(parseRunDeepLink("#run-r1")).toBeNull();
    expect(parseRunDeepLink(`#run-${runId.slice(0, -1)}`)).toBeNull();
    expect(parseRunDeepLink(`#run-${runId.slice(0, 35)}z`)).toBeNull();
  });

  it("formats a run id for notification navigation", () => {
    expect(runDeepLink(runId)).toBe(`#run-${runId}`);
  });

  it("parseRunDeepLink extracts runId from step deep links (backward compat)", () => {
    expect(parseRunDeepLink(`#run-${runId}/step/gate-1`)).toBe(runId);
  });
});

describe("approval deep links", () => {
  it("formats a step-specific deep link", () => {
    expect(approvalDeepLink(runId, "gate-1")).toBe(`#run-${runId}/step/gate-1`);
  });

  it("lowercases the run id", () => {
    expect(approvalDeepLink(runId.toUpperCase(), "review")).toBe(`#run-${runId}/step/review`);
  });

  it("handles step ids with colons and dots", () => {
    expect(approvalDeepLink(runId, "ns:check.final")).toBe(`#run-${runId}/step/ns:check.final`);
  });
});

describe("parseDeepLink", () => {
  it("parses a run-only hash", () => {
    expect(parseDeepLink(`#run-${runId}`)).toEqual({ runId, stepId: undefined });
  });

  it("parses a step-specific hash", () => {
    expect(parseDeepLink(`#run-${runId}/step/gate-1`)).toEqual({ runId, stepId: "gate-1" });
  });

  it("handles step ids with colons, dots, and underscores", () => {
    expect(parseDeepLink(`#run-${runId}/step/ns:check_final.v2`)).toEqual({
      runId,
      stepId: "ns:check_final.v2",
    });
  });

  it("trims whitespace", () => {
    expect(parseDeepLink(`  #run-${runId}/step/s1  `)).toEqual({ runId, stepId: "s1" });
  });

  it("returns null for unrelated hashes", () => {
    expect(parseDeepLink("")).toBeNull();
    expect(parseDeepLink("#workflow-tour")).toBeNull();
    expect(parseDeepLink("#run-")).toBeNull();
  });

  it("returns null for invalid UUIDs", () => {
    expect(parseDeepLink("#run-r1/step/x")).toBeNull();
  });

  it("ignores malformed step ids (returns runId only)", () => {
    expect(parseDeepLink(`#run-${runId}/step/bad step!`)).toEqual({ runId, stepId: undefined });
  });

  it("is case-insensitive for the run prefix", () => {
    expect(parseDeepLink(`#RUN-${runId.toUpperCase()}/step/gate`)).toEqual({
      runId,
      stepId: "gate",
    });
  });
});
