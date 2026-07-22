import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_FAILOVER,
  failoverTriggerMatches,
  isFailoverEligibleFailure,
  resolveModelFailoverPolicy,
  shouldAdvanceFailover,
  shouldFailFastWithoutCandidate,
} from "../src/workflow/model-failover";

describe("resolveModelFailoverPolicy", () => {
  it("falls through step → workflow → config → defaults", () => {
    const resolved = resolveModelFailoverPolicy(
      { failoverDelayMs: 10 },
      { enabled: true, on: ["quota"] },
      { enabled: false, preferNextModel: false },
    );
    expect(resolved.enabled).toBe(true); // workflow wins over config
    expect(resolved.on).toEqual(["quota"]);
    expect(resolved.failoverDelayMs).toBe(10); // step wins
    expect(resolved.preferNextModel).toBe(false); // config (workflow omitted)
    expect(resolved.onCapacityResult).toBe(DEFAULT_MODEL_FAILOVER.onCapacityResult);
  });

  it("disables failover when step sets enabled: false", () => {
    const resolved = resolveModelFailoverPolicy({ enabled: false }, { enabled: true });
    expect(resolved.enabled).toBe(false);
  });
});

describe("failover eligibility", () => {
  const policy = resolveModelFailoverPolicy();

  it("keeps classic transport failures eligible", () => {
    expect(
      isFailoverEligibleFailure(policy, {
        kind: "transient",
        cancelled: false,
        sawResult: false,
        sawToolUse: false,
        classicRetryable: true,
      }),
    ).toBe(true);
  });

  it("treats quota result errors as eligible when onCapacityResult", () => {
    expect(
      isFailoverEligibleFailure(policy, {
        kind: "quota",
        cancelled: false,
        sawResult: true,
        sawToolUse: false,
        classicRetryable: false,
      }),
    ).toBe(true);
  });

  it("blocks capacity result failover when onCapacityResult is false", () => {
    const strict = resolveModelFailoverPolicy({ onCapacityResult: false });
    expect(
      isFailoverEligibleFailure(strict, {
        kind: "quota",
        cancelled: false,
        sawResult: true,
        sawToolUse: false,
        classicRetryable: false,
      }),
    ).toBe(false);
  });

  it("blocks after tool use unless allowAfterToolUse", () => {
    expect(
      isFailoverEligibleFailure(policy, {
        kind: "quota",
        cancelled: false,
        sawResult: true,
        sawToolUse: true,
        classicRetryable: false,
      }),
    ).toBe(false);
    const loose = resolveModelFailoverPolicy({ allowAfterToolUse: true });
    expect(
      isFailoverEligibleFailure(loose, {
        kind: "quota",
        cancelled: false,
        sawResult: true,
        sawToolUse: true,
        classicRetryable: false,
      }),
    ).toBe(true);
  });

  it("never retries cancellations", () => {
    expect(
      isFailoverEligibleFailure(policy, {
        kind: "quota",
        cancelled: true,
        sawResult: true,
        sawToolUse: false,
        classicRetryable: false,
      }),
    ).toBe(false);
  });
});

describe("shouldAdvanceFailover / fail-fast", () => {
  const policy = resolveModelFailoverPolicy();

  it("advances on quota when a next candidate exists", () => {
    expect(shouldAdvanceFailover(policy, { kind: "quota", hasNextCandidate: true })).toBe(true);
  });

  it("treats classic unclassified transport failures as transient for advancement", () => {
    expect(
      shouldAdvanceFailover(policy, {
        kind: "unknown",
        hasNextCandidate: true,
        classicRetryable: true,
      }),
    ).toBe(true);
  });

  it("does not advance capacity failures when preferNextModel is false", () => {
    expect(
      shouldAdvanceFailover(resolveModelFailoverPolicy({ preferNextModel: false }), {
        kind: "quota",
        hasNextCandidate: true,
      }),
    ).toBe(false);
  });

  it("does not advance bare unknown without classicRetryable (even with on: any)", () => {
    // `"any"` lets unknown past the trigger gate, but unknown is not a
    // switch-worthy kind unless it was a clean classic transport failure.
    expect(
      shouldAdvanceFailover(resolveModelFailoverPolicy({ on: ["any"] }), {
        kind: "unknown",
        hasNextCandidate: true,
      }),
    ).toBe(false);
  });

  it("does not advance when disabled or no candidate", () => {
    expect(
      shouldAdvanceFailover(resolveModelFailoverPolicy({ enabled: false }), {
        kind: "quota",
        hasNextCandidate: true,
      }),
    ).toBe(false);
    expect(shouldAdvanceFailover(policy, { kind: "quota", hasNextCandidate: false })).toBe(false);
  });

  it("fails fast on quota with no remaining candidate", () => {
    expect(shouldFailFastWithoutCandidate(policy, "quota", false)).toBe(true);
    expect(shouldFailFastWithoutCandidate(policy, "rate_limit", false)).toBe(false);
    expect(shouldFailFastWithoutCandidate(policy, "quota", true)).toBe(false);
  });

  it("matches triggers including any", () => {
    expect(failoverTriggerMatches(policy, "quota")).toBe(true);
    expect(failoverTriggerMatches(policy, "auth")).toBe(false);
    expect(failoverTriggerMatches(resolveModelFailoverPolicy({ on: ["any"] }), "permanent")).toBe(
      true,
    );
  });
});
