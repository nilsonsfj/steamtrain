import { describe, expect, it } from "vitest";
import { extractWorkflowScope } from "../src/commands/workflow-scope";

describe("extractWorkflowScope", () => {
  it("defaults to user with no flag and leaves args untouched", () => {
    expect(extractWorkflowScope(["audit", "the", "api"])).toEqual({
      scope: "user",
      rest: ["audit", "the", "api"],
    });
  });

  it("treats --project as project scope and strips it", () => {
    expect(extractWorkflowScope(["--project", "audit", "the", "api"])).toEqual({
      scope: "project",
      rest: ["audit", "the", "api"],
    });
  });

  it("accepts --scope project / --scope user and consumes the value", () => {
    expect(extractWorkflowScope(["--scope", "project", "x"])).toEqual({
      scope: "project",
      rest: ["x"],
    });
    expect(extractWorkflowScope(["--scope", "user", "x"])).toEqual({
      scope: "user",
      rest: ["x"],
    });
  });

  it("handles the flag mid-arguments", () => {
    expect(extractWorkflowScope(["build", "a", "thing", "--project"])).toEqual({
      scope: "project",
      rest: ["build", "a", "thing"],
    });
  });

  it("ignores --scope with no following value (stays default, drops the flag)", () => {
    expect(extractWorkflowScope(["--scope"])).toEqual({ scope: "user", rest: [] });
  });

  it("ignores an invalid --scope value (the value falls through as free text)", () => {
    // Documents the (safe) behavior: an unrecognized value is not consumed, so
    // it remains in the positional args rather than silently changing scope.
    expect(extractWorkflowScope(["--scope", "bogus", "x"])).toEqual({
      scope: "user",
      rest: ["bogus", "x"],
    });
  });

  it("lets the last flag win when both are present", () => {
    expect(extractWorkflowScope(["--project", "--user", "x"])).toEqual({
      scope: "user",
      rest: ["x"],
    });
  });
});
