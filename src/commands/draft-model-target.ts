import { modelIdsForAgent } from "../agents";
import {
  type DraftTarget,
  draftModelCompletions,
  formatDraftTarget,
  parseDraftModelRequest,
} from "../tui/draft-model";
import type { DraftModelContext, SlashCommandResult } from "./types";

/**
 * Drive the drafting agent/model from `/model` while sitting on the workflow
 * picker (no step selected). This is the sibling of the workflow-step and
 * workspace-tab `/model` handlers: same command, different target depending on
 * where you are. The override it sets is what `/createworkflow` drafts with.
 *
 * Takes the (already narrowed) {@link DraftModelContext} directly rather than the
 * whole command context, so the caller's `if (ctx.draftModel)` guard is the type
 * guard — no non-null assertion here.
 */
export function executeDraftModelCommand(
  args: string[],
  dm: DraftModelContext,
): SlashCommandResult {
  const healthy = new Set(dm.healthyAgents);
  const req = parseDraftModelRequest(args, healthy);

  if (req.kind === "error") {
    return notice("error", req.message);
  }

  if (req.kind === "reset") {
    dm.set(null);
    return notice("info", "drafting model reset to auto");
  }

  if (req.kind === "set") {
    dm.set(req.target);
    return notice("info", `drafting model set to ${formatDraftTarget(req.target)}`);
  }

  // show
  const lines: string[] = [];
  if (dm.current) {
    lines.push(
      `drafting model: ${formatDraftTarget(dm.current)} (${dm.usingOverride ? "override" : "auto"})`,
    );
  } else {
    lines.push("drafting model: none — no healthy agent (check the doctor panel)");
  }
  const available = availableLine(dm.healthyAgents);
  if (available) lines.push(available);
  lines.push("set with /model <model-id> or /model <agent> [model]; /model auto resets");
  return notice("info", lines.join("\n"));
}

export function completeDraftModelArgs(dm: DraftModelContext): readonly string[] {
  return draftModelCompletions(new Set(dm.healthyAgents));
}

function availableLine(healthyAgents: readonly DraftTarget["agent"][]): string | undefined {
  const parts = healthyAgents.map((agent) => `${agent}: ${modelIdsForAgent(agent).join(", ")}`);
  return parts.length ? `available — ${parts.join("  ·  ")}` : undefined;
}

function notice(level: "info" | "error", text: string): SlashCommandResult {
  return { handled: true, clearInput: true, notices: [{ level, text }] };
}
