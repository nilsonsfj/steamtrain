import {
  PERMISSION_PROFILES,
  type PermissionProfile,
  isPermissionProfile,
  permissionsBadge,
  permissionsDescription,
  providerPermissionSupport,
  resolvePermissions,
} from "../../agents/permissions";
import { listRetargetableSteps } from "../../tui/workflow-step-editor";
import {
  formatPermissionSummary,
  permissionEnforcementNote,
  workflowPermissionSummary,
  workflowPermissionVerdicts,
} from "../../workflow";
import type {
  SlashCommand,
  SlashCommandContext,
  SlashCommandNotice,
  SlashCommandResult,
} from "../types";
import { hasWorkflowStepTarget, takeAllFlag } from "../workflow-step-target";

/**
 * `/permissions` — the "I'm about to run this on my real repo" command.
 *
 * With a workflow step selected it sets that step's sandbox profile for the
 * session (`/save-workflows` persists it); with `--all` it locks down every
 * agent step in the pipeline at once, which is the actual thing a cautious user
 * wants to do to somebody else's workflow before trusting it. With no argument
 * it reports the whole workflow's posture, step by step, including which agents
 * can genuinely enforce what they were asked to.
 */
export const permissionsCommand: SlashCommand = {
  name: "permissions",
  description: "Show or set per-step tool permissions (read-only / edit / full)",
  usage: "/permissions [read-only|edit|full|clear] [--all]",
  execute(args, ctx) {
    const { args: bare, all } = takeAllFlag(args);

    if (bare.length === 0) return reportPermissions(ctx);

    const next = bare[0]!;
    if (next !== "clear" && !isPermissionProfile(next)) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "error",
            text: `unknown profile '${next}'; try: ${PERMISSION_PROFILES.join(", ")} or clear`,
          },
        ],
      };
    }

    const update = ctx.updateWorkflowStep;
    if (!update) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "warn",
            text: "/permissions can only change a workflow step — open a workflow preview and select an agent-backed step (or run /permissions with no argument to inspect)",
          },
        ],
      };
    }

    const value = next === "clear" ? undefined : (next as PermissionProfile);

    if (all) {
      if (!ctx.workflowSpec) {
        return {
          handled: true,
          clearInput: true,
          notices: [{ level: "warn", text: "--all needs an active workflow preview" }],
        };
      }
      const steps = listRetargetableSteps(ctx.workflowSpec, ctx.resolveWorkflow);
      // Merge steps are excluded on purpose: a conflict resolver must write, so
      // blanket-applying `read-only` to one would author a contradiction the
      // validator then rejects.
      const targets = steps.filter((step) => step.kindLabel !== "merge" || value !== "read-only");
      for (const step of targets) update(step.stepId, { permissions: value });
      const label = value ? permissionsBadge(value) : "cleared (no profile)";
      const skipped = steps.length - targets.length;
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text: `permissions ${label} on ${targets.length} agent step(s)${skipped > 0 ? ` · ${skipped} merge step(s) skipped (a conflict resolver must write)` : ""} · /save-workflows to persist`,
          },
        ],
      };
    }

    if (!hasWorkflowStepTarget(ctx)) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "warn",
            text: "/permissions requires a selected agent-backed workflow step (↑/↓ in the workflow preview), or --all for the whole pipeline",
          },
        ],
      };
    }

    const step = ctx.workflowStep!;
    update(step.stepId, { permissions: value });
    if (!value) {
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text: `permissions cleared for step '${step.stepId}' (unrestricted unless the workflow or config sets a default)`,
          },
        ],
      };
    }
    const support = step.agent ? enforcementNote(ctx, step.stepId) : undefined;
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "info",
          text: `step '${step.stepId}' → ${permissionsBadge(value)}${support ? ` · ${support}` : ""} · ${permissionsDescription(value)}`,
        },
      ],
    };
  },
  complete(args) {
    const { args: bare } = takeAllFlag(args);
    if (bare.length <= 1) return [...PERMISSION_PROFILES, "clear"];
    if (bare.length === 2 && bare[0] && !args.includes("--all") && !args.includes("-a")) {
      return ["--all"];
    }
    return [];
  },
};

/** Enforcement note for one step under the live spec + config. */
function enforcementNote(ctx: SlashCommandContext, stepId: string): string | undefined {
  if (!ctx.workflowSpec) return undefined;
  const verdict = workflowPermissionVerdicts(ctx.workflowSpec, ctx.config).find(
    (v) => v.stepId === stepId,
  );
  return verdict ? permissionEnforcementNote(verdict) : undefined;
}

/**
 * No-argument form: the workflow's posture in one screen — the summary line,
 * then one line per step that has a profile, then the agents whose CLIs cannot
 * enforce a restriction at all (so the fix is obvious).
 */
function reportPermissions(ctx: SlashCommandContext): SlashCommandResult {
  const spec = ctx.workflowSpec;
  if (!spec) {
    const selected = ctx.workflowStep;
    if (selected) {
      const perms = resolvePermissions(selected.permissions);
      return {
        handled: true,
        clearInput: true,
        notices: [
          {
            level: "info",
            text: perms
              ? `step '${selected.stepId}': ${permissionsBadge(perms.profile)} · ${permissionsDescription(perms.profile)}`
              : `step '${selected.stepId}': no profile — unrestricted`,
          },
        ],
      };
    }
    return {
      handled: true,
      clearInput: true,
      notices: [
        {
          level: "info",
          text: `profiles: ${PERMISSION_PROFILES.join(", ")} — open a workflow preview to see or set per-step permissions`,
        },
      ],
    };
  }

  const notices: SlashCommandNotice[] = [];
  const summary = formatPermissionSummary(workflowPermissionSummary(spec, ctx.config));
  notices.push({
    level: "info",
    text: summary
      ? `🔒 ${spec.name}: ${summary}`
      : `${spec.name} runs no agent steps — nothing to sandbox`,
  });

  const verdicts = workflowPermissionVerdicts(spec, ctx.config);
  for (const verdict of verdicts) {
    notices.push({
      level: verdict.blocking ? "error" : verdict.enforcement === "none" ? "warn" : "info",
      text: `  ${verdict.stepId}: ${permissionsBadge(verdict.permissions.profile)} · ${permissionEnforcementNote(verdict)}`,
    });
  }
  if (verdicts.length === 0) {
    notices.push({
      level: "info",
      text: "  no step declares a profile — /permissions read-only --all locks the whole pipeline down",
    });
  }
  return { handled: true, clearInput: true, notices };
}

/** Profiles a provider can actually enforce, for help text and diagnostics. */
export function enforceableProfiles(provider: Parameters<typeof providerPermissionSupport>[0]) {
  const support = providerPermissionSupport(provider);
  return PERMISSION_PROFILES.filter((profile) => support.profiles[profile] !== "none");
}
