import { useCallback, useMemo, useRef, useState } from "react";
import { modelsForAgent } from "../agents";
import {
  type SlashCommandContext,
  applySlashSuggestion,
  autocompleteSlashCommand,
  isSlashCommandInput,
  listSlashCommands,
  parseSlashInput,
} from "../commands";
import type { WorkflowStepSelection } from "../commands/types";
import type { SteamtrainSettings } from "../settings";
import { DEFAULT_PROMPT_HISTORY_LIMIT } from "../settings";
import type { WorkspaceEntry } from "../workspace";
import { isSpuriousLetterInsert } from "./PromptInput";
import type { Mode } from "./modes";
import { isWorkspaceMode } from "./modes";
import {
  type PromptDraftByMode,
  getPromptDraft,
  initialPromptTabState,
  patchPromptDraft,
} from "./prompt-draft";
import { workflowListNavigation } from "./prompt-editing";
import {
  type PromptArrowContext,
  type PromptHistoryBrowse,
  type PromptHistoryByMode,
  initialPromptHistoryBrowse,
  navigatePromptHistory,
  pushPromptHistory,
  shouldPromptHistoryArrows,
  shouldPromptHistoryCaptureDown,
  shouldPromptHistoryCaptureUp,
} from "./prompt-history";
import { shouldApplySuggestionOnSubmit } from "./slash-completion";

export interface UsePromptParams {
  mode: Mode;
  settings: SteamtrainSettings;
  slashCtx: SlashCommandContext;
  agentCatalogTick: number;
  workspaceMap: Map<string, WorkspaceEntry>;
  previewStepSelection: WorkflowStepSelection | undefined;
}

export interface UsePromptReturn {
  value: string;
  historyBrowse: PromptHistoryBrowse;
  promptEditing: boolean;
  commandSuggestions: readonly string[];
  suggestionIndex: number;
  cursorResetKey: number;
  promptHistoryArrows: boolean;
  suggestionMenuOpen: boolean;
  suggestionDescriptions: Map<string, string> | undefined;
  promptHistoryByMode: PromptHistoryByMode;
  promptArrowCtx: PromptArrowContext;
  updatePromptDraft: (patch: Partial<typeof initialPromptTabState>) => void;
  handleValueChange: (next: string) => void;
  /** Mark the next single-character insert of `letter` as a hotkey leak to drop. */
  swallowNextInsert: (letter: string) => void;
  handleTab: () => void;
  handleHistoryNavigate: (direction: "up" | "down") => boolean;
  handleSuggestionNavigate: (direction: "up" | "down") => void;
  handlePromptSubmit: (raw: string, onSubmit: (raw: string) => void) => void;
  recordPromptHistory: (raw: string) => void;
  exitPromptEditing: () => void;
  bumpCursorToEnd: () => void;
  setCommandSuggestions: React.Dispatch<React.SetStateAction<readonly string[]>>;
  setSuggestionIndex: React.Dispatch<React.SetStateAction<number>>;
}

export function usePrompt({
  mode,
  settings,
  slashCtx,
  agentCatalogTick,
  workspaceMap,
  previewStepSelection,
}: UsePromptParams): UsePromptReturn {
  const [draftByMode, setDraftByMode] = useState<PromptDraftByMode>(() => new Map());
  const activeDraft = getPromptDraft(draftByMode, mode);
  const value = activeDraft.value;
  const historyBrowse = activeDraft.historyBrowse;
  const promptEditing = activeDraft.promptEditing;
  const [commandSuggestions, setCommandSuggestions] = useState<readonly string[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [cursorResetKey, setCursorResetKey] = useState(0);
  const [promptHistoryByMode, setPromptHistoryByMode] = useState<PromptHistoryByMode>(
    () => new Map(),
  );
  const promptHistoryLimit = settings.promptHistoryLimit ?? DEFAULT_PROMPT_HISTORY_LIMIT;

  const updatePromptDraft = useCallback(
    (patch: Partial<typeof initialPromptTabState>) => {
      setDraftByMode((prev) => patchPromptDraft(prev, mode, patch));
    },
    [mode],
  );

  const bumpCursorToEnd = useCallback(() => {
    setCursorResetKey((k) => k + 1);
  }, []);

  const exitPromptEditing = useCallback(() => {
    const patch: Partial<typeof initialPromptTabState> = {
      historyBrowse: initialPromptHistoryBrowse,
      promptEditing: false,
    };
    if (historyBrowse.browseIndex !== null) patch.value = historyBrowse.draft;
    updatePromptDraft(patch);
    setCommandSuggestions([]);
    setSuggestionIndex(0);
    bumpCursorToEnd();
  }, [historyBrowse, updatePromptDraft, bumpCursorToEnd]);

  // Bare-letter hotkeys (the Arrival receipt's r/n/h/i) are consumed by the
  // app-level useInput handler, but ink still delivers the same keystroke to
  // the prompt's TextInput — there is no propagation stop between useInput
  // hooks. The hotkey handler flags the letter here so the resulting
  // one-character insert is dropped instead of polluting the draft (the same
  // trick PromptInput plays for Ctrl-chord letters).
  const swallowInsertRef = useRef<string | null>(null);
  const swallowNextInsert = useCallback((letter: string) => {
    swallowInsertRef.current = letter;
  }, []);

  const handleValueChange = useCallback(
    (next: string) => {
      const swallow = swallowInsertRef.current;
      swallowInsertRef.current = null;
      if (swallow && isSpuriousLetterInsert(value, next, swallow)) return;
      updatePromptDraft({
        value: next,
        promptEditing: true,
        historyBrowse: initialPromptHistoryBrowse,
      });
      setCommandSuggestions([]);
      setSuggestionIndex(0);
    },
    [value, updatePromptDraft],
  );

  const recordPromptHistory = useCallback(
    (raw: string) => {
      setPromptHistoryByMode((prev) => pushPromptHistory(prev, mode, raw, promptHistoryLimit));
      updatePromptDraft({ historyBrowse: initialPromptHistoryBrowse });
    },
    [mode, promptHistoryLimit, updatePromptDraft],
  );

  const promptArrowCtx = useMemo<PromptArrowContext>(
    () => ({
      deferToListNavigation: workflowListNavigation(mode),
      promptEditing,
    }),
    [mode, promptEditing],
  );

  const handleHistoryNavigate = useCallback(
    (direction: "up" | "down"): boolean => {
      if (direction === "up") {
        if (
          !shouldPromptHistoryCaptureUp(
            promptHistoryByMode,
            mode,
            value,
            historyBrowse,
            promptArrowCtx,
          )
        ) {
          return false;
        }
      } else if (!shouldPromptHistoryCaptureDown(historyBrowse, promptArrowCtx, value)) {
        return false;
      }

      const result = navigatePromptHistory(
        promptHistoryByMode,
        historyBrowse,
        mode,
        value,
        direction,
      );
      if (!result) return false;
      updatePromptDraft({
        value: result.value,
        historyBrowse: { browseIndex: result.browseIndex, draft: result.draft },
      });
      bumpCursorToEnd();
      return true;
    },
    [
      promptHistoryByMode,
      mode,
      value,
      historyBrowse,
      promptArrowCtx,
      updatePromptDraft,
      bumpCursorToEnd,
    ],
  );

  const promptHistoryArrows = shouldPromptHistoryArrows(promptArrowCtx, value, historyBrowse);

  const handleTab = useCallback(() => {
    if (!isSlashCommandInput(value)) return;
    const commands = listSlashCommands();

    if (commandSuggestions.length > 1) {
      const pick = commandSuggestions[suggestionIndex];
      if (!pick) return;
      const nextValue = applySlashSuggestion(value, pick, commands, slashCtx);
      if (nextValue !== value) {
        updatePromptDraft({ value: nextValue, promptEditing: true });
        bumpCursorToEnd();
      }
      const result = autocompleteSlashCommand(nextValue, commands, slashCtx);
      if (!result) {
        setCommandSuggestions([]);
        setSuggestionIndex(0);
        return;
      }
      setCommandSuggestions(result.suggestions);
      setSuggestionIndex(0);
      return;
    }

    const result = autocompleteSlashCommand(value, commands, slashCtx);
    if (!result) {
      setCommandSuggestions([]);
      setSuggestionIndex(0);
      return;
    }
    if (result.value !== value) {
      updatePromptDraft({ value: result.value, promptEditing: true });
      bumpCursorToEnd();
    }
    setCommandSuggestions(result.suggestions);
    setSuggestionIndex(0);
  }, [value, slashCtx, commandSuggestions, suggestionIndex, updatePromptDraft, bumpCursorToEnd]);

  const handleSuggestionNavigate = useCallback(
    (direction: "up" | "down") => {
      if (commandSuggestions.length <= 1) return;
      setSuggestionIndex((i) => {
        if (direction === "down") {
          return Math.min(commandSuggestions.length - 1, i + 1);
        }
        return Math.max(0, i - 1);
      });
    },
    [commandSuggestions.length],
  );

  const suggestionMenuOpen = commandSuggestions.length > 1 && isSlashCommandInput(value);

  const suggestionDescriptions = useMemo(() => {
    if (!suggestionMenuOpen) return undefined;
    const parsed = parseSlashInput(value);
    if (!parsed) return undefined;

    if (parsed.command === "model") {
      if (isWorkspaceMode(mode)) {
        const entry = workspaceMap.get(mode);
        if (!entry) return undefined;
        void agentCatalogTick;
        const map = new Map<string, string>();
        for (const model of modelsForAgent(entry.agent, slashCtx.config)) {
          if (model.name !== model.id) map.set(model.id, model.name);
        }
        return map.size > 0 ? map : undefined;
      }
      if (previewStepSelection) {
        void agentCatalogTick;
        const map = new Map<string, string>();
        for (const model of modelsForAgent(previewStepSelection.agent, slashCtx.config)) {
          if (model.name !== model.id) map.set(model.id, model.name);
        }
        return map.size > 0 ? map : undefined;
      }
    }

    const body = value.trimStart().slice(1);
    const hasArgumentTokens = body.includes(" ");
    if (hasArgumentTokens && parsed.command.length > 0) return undefined;
    const map = new Map<string, string>();
    for (const c of listSlashCommands()) {
      map.set(c.name, c.description);
    }
    return map;
  }, [value, suggestionMenuOpen, mode, workspaceMap, agentCatalogTick, previewStepSelection]);

  const handlePromptSubmit = useCallback(
    (raw: string, onSubmit: (raw: string) => void) => {
      if (shouldApplySuggestionOnSubmit(commandSuggestions, raw)) {
        handleTab();
        return;
      }
      recordPromptHistory(raw);
      onSubmit(raw);
    },
    [commandSuggestions, handleTab, recordPromptHistory],
  );

  return {
    value,
    historyBrowse,
    promptEditing,
    commandSuggestions,
    suggestionIndex,
    cursorResetKey,
    promptHistoryArrows,
    promptHistoryByMode,
    suggestionMenuOpen,
    suggestionDescriptions,
    promptArrowCtx,
    updatePromptDraft,
    handleValueChange,
    swallowNextInsert,
    handleTab,
    handleHistoryNavigate,
    handleSuggestionNavigate,
    handlePromptSubmit,
    recordPromptHistory,
    exitPromptEditing,
    bumpCursorToEnd,
    setCommandSuggestions,
    setSuggestionIndex,
  };
}
