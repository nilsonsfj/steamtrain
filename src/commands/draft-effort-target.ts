import {
  type DraftTarget,
  draftEffortCompletions,
  formatDraftTarget,
  parseDraftEffortRequest,
} from "../tui/draft-model";
import type { DraftModelContext, SlashCommandResult } from "./types";

/**
 * Drive the drafting effort from `/effort` while sitting on the workflow
 * picker (no step selected). This is the sibling of the workflow-step and
 * workspace-tab `/effort` handlers: same command, different target depending on
 * where you are. The override it sets is what `/createworkflow` drafts with.
 *
 * Takes the (already narrowed) {@link DraftModelContext} directly rather than the
 * whole command context, so the caller's `if (ctx.draftModel)` guard is the type
 * guard — no non-null assertion here.
 */
export function executeDraftEffortCommand(
  args: string[],
  dm: DraftModelContext,
): SlashCommandResult {
  const req = parseDraftEffortRequest(args, dm.current, dm.config);

  if (req.kind === "error") {
    return notice("error", req.message);
  }

  if (req.kind === "clear") {
    dm.set(dm.current ? { ...dm.current, effort: undefined } : null);
    return notice("info", "drafting effort cleared (model default)");
  }

  if (req.kind === "set") {
    if (!dm.current) {
      return notice("error", "no draft target set (use /model first)");
    }
    dm.set({ ...dm.current, effort: req.effort });
    return notice(
      "info",
      `drafting effort set to ${req.effort} for ${formatDraftTarget({ ...dm.current, effort: req.effort }, dm.config)}`,
    );
  }

  // show
  const lines: string[] = [];
  if (dm.current) {
    const currentEffort = dm.current.effort ?? "default";
    lines.push(`drafting effort: ${currentEffort} (${dm.usingOverride ? "override" : "auto"})`);
    lines.push(`model: ${formatDraftTarget(dm.current, dm.config)}`);
  } else {
    lines.push("drafting effort: no target set (use /model first)");
  }
  lines.push("set with /effort <level> or /effort clear");
  return notice("info", lines.join("\n"));
}

export function completeDraftEffortArgs(args: string[], dm: DraftModelContext): readonly string[] {
  if (args.length > 1) return [];
  return draftEffortCompletions(dm.current, dm.config);
}

function notice(level: "info" | "error", text: string): SlashCommandResult {
  return { handled: true, clearInput: true, notices: [{ level, text }] };
}
