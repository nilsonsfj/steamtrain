import { describe, expect, it } from "vitest";
import {
  SETTINGS_SECTIONS,
  parseDeepLink,
  parseRoute,
  parseRunDeepLink,
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

  it("returns null for anything else", () => {
    expect(parseRoute("")).toBeNull();
    expect(parseRoute("#")).toBeNull();
    expect(parseRoute("#run-not-a-uuid")).toBeNull();
    expect(parseRoute("#settingsish")).toBeNull();
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
