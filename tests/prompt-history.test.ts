import { describe, expect, it } from "vitest";
import {
  initialPromptHistoryBrowse,
  navigatePromptHistory,
  pushPromptHistory,
  shouldPromptHistoryCaptureDown,
  shouldPromptHistoryCaptureUp,
} from "../src/tui/prompt-history";

describe("pushPromptHistory", () => {
  it("stores entries per tab and skips adjacent duplicates", () => {
    let byMode = pushPromptHistory(new Map(), "plan", "first task", 100);
    byMode = pushPromptHistory(byMode, "plan", "first task", 100);
    byMode = pushPromptHistory(byMode, "plan", "second task", 100);
    byMode = pushPromptHistory(byMode, "implement", "other tab", 100);

    expect(byMode.get("plan")).toEqual(["first task", "second task"]);
    expect(byMode.get("implement")).toEqual(["other tab"]);
  });

  it("trims entries and ignores empty submissions", () => {
    const byMode = pushPromptHistory(new Map(), "plan", "  hello  ", 100);
    expect(byMode.get("plan")).toEqual(["hello"]);
    expect(pushPromptHistory(byMode, "plan", "   ", 100)).toBe(byMode);
  });

  it("drops oldest entries when over the limit", () => {
    let byMode = new Map<string, string[]>();
    for (let i = 1; i <= 5; i++) {
      byMode = pushPromptHistory(byMode, "plan", `cmd-${i}`, 3);
    }
    expect(byMode.get("plan")).toEqual(["cmd-3", "cmd-4", "cmd-5"]);
  });
});

describe("navigatePromptHistory", () => {
  const byMode = new Map([["plan", ["alpha", "beta", "gamma"]]]);

  it("walks up from the live prompt and back down to draft", () => {
    let browse = initialPromptHistoryBrowse;
    const up1 = navigatePromptHistory(byMode, browse, "plan", "draft text", "up");
    expect(up1).toEqual({ value: "gamma", browseIndex: 2, draft: "draft text" });
    browse = { browseIndex: up1!.browseIndex, draft: up1!.draft };

    const up2 = navigatePromptHistory(byMode, browse, "plan", up1!.value, "up");
    expect(up2?.value).toBe("beta");

    const down1 = navigatePromptHistory(
      byMode,
      { browseIndex: up2!.browseIndex, draft: browse.draft },
      "plan",
      up2!.value,
      "down",
    );
    expect(down1?.value).toBe("gamma");

    const down2 = navigatePromptHistory(
      byMode,
      { browseIndex: down1!.browseIndex, draft: browse.draft },
      "plan",
      down1!.value,
      "down",
    );
    expect(down2).toEqual({ value: "draft text", browseIndex: null, draft: "draft text" });
  });

  it("does nothing when history is empty", () => {
    expect(
      navigatePromptHistory(new Map(), initialPromptHistoryBrowse, "plan", "", "up"),
    ).toBeNull();
  });
});

describe("shouldPromptHistoryCaptureUp", () => {
  const byMode = new Map([["plan", ["one"]]]);

  it("captures when browsing, typing, or history exists", () => {
    expect(shouldPromptHistoryCaptureUp(byMode, "plan", "", initialPromptHistoryBrowse)).toBe(true);
    expect(
      shouldPromptHistoryCaptureUp(new Map(), "plan", "typing", initialPromptHistoryBrowse),
    ).toBe(true);
    expect(shouldPromptHistoryCaptureUp(new Map(), "plan", "", { browseIndex: 0, draft: "" })).toBe(
      true,
    );
  });

  it("does not capture on an empty prompt with no history", () => {
    expect(shouldPromptHistoryCaptureUp(new Map(), "plan", "", initialPromptHistoryBrowse)).toBe(
      false,
    );
  });
});

describe("shouldPromptHistoryCaptureDown", () => {
  it("captures only while browsing history", () => {
    expect(shouldPromptHistoryCaptureDown(initialPromptHistoryBrowse)).toBe(false);
    expect(shouldPromptHistoryCaptureDown({ browseIndex: 0, draft: "" })).toBe(true);
  });
});
