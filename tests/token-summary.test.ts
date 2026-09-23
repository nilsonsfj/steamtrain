/**
 * The one-line token summary every surface prints. Reasoning is billed inside
 * output (see `totalTokens`), so the line must not list it beside output as a
 * category of its own, or the parts add up to more than the total (#160). The
 * web client keeps its own copy in st-core.js; both are checked here.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TokenUsage } from "../src/types/events";
import { formatTokenSummary } from "../src/workflow/cost";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");

/** Load st-core.js against stubs and hand back its token summary. */
function loadWebSummary(): (t: TokenUsage | undefined) => string {
  const window: Record<string, unknown> = {};
  new Function(
    "window",
    "document",
    "localStorage",
    "setInterval",
    "clearInterval",
    "SteamtrainReducer",
    readFileSync(join(PUBLIC_DIR, "st-core.js"), "utf8"),
  )(
    window,
    { getElementById: () => null },
    { getItem: () => null, setItem: () => {} },
    () => 1,
    () => {},
    {},
  );
  return (window.Steamtrain as { fmtTokenSummary: (t: TokenUsage | undefined) => string })
    .fmtTokenSummary;
}

describe.each([
  ["formatTokenSummary", formatTokenSummary],
  ["the web client's fmtTokenSummary", loadWebSummary()],
])("%s", (_name, summary) => {
  it("shows reasoning inside output, so the parts add up to the total", () => {
    expect(summary({ input: 100_000, output: 68_400, reasoning: 48_000 })).toBe(
      "168k tok (in 100k · out 68k incl. 48k reasoning)",
    );
  });

  it("keeps the other categories in order around it", () => {
    expect(
      summary({ input: 8000, output: 3000, reasoning: 1200, cacheRead: 1300, cacheWrite: 40 }),
    ).toBe("12k tok (in 8.0k · out 3.0k incl. 1.2k reasoning · cache r 1.3k · cache w 40)");
  });

  it("leaves reasoning out when there is none", () => {
    expect(summary({ input: 10, output: 5 })).toBe("15 tok (in 10 · out 5)");
  });

  it("drops reasoning reported without any output, as the total does", () => {
    // Inconsistent data under the invariant; "out 0 incl. 50 reasoning" would
    // read worse than leaving it out.
    expect(summary({ input: 10, reasoning: 50 })).toBe("10 tok (in 10)");
  });

  it("is empty with nothing billed", () => {
    expect(summary(undefined)).toBe("");
    expect(summary({ reasoning: 5 })).toBe("");
  });
});
