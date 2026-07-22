import { describe, expect, it } from "vitest";
import {
  classifyAgentFailure,
  describeFailureKind,
  isCapacityFailure,
  isDefaultFailoverTrigger,
} from "../src/agents/failure-classify";

describe("classifyAgentFailure", () => {
  it("detects quota / billing exhaustion messages", () => {
    expect(classifyAgentFailure("You have exceeded your current quota")).toBe("quota");
    expect(
      classifyAgentFailure(
        "Execute mode requires paid credits. Add credits at https://ampcode.com/pay",
      ),
    ).toBe("quota");
    expect(classifyAgentFailure("insufficient_quota")).toBe("quota");
    expect(classifyAgentFailure("RESOURCE_EXHAUSTED: Budget exhausted")).toBe("quota");
    expect(classifyAgentFailure("monthly limit reached")).toBe("quota");
  });

  it("detects rate limit messages", () => {
    expect(classifyAgentFailure("rate limit exceeded")).toBe("rate_limit");
    expect(classifyAgentFailure("Too Many Requests")).toBe("rate_limit");
    expect(classifyAgentFailure("HTTP 429 from provider")).toBe("rate_limit");
    expect(classifyAgentFailure("tokens per minute exceeded")).toBe("rate_limit");
  });

  it("detects auth failures", () => {
    expect(classifyAgentFailure("unauthorized: invalid api key")).toBe("auth");
    expect(classifyAgentFailure("HTTP 401")).toBe("auth");
    expect(classifyAgentFailure("not authenticated — please log in")).toBe("auth");
  });

  it("detects transient transport failures", () => {
    expect(classifyAgentFailure("ETIMEDOUT connecting to api")).toBe("transient");
    expect(classifyAgentFailure("socket hang up")).toBe("transient");
    expect(classifyAgentFailure("spawn ENOENT")).toBe("transient");
  });

  it("detects permanent client errors", () => {
    expect(classifyAgentFailure("invalid model 'foo-bar'")).toBe("permanent");
    expect(classifyAgentFailure("context length exceeded")).toBe("permanent");
  });

  it("honors an adapter hint over heuristics", () => {
    expect(classifyAgentFailure("something vague", { hint: "quota" })).toBe("quota");
  });

  it("returns unknown for empty or unrecognised text", () => {
    expect(classifyAgentFailure(undefined)).toBe("unknown");
    expect(classifyAgentFailure("logic fail: tests red")).toBe("unknown");
  });

  it("labels kinds for narration", () => {
    expect(describeFailureKind("quota")).toContain("quota");
    expect(describeFailureKind("rate_limit")).toContain("rate");
  });

  it("flags capacity and default failover triggers", () => {
    expect(isCapacityFailure("quota")).toBe(true);
    expect(isCapacityFailure("rate_limit")).toBe(true);
    expect(isCapacityFailure("transient")).toBe(false);
    expect(isDefaultFailoverTrigger("quota")).toBe(true);
    expect(isDefaultFailoverTrigger("permanent")).toBe(false);
  });
});
