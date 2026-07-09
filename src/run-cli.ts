import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openSync } from "node:fs";
import { join } from "node:path";
import { refreshAgentCatalogCaches } from "./agents/models";
import type { CliIO } from "./cli";
import { message, readAll, truncateLine } from "./cli-util";
import type { SteamtrainConfig } from "./config";
import { runDoctor } from "./doctor";
import type { Orchestrator } from "./orchestrator";
import {
  type ApprovalProvider,
  type LiveRunMeta,
  type LiveRunSource,
  type ModelUsage,
  type RerunMode,
  RunRecordBuilder,
  type RunRecordStatus,
  type StepResult,
  WORKFLOW_CACHE_DIR,
  WORKFLOW_HISTORY_DIR,
  WORKFLOW_RUNS_DIR,
  type WorkflowEvent,
  type WorkflowHistoryStore,
  type WorkflowSpec,
  acquireRunSlot,
  aggregateLeavesByModel,
  createLiveRunPublisher,
  createLiveRunStore,
  createWorkflowCacheStore,
  createWorkflowHistoryStore,
  formatTokenSummary,
  formatTokens,
  formatUsd,
  hashWorkflowSpec,
  headlessApprovalProvider,
  isRerunError,
  isTerminalLiveRunStatus,
  lintTemplateRefs,
  newLiveRunMeta,
  persistWorkflowStepDone,
  planRerun,
  rerunDowngradeMessage,
  resolveInputs,
  resolveMaxParallelRuns,
  resolveWorkflowTimeoutSec,
  resultLeaves,
  stepMetaFromSpec,
  storeApprovalProvider,
  timeoutMsFromSec,
  tokensForResults,
  totalTokens,
  watchRunCancel,
  workflowAgentIds,
  workflowCacheKey,
  workflowLlmSteps,
} from "./workflow";

/**
 * The `workflow run / attach / runs / cancel / approve` CLI drivers, plus the
 * hidden `_detached-runner` entry a `--detach` launch re-execs into. Extracted
 * from `cli.ts` so the run machinery (queue, live-run mirroring, detach) lives
 * in one place.
 */

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
  /** `--detach`: run under a background process; attach later from any UI. */
  detach: boolean;
}

export function parseRunOptions(args: string[]): RunOptions | null {
  const options: RunOptions = {
    stdin: false,
    json: false,
    fresh: false,
    retryFailed: false,
    params: {},
    approveAll: false,
    detach: false,
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
    } else if (arg === "--approve-all") {
      options.approveAll = true;
    } else if (arg === "--on-approval") {
      const value = args[i + 1];
      if (value !== "fail" && value !== "stop") return null;
      options.onApproval = value;
      i += 1;
    } else {
      return null;
    }
  }
  // `--approve-all` and `--on-approval` are mutually exclusive intents.
  if (options.approveAll && options.onApproval) return null;
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
      `usage: steamtrain workflow run <name> --input <text> [--param key=value ...] [--json] [--fresh] [--detach] [--approve-all | --on-approval fail|stop]
       steamtrain workflow run --from <runId> [--retry-failed] [--json] [--detach]
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

  if (options.retryFailed && !options.from) {
    err("--retry-failed only applies with --from <runId>\n");
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
      err(`note: ${rerunDowngradeMessage(plan.downgraded)}\n`);
    }
    // An explicit --fresh forces a clean run and ignores any seed.
    forceFresh = options.fresh || mode === "rerun" || Boolean(plan.downgraded);
    seed = forceFresh ? undefined : plan.seedCache;
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

  const spec = orchestrator.listWorkflows()[name];
  if (!spec) {
    err(`unknown workflow '${name}'\n`);
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
  if (usesAgents || workflowLlmSteps(spec).length > 0) {
    const check = orchestrator.canDispatchWorkflow(name);
    if (!check.ok) {
      err(`cannot run '${name}': ${check.reason}\n`);
      return 1;
    }
  }

  const trimmedInput = input.trim();
  const params = Object.keys(resolved.values).length > 0 ? resolved.values : undefined;

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
  if (
    !options.approveAll &&
    !options.onApproval &&
    specHasApprovalCheckpoints(spec, (childName) => workflowCatalog[childName])
  ) {
    err(
      "note: this workflow has approval checkpoints; with no --approve-all / --on-approval they auto-reject and stop the run (or use --detach, which waits for a decision from any attached UI)\n",
    );
  }

  // Wire cancellation so Ctrl+C unwinds the run and records it as "canceled"
  // (matching the TUI and web drivers) instead of hard-killing the process
  // before history is written. A second Ctrl+C force-exits.
  return driveWorkflowRun({
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
      process.on("SIGINT", onSigint);
      return () => process.removeListener("SIGINT", onSigint);
    },
  });
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

  // Bake cache prep into the store now so the child can simply load it: an
  // explicit --fresh clears, a --from retry seeds the already-succeeded steps.
  const cacheStore = createWorkflowCacheStore(join(cwd, WORKFLOW_CACHE_DIR));
  const key = workflowCacheKey(options.name, options.input, cwd, options.spec, options.params);
  if (options.forceFresh) await cacheStore.clear(key);
  if (options.seed && options.seed.size > 0 && !options.forceFresh) {
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
        fresh: false,
        approveAll: options.approveAll || undefined,
        onApproval: options.onApproval,
      },
    }),
  );

  const logFd = openSync(join(store.rootDir, sanitizeRunDirName(runId), "runner.log"), "a");
  const childArgs = [
    script,
    ...(options.io.configPath ? ["--config-file", options.io.configPath] : []),
    ...(options.io.workspacePath ? ["--workspace", options.io.workspacePath] : []),
    "workflow",
    "_detached-runner",
    runId,
  ];
  const child = spawn(process.execPath, childArgs, {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();

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

/** Mirrors the live-run store's id sanitization (for the runner.log path). */
function sanitizeRunDirName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
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
  const spec = orchestrator.listWorkflows()[launch.workflow];
  if (!spec) return failEarly(`unknown workflow '${launch.workflow}'`);

  const usesAgents = workflowAgentIds(spec).length > 0;
  if (usesAgents) {
    const doctor = await runDoctor(config);
    orchestrator.setDoctor(doctor);
    await refreshAgentCatalogCaches(config, doctor);
  }
  if (usesAgents || workflowLlmSteps(spec).length > 0) {
    const check = orchestrator.canDispatchWorkflow(launch.workflow);
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

  return driveWorkflowRun({
    orchestrator,
    config,
    name: launch.workflow,
    spec,
    input: launch.input,
    params: launch.params,
    cwd,
    runId,
    fresh: Boolean(launch.fresh),
    source: "cli-detached",
    detached: true,
    registerLiveRun: false,
    approval,
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
  source: LiveRunSource;
  detached: boolean;
  /** Create the live-run entry here (foreground); detached parents pre-create it. */
  registerLiveRun: boolean;
  approval: ApprovalProvider;
  json: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Wire process signals to `abort`; returns a dispose fn. */
  installSignalHandlers: (abort: () => void) => () => void;
}

/**
 * Drive one workflow run end-to-end for the CLI (foreground or detached
 * runner): register in the live-run store, wait for a queue slot, prep the
 * cache, stream events (printing + mirroring to the store), and settle
 * history + terminal meta. Returns the process exit code.
 */
async function driveWorkflowRun(options: DriveWorkflowRunOptions): Promise<number> {
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

  const recorder = new RunRecordBuilder({
    id: runId,
    workflow: name,
    input,
    cwd,
    specHash: hashWorkflowSpec(spec),
    params,
  });

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
    await store.update(runId, { status: "canceled", ok: false, endedAt: Date.now() });
    await saveHistory(historyStore, recorder, "canceled", err);
    err("run canceled while queued\n");
    return 130;
  }

  const key = workflowCacheKey(name, input, cwd, spec, params);
  const cache = new Map<string, StepResult>();
  if (options.fresh) {
    await cacheStore.clear(key);
  } else {
    const loaded = await cacheStore.load(key);
    for (const [stepId, result] of loaded) cache.set(stepId, result);
  }
  if (options.seed && options.seed.size > 0) {
    // Seed the already-succeeded steps and make them the resume baseline so an
    // interrupted retry can pick up from here too.
    for (const [stepId, result] of options.seed) cache.set(stepId, result);
    await cacheStore.save(key, cache);
  }

  // Enforce whole-workflow wall-clock timeout (clock starts once executing).
  const workflowTimeoutMs = timeoutMsFromSec(resolveWorkflowTimeoutSec(spec, config));
  const timeoutTimer =
    workflowTimeoutMs > 0 ? setTimeout(() => ac.abort(), workflowTimeoutMs) : undefined;
  timeoutTimer?.unref?.();

  const publisher = createLiveRunPublisher(store, runId);
  let ok = false;
  let budgetExceeded = false;
  try {
    for await (const event of orchestrator.runWorkflow(
      name,
      input,
      ac.signal,
      cache,
      cwd,
      undefined,
      params,
      options.approval,
    )) {
      recorder.handle(event);
      publisher.event(event);
      if (options.json) out(`${JSON.stringify(event)}\n`);
      else printHumanEvent(event, out);
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
    await publisher.finish(status, { ok: status === "done" });
    await saveHistory(historyStore, recorder, status, err);
    return status === "canceled" ? 130 : ok ? 0 : 1;
  } catch (runErr) {
    const status: RunRecordStatus = ac.signal.aborted ? "canceled" : "error";
    const error = status === "error" ? message(runErr) : undefined;
    await publisher.finish(status, { ok: false, error });
    await saveHistory(historyStore, recorder, status, err, error);
    if (status === "canceled") return 130;
    throw runErr;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    disposeSignals();
    disposeCancelWatch();
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
  }

  const ac = new AbortController();
  let detached = false;
  const onSigint = (): void => {
    detached = true;
    ac.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    for await (const event of store.tailEvents(runId, { signal: ac.signal })) {
      if (json) out(`${JSON.stringify(event)}\n`);
      else printHumanEvent(event, out);
      if (!json && event.kind === "approval_pending") {
        out(`     decide with: steamtrain workflow approve ${runId} --step ${event.stepId}\n`);
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
  if (json) {
    out(
      `${JSON.stringify({ type: "status", status: final.status, ok: final.ok, error: final.error })}\n`,
    );
  } else {
    out(`\nrun ${final.status}${final.error ? `: ${final.error}` : ""}\n`);
  }
  if (final.status === "canceled") return 130;
  return final.status === "done" && final.ok !== false ? 0 : 1;
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
    run.pendingApprovals?.length
      ? `⏳ approval: ${run.pendingApprovals.map((p) => p.stepId).join(", ")}`
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
      if (!stepId) {
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
  let target = stepId
    ? pending.find((p) => p.stepId === stepId || p.stepId.endsWith(`::${stepId}`))
    : undefined;
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

// ── shared printing ──────────────────────────────────────────────────────────

/** Persist a finished run to history; a write failure only warns, never fails the run. */
async function saveHistory(
  historyStore: WorkflowHistoryStore,
  recorder: RunRecordBuilder,
  status: RunRecordStatus,
  err: (text: string) => void,
  error?: string,
): Promise<void> {
  try {
    await historyStore.save(recorder.build({ status, error }));
  } catch (e) {
    err(`warning: could not record run history: ${message(e)}\n`);
  }
}

export function printHumanEvent(event: WorkflowEvent, out: (text: string) => void): void {
  switch (event.kind) {
    case "workflow_start":
      out(
        `workflow ${event.name} started (${event.phaseCount} phases, ${event.stepCount} steps)\n`,
      );
      return;
    case "phase_start":
      out(`\nphase ${event.index + 1}: ${event.title}\n`);
      return;
    case "step_start":
      out(`  start ${event.blockKind ?? "worker"} ${event.stepId}\n`);
      return;
    case "fan_out":
      out(
        `  fan-out ${event.parentStepId} -> ${event.count} item${event.count === 1 ? "" : "s"}\n`,
      );
      return;
    case "step_event":
      if (event.event.kind === "text_delta" && !event.event.thinking) out(event.event.text);
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
    case "step_done":
      out(
        `  ${event.result.ok ? "done" : "fail"} ${event.stepId}${event.cached ? " (cached)" : ""}\n`,
      );
      return;
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
    case "workflow_done":
      out(
        `\nworkflow ${event.budgetExceeded ? "budget-exceeded" : event.ok ? "done" : "failed"}\n`,
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
  let totalCost = 0;
  let totalMs = 0;
  for (const result of results) {
    if (result.childResults?.length) continue; // children are listed individually
    const status = result.ok ? "ok  " : "fail";
    if (result.ok) okCount += 1;
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
