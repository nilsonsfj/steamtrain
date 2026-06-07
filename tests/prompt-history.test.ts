import { describe, expect, it } from "vitest";
import {
  initialPromptHistoryBrowse,
  isPromptArrowActive,
  navigatePromptHistory,
  pushPromptHistory,
  shouldPromptHistoryArrows,
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

describe("isPromptArrowActive", () => {
  const listCtx = { deferToListNavigation: true, promptEditing: false };

  it("is always active outside workflow list navigation", () => {
    expect(isPromptArrowActive(undefined, "", initialPromptHistoryBrowse)).toBe(true);
    expect(
      isPromptArrowActive({ deferToListNavigation: false, promptEditing: false }, "", initialPromptHistoryBrowse),
    ).toBe(true);
  });

  it("follows prompt editing on workflow surfaces", () => {
    expect(isPromptArrowActive(listCtx, "", initialPromptHistoryBrowse)).toBe(false);
    expect(isPromptArrowActive(listCtx, "typing", initialPromptHistoryBrowse)).toBe(false);
    expect(
      isPromptArrowActive({ deferToListNavigation: true, promptEditing: true }, "", initialPromptHistoryBrowse),
    ).toBe(true);
    expect(
      isPromptArrowActive({ deferToListNavigation: true, promptEditing: true }, "typing", initialPromptHistoryBrowse),
    ).toBe(true);
  });
});

describe("shouldPromptHistoryCaptureUp", () => {
  const byMode = new Map([["plan", ["one"]]]);
  const listCtx = { deferToListNavigation: true, promptEditing: false };
  const editingCtx = { deferToListNavigation: true, promptEditing: true };

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

  it("defers to list navigation until the prompt is being edited", () => {
    const wfHistory = new Map([["workflow", ["one"]]]);
    expect(
      shouldPromptHistoryCaptureUp(wfHistory, "workflow", "", initialPromptHistoryBrowse, listCtx),
    ).toBe(false);
    expect(
      shouldPromptHistoryCaptureUp(wfHistory, "workflow", "", initialPromptHistoryBrowse, editingCtx),
    ).toBe(true);
    expect(
      shouldPromptHistoryCaptureUp(
        wfHistory,
        "workflow",
        "typing",
        initialPromptHistoryBrowse,
        listCtx,
      ),
    ).toBe(false);
    expect(
      shouldPromptHistoryCaptureUp(
        wfHistory,
        "workflow",
        "typing",
        initialPromptHistoryBrowse,
        editingCtx,
      ),
    ).toBe(true);
  });
});

describe("shouldPromptHistoryCaptureDown", () => {
  const listCtx = { deferToListNavigation: true, promptEditing: false };
  const editingCtx = { deferToListNavigation: true, promptEditing: true };

  it("captures only while browsing history", () => {
    expect(shouldPromptHistoryCaptureDown(initialPromptHistoryBrowse)).toBe(false);
    expect(shouldPromptHistoryCaptureDown({ browseIndex: 0, draft: "" })).toBe(true);
  });

  it("defers to list navigation until the prompt is being edited", () => {
    expect(shouldPromptHistoryCaptureDown({ browseIndex: 0, draft: "" }, listCtx)).toBe(false);
    expect(shouldPromptHistoryCaptureDown({ browseIndex: 0, draft: "" }, editingCtx)).toBe(true);
  });
});

describe("shouldPromptHistoryArrows", () => {
  it("is always on outside workflow list navigation", () => {
    expect(shouldPromptHistoryArrows(undefined)).toBe(true);
    expect(
      shouldPromptHistoryArrows({ deferToListNavigation: false, promptEditing: false }),
    ).toBe(true);
  });

  it("follows prompt editing on workflow surfaces", () => {
    expect(
      shouldPromptHistoryArrows({ deferToListNavigation: true, promptEditing: false }),
    ).toBe(false);
    expect(
      shouldPromptHistoryArrows({ deferToListNavigation: true, promptEditing: true }),
    ).toBe(true);
    expect(
      shouldPromptHistoryArrows({ deferToListNavigation: true, promptEditing: false }, "text"),
    ).toBe(false);
  });
});
