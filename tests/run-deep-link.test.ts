import { describe, expect, it } from "vitest";
import { parseRunDeepLink, runDeepLink } from "../src/web/run-deep-link";

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
});
