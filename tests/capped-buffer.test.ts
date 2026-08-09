import { describe, expect, it } from "vitest";
import { appendCapped } from "../src/util/capped-buffer";

describe("appendCapped", () => {
  it("appends when under the cap", () => {
    expect(appendCapped("ab", "cd", 10)).toBe("abcd");
  });

  it("keeps the tail when the result would exceed the cap", () => {
    expect(appendCapped("hello", "WORLD", 6)).toBe("oWORLD");
  });

  it("returns the chunk unchanged when empty base is oversized", () => {
    expect(appendCapped("", "abcdefgh", 4)).toBe("efgh");
  });

  it("ignores empty chunks", () => {
    expect(appendCapped("keep", "", 10)).toBe("keep");
  });
});
