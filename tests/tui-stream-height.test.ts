import { describe, expect, it } from "vitest";

import { computeStreamHeight, wrappedLines } from "../src/tui/util";

describe("wrappedLines", () => {
  it("returns at least one row for short/empty content", () => {
    expect(wrappedLines(0, 80)).toBe(1);
    expect(wrappedLines(10, 80)).toBe(1);
  });

  it("wraps long content across rows", () => {
    expect(wrappedLines(80, 40)).toBe(2);
    expect(wrappedLines(81, 40)).toBe(3);
  });
});

describe("computeStreamHeight", () => {
  const base = { rows: 40, columns: 100, promptValueLength: 0 };

  it("reserves the fixed chrome rows", () => {
    // rows - BASE_RESERVED_ROWS(9) with no prompt wrap and no notice.
    expect(computeStreamHeight(base)).toBe(31);
  });

  it("shrinks the stream by one row when a short notice is showing", () => {
    const withNotice = computeStreamHeight({
      ...base,
      notice: "type input in the prompt before running",
    });
    // Regression: the notice line must be reserved, otherwise total frame
    // height = rows + 1 and Ink flickers on every keypress.
    expect(withNotice).toBe(computeStreamHeight(base) - 1);
  });

  it("reserves extra rows for a notice that wraps", () => {
    const longNotice = "x".repeat(200); // wraps at columns-2 = 98 → 3 rows
    expect(computeStreamHeight({ ...base, notice: longNotice })).toBe(
      computeStreamHeight(base) - 3,
    );
  });

  it("shrinks the stream by one row when the status bar shows its API line", () => {
    // Regression: the status bar's second (API) line adds a row; if it isn't
    // reserved the total frame overflows the terminal and Ink flickers on
    // every keypress.
    expect(computeStreamHeight({ ...base, statusApiLine: true })).toBe(
      computeStreamHeight(base) - 1,
    );
    expect(computeStreamHeight({ ...base, statusApiLine: false })).toBe(computeStreamHeight(base));
  });

  it("reserves rows for a wrapped prompt", () => {
    // prompt width = columns - 6 = 94; length 94 (+1 cursor) → 1 extra line.
    expect(computeStreamHeight({ ...base, promptValueLength: 94 })).toBe(
      computeStreamHeight(base) - 1,
    );
  });

  it("never drops below the minimum height", () => {
    expect(computeStreamHeight({ rows: 5, columns: 80, promptValueLength: 0 })).toBe(6);
  });
});
