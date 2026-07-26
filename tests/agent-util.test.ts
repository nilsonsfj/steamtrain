import { describe, expect, it } from "vitest";
import { firstLine, stderrSummary } from "../src/agents/util";

describe("stderrSummary", () => {
  it("returns the first non-empty line when stderr is a single error", () => {
    expect(stderrSummary("error: unexpected argument '--print' found\n")).toBe(
      "error: unexpected argument '--print' found",
    );
  });

  it("skips kiro trust-all banner noise and surfaces the real failure", () => {
    const stderr = [
      "All tools are now trusted (!). Kiro will execute tools without asking for confirmation.",
      "Agents can sometimes do unexpected things so understand the risks.",
      "",
      "Learn more at https://kiro.dev/docs/cli/chat/security/#using-tools-trust-all-safely",
      "",
      "",
      "",
      "Monthly request limit reached",
      "",
      "You can enable overages to continue making requests, or upgrade your plan for more included requests.",
      "See https://kiro.dev/pricing",
      "",
      "The limits reset on 08/01.",
    ].join("\n");

    expect(stderrSummary(stderr)).toBe("Monthly request limit reached");
    // firstLine alone would hide the quota failure behind the trust banner.
    expect(firstLine(stderr)).toMatch(/All tools are now trusted/);
  });

  it("falls back to the first non-empty line when only banner noise is present", () => {
    expect(
      stderrSummary(
        "All tools are now trusted (!). Kiro will execute tools without asking for confirmation.\n",
      ),
    ).toBe(
      "All tools are now trusted (!). Kiro will execute tools without asking for confirmation.",
    );
  });

  it("returns empty string for blank stderr", () => {
    expect(stderrSummary("")).toBe("");
    expect(stderrSummary("   \n\n")).toBe("");
  });
});
