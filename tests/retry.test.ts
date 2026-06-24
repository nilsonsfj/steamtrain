import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY,
  backoffDelayMs,
  resolveRetryPolicy,
} from "../src/workflow/retry";

describe("resolveRetryPolicy", () => {
  it("falls back to built-in defaults when nothing is set", () => {
    expect(resolveRetryPolicy()).toEqual(DEFAULT_RETRY);
  });

  it("uses the workflow default over the built-in default", () => {
    const resolved = resolveRetryPolicy(undefined, { maxAttempts: 5 });
    expect(resolved.maxAttempts).toBe(5);
    expect(resolved.initialDelayMs).toBe(DEFAULT_RETRY.initialDelayMs);
  });

  it("lets a per-step policy override the workflow default", () => {
    const resolved = resolveRetryPolicy({ maxAttempts: 2 }, { maxAttempts: 5, factor: 3 });
    expect(resolved.maxAttempts).toBe(2); // step wins
    expect(resolved.factor).toBe(3); // inherited from workflow
  });

  it("resolves each field independently (partial overrides)", () => {
    const resolved = resolveRetryPolicy({ jitter: false }, { initialDelayMs: 250 });
    expect(resolved.jitter).toBe(false);
    expect(resolved.initialDelayMs).toBe(250);
    expect(resolved.maxAttempts).toBe(DEFAULT_RETRY.maxAttempts);
  });
});

describe("backoffDelayMs", () => {
  const policy = resolveRetryPolicy({
    initialDelayMs: 1000,
    factor: 2,
    maxDelayMs: 30000,
    jitter: false,
  });

  it("grows geometrically per attempt (1-based)", () => {
    expect(backoffDelayMs(policy, 1)).toBe(1000);
    expect(backoffDelayMs(policy, 2)).toBe(2000);
    expect(backoffDelayMs(policy, 3)).toBe(4000);
  });

  it("caps at maxDelayMs", () => {
    expect(backoffDelayMs(policy, 20)).toBe(30000);
  });

  it("scales by rand() under full jitter", () => {
    const jittered = resolveRetryPolicy({
      initialDelayMs: 1000,
      factor: 2,
      jitter: true,
    });
    expect(backoffDelayMs(jittered, 2, () => 1)).toBe(2000);
    expect(backoffDelayMs(jittered, 2, () => 0.5)).toBe(1000);
    expect(backoffDelayMs(jittered, 2, () => 0)).toBe(0);
  });

  it("ignores rand when jitter is off", () => {
    expect(backoffDelayMs(policy, 2, () => 0)).toBe(2000);
  });
});
