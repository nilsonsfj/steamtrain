import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTIONS,
  parseDeepLink,
  parseRoute,
  parseRunDeepLink,
  runsDeepLink,
  settingsDeepLink,
} from "../src/web/run-deep-link";

const RUN = "8f21c0de-1a2b-4c3d-8e4f-5a6b7c8d9e0f";

describe("parseRoute", () => {
  it("parses a run link", () => {
    expect(parseRoute(`#run-${RUN}`)).toEqual({ kind: "run", runId: RUN, stepId: undefined });
  });

  it("parses a run link with a step", () => {
    expect(parseRoute(`#run-${RUN}/step/cross-check`)).toEqual({
      kind: "run",
      runId: RUN,
      stepId: "cross-check",
    });
  });

  it("parses bare #settings as the first section", () => {
    expect(parseRoute("#settings")).toEqual({ kind: "settings", section: "runners" });
  });

  it("parses an explicit settings section", () => {
    expect(parseRoute("#settings/limits")).toEqual({ kind: "settings", section: "limits" });
  });

  it("is case-insensitive on the section", () => {
    expect(parseRoute("#Settings/Limits")).toEqual({ kind: "settings", section: "limits" });
  });

  it("falls back to the first section for an unknown one", () => {
    expect(parseRoute("#settings/does-not-exist")).toEqual({
      kind: "settings",
      section: "runners",
    });
  });

  it("parses bare #runs as the run browser with nothing selected", () => {
    expect(parseRoute("#runs")).toEqual({ kind: "runs" });
  });

  it("parses #runs/<id> as the run browser with that run selected", () => {
    expect(parseRoute(`#runs/${RUN}`)).toEqual({ kind: "runs", runId: RUN });
  });

  it("lowercases the selected run id", () => {
    expect(parseRoute(`#RUNS/${RUN.toUpperCase()}`)).toEqual({ kind: "runs", runId: RUN });
  });

  // A hand-edited or truncated link should still land on the list rather than
  // on a page that cannot resolve what it was asked for.
  it("degrades an unparseable selection to the plain list", () => {
    expect(parseRoute("#runs/not-a-uuid")).toEqual({ kind: "runs" });
    expect(parseRoute("#runs/")).toEqual({ kind: "runs" });
  });

  // `#run-<id>` (open one run) and `#runs` (browse them) are different routes
  // that differ by one character — neither may swallow the other.
  it("keeps #runs and #run- apart", () => {
    expect(parseRoute("#runs")).toEqual({ kind: "runs" });
    expect(parseRoute(`#run-${RUN}`)).toEqual({ kind: "run", runId: RUN, stepId: undefined });
    expect(parseRunDeepLink("#runs")).toBeNull();
    expect(parseRunDeepLink(`#runs/${RUN}`)).toBeNull();
  });

  it("returns null for anything else", () => {
    expect(parseRoute("")).toBeNull();
    expect(parseRoute("#")).toBeNull();
    expect(parseRoute("#run-not-a-uuid")).toBeNull();
    expect(parseRoute("#settingsish")).toBeNull();
    expect(parseRoute("#runsish")).toBeNull();
    expect(parseRoute(`#runs/${RUN}/step/x`)).toBeNull();
  });
});

describe("runsDeepLink", () => {
  it("is the bare list with no run", () => {
    expect(runsDeepLink()).toBe("#runs");
  });

  it("round-trips a selected run through parseRoute", () => {
    expect(parseRoute(runsDeepLink(RUN))).toEqual({ kind: "runs", runId: RUN });
    expect(parseRoute(runsDeepLink(RUN.toUpperCase()))).toEqual({ kind: "runs", runId: RUN });
  });
});

describe("settingsDeepLink", () => {
  it("defaults to the first section", () => {
    expect(settingsDeepLink()).toBe("#settings/runners");
  });

  it("round-trips through parseRoute for every known section", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(parseRoute(settingsDeepLink(section))).toEqual({ kind: "settings", section });
    }
  });
});

describe("existing run helpers are unchanged", () => {
  it("still parses run links", () => {
    expect(parseRunDeepLink(`#run-${RUN}`)).toBe(RUN);
    expect(parseDeepLink(`#run-${RUN}/step/s1`)).toEqual({ runId: RUN, stepId: "s1" });
  });

  it("still returns null for a settings link", () => {
    expect(parseRunDeepLink("#settings")).toBeNull();
    expect(parseDeepLink("#settings")).toBeNull();
  });
});
