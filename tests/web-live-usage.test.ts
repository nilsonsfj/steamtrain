/**
 * Live spend on the run surface. A running step's tokens/cost arrive as
 * `StepState.usage` (folded by the reducer from the agent's mid-flight
 * reports); once the step lands, `result` is the billed record. `ST.stepUsage`
 * is the one place that decides which of the two a surface shows, so the row,
 * the rail and the ticker can never disagree about it.
 *
 * It lives in st-core.js so this can mount it for real; the read sites are
 * checked against the module source, since there is no layout engine here.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "web", "public");
const coreJs = readFileSync(join(PUBLIC_DIR, "st-core.js"), "utf8");
const runJs = readFileSync(join(PUBLIC_DIR, "st-run.js"), "utf8");
const inspectorJs = readFileSync(join(PUBLIC_DIR, "st-inspector.js"), "utf8");
const runCss = readFileSync(join(PUBLIC_DIR, "run.css"), "utf8");

interface Usage {
  costUsd: number;
  tokens: number;
  live: boolean;
}

/** Load st-core.js against stubs and hand back its step-usage resolver. */
function loadStepUsage(): (step: unknown) => Usage {
  const window: Record<string, unknown> = {};
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
    { getItem: () => null, setItem: () => {} },
    () => 1,
    () => {},
    {},
  );
  return (window.Steamtrain as { stepUsage: (s: unknown) => Usage }).stepUsage;
}

describe("ST.stepUsage", () => {
  const stepUsage = loadStepUsage();

  it("reports nothing for a step that has not billed anything", () => {
    expect(stepUsage({ stepId: "a", status: "running" })).toEqual({
      costUsd: 0,
      tokens: 0,
      live: false,
    });
  });

  it("reports a running step's accumulated usage as live", () => {
    expect(
      stepUsage({
        stepId: "a",
        status: "running",
        usage: { tokens: { input: 14_000, output: 100 } },
      }),
    ).toEqual({ costUsd: 0, tokens: 14_100, live: true });
  });

  it("keeps spend absent when the agent reports tokens but no mid-flight price", () => {
    // Claude Code prices only at the end of a turn. A "$0.0000" there would
    // read as free rather than as not-yet-known.
    const use = stepUsage({ status: "running", usage: { tokens: { output: 500 } } });
    expect(use.costUsd).toBe(0);
    expect(use.tokens).toBe(500);
  });

  it("prefers the finished result over the live total, and stops calling it live", () => {
    expect(
      stepUsage({
        stepId: "a",
        status: "done",
        usage: { tokens: { input: 100, output: 10 }, costUsd: 0.001 },
        result: { tokens: { input: 100, output: 40 }, costUsd: 0.004 },
      }),
    ).toEqual({ costUsd: 0.004, tokens: 140, live: false });
  });

  it("never adds the live total to the result's", () => {
    const use = stepUsage({
      status: "done",
      usage: { tokens: { output: 10 } },
      result: { tokens: { output: 40 } },
    });
    expect(use.tokens).toBe(40);
  });

  it("falls back field by field when a result reports only one of the two", () => {
    // A result that priced the step but reported no tokens must not blank out
    // the token count the stream already established.
    const use = stepUsage({
      status: "done",
      usage: { tokens: { output: 10 } },
      result: { costUsd: 0.004 },
    });
    expect(use).toEqual({ costUsd: 0.004, tokens: 10, live: false });
  });

  it("ignores an empty usage object", () => {
    expect(stepUsage({ status: "running", usage: {} })).toEqual({
      costUsd: 0,
      tokens: 0,
      live: false,
    });
  });

  it("survives a step with no fields at all", () => {
    expect(stepUsage(undefined)).toEqual({ costUsd: 0, tokens: 0, live: false });
  });
});

describe("live usage read sites", () => {
  it("lays out the band's cost/token columns from stepUsage, not from result alone", () => {
    // The column spec is what decides whether a running agent's tokens have
    // anywhere to render at all — reading `s.result` here would keep the
    // column closed until the step finished.
    const spec = runJs.slice(
      runJs.indexOf("function bandColumns("),
      runJs.indexOf("function stepMetaCell("),
    );
    expect(spec).toContain("stepUsage(s)");
    expect(spec).not.toContain("s.result.costUsd");
    expect(spec).not.toContain("totalTokens(s.result.tokens)");
  });

  it("renders the row's cost and token cells from stepUsage", () => {
    const row = runJs.slice(
      runJs.indexOf("function renderStepRow("),
      runJs.indexOf("function subWorkflowRow("),
    );
    expect(row).toContain("stepUsage(s)");
    expect(row).toContain("use.costUsd");
    expect(row).toContain("use.tokens");
  });

  it("marks a still-climbing number as live, in class and in tooltip", () => {
    expect(runJs).toContain('use.live ? " live" : ""');
    expect(runJs).toContain("still running");
    expect(runCss).toContain(".step-row .num.live");
  });

  it("counts running steps into the run's live cost ticker", () => {
    const ticker = runJs.slice(runJs.indexOf("// Live cost/token ticker"));
    expect(ticker).toContain("s.result || s.usage");
  });

  it("shows the rail's Spend/Tokens from stepUsage too", () => {
    expect(inspectorJs).toContain("ST.stepUsage(s)");
    expect(inspectorJs).not.toContain("s.result.costUsd.toFixed(4)");
  });
});
