import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { refreshAgentCatalogCaches } from "./agents/models";
import type { CliIO } from "./cli";
import { message, readAll, truncateLine, unknownWorkflowMessage } from "./cli-util";
import type { SteamtrainConfig } from "./config";
import { runDoctor } from "./doctor";
import type { Orchestrator } from "./orchestrator";
import {
  type ApprovalProvider,
  type HumanInputProvider,
  type LiveRunMeta,
  type LiveRunSource,
  type LoopProgress,
  type ModelUsage,
  type ReportFormat,
  type RerunMode,
  type RunOutcome,
  type RunRecord,
  RunRecordBuilder,
  type RunRecordStatus,
  type StepEditPatch,
  type StepResult,
  WORKFLOW_CACHE_DIR,
  WORKFLOW_HISTORY_DIR,
  WORKFLOW_RUNS_DIR,
  type WorkflowEvent,
  type WorkflowHistoryStore,
  type WorkflowSpec,
  acquireRunSlot,
  addSpend,
  aggregateLeavesByModel,
  applyRetryStepFilter,
  applyWorkflowStepOverrides,
  classifyRun,
  createLiveRunPublisher,
  createLiveRunStore,
  createNotifier,
  createWorkflowCacheStore,
  createWorkflowHistoryStore,
  createWorkflowRunControl,
  dropsCacheEntries,
  exitCodeForOutcome,
  exitCodeForRun,
  formatReroutePlan,
  formatTakeoverCommand,
  formatTokenSummary,
  formatTokens,
  formatUsd,
  hasFailingGate,
  hashWorkflowSpec,
  headlessApprovalProvider,
  headlessHumanInputProvider,
  isReportFormat,
  isRerunError,
  isTerminalLiveRunStatus,
  lintTemplateRefs,
  matchPendingApproval,
  matchPendingInput,
  newLiveRunMeta,
  notifyWorkflowEvent,
  persistWorkflowStepDone,
  planRerun,
  planTakeover,
  recordTakeover,
  renderReport,
  rerunDowngradeMessage,
  resolveInputs,
  resolveMaxParallelRuns,
  resolveWorkflowTimeoutSec,
  resultLeaves,
  spawnDetachedRunner,
  stepMetaFromSpec,
  storeApprovalProvider,
  storeHumanInputProvider,
  timeoutMsFromSec,
  tokensForResults,
  totalTokens,
  watchRunCancel,
  watchRunControl,
  workflowAgentIds,
  workflowAutonomy,
  workflowCacheKey,
  workflowLlmSteps,
} from "./workflow";

/**
 * The `workflow run / attach / runs / cancel / approve` CLI drivers, plus the
 * hidden `_detached-runner` entry a `--detach` launch re-execs into. Extracted
 * from `cli.ts` so the run machinery (queue, live-run mirroring, detach) lives
 * in one place.
 */

/** POSIX-safe single-quote for a copy-paste command hint. */
function shellQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface RunOptions {
  input?: string;
  stdin: boolean;
  json: boolean;
  fresh: boolean;
  from?: string;
  retryFailed: boolean;
  params: Record<string, string>;
  /** `--approve-all`: auto-approve every human checkpoint (unattended). */
  approveAll: boolean;
  /** `--on-approval fail|stop`: auto-reject every human checkpoint with this disposition. */
  onApproval?: "fail" | "stop";
  /** `--human <stepId>=<value|@file>`: pre-supplied answers for human steps / agent questions. */
  human: Record<string, string>;
  /** `--detach`: run under a background process; attach later from any UI. */
  detach: boolean;
  /** `--agent <id>`: re-route steps whose pinned agent is not ready to this agent (this run only). */
  agent?: string;
  /**
   * `--retarget-agent <id>`: force failed/not-run agent steps onto this agent
   * when used with `--from --retry-failed` (even if the original agent is ready).
   */
  retargetAgent?: string;
  /** `--retarget-model <id>`: optional model for `--retarget-agent`. */
  retargetModel?: string;
  /** `--step <id>` (repeatable): narrow which failed/not-run steps re-execute on retry-failed. */
  steps: string[];
  /** `--report json|markdown|junit`: write a machine-readable report when the run settles. */
  report?: ReportFormat;
  /** `--output <file>`: write the `--report` to a file instead of stdout. */
  output?: string;
}

export function parseRunOptions(args: string[]): RunOptions | null {
  const options: RunOptions = {
    stdin: false,
    json: false,
    fresh: false,
    retryFailed: false,
    params: {},
    approveAll: false,
    human: {},
    detach: false,
    steps: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--input" || arg === "-i") {
      const value = args[i + 1];
      if (!value) return null;
      options.input = value;
      i += 1;
    } else if (arg === "--param" || arg === "-p") {
      const value = args[i + 1];
      if (!value) return null;
      const eq = value.indexOf("=");
      if (eq < 1) return null;
      const key = value.slice(0, eq);
      if (key.startsWith("-")) return null;
      options.params[key] = value.slice(eq + 1);
      i += 1;
    } else if (arg === "--from") {
      const value = args[i + 1];
      if (!value) return null;
      options.from = value;
      i += 1;
    } else if (arg === "--retry-failed") {
      options.retryFailed = true;
    } else if (arg === "--stdin") {
      options.stdin = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fresh") {
      options.fresh = true;
    } else if (arg === "--detach" || arg === "-d") {
      options.detach = true;
    } else if (arg === "--agent") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) return null;
      options.agent = value;
      i += 1;
    } else if (arg === "--retarget-agent") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) return null;
      options.retargetAgent = value;
      i += 1;
    } else if (arg === "--retarget-model") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) return null;
      options.retargetModel = value;
      i += 1;
    } else if (arg === "--step") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) return null;
      options.steps.push(value);
      i += 1;
    } else if (arg === "--human") {
      const value = args[i + 1];
      if (!value) return null;
      const eq = value.indexOf("=");
      if (eq < 1) return null;
      const key = value.slice(0, eq);
      if (key.startsWith("-")) return null;
      options.human[key] = value.slice(eq + 1);
      i += 1;
    } else if (arg === "--approve-all") {
      options.approveAll = true;
    } else if (arg === "--on-approval") {
      const value = args[i + 1];
      if (value !== "fail" && value !== "stop") return null;
      options.onApproval = value;
      i += 1;
    } else if (arg === "--report") {
      const value = args[i + 1];
      if (!value || !isReportFormat(value)) return null;
      options.report = value;
      i += 1;
    } else if (arg === "--output" || arg === "-o") {
      const value = args[i + 1];
      if (!value) return null;
      options.output = value;
      i += 1;
    } else {
      return null;
    }
  }
  // `--approve-all` and `--on-approval` are mutually exclusive intents.
  if (options.approveAll && options.onApproval) return null;
  // `--output` only has meaning alongside `--report`.
  if (options.output && !options.report) return null;
  return options;
}

export async function runWorkflowCommand(
  orchestrator: Orchestrator,
  config: SteamtrainConfig,
  args: string[],
  io: CliIO,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  // The positional name is optional when re-launching a past run with --from.
  const positional = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const options = parseRunOptions(positional ? args.slice(1) : args);
  if (!options) {
    err(
      `usage: steamtrain workflow run <name> --input <text> [--param key=value ...] [--json] [--fresh] [--dry-run] [--detach] [--agent <id>] [--approve-all | --on-approval fail|stop] [--human <stepId>=<value|@file> ...] [--report json|markdown|junit [--output <file>]]
       steamtrain workflow run --from <runId> [--retry-failed] [--retarget-agent <id> [--retarget-model <id>]] [--step <id> ...] [--json] [--detach]
`,
    );
    return 1;
  }

  const cwd = io.cwd ?? process.cwd();
  const historyStore = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));

  let name = positional;
  let input = options.input;
  let seed: Map<string, StepResult> | undefined;
  let forceFresh = options.fresh;
  let fromRecord: RunRecord | undefined;
  const wantsRetarget = Boolean(options.retargetAgent || options.retargetModel);
  const wantsStepFilter = options.steps.length > 0;
  const wantsRetryNarrow = wantsRetarget || wantsStepFilter;

  if (options.retryFailed && !options.from) {
    err("--retry-failed only applies with --from <runId>\n");
    return 1;
  }
  if (wantsRetryNarrow && !options.retryFailed) {
    err(
      "--retarget-agent / --retarget-model / --step only apply with --from <runId> --retry-failed\n",
    );
    return 1;
  }
  if (options.retargetModel && !options.retargetAgent) {
    err("--retarget-model requires --retarget-agent\n");
    return 1;
  }
  if (options.agent && options.retargetAgent) {
    err("--agent and --retarget-agent are mutually exclusive\n");
    return 1;
  }

  // --from <runId>: take the workflow + input from a recorded run and decide
  // whether to seed the cache (retry-failed) or run fresh (re-run).
  if (options.from) {
    if (positional) {
      err("workflow run: pass a workflow name or --from <runId>, not both\n");
      return 1;
    }
    const record = await historyStore.get(options.from);
    if (!record) {
      err(`unknown run '${options.from}'\n`);
      return 1;
    }
    fromRecord = record;
    name = record.workflow;
    const mode: RerunMode = options.retryFailed ? "retry-failed" : "rerun";
    const plan = planRerun(record, mode, orchestrator.listWorkflows()[name], {
      input: options.input,
      cwd,
      params: Object.keys(options.params).length > 0 ? options.params : undefined,
    });
    if (isRerunError(plan)) {
      err(`${plan.error}\n`);
      return 1;
    }
    input = plan.input;
    if (plan.params) {
      // Use the plan's resolved params (from the original run or user override).
      for (const [k, v] of Object.entries(plan.params)) {
        if (!(k in options.params)) options.params[k] = String(v);
      }
    }
    if (plan.downgraded) {
      if (wantsRetryNarrow) {
        err(
          `cannot retarget/narrow retry: ${rerunDowngradeMessage(plan.downgraded)} — use a normal run with /set-all or Ctrl+E instead\n`,
        );
        return 1;
      }
      err(`note: ${rerunDowngradeMessage(plan.downgraded)}\n`);
    }
    // An explicit --fresh forces a clean run and ignores any seed.
    forceFresh = options.fresh || mode === "rerun" || Boolean(plan.downgraded);
    seed = forceFresh ? undefined : plan.seedCache;
    if (seed && wantsStepFilter) {
      try {
        seed = applyRetryStepFilter(
          record,
          seed,
          options.steps,
          orchestrator.listWorkflows()[name],
        );
      } catch (e) {
        err(`${message(e)}\n`);
        return 1;
      }
    }
  } else {
    input = options.input ?? (options.stdin ? await readAll(io.stdin ?? process.stdin) : undefined);
  }

  if (!name) {
    err("workflow run requires a workflow name (or --from <runId>)\n");
    return 1;
  }
  if (!input?.trim()) {
    err("workflow run requires --input <text> or --stdin\n");
    return 1;
  }

  let spec = orchestrator.listWorkflows()[name];
  if (!spec) {
    err(`${unknownWorkflowMessage(name, Object.keys(orchestrator.listWorkflows()))}\n`);
    return 1;
  }

  const resolved = resolveInputs(spec, options.params);
  if (resolved.errors.length > 0) {
    for (const e of resolved.errors) err(`input error: ${e}\n`);
    return 1;
  }

  const templateWarnings = lintTemplateRefs(spec);
  for (const w of templateWarnings) out(`warn: ${w}\n`);

  // Agentless workflows (only distributors / consolidators / gates) never spawn
  // a CLI, so skip the doctor + catalog refresh — they would otherwise spawn
  // real agent binaries just to gate a run that needs none. llm-step workflows
  // still get the dispatch gate (API instance resolves + key present), which is
  // purely local and spawns nothing.
  const usesAgents = workflowAgentIds(spec).length > 0;
  if (usesAgents) {
    const doctor = await runDoctor(config);
    orchestrator.setDoctor(doctor);
    await refreshAgentCatalogCaches(config, doctor);
  }
  // --retarget-agent: force failed/not-run agent steps onto a chosen ready
  // agent for this retry-failed run only (even when the original agent is ready).
  if (options.retargetAgent) {
    if (!fromRecord) {
      err("--retarget-agent requires --from <runId> --retry-failed\n");
      return 1;
    }
    if (!usesAgents) {
      err(`--retarget-agent: workflow '${name}' has no agent-backed steps to retarget\n`);
      return 1;
    }
    const retarget = orchestrator.planWorkflowRetryRetarget(spec, fromRecord, {
      agent: options.retargetAgent,
      model: options.retargetModel,
      stepIds: wantsStepFilter ? options.steps : undefined,
    });
    if (!retarget.ok) {
      err(`--retarget-agent ${options.retargetAgent}: ${retarget.error}\n`);
      return 1;
    }
    spec = applyWorkflowStepOverrides(spec, retarget.overrides);
    const steps = retarget.stepIds.length === 1 ? "1 step" : `${retarget.stepIds.length} steps`;
    (options.json ? err : out)(
      `retarget ${steps} → ${options.retargetAgent}/${retarget.targetModel} — this run only\n`,
    );
  }
  // --agent <id>: re-route steps whose pinned agent is not ready onto the
  // requested (ready) agent, for this run only. The workflow on disk is
  // untouched. A detached child re-plans from the same target (see launch
  // metadata), so the parent applies it here too to keep cache keys aligned.
  if (options.agent) {
    if (!usesAgents) {
      err(`--agent: workflow '${name}' has no agent-backed steps to re-route\n`);
      return 1;
    }
    const reroute = orchestrator.planWorkflowReroute(spec, { target: options.agent });
    if (!reroute.ok) {
      if (reroute.error) {
        err(`--agent ${options.agent}: ${reroute.error}\n`);
        return 1;
      }
      // Notes go to stderr under --json so stdout stays parseable JSON.
      (options.json ? err : out)(
        "note: every agent this workflow uses is ready — nothing to re-route\n",
      );
    } else {
      spec = applyWorkflowStepOverrides(spec, reroute.plan.overrides);
      (options.json ? err : out)(`${formatReroutePlan(reroute.plan)} — this run only\n`);
    }
  }
  if (usesAgents || workflowLlmSteps(spec).length > 0) {
    const check = orchestrator.canDispatchWorkflowSpec(spec);
    if (!check.ok) {
      err(`cannot run '${name}': ${check.reason}\n`);
      if (!options.agent) {
        const reroute = orchestrator.planWorkflowReroute(spec);
        if (reroute.ok) {
          // Emit the full runnable command so it's genuinely copy-paste-able
          // (the doctor's install hints are; this should match) — including any
          // --param values the original invocation supplied, so a workflow with
          // required declared inputs doesn't fail input resolution on re-run.
          const paramArgs = Object.entries(options.params)
            .map(([k, v]) => ` --param ${shellQuote(`${k}=${v}`)}`)
            .join("");
          const rerun = `steamtrain workflow run ${name} --input ${shellQuote(
            input?.trim() ?? "",
          )}${paramArgs} --agent ${reroute.plan.target}`;
          err(`hint: ${formatReroutePlan(reroute.plan)}\n`);
          err(`      re-run with: ${rerun}\n`);
        }
      }
      return 1;
    }
  }

  const trimmedInput = input.trim();
  const params = Object.keys(resolved.values).length > 0 ? resolved.values : undefined;

  // Resolve `--human <stepId>=@file` values up front so a bad path fails the
  // launch, not the step, and a detached child gets plain baked values.
  const humanValues: Record<string, string> = {};
  for (const [stepId, raw] of Object.entries(options.human)) {
    if (raw.startsWith("@")) {
      try {
        humanValues[stepId] = await readFile(raw.slice(1), "utf8");
      } catch (e) {
        err(`could not read --human ${stepId}=@${raw.slice(1)}: ${message(e)}\n`);
        return 1;
      }
    } else {
      humanValues[stepId] = raw;
    }
  }

  // A report is written once the run settles, so it needs a foreground run.
  if (options.report && options.detach) {
    err(
      "--report cannot be used with --detach (the run is backgrounded); run in the foreground, or inspect a finished run with 'steamtrain workflow history show <id>'\n",
    );
    return 1;
  }
  // Both --json (live event stream) and a stdout report would interleave on
  // stdout; send one of them to a file with --output to keep stdout parseable.
  if (options.report && options.json && !options.output) {
    err("--report without --output cannot be combined with --json (both write to stdout)\n");
    return 1;
  }

  if (options.detach) {
    return spawnDetachedRun({
      spec,
      name,
      input: trimmedInput,
      params,
      forceFresh,
      seed,
      approveAll: options.approveAll,
      onApproval: options.onApproval,
      humanInputs: Object.keys(humanValues).length > 0 ? humanValues : undefined,
      rerouteAgent: options.agent,
      json: options.json,
      cwd,
      io,
      out,
      err,
    });
  }

  // Human-approval checkpoints run non-interactively in the headless CLI:
  // `--approve-all` approves; `--on-approval fail|stop` rejects with that
  // disposition; with neither flag we auto-reject and stop (the safe default —
  // don't spend money / mutate a repo without an explicit decision).
  const approvalProvider: ApprovalProvider = options.approveAll
    ? headlessApprovalProvider("approve-all")
    : options.onApproval === "fail"
      ? headlessApprovalProvider("reject-fail")
      : headlessApprovalProvider("reject-stop");
  const workflowCatalog = orchestrator.listWorkflows();
  const autonomy = workflowAutonomy(spec, (childName) => workflowCatalog[childName]);
  if (
    !options.approveAll &&
    !options.onApproval &&
    specHasApprovalCheckpoints(spec, (childName) => workflowCatalog[childName])
  ) {
    err(
      "note: this workflow has approval checkpoints; with no --approve-all / --on-approval they auto-reject and stop the run (or use --detach, which waits for a decision from any attached UI)\n",
    );
  }
  // Human steps / agent questions run headlessly from pre-supplied answers;
  // an unanswered one fails fast with guidance rather than hanging CI.
  const humanInputProvider = headlessHumanInputProvider(humanValues);
  if (autonomy === "interactive" && Object.keys(humanValues).length === 0) {
    err(
      "note: this workflow needs human input mid-run; supply answers with --human <stepId>=<value|@file>, or use --detach and answer from any attached UI ('steamtrain workflow answer')\n",
    );
  }

  // Wire cancellation so Ctrl+C unwinds the run and records it as "canceled"
  // (matching the TUI and web drivers) instead of hard-killing the process
  // before history is written. A second Ctrl+C force-exits.
  const result = await driveWorkflowRun({
    orchestrator,
    config,
    name,
    spec,
    input: trimmedInput,
    params,
    cwd,
    runId: randomUUID(),
    fresh: forceFresh,
    seed,
    source: "cli",
    detached: false,
    registerLiveRun: true,
    approval: approvalProvider,
    humanInput: humanInputProvider,
    json: options.json,
    out,
    err,
    installSignalHandlers: (abort) => {
      let interrupts = 0;
      const onSigint = (): void => {
        interrupts += 1;
        if (interrupts === 1) abort();
        else process.exit(130);
      };
      // SIGTERM (kill, service manager) unwinds gracefully too, so the run is
      // recorded as canceled instead of vanishing mid-flight.
      const onSigterm = (): void => abort();
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
      return () => {
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
      };
    },
  });

  if (options.report && result.record) {
    await writeRunReport(result.record, result.outcome, options, out, err);
  }
  return result.code;
}

/**
 * Render a settled run's `--report` and deliver it to `--output <file>` or
 * stdout. A report write failure warns but never masks the run's own exit code
 * — the pipeline still sees why the run failed.
 */
async function writeRunReport(
  record: RunRecord,
  outcome: RunOutcome,
  options: Pick<RunOptions, "report" | "output">,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<void> {
  const format = options.report;
  if (!format) return;
  const report = renderReport(record, format, { outcome });
  if (options.output) {
    try {
      await writeFile(options.output, report, "utf8");
      // A confirmation on stderr keeps stdout clean for --json / piping while
      // still telling a human where the artifact landed.
      err(`report: wrote ${format} report to ${options.output}\n`);
    } catch (e) {
      err(`warning: could not write report to ${options.output}: ${message(e)}\n`);
    }
    return;
  }
  out(report);
}

interface SpawnDetachedRunOptions {
  spec: WorkflowSpec;
  name: string;
  input: string;
  params?: Record<string, string | number | boolean>;
  forceFresh: boolean;
  seed?: Map<string, StepResult>;
  approveAll: boolean;
  onApproval?: "fail" | "stop";
  humanInputs?: Record<string, string>;
  /** `--agent <id>`: the detached child re-plans the re-route from this target. */
  rerouteAgent?: string;
  json: boolean;
  cwd: string;
  io: CliIO;
  out: (text: string) => void;
  err: (text: string) => void;
}

/**
 * Launch a `--detach` run: register the run (status "queued"), prepare the
 * on-disk cache (fresh / --from seeds), then re-exec this same CLI as a
 * detached child (`workflow _detached-runner <runId>`) whose stdout/stderr land
 * in the run dir's runner.log. The parent prints the run id and returns
 * immediately; the child survives this terminal.
 */
async function spawnDetachedRun(options: SpawnDetachedRunOptions): Promise<number> {
  const { cwd, out, err } = options;
  const script = process.argv[1];
  if (!script) {
    err("cannot detach: the steamtrain entry script could not be determined\n");
    return 1;
  }

  // Bake --from retry seeds into the store now so the child can simply load
  // them. An explicit --fresh is passed THROUGH to the child instead of being
  // applied here: the child clears the cache after it acquires its queue slot,
  // so a concurrent identical run finishing while this one waits in the queue
  // cannot repopulate a cache the parent already cleared.
  if (options.seed && options.seed.size > 0 && !options.forceFresh) {
    const cacheStore = createWorkflowCacheStore(join(cwd, WORKFLOW_CACHE_DIR));
    const key = workflowCacheKey(options.name, options.input, cwd, options.spec, options.params);
    const cache = await cacheStore.load(key);
    for (const [stepId, result] of options.seed) cache.set(stepId, result);
    await cacheStore.save(key, cache);
  }

  const historyStore = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));
  const store = createLiveRunStore(join(cwd, WORKFLOW_RUNS_DIR), { historyStore });
  const runId = randomUUID();
  await store.create(
    newLiveRunMeta({
      id: runId,
      workflow: options.name,
      input: options.input,
      params: options.params,
      cwd,
      source: "cli-detached",
      detached: true,
      // The child reports its own pid on startup; -1 marks "not started yet".
      pid: -1,
      launch: {
        workflow: options.name,
        input: options.input,
        params: options.params,
        fresh: options.forceFresh || undefined,
        approveAll: options.approveAll || undefined,
        onApproval: options.onApproval,
        humanInputs: options.humanInputs,
        rerouteAgent: options.rerouteAgent,
      },
    }),
  );

  // Re-exec this CLI as the detached child that owns the run. A failed exec
  // (missing/blocked binary) settles the registry entry as errored rather than
  // leaving a zombie "queued" entry.
  const spawned = await spawnDetachedRunner({
    store,
    runId,
    cwd,
    projectDir: options.io.cwd,
    configPath: options.io.configPath,
    workspacePath: options.io.workspacePath,
  });
  if (!spawned.ok) {
    await store
      .update(runId, {
        status: "error",
        ok: false,
        error: `could not spawn the detached runner: ${spawned.error}`,
        endedAt: Date.now(),
      })
      .catch(() => {});
    err(`could not spawn the detached runner: ${spawned.error}\n`);
    return 1;
  }

  if (options.json) {
    out(`${JSON.stringify({ ok: true, runId, detached: true })}\n`);
  } else {
    out(`detached run ${runId} (${options.name})\n`);
    out(`  attach:  steamtrain workflow attach ${runId}\n`);
    out("  status:  steamtrain workflow runs\n");
    out(`  cancel:  steamtrain workflow cancel ${runId}\n`);
  }
  return 0;
}

/**
 * The hidden `workflow _detached-runner <runId>` entry point the detached
 * child re-execs into. Reads the launch args from the run's meta, re-checks
 * agent health, then drives the run exactly like a foreground one — writing
 * events to the live-run store and the final record to history. Approval
 * checkpoints wait for a decision from any attached UI unless the launch
 * carried `--approve-all` / `--on-approval`.
 */
export async function runDetachedRunner(
  orchestrator: Orchestrator,
  config: SteamtrainConfig,
  runId: string | undefined,
  io: CliIO,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  if (!runId) {
    err("usage: steamtrain workflow _detached-runner <runId>\n");
    return 1;
  }
  const cwd = io.cwd ?? process.cwd();
  const historyStore = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));
  const store = createLiveRunStore(join(cwd, WORKFLOW_RUNS_DIR), { historyStore });
  const meta = await store.get(runId);
  if (!meta?.launch) {
    err(`unknown detached run '${runId}' (no launch metadata)\n`);
    return 1;
  }
  await store.update(runId, { pid: process.pid });

  // Crash safety: this process OWNS the run — an uncaught exception or
  // unhandled rejection must settle the registry entry as errored instead of
  // leaving a "running" zombie until the orphan sweep catches it.
  const onFatal = (fatal: unknown): void => {
    err(`detached runner crashed: ${message(fatal)}\n`);
    void store
      .update(runId, {
        status: "error",
        ok: false,
        error: `detached runner crashed: ${message(fatal)}`,
        endedAt: Date.now(),
        pendingApprovals: [],
      })
      .catch(() => {})
      .finally(() => process.exit(1));
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);

  const failEarly = async (reason: string): Promise<number> => {
    err(`${reason}\n`);
    await store.update(runId, {
      status: "error",
      ok: false,
      error: reason,
      endedAt: Date.now(),
    });
    await saveHistory(
      historyStore,
      new RunRecordBuilder({
        id: runId,
        workflow: meta.launch?.workflow ?? meta.workflow,
        input: meta.launch?.input ?? meta.input,
        cwd,
        params: meta.launch?.params,
      }),
      "error",
      err,
      reason,
    );
    return 1;
  };

  const launch = meta.launch;
  // A mid-run detach (TUI/web handoff) carries the exact resolved spec it was
  // running, so the background process continues with the same per-session
  // overrides and cache key. A `--detach`-at-launch run has no spec here and
  // resolves the workflow from the catalog (re-planning any `--agent` re-route).
  const carriedSpec = launch.spec;
  let spec = carriedSpec ?? orchestrator.listWorkflows()[launch.workflow];
  if (!spec) return failEarly(`unknown workflow '${launch.workflow}'`);

  const usesAgents = workflowAgentIds(spec).length > 0;
  if (usesAgents) {
    const doctor = await runDoctor(config);
    orchestrator.setDoctor(doctor);
    await refreshAgentCatalogCaches(config, doctor);
  }
  // Re-plan the parent's `--agent` re-route against current health (the plan
  // is deterministic for an explicit target, keeping cache keys aligned). A
  // carried spec already has any re-route baked in, so skip the re-plan.
  if (launch.rerouteAgent && usesAgents && !carriedSpec) {
    const reroute = orchestrator.planWorkflowReroute(spec, { target: launch.rerouteAgent });
    if (!reroute.ok && reroute.error) {
      return failEarly(`--agent ${launch.rerouteAgent}: ${reroute.error}`);
    }
    if (reroute.ok) {
      spec = applyWorkflowStepOverrides(spec, reroute.plan.overrides);
      out(`${formatReroutePlan(reroute.plan)} — this run only\n`);
    }
  }
  if (usesAgents || workflowLlmSteps(spec).length > 0) {
    const check = orchestrator.canDispatchWorkflowSpec(spec);
    if (!check.ok) return failEarly(`cannot run '${launch.workflow}': ${check.reason}`);
  }

  const approval: ApprovalProvider = launch.approveAll
    ? headlessApprovalProvider("approve-all")
    : launch.onApproval === "fail"
      ? headlessApprovalProvider("reject-fail")
      : launch.onApproval === "stop"
        ? headlessApprovalProvider("reject-stop")
        : // No policy: park on the checkpoint until a human decides from any
          // attached UI (CLI approve / TUI / web) — that's the point of detach.
          storeApprovalProvider(store, runId);

  // Pre-supplied `--human` answers resolve immediately; anything else parks
  // until an attached UI answers (`steamtrain workflow answer` / TUI / web).
  const presupplied = launch.humanInputs ?? {};
  const presuppliedProvider = headlessHumanInputProvider(presupplied);
  const storeProvider = storeHumanInputProvider(store, runId);
  const humanInput: HumanInputProvider = async (request, signal) => {
    // Only attempt 1 consults the pre-supplied value: a re-ask means that
    // value was rejected, so waiting for a fresh interactive answer is the
    // only path that can still succeed.
    if (request.attempt === 1) {
      const canned = await presuppliedProvider(request, signal);
      if (!canned.canceled) return canned;
    }
    return storeProvider(request, signal);
  };

  const driven = await driveWorkflowRun({
    orchestrator,
    config,
    name: launch.workflow,
    spec,
    input: launch.input,
    params: launch.params,
    cwd,
    runId,
    fresh: Boolean(launch.fresh),
    priorOwner: priorOwnerWork(
      await store.readEvents(runId).catch((e) => {
        // Not fatal, but the steps already done would then bill as replays.
        err(`warning: could not read the run's earlier events: ${message(e)}\n`);
        return [];
      }),
    ),
    source: "cli-detached",
    detached: true,
    registerLiveRun: false,
    approval,
    humanInput,
    json: false,
    out,
    err,
    installSignalHandlers: (abort) => {
      const onSignal = (): void => abort();
      process.on("SIGTERM", onSignal);
      process.on("SIGINT", onSignal);
      return () => {
        process.removeListener("SIGTERM", onSignal);
        process.removeListener("SIGINT", onSignal);
      };
    },
  });
  return driven.code;
}

/** What a handed-off run's previous owner already did, read back from its events. */
export interface PriorOwnerWork {
  /** When the run started — the previous owner's `workflow_start`. */
  startedAt?: number;
  /** Steps (and fan-out children) the previous owner ran to success itself, not from cache. */
  ran: Set<string>;
  /** What the previous owner's own runs of each step billed, every pass summed. */
  spend: Map<string, Pick<StepResult, "costUsd" | "tokens">>;
  /**
   * Where the previous owner's loops were: the passes it finished and looped
   * back from, and each gate's pass. The new owner's engine continues from
   * here, so pass tags, `{{iteration}}` and loop budgets carry on.
   */
  loopProgress: LoopProgress;
  /** The previous owner's events, which seed the run's history record. */
  events: readonly WorkflowEvent[];
}

/**
 * A mid-run detach (TUI/web) re-drives the run under the same id in a new
 * process, and the steps the previous owner already finished replay from the
 * step cache. They are this run's own work, not an earlier run's: reported as
 * cached they bill $0 and read "reused a cached result", so a run that spent
 * $0.07 recorded $0.01. Read back from the events the previous owner flushed
 * before handing off; a `--detach` launch has none.
 */
export function priorOwnerWork(events: readonly WorkflowEvent[]): PriorOwnerWork {
  const ran = new Set<string>();
  const spend = new Map<string, Pick<StepResult, "costUsd" | "tokens">>();
  let startedAt: number | undefined;
  // Each phase pass in start order, keyed `phaseId:iteration`. A pass started
  // again (by a later owner) moves to the end: that is when it last ran.
  const passes = new Map<string, { phaseId: string; superseded: boolean; seq: number }>();
  const gates = new Map<string, { iteration: number; seq: number }>();
  let seq = 0;
  for (const event of events) {
    seq += 1;
    if (event.kind === "workflow_start") {
      startedAt ??= event.ts;
      continue;
    }
    if (event.kind === "phase_start") {
      const key = `${event.phaseId}:${event.iteration ?? 1}`;
      passes.delete(key);
      passes.set(key, { phaseId: event.phaseId, superseded: false, seq });
      continue;
    }
    if (event.kind === "loop_iteration") {
      // The loop jumps back: every pass since its target phase last started
      // is finished history the next owner will not run again…
      const order = [...passes.values()];
      // (A jump to a phase that never started cannot come from the engine;
      // should one appear, everything so far counts as looped back from.)
      const from = order.findLastIndex((pass) => pass.phaseId === event.loopTo);
      for (const pass of order.slice(Math.max(from, 0))) pass.superseded = true;
      // …and a loop nested in that region starts its count over, as the
      // engine's resetNestedLoops does.
      const since = order[from]?.seq ?? 0;
      for (const [id, gate] of gates)
        if (id !== event.gateStepId && gate.seq >= since) gates.delete(id);
      gates.set(event.gateStepId, { iteration: event.iteration, seq });
      continue;
    }
    if (event.kind !== "step_done" || event.cached) continue;
    // A later owner's replay of an earlier owner's step, re-labeled by
    // ownWorkRewriter: its spend is already counted from the original.
    if (event.claimed) continue;
    if (event.result.ok) ran.add(event.stepId);
    // A fan-out parent's spend is its children's; they are summed themselves.
    if (event.result.childResults?.length) continue;
    const before = spend.get(event.stepId);
    spend.set(event.stepId, before ? addSpend(before, event.result) : event.result);
  }
  const loopProgress: LoopProgress = { phaseRuns: {}, gateIterations: {} };
  for (const pass of passes.values()) {
    if (pass.superseded) {
      loopProgress.phaseRuns[pass.phaseId] = (loopProgress.phaseRuns[pass.phaseId] ?? 0) + 1;
    }
  }
  for (const [id, gate] of gates) loopProgress.gateIterations[id] = gate.iteration;
  return { startedAt, ran, spend, loopProgress, events };
}

/**
 * Rewrites a handed-off run's events as its own work (see {@link priorOwnerWork}):
 * the previous owner's steps are not cached replays, and the run started when
 * the previous owner started it. The engine's final results zero a replay and
 * sum only this process's passes, so the previous owner's spend is added back
 * — every pass of a loop it ran, not just the one the cache replays.
 * Identity when there was no previous owner.
 */
export function ownWorkRewriter(
  prior: PriorOwnerWork | undefined,
): (event: WorkflowEvent) => WorkflowEvent {
  if (!prior || (prior.ran.size === 0 && prior.startedAt === undefined)) return (event) => event;
  const restore = (result: StepResult): StepResult => {
    const children = result.childResults?.map(restore);
    const own = prior.spend.get(result.stepId);
    const withSpend = own ? { ...result, ...addSpend(result, own) } : result;
    return children ? { ...withSpend, childResults: children } : withSpend;
  };
  return (event) => {
    if (event.kind === "workflow_start" && prior.startedAt !== undefined) {
      return { ...event, ts: prior.startedAt };
    }
    if (event.kind === "step_done" && event.cached && prior.ran.has(event.stepId)) {
      return { ...event, cached: false, claimed: true };
    }
    if (event.kind === "workflow_done" && prior.spend.size > 0) {
      return { ...event, results: event.results.map(restore) };
    }
    return event;
  };
}

interface DriveWorkflowRunOptions {
  orchestrator: Orchestrator;
  config: SteamtrainConfig;
  name: string;
  spec: WorkflowSpec;
  input: string;
  params?: Record<string, string | number | boolean>;
  cwd: string;
  runId: string;
  fresh: boolean;
  seed?: Map<string, StepResult>;
  /** What the run's previous owner did before a mid-run handoff; see {@link priorOwnerWork}. */
  priorOwner?: PriorOwnerWork;
  source: LiveRunSource;
  detached: boolean;
  /** Create the live-run entry here (foreground); detached parents pre-create it. */
  registerLiveRun: boolean;
  approval: ApprovalProvider;
  humanInput: HumanInputProvider;
  json: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Wire process signals to `abort`; returns a dispose fn. */
  installSignalHandlers: (abort: () => void) => () => void;
}

/**
 * The settled outcome of a driven run: the process exit code (the documented
 * CI contract), the high-level {@link RunOutcome} classification, and the final
 * {@link RunRecord} (when one could be built) so the caller can render a
 * `--report`. `record` is undefined only on the queued-cancel path before any
 * events were folded.
 */
export interface DriveWorkflowRunResult {
  code: number;
  outcome: RunOutcome;
  record?: RunRecord;
}

/**
 * Drive one workflow run end-to-end for the CLI (foreground or detached
 * runner): register in the live-run store, wait for a queue slot, prep the
 * cache, stream events (printing + mirroring to the store), and settle
 * history + terminal meta. Returns the exit code, outcome, and final record.
 */
async function driveWorkflowRun(options: DriveWorkflowRunOptions): Promise<DriveWorkflowRunResult> {
  const { orchestrator, config, name, spec, input, params, cwd, runId, out, err } = options;
  const cacheStore = createWorkflowCacheStore(join(cwd, WORKFLOW_CACHE_DIR));
  const historyStore = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));
  const store = createLiveRunStore(join(cwd, WORKFLOW_RUNS_DIR), { historyStore });

  if (options.registerLiveRun) {
    await store.create(
      newLiveRunMeta({
        id: runId,
        workflow: name,
        input,
        params,
        cwd,
        source: options.source,
        detached: options.detached,
      }),
    );
  }

  const ac = new AbortController();
  const disposeSignals = options.installSignalHandlers(() => ac.abort());
  const disposeCancelWatch = watchRunCancel(store, runId, () => ac.abort());
  // Mid-run steering: any attached UI (TUI /pause key, web button, `steamtrain
  // workflow pause|resume|edit-step`) writes control files; this watcher
  // applies them to the run.
  const control = createWorkflowRunControl();
  const disposeControlWatch = watchRunControl(store, runId, control);

  const recorder = new RunRecordBuilder({
    id: runId,
    workflow: name,
    input,
    cwd,
    specHash: hashWorkflowSpec(spec),
    params,
  });
  // A handed-off run's record starts from what the previous owner did, or the
  // loop passes it finished (and their spend) would be missing from history.
  if (options.priorOwner) recorder.continueFrom(options.priorOwner.events);

  // Wait for a queue slot; runs beyond `maxParallelRuns` queue instead of
  // colliding over the step cache and git worktrees.
  let lastQueuePosition = -1;
  const slot = await acquireRunSlot(store, runId, resolveMaxParallelRuns(config), {
    signal: ac.signal,
    onQueued: (position, running, limit) => {
      if (position === lastQueuePosition) return;
      lastQueuePosition = position;
      err(
        `queued: ${running}/${limit} run slots busy — position ${position}; waiting (cancel with Ctrl+C or 'steamtrain workflow cancel ${runId}')\n`,
      );
    },
  });
  if (!slot.ok) {
    disposeSignals();
    disposeCancelWatch();
    disposeControlWatch();
    await store.update(runId, { status: "canceled", ok: false, endedAt: Date.now() });
    const record = await saveHistory(historyStore, recorder, "canceled", err);
    err("run canceled while queued\n");
    return { code: exitCodeForOutcome("canceled"), outcome: "canceled", record };
  }

  const key = workflowCacheKey(name, input, cwd, spec, params);
  let cache: Map<string, StepResult>;
  if (options.fresh) {
    await cacheStore.clear(key);
    cache = new Map();
  } else {
    // Run on this very map, not a copy: saves track the engine's drops by it.
    cache = await cacheStore.load(key);
  }
  if (options.seed && options.seed.size > 0) {
    // Seed the already-succeeded steps and make them the resume baseline so an
    // interrupted retry can pick up from here too.
    for (const [stepId, result] of options.seed) cache.set(stepId, result);
    await cacheStore.save(key, cache);
  }

  // Enforce whole-workflow wall-clock timeout (clock starts once executing).
  // `timedOut` distinguishes a timeout abort from a user cancel: both abort the
  // same controller, but they settle to different outcomes (and exit codes).
  let timedOut = false;
  const workflowTimeoutMs = timeoutMsFromSec(resolveWorkflowTimeoutSec(spec, config));
  const timeoutTimer =
    workflowTimeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, workflowTimeoutMs)
      : undefined;
  timeoutTimer?.unref?.();

  const publisher = createLiveRunPublisher(store, runId);
  const asOwnWork = ownWorkRewriter(options.priorOwner);
  // Run notifications (bell / desktop / webhook) per the `notify` config —
  // this process owns the run, so it is the one that pings.
  const notifier = createNotifier(config.notify);
  const notifyMeta = { workflow: name, runId };
  let ok = false;
  let budgetExceeded = false;
  try {
    for await (const replayed of orchestrator.runWorkflow(
      name,
      input,
      ac.signal,
      cache,
      cwd,
      // Pass the resolved spec (which carries any `--agent` re-route) so the
      // engine runs exactly what preflight and the cache key were computed
      // against — without this the engine re-resolves the original catalog
      // workflow and a re-route would silently not take effect.
      spec,
      params,
      options.approval,
      control,
      options.humanInput,
      undefined,
      options.priorOwner?.loopProgress,
    )) {
      const event = asOwnWork(replayed);
      recorder.handle(event);
      publisher.event(event);
      notifyWorkflowEvent(notifier, notifyMeta, event);
      if (options.json) out(`${JSON.stringify(event)}\n`);
      else printHumanEvent(event, out, { canceled: ac.signal.aborted && !timedOut, timedOut });
      if (event.kind === "step_done") {
        await persistWorkflowStepDone(
          cacheStore,
          key,
          cache,
          event.stepId,
          event.result,
          event.cached,
        );
      }
      if (dropsCacheEntries(event)) await cacheStore.save(key, cache);
      if (event.kind === "workflow_done") {
        ok = event.ok;
        budgetExceeded = Boolean(event.budgetExceeded);
        if (!options.json) printRunSummary(event.results, out, stepMetaFromSpec(spec));
      }
    }
    // The engine yields a final workflow_done on abort rather than throwing, so
    // check the signal first: a canceled run must not be mislabeled done/error.
    const status: RunRecordStatus = ac.signal.aborted
      ? "canceled"
      : budgetExceeded
        ? "budget-exceeded"
        : ok
          ? "done"
          : "error";
    await publisher.finish(status, { ok: status === "done", timedOut });
    const record = await saveHistory(historyStore, recorder, status, err, undefined, timedOut);
    const outcome = record ? classifyRun(record, { timedOut }) : "canceled";
    return { code: exitCodeForOutcome(outcome), outcome, record };
  } catch (runErr) {
    const status: RunRecordStatus = ac.signal.aborted ? "canceled" : "error";
    const error = status === "error" ? message(runErr) : undefined;
    await publisher.finish(status, { ok: false, error, timedOut });
    const record = await saveHistory(historyStore, recorder, status, err, error, timedOut);
    if (status === "canceled") {
      const outcome = record ? classifyRun(record, { timedOut }) : "canceled";
      return { code: exitCodeForOutcome(outcome), outcome, record };
    }
    throw runErr;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    disposeSignals();
    disposeCancelWatch();
    disposeControlWatch();
  }
}

// ── workflow attach ──────────────────────────────────────────────────────────

/**
 * `steamtrain workflow attach [<runId>] [--json]` — replay a live run's
 * recorded events, then tail it until it finishes. Ctrl+C detaches (the run
 * keeps going); the exit code mirrors the run's outcome. With no id, attaches
 * to the single active run, or lists the candidates.
 */
export async function runAttachCommand(
  args: string[],
  cwd: string,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length > 1) {
    err("usage: steamtrain workflow attach [<runId>] [--json]\n");
    return 1;
  }
  const historyStore = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));
  const store = createLiveRunStore(join(cwd, WORKFLOW_RUNS_DIR), { historyStore });

  let runId = positional[0];
  if (!runId) {
    const active = (await store.list()).filter((run) => !isTerminalLiveRunStatus(run.status));
    if (active.length === 0) {
      err("no active runs to attach to (see 'steamtrain workflow runs')\n");
      return 1;
    }
    if (active.length > 1) {
      err("multiple active runs — pass a run id:\n");
      for (const run of active) printLiveRunRow(run, err);
      return 1;
    }
    runId = active[0]!.id;
  }

  const meta = await store.get(runId);
  if (!meta) {
    const record = await historyStore.get(runId);
    if (record) {
      err(
        `run '${runId}' already finished (${record.status}); inspect it with 'steamtrain workflow history show ${runId}'\n`,
      );
      return 1;
    }
    err(`unknown run '${runId}'\n`);
    return 1;
  }

  if (!json) {
    out(
      `attached to run ${meta.id} (${meta.workflow}, ${meta.status}) — Ctrl+C detaches; the run keeps going\n`,
    );
    if (meta.pendingApprovals?.length) {
      out(
        `⏳ pending approval: ${meta.pendingApprovals
          .map((p) => p.stepId)
          .join(", ")} — decide with 'steamtrain workflow approve ${meta.id}'\n`,
      );
    }
    if (meta.pendingInputs?.length) {
      out(
        `✎ waiting for input: ${meta.pendingInputs
          .map((p) => p.stepId)
          .join(", ")} — answer with 'steamtrain workflow answer ${meta.id}'\n`,
      );
    }
  }

  const ac = new AbortController();
  let detached = false;
  const onSigint = (): void => {
    detached = true;
    ac.abort();
  };
  process.on("SIGINT", onSigint);
  // The verdict line waits for the run's final status: a viewer cannot tell a
  // canceled run from a failed one by its events alone.
  let done: WorkflowEvent | undefined;
  // What each step ran on, as its own step_start said — the summary's
  // by-model breakdown, which a viewer has no spec for.
  const stepMeta = new Map<string, { agent?: string; api?: string; model?: string }>();
  try {
    for await (const event of store.tailEvents(runId, { signal: ac.signal })) {
      if (event.kind === "step_start" && !event.parentStepId) {
        stepMeta.set(event.stepId, { agent: event.agent, api: event.api, model: event.model });
      }
      // Kept in JSON mode too: the exit code falls back to its results.
      if (event.kind === "workflow_done") done = event;
      if (json) out(`${JSON.stringify(event)}\n`);
      // Human mode prints workflow_done below, once the final status is known.
      // Steps the cancel took down carry `interrupted`, which is what keeps
      // their why-line quiet. A run-wide cancel flag would also silence a
      // step that genuinely failed before the cancel when attaching late.
      else if (event.kind !== "workflow_done") printHumanEvent(event, out);
      if (!json && event.kind === "approval_pending") {
        out(`     decide with: steamtrain workflow approve ${runId} --step ${event.stepId}\n`);
      }
      if (!json && event.kind === "human_input_pending") {
        out(
          `     answer with: steamtrain workflow answer ${runId} --step ${event.stepId} --value <text>\n`,
        );
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  if (detached) {
    out(`\ndetached from run ${runId}; it keeps running (re-attach any time)\n`);
    return 0;
  }

  const final = (await store.get(runId)) ?? meta;
  const timedOut = final.status === "canceled" && Boolean(final.timedOut);
  if (done && !json) {
    printHumanEvent(done, out, { canceled: final.status === "canceled" && !timedOut, timedOut });
    if (done.kind === "workflow_done") printRunSummary(done.results, out, stepMeta);
  }
  if (json) {
    out(
      `${JSON.stringify({
        type: "status",
        status: final.status,
        ok: final.ok,
        error: final.error,
        timedOut: timedOut || undefined,
      })}\n`,
    );
  } else {
    out(`\nrun ${timedOut ? "timed out" : final.status}${final.error ? `: ${final.error}` : ""}\n`);
  }
  // The same codes a foreground run exits with: classified from the record the
  // owner saved (a gate failure is 2, a timeout 3, a budget stop 4). The
  // record lands just after the terminal meta, so wait briefly for it.
  let record: RunRecord | undefined;
  for (let tries = 0; tries < 10 && !record; tries++) {
    record = await historyStore.get(runId).catch(() => undefined);
    if (!record) await new Promise((r) => setTimeout(r, 200));
  }
  if (record) return exitCodeForRun(record, { timedOut });
  if (timedOut) return exitCodeForOutcome("timeout");
  if (final.status === "budget-exceeded") return exitCodeForOutcome("budget-exceeded");
  if (final.status === "canceled") return exitCodeForOutcome("canceled");
  if (final.status === "done" && final.ok !== false) return 0;
  // A failed run with no record: its final results still carry the gate
  // outcomes, which is what tells a gate failure (2) from a step failure (1).
  if (done?.kind === "workflow_done" && hasFailingGate(done.results)) {
    return exitCodeForOutcome("gate-failed");
  }
  return exitCodeForOutcome("step-failed");
}

// ── workflow runs (list) ─────────────────────────────────────────────────────

/**
 * `steamtrain workflow runs [--all] [--json]` — the in-flight run registry:
 * queued and running runs (plus, with --all, recently finished ones still in
 * the live store).
 */
export async function runRunsCommand(
  args: string[],
  cwd: string,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const json = args.includes("--json");
  const all = args.includes("--all");
  const unknown = args.find((a) => a !== "--json" && a !== "--all");
  if (unknown) {
    err("usage: steamtrain workflow runs [--all] [--json]\n");
    return 1;
  }
  const historyStore = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));
  const store = createLiveRunStore(join(cwd, WORKFLOW_RUNS_DIR), { historyStore });
  const runs = (await store.list()).filter((run) => all || !isTerminalLiveRunStatus(run.status));
  if (json) {
    out(`${JSON.stringify({ runs }, null, 2)}\n`);
    return 0;
  }
  if (runs.length === 0) {
    out(all ? "no live runs\n" : "no active runs (use --all to include recently finished)\n");
    return 0;
  }
  out(`live runs (${runs.length})\n`);
  for (const run of runs) printLiveRunRow(run, out);
  return 0;
}

function printLiveRunRow(run: LiveRunMeta, out: (text: string) => void): void {
  const started = new Date(run.startedAt ?? run.createdAt).toISOString();
  const flags = [
    run.detached ? "detached" : run.source,
    run.paused ? "⏸ paused" : undefined,
    run.pendingApprovals?.length
      ? `⏳ approval: ${run.pendingApprovals.map((p) => p.stepId).join(", ")}`
      : undefined,
    run.pendingInputs?.length
      ? `✎ input: ${run.pendingInputs.map((p) => p.stepId).join(", ")}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  out(`  ${run.status.padEnd(8)} ${run.id}  ${run.workflow}  ${started}  [${flags}]\n`);
  out(`           input: ${truncateLine(run.input, 100)}\n`);
}

// ── workflow cancel ──────────────────────────────────────────────────────────

/** `steamtrain workflow cancel <runId>` — ask the owning process to stop the run. */
export async function runCancelCommand(
  args: string[],
  cwd: string,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const runId = args[0];
  if (!runId || runId.startsWith("--")) {
    err("usage: steamtrain workflow cancel <runId>\n");
    return 1;
  }
  const store = createLiveRunStore(join(cwd, WORKFLOW_RUNS_DIR));
  const requested = await store.requestCancel(runId);
  if (!requested) {
    err(`no active run '${runId}' to cancel (see 'steamtrain workflow runs')\n`);
    return 1;
  }
  out(`cancel requested for run ${runId}; the owning process stops it shortly\n`);
  return 0;
}

// ── workflow pause / resume / edit-step ─────────────────────────────────────

/**
 * `steamtrain workflow pause <runId>` / `resume <runId>` — write the desired
 * pause state; the owning process's control watcher applies it. Pausing lets
 * in-flight steps finish and schedules nothing new; pending steps can then be
 * edited (`workflow edit-step`) before resuming.
 */
export async function runPauseCommand(
  args: string[],
  cwd: string,
  paused: boolean,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const verb = paused ? "pause" : "resume";
  const runId = args[0];
  if (!runId || runId.startsWith("--") || args.length > 1) {
    err(`usage: steamtrain workflow ${verb} <runId>\n`);
    return 1;
  }
  const store = createLiveRunStore(join(cwd, WORKFLOW_RUNS_DIR));
  const requested = await store.writePauseState(runId, { paused, by: "human:cli" });
  if (!requested) {
    err(`no active run '${runId}' to ${verb} (see 'steamtrain workflow runs')\n`);
    return 1;
  }
  out(
    paused
      ? `pause requested for run ${runId}; in-flight steps finish, nothing new starts\n`
      : `resume requested for run ${runId}; the run continues shortly\n`,
  );
  return 0;
}

/** How long `workflow edit-step` polls for the owner's accept/reject outcome. */
const EDIT_RESULT_WAIT_MS = 5_000;
const EDIT_RESULT_POLL_MS = 200;

/**
 * `steamtrain workflow edit-step <runId> <stepId> [--prompt <text> |
 * --prompt-file <path>] [--cmd <text>] [--model <id>] [--effort <level>]` —
 * stage a mid-run edit for a not-yet-started step of a paused run, then wait
 * briefly for the owning process to accept or reject it.
 */
export async function runEditStepCommand(
  args: string[],
  cwd: string,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const usage =
    "usage: steamtrain workflow edit-step <runId> <stepId> [--prompt <text> | --prompt-file <path>] [--cmd <text>] [--model <id>] [--effort <level>] [--permissions read-only|edit|full|none]\n";
  const runId = args[0];
  const stepId = args[1];
  if (!runId || runId.startsWith("--") || !stepId || stepId.startsWith("--")) {
    err(usage);
    return 1;
  }
  const patch: StepEditPatch = {};
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (
      arg === "--prompt" ||
      arg === "--cmd" ||
      arg === "--model" ||
      arg === "--effort" ||
      arg === "--permissions"
    ) {
      if (value === undefined) {
        err(usage);
        return 1;
      }
      i++;
      if (arg === "--prompt") patch.prompt = value;
      else if (arg === "--cmd") patch.cmd = value;
      else if (arg === "--model") patch.model = value;
      else if (arg === "--effort") patch.effort = value;
      // `none` reads better than an empty string on a command line; both clear.
      else patch.permissions = value === "none" ? "" : value;
    } else if (arg === "--prompt-file") {
      if (value === undefined) {
        err(usage);
        return 1;
      }
      i++;
      try {
        patch.prompt = await readFile(value, "utf8");
      } catch (e) {
        err(`could not read --prompt-file '${value}': ${message(e)}\n`);
        return 1;
      }
    } else {
      err(usage);
      return 1;
    }
  }
  if (
    patch.prompt === undefined &&
    patch.cmd === undefined &&
    patch.model === undefined &&
    patch.effort === undefined &&
    patch.permissions === undefined
  ) {
    err(
      "nothing to change — pass at least one of --prompt/--prompt-file/--cmd/--model/--effort/--permissions\n",
    );
    return 1;
  }

  const store = createLiveRunStore(join(cwd, WORKFLOW_RUNS_DIR));
  const meta = await store.get(runId);
  if (!meta || isTerminalLiveRunStatus(meta.status)) {
    err(`no active run '${runId}' (see 'steamtrain workflow runs')\n`);
    return 1;
  }
  const desired = await store.readPauseState(runId);
  if (!meta.paused && !desired?.paused) {
    err(`run '${runId}' is not paused — pause it first: steamtrain workflow pause ${runId}\n`);
    return 1;
  }

  const editId = await store.requestStepEdit(runId, { stepId, patch, by: "human:cli" });
  if (!editId) {
    err(`no active run '${runId}' (see 'steamtrain workflow runs')\n`);
    return 1;
  }
  const deadline = Date.now() + EDIT_RESULT_WAIT_MS;
  while (Date.now() < deadline) {
    const result = await store.readStepEditResult(runId, editId);
    if (result) {
      if (result.ok) {
        out(
          `✓ edit accepted for step '${stepId}' — it applies when the step runs (resume with 'steamtrain workflow resume ${runId}')\n`,
        );
        return 0;
      }
      err(`✗ edit rejected: ${result.error}\n`);
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, EDIT_RESULT_POLL_MS));
  }
  out(
    `edit requested for step '${stepId}' — no response from the owning process yet; watch the run ('steamtrain workflow attach ${runId}') to confirm\n`,
  );
  return 0;
}

// ── workflow approve ─────────────────────────────────────────────────────────

/**
 * `steamtrain workflow approve <runId> [--step <stepId>] [--reject
 * [--on-reject fail|stop]] [--note <text>]` — decide a pending human-approval
 * checkpoint on a live (typically detached) run from the command line.
 */
export async function runApproveCommand(
  args: string[],
  cwd: string,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const usage =
    "usage: steamtrain workflow approve <runId> [--step <stepId>] [--reject [--on-reject fail|stop]] [--note <text>]\n";
  const runId = args[0];
  if (!runId || runId.startsWith("--")) {
    err(usage);
    return 1;
  }
  let stepId: string | undefined;
  let reject = false;
  let onReject: "fail" | "stop" | undefined;
  let note: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--step") {
      stepId = args[++i];
      if (!stepId || stepId.startsWith("--")) {
        err(usage);
        return 1;
      }
    } else if (arg === "--reject") {
      reject = true;
    } else if (arg === "--on-reject") {
      const value = args[++i];
      if (value !== "fail" && value !== "stop") {
        err(usage);
        return 1;
      }
      onReject = value;
    } else if (arg === "--note") {
      note = args[++i];
      if (note === undefined) {
        err(usage);
        return 1;
      }
    } else {
      err(usage);
      return 1;
    }
  }
  if (onReject && !reject) {
    err("--on-reject only applies with --reject\n");
    return 1;
  }

  const store = createLiveRunStore(join(cwd, WORKFLOW_RUNS_DIR));
  const meta = await store.get(runId);
  if (!meta || isTerminalLiveRunStatus(meta.status)) {
    err(`no active run '${runId}' (see 'steamtrain workflow runs')\n`);
    return 1;
  }
  const pending = meta.pendingApprovals ?? [];
  if (pending.length === 0) {
    err(`run '${runId}' has no pending approval checkpoints\n`);
    return 1;
  }
  let target = stepId ? matchPendingApproval(pending, stepId) : undefined;
  if (!stepId) {
    if (pending.length > 1) {
      err(
        `run '${runId}' has ${pending.length} pending checkpoints — pass --step <stepId>: ${pending
          .map((p) => p.stepId)
          .join(", ")}\n`,
      );
      return 1;
    }
    target = pending[0];
  }
  if (!target) {
    err(
      `no pending checkpoint '${stepId}' on run '${runId}' (pending: ${pending.map((p) => p.stepId).join(", ")})\n`,
    );
    return 1;
  }

  await store.writeApprovalDecision(runId, target.stepId, target.iteration, {
    approved: !reject,
    by: "human:cli",
    note,
    rejectDisposition: reject ? onReject : undefined,
  });
  out(
    `${reject ? "✗ rejected" : "✓ approved"} checkpoint '${target.stepId}' on run ${runId}; the run picks it up shortly\n`,
  );
  return 0;
}

// ── workflow answer ──────────────────────────────────────────────────────────

/**
 * `steamtrain workflow answer <runId> [--step <stepId>] [--value <text> |
 * --file <path>]` — answer a pending human-input request (a `human` step or an
 * agent's clarifying question) on a live (typically detached) run. With no
 * pending step named and exactly one pending, it targets that one; with no
 * value it prints what's being asked so the user can decide.
 */
export async function runAnswerCommand(
  args: string[],
  cwd: string,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const usage =
    "usage: steamtrain workflow answer <runId> [--step <stepId>] [--value <text> | --file <path>]\n";
  const runId = args[0];
  if (!runId || runId.startsWith("--")) {
    err(usage);
    return 1;
  }
  let stepId: string | undefined;
  let value: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--step") {
      stepId = args[++i];
      if (!stepId || stepId.startsWith("--")) {
        err(usage);
        return 1;
      }
    } else if (arg === "--value") {
      value = args[++i];
      if (value === undefined) {
        err(usage);
        return 1;
      }
    } else if (arg === "--file") {
      const path = args[++i];
      if (!path || path.startsWith("--")) {
        err(usage);
        return 1;
      }
      try {
        value = await readFile(path, "utf8");
      } catch (e) {
        err(`could not read --file '${path}': ${message(e)}\n`);
        return 1;
      }
    } else {
      err(usage);
      return 1;
    }
  }

  const store = createLiveRunStore(join(cwd, WORKFLOW_RUNS_DIR));
  const meta = await store.get(runId);
  if (!meta || isTerminalLiveRunStatus(meta.status)) {
    err(`no active run '${runId}' (see 'steamtrain workflow runs')\n`);
    return 1;
  }
  const pending = meta.pendingInputs ?? [];
  if (pending.length === 0) {
    err(`run '${runId}' has no pending human-input requests\n`);
    return 1;
  }
  let target = stepId ? matchPendingInput(pending, stepId) : undefined;
  if (!stepId) {
    if (pending.length > 1) {
      err(
        `run '${runId}' has ${pending.length} pending requests — pass --step <stepId>: ${pending
          .map((p) => p.stepId)
          .join(", ")}\n`,
      );
      return 1;
    }
    target = pending[0];
  }
  if (!target) {
    err(
      `no pending request '${stepId}' on run '${runId}' (pending: ${pending.map((p) => p.stepId).join(", ")})\n`,
    );
    return 1;
  }

  if (value === undefined) {
    // No value: show what's being asked, so `answer <runId>` doubles as "what
    // does this run want from me?".
    out(`run ${runId} is waiting on '${target.stepId}':\n`);
    if (target.prompt) out(`  ${target.prompt}\n`);
    if (target.choices?.length) {
      target.choices.forEach((choice, i) => out(`    ${i + 1}) ${choice}\n`));
    }
    out(
      `answer with: steamtrain workflow answer ${runId} --step ${target.stepId} --value <text>\n`,
    );
    return 1;
  }

  await store.writeHumanInputResponse(runId, target.stepId, target.iteration, target.attempt, {
    value,
    by: "human:cli",
  });
  out(`✎ answered '${target.stepId}' on run ${runId}; the run picks it up shortly\n`);
  return 0;
}

// ── workflow takeover ────────────────────────────────────────────────────────

/**
 * `steamtrain workflow takeover <runId> <stepId>` — drop into a recorded
 * step's agent session interactively, inside its still-live worktree. The
 * human finishes the job by hand with the agent's full context; on exit the
 * takeover is recorded in run history, and the worktree's final state flows
 * into the existing harvest machinery (`history show --diff` / `history
 * apply`).
 */
export async function runTakeoverCommand(
  config: SteamtrainConfig,
  args: string[],
  cwd: string,
  out: (text: string) => void,
  err: (text: string) => void,
  spawnFn: typeof spawn = spawn,
): Promise<number> {
  const runId = args[0];
  const stepId = args[1];
  if (!runId || runId.startsWith("--") || !stepId || stepId.startsWith("--") || args.length > 2) {
    err("usage: steamtrain workflow takeover <runId> <stepId>\n");
    return 1;
  }
  const historyStore = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));
  const record = await historyStore.get(runId);
  if (!record) {
    const liveStore = createLiveRunStore(join(cwd, WORKFLOW_RUNS_DIR));
    const live = await liveStore.get(runId);
    if (live && !isTerminalLiveRunStatus(live.status)) {
      err(
        `run '${runId}' is still ${live.status} — takeover targets finished runs; cancel it first ('steamtrain workflow cancel ${runId}') or wait for it to settle\n`,
      );
      return 1;
    }
    err(`unknown run '${runId}' (see 'steamtrain workflow history')\n`);
    return 1;
  }

  const planned = planTakeover(record, stepId, config);
  if (!planned.ok) {
    err(`${planned.error}\n`);
    return 1;
  }
  const { plan } = planned;
  for (const note of plan.notes) out(`note: ${note}\n`);
  out(
    `taking over step '${plan.stepId}' (${plan.agent})${plan.resumed ? " — resuming its recorded session" : ""}\n`,
  );
  out(`  workspace: ${plan.cwd}\n`);
  out(`  launching: ${formatTakeoverCommand(plan)}\n\n`);

  const startedAt = Date.now();
  const exitCode = await new Promise<number | undefined>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(plan.binary, plan.args, {
        cwd: plan.cwd,
        stdio: "inherit",
        env: { ...process.env, ...plan.env },
      });
    } catch (e) {
      err(`could not launch '${plan.binary}': ${message(e)}\n`);
      resolve(undefined);
      return;
    }
    child.once("error", (e) => {
      err(`could not launch '${plan.binary}': ${message(e)}\n`);
      resolve(undefined);
    });
    child.once("exit", (code) => resolve(code ?? undefined));
  });
  if (exitCode === undefined) return 1;

  await recordTakeover(historyStore, runId, {
    stepId: plan.stepId,
    sessionId: plan.sessionId,
    resumed: plan.resumed,
    by: "human:cli",
    startedAt,
    endedAt: Date.now(),
    exitCode,
  }).catch(() => false);

  out(`\ntakeover of '${plan.stepId}' ended (exit ${exitCode}); recorded in run history\n`);
  out(`  review what changed:  steamtrain workflow history show ${runId} --diff\n`);
  out(`  land the changes:     steamtrain workflow history apply ${runId}\n`);
  return exitCode === 0 ? 0 : exitCode;
}

// ── shared printing ──────────────────────────────────────────────────────────

/**
 * Persist a finished run to history and return the built record (for `--report`
 * rendering). A write failure only warns, never fails the run — the record is
 * still returned so a report can be produced even if history could not be saved.
 */
async function saveHistory(
  historyStore: WorkflowHistoryStore,
  recorder: RunRecordBuilder,
  status: RunRecordStatus,
  err: (text: string) => void,
  error?: string,
  timedOut?: boolean,
): Promise<RunRecord> {
  const record = recorder.build({ status, error, timedOut });
  try {
    await historyStore.save(record);
  } catch (e) {
    err(`warning: could not record run history: ${message(e)}\n`);
  }
  return record;
}

/**
 * Whether the last text written through each `out` stopped mid-line. Agent
 * text streams in raw deltas, so the next status line must start fresh or it
 * lands on the end of the agent's last sentence ("noted  done s1").
 */
const midLine = new WeakMap<(text: string) => void, boolean>();

export function printHumanEvent(
  event: WorkflowEvent,
  out: (text: string) => void,
  run: { canceled?: boolean; timedOut?: boolean } = {},
): void {
  if (event.kind === "step_event") {
    if (event.event.kind === "text_delta" && !event.event.thinking && event.event.text) {
      out(event.event.text);
      midLine.set(out, !event.event.text.endsWith("\n"));
    }
    return;
  }
  if (midLine.get(out)) {
    out("\n");
    midLine.set(out, false);
  }
  switch (event.kind) {
    case "workflow_start":
      out(
        `workflow ${event.name} started (${event.phaseCount} phases, ${event.stepCount} steps)\n`,
      );
      return;
    case "phase_start":
      out(`\nphase ${event.index + 1}: ${event.title}\n`);
      return;
    case "step_start": {
      // The profile is part of the step's identity in a log: a CI reader must be
      // able to see that the review step ran locked down, not infer it.
      const sandbox = event.permissions ? ` [${event.permissions.profile}]` : "";
      out(`  start ${event.blockKind ?? "worker"} ${event.stepId}${sandbox}\n`);
      return;
    }
    case "step_workspace":
      out(
        event.worktree
          ? `  workspace ${event.stepId}: ${event.cwd} (worktree ${event.worktree.branch})\n`
          : `  workspace ${event.stepId}: ${event.cwd}\n`,
      );
      return;
    case "fan_out":
      out(
        `  fan-out ${event.parentStepId} -> ${event.count} item${event.count === 1 ? "" : "s"}\n`,
      );
      return;
    case "gate_evaluated":
      out(
        `  gate ${event.stepId}: ${event.passed ? "passed" : "blocked"}${
          event.target ? ` -> ${event.target}` : ""
        }\n`,
      );
      return;
    case "approval_pending": {
      const review = event.reviewStepId ? ` (reviewing ${event.reviewStepId})` : "";
      out(`  ⏳ approval ${event.stepId}${review} — awaiting decision\n`);
      if (event.message) out(`     ${event.message}\n`);
      return;
    }
    case "approval_resolved": {
      const who = event.by ? ` by ${event.by}` : "";
      const note = event.note ? ` — ${event.note}` : "";
      out(`  ${event.approved ? "✓ approved" : "✗ rejected"} ${event.stepId}${who}${note}\n`);
      return;
    }
    case "human_input_pending": {
      const kindLabel = event.origin === "agent-question" ? "agent question" : "input needed";
      const retry = event.attempt > 1 ? ` (attempt ${event.attempt})` : "";
      out(`  ✎ ${kindLabel} ${event.stepId}${retry} — awaiting answer\n`);
      if (event.retryError) out(`     previous answer rejected: ${event.retryError}\n`);
      out(`     ${truncateLine(event.prompt.split("\n")[0] ?? "", 160)}\n`);
      if (event.choices?.length) {
        event.choices.forEach((choice, i) => out(`       ${i + 1}) ${choice}\n`));
      }
      return;
    }
    case "human_input_resolved": {
      const who = event.by ? ` by ${event.by}` : "";
      if (event.canceled) {
        out(`  ✎ ${event.stepId} input canceled${who}\n`);
      } else {
        out(
          `  ✎ ${event.stepId} answered${who}: ${truncateLine(event.value?.split("\n")[0] ?? "", 120)}\n`,
        );
      }
      return;
    }
    case "step_done": {
      out(
        `  ${event.result.ok ? "done" : event.result.interrupted ? "stop" : "fail"} ${event.stepId}${
          event.cached ? " (cached)" : ""
        }\n`,
      );
      // Say why, unless the step only stopped because the run was canceled.
      const why =
        event.result.ok || event.result.interrupted || run.canceled || run.timedOut
          ? undefined
          : event.result.error?.trim();
      if (why) out(`     ${why.split("\n", 1)[0]}\n`);
      const violations = event.result.permissions?.violations;
      if (violations?.length) {
        out(
          `     🔓 permission violation: modified ${violations.length} path(s) — ${violations.slice(0, 6).join(", ")}\n`,
        );
      }
      return;
    }
    case "phase_done":
      out(`phase ${event.phaseId} ${event.ok ? "ok" : "failed"}\n`);
      return;
    case "budget_exceeded": {
      const where = event.scope === "step" && event.stepId ? `step '${event.stepId}'` : "workflow";
      out(
        `\n  ⚠ ${where} cost budget ${formatUsd(event.limitUsd)} reached (spent ${formatUsd(event.spentUsd)}) — stopping new steps; resume after raising the cap\n`,
      );
      return;
    }
    case "run_paused":
      out(
        `\n  ⏸ run paused${event.by ? ` by ${event.by}` : ""} — in-flight steps finish, nothing new starts (edit pending steps with 'workflow edit-step', continue with 'workflow resume')\n`,
      );
      return;
    case "run_resumed":
      out(`  ▶ run resumed${event.by ? ` by ${event.by}` : ""}\n`);
      return;
    case "step_edited": {
      const fields = Object.keys(event.patch).join(", ");
      out(`  ✎ step ${event.stepId} edited (${fields})${event.by ? ` by ${event.by}` : ""}\n`);
      return;
    }
    case "workflow_done":
      out(
        `\nworkflow ${
          run.timedOut
            ? "timed out"
            : run.canceled
              ? "canceled"
              : event.budgetExceeded
                ? "budget-exceeded"
                : event.ok
                  ? "done"
                  : "failed"
        }\n`,
      );
      return;
  }
}

/**
 * A compact, end-of-run report: per-step status (with data-flow source for
 * fan-out children), duration, cache/cost, and roll-up totals. This is the CLI
 * analog of the TUI's live status header.
 */
export function printRunSummary(
  results: StepResult[],
  out: (text: string) => void,
  stepMeta?: Map<string, { agent?: string; api?: string; model?: string }>,
): void {
  if (results.length === 0) return;
  out("\nsummary\n");
  let okCount = 0;
  let failCount = 0;
  // Taken down by the run's cancel or timeout: stopped, not broken.
  let interruptedCount = 0;
  let totalCost = 0;
  let totalMs = 0;
  for (const result of results) {
    if (result.childResults?.length) continue; // children are listed individually
    const status = result.ok ? "ok  " : result.interrupted ? "stop" : "fail";
    if (result.ok) okCount += 1;
    else if (result.interrupted) interruptedCount += 1;
    else failCount += 1;
    const cost = result.costUsd ?? 0;
    totalCost += cost;
    totalMs += result.durationMs;
    const bits = [`${(result.durationMs / 1000).toFixed(1)}s`];
    if (result.skipped) bits.push("skipped");
    if (cost > 0) bits.push(`$${cost.toFixed(4)}`);
    const tokenLine = formatTokenSummary(result.tokens);
    if (tokenLine) bits.push(tokenLine);
    if (result.gate) bits.push(result.gate.passed ? "gate:passed" : "gate:blocked");
    const from = result.item ? ` (item ${result.item.index})` : "";
    out(`  ${status} ${result.stepId}${from}  ${bits.join(" · ")}\n`);
  }
  const grandTokens = tokensForResults(results);
  const totals = [
    `${okCount} ok`,
    failCount > 0 ? `${failCount} failed` : undefined,
    interruptedCount > 0 ? `${interruptedCount} interrupted` : undefined,
    totalCost > 0 ? `$${totalCost.toFixed(4)}` : undefined,
    totalTokens(grandTokens) > 0 ? `${formatTokens(totalTokens(grandTokens))} tok` : undefined,
    `${(totalMs / 1000).toFixed(1)}s total`,
  ].filter(Boolean);
  out(`  ── ${totals.join(" · ")}\n`);

  // Per-model breakdown — "which model is eating the budget?".
  if (stepMeta) {
    const byModel = aggregateLeavesByModel(resultLeaves(results, stepMeta));
    printModelBreakdown(byModel, out);
  }
}

/** Render the per-model cost/token breakdown shared by the run summary and history show. */
export function printModelBreakdown(byModel: ModelUsage[], out: (text: string) => void): void {
  const models = byModel.filter((m) => m.costUsd > 0 || totalTokens(m.tokens) > 0);
  if (models.length === 0) return;
  out("  by model\n");
  for (const m of models) {
    const bits = [`${m.steps} step${m.steps === 1 ? "" : "s"}`];
    if (m.costUsd > 0) bits.push(formatUsd(m.costUsd));
    const tokenLine = formatTokenSummary(m.tokens);
    if (tokenLine) bits.push(tokenLine);
    out(`    ${m.model}  ${bits.join(" · ")}\n`);
  }
}

/**
 * Whether a workflow contains any human-approval checkpoint (approval step or
 * human gate), recursing into named sub-workflows so a checkpoint nested inside
 * a `kind: "workflow"` call still triggers the headless advisory. `resolve`
 * looks up a child spec by name (the orchestrator catalog); `seen` guards
 * against workflows that reference each other cyclically.
 */
export function specHasApprovalCheckpoints(
  spec: WorkflowSpec,
  resolve?: (name: string) => WorkflowSpec | undefined,
  seen: Set<string> = new Set(),
): boolean {
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      if (step.kind === "approval") return true;
      if (step.kind === "gate" && step.condition.human === true) return true;
      if (step.kind === "workflow" && resolve && !seen.has(step.workflow)) {
        seen.add(step.workflow);
        const child = resolve(step.workflow);
        if (child && specHasApprovalCheckpoints(child, resolve, seen)) return true;
      }
    }
  }
  return false;
}
