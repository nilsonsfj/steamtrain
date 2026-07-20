import { existsSync } from "node:fs";
import { resolveAgentInstance } from "../agents";
import type { SteamtrainConfig } from "../config/types";
import type { AgentProviderId } from "../types/events";
import type { HistoryStep, RunRecord } from "./history";
import type { WorkflowHistoryStore } from "./history-store";

/**
 * Interactive takeover (next-frontier §4): drop a human into a recorded
 * step's agent session, inside that step's still-live git worktree. A step
 * that got 90% of the way there and stalled — or a finished run you want to
 * nudge — no longer forces a choice between re-prompting through another step
 * and abandoning the orchestrator for a fresh, contextless session.
 *
 * `steamtrain workflow takeover <runId> <stepId>` plans and launches the
 * agent's *interactive* CLI (no `--print`) in the step's worktree, resuming
 * the step's recorded session where the provider supports it (claude:
 * `--resume <sessionId>`; other providers launch a fresh interactive session
 * in the same worktree, clearly noted). When the human exits, the takeover is
 * recorded in run history as an intervention, and the worktree's final state
 * flows into the existing merge/diff machinery — `history show --diff` and
 * `history apply` see exactly what the human left behind.
 *
 * Takeover targets *recorded* runs (finished: done / error / canceled). A
 * live run's steps are still owned by the engine — pause or cancel it first.
 *
 * The planning half is pure (no spawn, injectable fs) so it is unit-testable
 * and reusable by the TUI/web step detail, which surface the equivalent
 * command to copy-paste.
 */

/** Providers whose interactive CLI can resume a recorded session, with the flag shape. */
const INTERACTIVE_RESUME_ARGS: Partial<Record<AgentProviderId, (sessionId: string) => string[]>> = {
  claude: (sessionId) => ["--resume", sessionId],
  // Cursor Agent CLI uses the same `--resume <chatId>` flag interactively and headlessly.
  cursor: (sessionId) => ["--resume", sessionId],
};

export interface TakeoverPlan {
  runId: string;
  /** The recorded step being taken over (namespaced id as recorded). */
  stepId: string;
  /** Configured agent instance id the step ran on. */
  agent: string;
  binary: string;
  /** Interactive CLI args (resume flags when supported; never `--print`). */
  args: string[];
  /** Env vars the instance declares (merged over process.env by the launcher). */
  env?: Record<string, string>;
  /** Where to launch: the step's worktree root, or its recorded cwd. */
  cwd: string;
  sessionId?: string;
  /** True when `args` resume the recorded session (vs. a fresh session). */
  resumed: boolean;
  /** Human-readable caveats ("session id missing — starting fresh", …). */
  notes: string[];
}

export type TakeoverPlanResult = { ok: true; plan: TakeoverPlan } | { ok: false; error: string };

/** Injection points for tests. */
export interface PlanTakeoverOptions {
  fsExists?: (path: string) => boolean;
}

/** Find a recorded step by id — the LAST matching instance wins (loop re-runs). */
export function findRecordedStep(
  record: RunRecord,
  stepId: string,
): { step: HistoryStep; phaseId: string } | undefined {
  let found: { step: HistoryStep; phaseId: string } | undefined;
  for (const phase of record.phases) {
    for (const step of phase.steps) {
      if (step.stepId === stepId || step.stepId.endsWith(`::${stepId}`)) {
        found = { step, phaseId: phase.phaseId };
      }
    }
  }
  return found;
}

/**
 * Plan a takeover of `stepId` in a recorded run: locate the step, verify its
 * worktree still exists, resolve the agent's interactive CLI, and decide
 * whether the recorded session can be resumed. Never spawns anything.
 */
export function planTakeover(
  record: RunRecord,
  stepId: string,
  config?: SteamtrainConfig,
  options: PlanTakeoverOptions = {},
): TakeoverPlanResult {
  const fsExists = options.fsExists ?? existsSync;
  const found = findRecordedStep(record, stepId);
  if (!found) {
    const known = record.phases
      .flatMap((phase) => phase.steps.map((step) => step.stepId))
      .filter((id) => !id.includes("::unstarted-"));
    return {
      ok: false,
      error: `run ${record.id} has no step '${stepId}' (steps: ${known.join(", ")})`,
    };
  }
  const { step } = found;
  if (!step.agent) {
    return {
      ok: false,
      error: `step '${step.stepId}' is a ${step.blockKind} step — takeover targets agent-backed steps (worker/processor), which own a session and a worktree`,
    };
  }
  const instance = resolveAgentInstance(config, step.agent, { includeDisabled: true });
  if (!instance) {
    return {
      ok: false,
      error: `agent '${step.agent}' is not configured — takeover needs the step's agent CLI to relaunch its session`,
    };
  }

  const worktree = step.worktree ?? step.result?.worktree;
  const notes: string[] = [];
  let cwd: string;
  if (worktree?.root && fsExists(worktree.root)) {
    cwd = worktree.cwd && fsExists(worktree.cwd) ? worktree.cwd : worktree.root;
  } else if (worktree?.root) {
    return {
      ok: false,
      error: `step '${step.stepId}' worktree is gone (${worktree.root}) — it was pruned or cleaned up, so there is no session workspace to take over`,
    };
  } else {
    cwd = step.cwd ?? record.cwd;
    notes.push("the step ran without an isolated worktree — taking over in its plain directory");
  }

  const sessionId = step.result?.sessionId;
  const resumeArgs = sessionId ? INTERACTIVE_RESUME_ARGS[instance.provider] : undefined;
  if (!sessionId) {
    notes.push(
      "no session id was recorded for this step — starting a fresh interactive session in its worktree",
    );
  } else if (!resumeArgs) {
    notes.push(
      `the '${instance.provider}' CLI has no supported headful session resume — starting a fresh interactive session in the step's worktree`,
    );
  }

  const args = [...(sessionId && resumeArgs ? resumeArgs(sessionId) : [])];
  return {
    ok: true,
    plan: {
      runId: record.id,
      stepId: step.stepId,
      agent: step.agent,
      binary: instance.binary,
      args,
      env: instance.env,
      cwd,
      sessionId,
      resumed: Boolean(sessionId && resumeArgs),
      notes,
    },
  };
}

/** Shell-quote one argument for display (POSIX-ish; display only, never executed). */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** The copy-pasteable equivalent of a planned takeover, for UI step detail. */
export function formatTakeoverCommand(plan: Pick<TakeoverPlan, "binary" | "args" | "cwd">): string {
  return `cd ${shellQuote(plan.cwd)} && ${[plan.binary, ...plan.args].map(shellQuote).join(" ")}`;
}

/**
 * Record a completed takeover as an intervention on the run's history record,
 * so a taken-over run stays an honest, auditable record. Best-effort: the
 * caller reports the takeover outcome regardless.
 */
export async function recordTakeover(
  historyStore: WorkflowHistoryStore,
  runId: string,
  outcome: {
    stepId: string;
    sessionId?: string;
    resumed: boolean;
    by?: string;
    startedAt: number;
    endedAt: number;
    exitCode?: number;
  },
): Promise<boolean> {
  const record = await historyStore.get(runId);
  if (!record) return false;
  const interventions = [...(record.interventions ?? [])];
  interventions.push({
    kind: "takeover",
    stepId: outcome.stepId,
    by: outcome.by ?? "human:cli",
    ts: outcome.startedAt,
    takeover: {
      sessionId: outcome.sessionId,
      resumed: outcome.resumed,
      endedAt: outcome.endedAt,
      exitCode: outcome.exitCode,
    },
  });
  await historyStore.save({ ...record, interventions });
  return true;
}
