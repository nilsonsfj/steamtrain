import { describe, expect, it } from "vitest";
import {
  hasDisallowedControlChars,
  insertedChunk,
  isEscapeSequenceRemnant,
  shouldAcceptTextInput,
  shouldRejectTextInputChange,
} from "../src/tui/text-input-filter";

describe("isEscapeSequenceRemnant", () => {
  it("flags modifyOtherKeys Option+` leftovers after ink strips ESC", () => {
    expect(isEscapeSequenceRemnant("[27;3;96~")).toBe(true);
    expect(isEscapeSequenceRemnant("[27;9;96~")).toBe(true);
  });

  it("flags Kitty CSI-u Option leftovers", () => {
    expect(isEscapeSequenceRemnant("[96;3u")).toBe(true);
  });

  it("does not flag truncated bracket text that a user might paste", () => {
    expect(isEscapeSequenceRemnant("[27;3")).toBe(false);
    expect(isEscapeSequenceRemnant("[27")).toBe(false);
  });

  it("does not flag ordinary typing or pastes", () => {
    expect(isEscapeSequenceRemnant("`")).toBe(false);
    expect(isEscapeSequenceRemnant("ab")).toBe(false);
    expect(isEscapeSequenceRemnant("hello world")).toBe(false);
    expect(isEscapeSequenceRemnant("[1]")).toBe(false);
  });
});

describe("shouldAcceptTextInput", () => {
  it("accepts plain printable characters", () => {
    expect(shouldAcceptTextInput("a", {})).toBe(true);
    expect(shouldAcceptTextInput("`", {})).toBe(true);
    expect(shouldAcceptTextInput("hello", {})).toBe(true);
  });

  it("rejects meta/ctrl/escape chords", () => {
    expect(shouldAcceptTextInput("a", { meta: true })).toBe(false);
    expect(shouldAcceptTextInput("r", { ctrl: true })).toBe(false);
    expect(shouldAcceptTextInput("", { escape: true })).toBe(false);
  });

  it("rejects CSI leftovers from Option/Alt sequences", () => {
    expect(shouldAcceptTextInput("[27;3;96~", {})).toBe(false);
    expect(shouldAcceptTextInput("[96;3u", {})).toBe(false);
  });

  it("rejects control characters", () => {
    expect(shouldAcceptTextInput("\x1b", {})).toBe(false);
    expect(shouldAcceptTextInput("a\x00b", {})).toBe(false);
  });
});

describe("shouldRejectTextInputChange", () => {
  it("rejects an Option+` CSI dump appended to the draft", () => {
    expect(shouldRejectTextInputChange("", "[27;3;96~")).toBe(true);
    expect(shouldRejectTextInputChange("run ", "run [27;3;96~")).toBe(true);
  });

  it("allows normal typing and mid-string inserts", () => {
    expect(shouldRejectTextInputChange("", "a")).toBe(false);
    expect(shouldRejectTextInputChange("ab", "a`b")).toBe(false);
    expect(shouldRejectTextInputChange("hi", "hi there")).toBe(false);
  });

  it("rejects control characters introduced by a change", () => {
    expect(shouldRejectTextInputChange("x", "x\x1b")).toBe(true);
  });
});

describe("insertedChunk / hasDisallowedControlChars", () => {
  it("extracts a mid-string insert", () => {
    expect(insertedChunk("design", "dersign")).toBe("r");
  });

  it("returns null for deletions", () => {
    expect(insertedChunk("ab", "a")).toBe(null);
  });

  it("detects control chars", () => {
    expect(hasDisallowedControlChars("ok")).toBe(false);
    expect(hasDisallowedControlChars("\x7f")).toBe(true);
  });
});
