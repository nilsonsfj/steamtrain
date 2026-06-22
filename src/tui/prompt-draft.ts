import { type PromptHistoryBrowse, initialPromptHistoryBrowse } from "./prompt-history";

export interface PromptTabState {
  value: string;
  historyBrowse: PromptHistoryBrowse;
  promptEditing: boolean;
}

export const initialPromptTabState: PromptTabState = {
  value: "",
  historyBrowse: initialPromptHistoryBrowse,
  promptEditing: false,
};

export type PromptDraftByMode = Map<string, PromptTabState>;

export function getPromptDraft(byMode: PromptDraftByMode, mode: string): PromptTabState {
  return byMode.get(mode) ?? initialPromptTabState;
}

export function patchPromptDraft(
  byMode: PromptDraftByMode,
  mode: string,
  patch: Partial<PromptTabState>,
): PromptDraftByMode {
  const next = new Map(byMode);
  next.set(mode, { ...getPromptDraft(byMode, mode), ...patch });
  return next;
}
