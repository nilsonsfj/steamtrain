import { describe, expect, it } from "vitest";
import { getPromptDraft, initialPromptTabState, patchPromptDraft } from "../src/tui/prompt-draft";
import { initialPromptHistoryBrowse } from "../src/tui/prompt-history";

describe("prompt draft by mode", () => {
  it("returns defaults for an unseen tab", () => {
    expect(getPromptDraft(new Map(), "plan")).toEqual(initialPromptTabState);
  });

  it("patches one tab without affecting others", () => {
    let drafts = patchPromptDraft(new Map(), "workflow", {
      value: "design cache",
      promptEditing: true,
    });
    drafts = patchPromptDraft(drafts, "plan", { value: "sketch api" });

    expect(getPromptDraft(drafts, "workflow")).toEqual({
      value: "design cache",
      historyBrowse: initialPromptHistoryBrowse,
      promptEditing: true,
    });
    expect(getPromptDraft(drafts, "plan").value).toBe("sketch api");
    expect(getPromptDraft(drafts, "implement")).toEqual(initialPromptTabState);
  });
});
