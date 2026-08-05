/**
 * `fmtElapsedRange` renders a band's spread of timings as one range. Merged
 * sibling bands (see buildBands in st-run.js) summarise N children that rarely
 * finish on the same tick, so the readout is "3.8–3.9s" rather than two
 * numbers — and the shared unit is stated once.
 *
 * The function lives in st-core.js purely so it can be exercised here: this
 * mounts st-core for real against stub globals and calls it.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const coreJs = readFileSync(join(PUBLIC_DIR, "st-core.js"), "utf8");

/** Load st-core.js against stubs and hand back its range formatter. */
function loadRange(): (lo: number, hi: number) => string {
  const window: Record<string, unknown> = {};
  const localStorage = { getItem: () => null, setItem: () => {} };
  new Function(
    "window",
    "document",
    "localStorage",
    "setInterval",
    "clearInterval",
    "SteamtrainReducer",
    coreJs,
  )(
    window,
    { getElementById: () => null },
    localStorage,
    () => 1,
    () => {},
    {},
  );
  const ST = window.Steamtrain as { fmtElapsedRange: (lo: number, hi: number) => string };
  return ST.fmtElapsedRange;
}

describe("fmtElapsedRange", () => {
  const range = loadRange();

  it("collapses equal ends to a single reading", () => {
    expect(range(3800, 3800)).toBe("3.8s");
    // Ends that merely *format* alike collapse too — the band is reporting a
    // span, and "3.8–3.8s" claims a spread the reader cannot see.
    expect(range(3840, 3849)).toBe("3.8s");
  });

  it("states a shared unit once", () => {
    expect(range(3800, 3900)).toBe("3.8–3.9s");
  });

  it("states a shared minute prefix once", () => {
    expect(range(71000, 75000)).toBe("1m 11–15s");
  });

  it("spells both ends out when they do not share a unit", () => {
    // 58.0s against 1m 02s: no common prefix, so neither end is abbreviated.
    expect(range(58000, 62000)).toBe("58.0s–1m 02s");
  });

  it("crosses into hours without inventing a shared prefix", () => {
    expect(range(3_600_000, 7_200_000)).toBe("1h 00m–2h 00m");
    expect(range(3_600_000, 3_900_000)).toBe("1h 00–05m");
  });

  it("falls back to whichever end is readable when one is not", () => {
    expect(range(Number.NaN, 3800)).toBe("3.8s");
    expect(range(3800, Number.NaN)).toBe("3.8s");
    expect(range(Number.NaN, Number.NaN)).toBe("");
  });

  it("does not abbreviate a negative reading into nonsense", () => {
    // fmtElapsed rejects negatives outright, so a bad clock reads as the one
    // end that survived rather than as a malformed range.
    expect(range(-1000, 3800)).toBe("3.8s");
  });
});
