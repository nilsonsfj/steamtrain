import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { createAdapter } from "./agents";
import { message, readAll, truncateLine } from "./cli-util";
import {
  type SteamtrainConfig,
  configDisplayLabel,
  loadConfig,
  saveProjectWorkflow,
} from "./config";
import { runInitCommand } from "./init";
import { Orchestrator } from "./orchestrator";
import {
  printModelBreakdown,
  runApproveCommand,
  runAttachCommand,
  runCancelCommand,
  runDetachedRunner,
  runRunsCommand,
  runWorkflowCommand,
} from "./run-cli";
import { loadSettings } from "./settings";
import type { AgentInstanceId } from "./types/events";
import {
  DEFAULT_MAX_PARALLEL_RUNS,
  type HarvestResult,
  MergeConflictError,
  type ModelUsage,
  type RunRecord,
  type RunRecordSummary,
  WORKFLOW_CACHE_DIR,
  WORKFLOW_HISTORY_DIR,
  type WorkflowSpec,
  type WorktreeDiff,
  type WorktreeSource,
  aggregateCosts,
  createWorkflowCacheStore,
  createWorkflowHistoryStore,
  formatRunTotals,
  formatTokenSummary,
  formatTokens,
  formatUsd,
  generateWorkflow,
  harvestWorktrees,
  modelBreakdownForRecord,
  planWorkflow,
  pruneWorktree,
  resolveInputs,
  resolveStepTimeoutSec,
  saveUserWorkflow,
  totalTokens,
  validateWorkflow,
  workflowCacheKey,
  workflowStepKind,
  worktreeDiff,
  worktreeSourceFromInfo,
} from "./workflow";
import { loadWorkflowCatalog, workflowCatalogEntries } from "./workflow";
import { loadWorkspaceConfig } from "./workspace";

export interface GlobalCliOptions {
  args: string[];
  workspacePath?: string;
  configPath?: string;
  /** Launch the browser-based UI instead of the TUI. */
  webUi?: boolean;
  port?: number;
  host?: string;
  /** Require this token to access the web UI (sets a cookie-based session). */
  authToken?: string;
  /** Print the version and exit. */
  version?: boolean;
  error?: string;
}

/** Strip global flags (e.g. `-w`, `--web-ui`) before dispatching subcommands or the TUI. */
export function parseGlobalArgs(args: string[]): GlobalCliOptions {
  const rest: string[] = [];
  let workspacePath: string | undefined;
  let configPath: string | undefined;
  let webUi = false;
  let port: number | undefined;
  let host: string | undefined;
  let authToken: string | undefined;
  let version = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-v" || arg === "--version") {
      version = true;
      continue;
    }
    if (arg === "-w" || arg === "--workspace") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        return { args: [], error: `${arg} requires a path argument` };
      }
      workspacePath = value;
      i += 1;
      continue;
    }
    if (arg === "--config-file") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        return { args: [], error: `${arg} requires a path argument` };
      }
      configPath = value;
      i += 1;
      continue;
    }
    if (arg === "--web-ui" || arg === "--web") {
      webUi = true;
      continue;
    }
    if (arg === "--port") {
      const value = args[i + 1];
      const parsed = value ? Number(value) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        return { args: [], error: "--port requires an integer 0-65535" };
      }
      port = parsed;
      i += 1;
      continue;
    }
    if (arg === "--host") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        return { args: [], error: "--host requires a value" };
      }
      host = value;
      i += 1;
      continue;
    }
    if (arg === "--auth-token") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        return { args: [], error: "--auth-token requires a value" };
      }
      authToken = value;
      i += 1;
      continue;
    }
    rest.push(arg);
  }
  return {
    args: rest,
    workspacePath,
    configPath,
    webUi: webUi || undefined,
    port,
    host,
    authToken,
    version: version || undefined,
  };
}

export interface CliIO {
  cwd?: string;
  workspacePath?: string;
  configPath?: string;
  stdin?: Readable;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function runCli(args: string[], io: CliIO = {}): Promise<number> {
  const out = io.stdout ?? ((text: string) => process.stdout.write(text));
  const err = io.stderr ?? ((text: string) => process.stderr.write(text));
  const [scope, command, ...rest] = normalizeArgs(args);

  if (!scope || scope === "help" || scope === "--help" || scope === "-h") {
    out(helpText());
    return 0;
  }

  if (scope === "init") {
    return runInitCommand(command === undefined ? [] : [command, ...rest], io);
  }

  if (scope !== "workflow") {
    err(`unknown command '${scope}'\n\n${helpText()}`);
    return 1;
  }

  const cwd = io.cwd ?? process.cwd();
  const {
    config,
    scope: configScope,
    user: userConfig,
    warning,
  } = loadConfig({ cwd, customPath: io.configPath });
  if (warning) err(`${warning}\n`);
  const { hasUserFile: hasUserSettings } = loadSettings();
  const configLabel = configDisplayLabel(configScope, {
    hasUserSettings,
    hasUserConfig: userConfig?.exists,
  });
  const { config: workspaces, warning: workspaceWarning } = loadWorkspaceConfig({
    cwd,
    customPath: io.workspacePath,
  });
  if (workspaceWarning) err(`${workspaceWarning}\n`);
  const workflowCatalog = loadWorkflowCatalog({
    home: homedir(),
    projectWorkflows: config.workflows,
  });
  if (workflowCatalog.warning) err(`${workflowCatalog.warning}\n`);
  const orchestrator = new Orchestrator(config, workspaces, [], workflowCatalog);

  switch (command ?? "list") {
    case "list":
    case "ls":
      printWorkflowList(workflowCatalogEntries(workflowCatalog), configLabel, out);
      return 0;
    case "validate":
      return validateWorkflows(orchestrator.listWorkflows(), rest[0], out, err);
    case "plan":
    case "dry-run":
      return planCommand(orchestrator, rest, io, out, err);
    case "cache":
      return runCacheCommand(rest, cwd, io, orchestrator, out, err);
    case "history":
      return runHistoryCommand(rest, cwd, out, err);
    case "costs":
    case "cost":
      return runCostsCommand(rest, cwd, out, err);
    case "run":
      return runWorkflowCommand(orchestrator, config, rest, io, out, err);
    case "attach":
      return runAttachCommand(rest, cwd, out, err);
    case "runs":
    case "ps":
      return runRunsCommand(rest, cwd, out, err);
    case "cancel":
      return runCancelCommand(rest, cwd, out, err);
    case "approve":
      return runApproveCommand(rest, cwd, out, err);
    // Hidden: the re-exec target a `workflow run --detach` child starts as.
    case "_detached-runner":
      return runDetachedRunner(orchestrator, config, rest[0], io, out, err);
    case "create":
    case "new":
      return runWorkflowCreateCommand(config, rest, io, out, err, configScope.path);
    default:
      err(`unknown workflow command '${command}'\n\n${helpText()}`);
      return 1;
  }
}

function normalizeArgs(args: string[]): string[] {
  if (args[0] === "workflows") return ["workflow", "list", ...args.slice(1)];
  return args;
}

function printWorkflowList(
  workflows: { name: string; spec: WorkflowSpec; source: string }[],
  source: string,
  out: (text: string) => void,
): void {
  out(`workflows (${source})\n`);
  for (const { name, spec, source: workflowSource } of workflows) {
    out(`- ${name} [${workflowSource}]  ${workflowSummary(spec)}\n`);
    if (spec.description) out(`  ${spec.description}\n`);
  }
}

function validateWorkflows(
  workflows: Record<string, WorkflowSpec>,
  name: string | undefined,
  out: (text: string) => void,
  err: (text: string) => void,
): number {
  const entries = name ? [[name, workflows[name]] as const] : Object.entries(workflows);
  let ok = true;

  for (const [workflowName, spec] of entries) {
    if (!spec) {
      err(`unknown workflow '${workflowName}'\n`);
      return 1;
    }
    const result = validateWorkflow(spec);
    if (result.ok) {
      out(`ok  ${workflowName}\n`);
      if (result.warnings) {
        for (const w of result.warnings) out(`    warn: ${w}\n`);
      }
    } else {
      ok = false;
      err(`bad ${workflowName}: ${result.error}\n`);
    }
  }

  return ok ? 0 : 1;
}

// ── workflow plan (dry-run) ──────────────────────────────────────────────────

interface PlanOptions {
  input?: string;
  stdin: boolean;
  params: Record<string, string>;
  json: boolean;
}

function parsePlanOptions(args: string[]): PlanOptions | null {
  const options: PlanOptions = { stdin: false, json: false, params: {} };
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
    } else if (arg === "--stdin") {
      options.stdin = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      return null;
    }
  }
  return options;
}

async function planCommand(
  orchestrator: Orchestrator,
  args: string[],
  io: CliIO,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const name = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const options = parsePlanOptions(name ? args.slice(1) : args);
  if (!options || !name) {
    err(
      `usage: steamtrain workflow plan <name> --input <text> [--param key=value ...] [--json]
       steamtrain workflow plan <name> --stdin [--param key=value ...] [--json]
`,
    );
    return 1;
  }

  const input =
    options.input ?? (options.stdin ? await readAll(io.stdin ?? process.stdin) : undefined);
  if (!input?.trim()) {
    err("workflow plan requires --input <text> or --stdin\n");
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

  const plan = planWorkflow(spec, input.trim(), resolved.values);

  if (options.json) {
    out(`${JSON.stringify(plan, null, 2)}\n`);
    return plan.ok ? 0 : 1;
  }

  if (!plan.ok) {
    err(`plan failed: ${plan.error}\n`);
    return 1;
  }

  // Print warnings.
  if (plan.warnings) {
    for (const w of plan.warnings) out(`warn: ${w}\n`);
    if (plan.warnings.length > 0) out("\n");
  }

  // Summary line.
  out(`plan: ${name}\n`);
  out(
    `  ${plan.phaseCount} phase${plan.phaseCount === 1 ? "" : "s"} · ${plan.staticStepCount} step${plan.staticStepCount === 1 ? "" : "s"}\n`,
  );
  out(
    `  ${plan.agentCallCount} agent call${plan.agentCallCount === 1 ? "" : "s"} · ${plan.llmCallCount} llm call${plan.llmCallCount === 1 ? "" : "s"} · ${plan.deterministicCount} deterministic step${plan.deterministicCount === 1 ? "" : "s"}\n`,
  );
  if (plan.agents.length > 0) out(`  agents: ${plan.agents.join(", ")}\n`);
  if (plan.apis.length > 0) out(`  apis: ${plan.apis.join(", ")}\n`);
  if (plan.maxCostUsd !== undefined) out(`  budget: $${plan.maxCostUsd.toFixed(2)}\n`);

  // forEach expansion.
  for (const fe of plan.forEachSteps) {
    out(`  fan-out: ${fe.stepId} → ${fe.source} (${fe.count} items)\n`);
  }
  for (const fe of plan.forEachDynamicSteps) {
    out(`  fan-out: ${fe.stepId} → ${fe.source} (dynamic, items resolved at runtime)\n`);
  }

  // Loop gates.
  for (const lg of plan.loopGates) {
    out(`  loop: ${lg.gateId} → ${lg.loopTo} (max ${lg.maxIterations} iterations)\n`);
  }

  // Sub-workflows.
  for (const ws of plan.workflowSteps) {
    out(`  sub-workflow: ${ws.stepId} → ${ws.workflow}\n`);
  }

  // Step table.
  out("\n");
  out("  steps:\n");
  for (const step of plan.steps) {
    const tags: string[] = [];
    if (step.isAgentBacked) {
      tags.push(step.model ? `${step.agent}/${step.model}` : (step.agent ?? "agent"));
    }
    if (step.kind === "llm") {
      tags.push(step.model ? `${step.llmApi ?? "llm"}/${step.model}` : (step.llmApi ?? "llm"));
    }
    if (step.isDeterministic) tags.push("deterministic");
    if (step.forEachSource) tags.push(`forEach→${step.forEachSource}`);
    if (step.loopTo) tags.push(`loopTo→${step.loopTo}`);
    if (step.whenCondition) tags.push(`when: ${step.whenCondition}`);
    if (step.gateCondition) tags.push(`gate: ${step.gateCondition}`);
    if (step.workflowName) tags.push(`workflow: ${step.workflowName}`);
    if (step.mergeMode) tags.push(`merge: ${step.mergeMode}`);
    if (step.workspaceSource) tags.push(`inherit: ${step.workspaceSource}`);
    if (step.artifacts) tags.push(`artifacts: ${step.artifacts.join(", ")}`);

    const tagStr = tags.length > 0 ? `  (${tags.join("; ")})` : "";
    out(`    ${step.stepId} [${step.kind}]${tagStr}\n`);

    if (step.renderedPrompt) {
      const lines = step.renderedPrompt.split("\n");
      const preview = lines.slice(0, 3).join("\n    ");
      out(`      prompt: ${preview}${lines.length > 3 ? " ..." : ""}\n`);
    }
  }

  return 0;
}

async function runCacheCommand(
  args: string[],
  cwd: string,
  io: CliIO,
  orchestrator: Orchestrator,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const sub = args[0];
  if (sub !== "clear") {
    err(`unknown workflow cache command '${sub ?? ""}'\n\n${helpText()}`);
    return 1;
  }

  const store = createWorkflowCacheStore(join(cwd, WORKFLOW_CACHE_DIR));
  const options = parseCacheClearOptions(args.slice(1));
  if (!options) {
    err(
      "usage: steamtrain workflow cache clear [--input <text> [--param key=value ...] | --stdin] [<workflow>]\n",
    );
    return 1;
  }

  if (!options.workflow) {
    await store.clearAll();
    out(`cleared all workflow caches in ${store.rootDir}\n`);
    return 0;
  }

  const spec = orchestrator.listWorkflows()[options.workflow];
  if (!spec) {
    err(`unknown workflow '${options.workflow}'\n`);
    return 1;
  }

  const resolved = resolveInputs(spec, options.params);
  if (resolved.errors.length > 0) {
    for (const e of resolved.errors) err(`input error: ${e}\n`);
    return 1;
  }

  const input =
    options.input ?? (options.stdin ? await readAll(io.stdin ?? process.stdin) : undefined);
  if (!input?.trim()) {
    err("workflow cache clear <name> requires --input <text> or --stdin\n");
    return 1;
  }

  const key = workflowCacheKey(options.workflow, input.trim(), cwd, spec, resolved.values);
  await store.clear(key);
  out(`cleared cache for workflow '${options.workflow}'\n`);
  return 0;
}

async function runHistoryCommand(
  args: string[],
  cwd: string,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const store = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));
  const sub = args[0] ?? "list";

  if (sub === "list" || sub === "ls") {
    const runs = await store.list();
    if (runs.length === 0) {
      out("no recorded runs\n");
      return 0;
    }
    out(`run history (${runs.length})\n`);
    for (const run of runs) printHistoryRow(run, out);
    return 0;
  }

  if (sub === "show") {
    const id = args[1];
    if (!id) {
      err("usage: steamtrain workflow history show <id> [--diff [--step <stepId>] [--stat]]\n");
      return 1;
    }
    const record = await store.get(id);
    if (!record) {
      err(`unknown run '${id}'\n`);
      return 1;
    }
    const flags = args.slice(2);
    if (flags.includes("--diff")) {
      const stepFilter = flagValue(flags, "--step");
      if (stepFilter === null) {
        err("--step requires a value: --step <stepId>\n");
        return 1;
      }
      return printHistoryDiff(record, stepFilter, flags.includes("--stat"), out, err);
    }
    printHistoryRecord(record, out);
    return 0;
  }

  if (sub === "apply") {
    const id = args[1];
    if (!id) {
      err("usage: steamtrain workflow history apply <id> [--step <stepId>]\n");
      return 1;
    }
    const record = await store.get(id);
    if (!record) {
      err(`unknown run '${id}'\n`);
      return 1;
    }
    const stepFilter = flagValue(args.slice(2), "--step");
    if (stepFilter === null) {
      err("--step requires a value: --step <stepId>\n");
      return 1;
    }
    return applyHistoryWorktrees(store, record, stepFilter, out, err);
  }

  if (sub === "prune") {
    const id = args[1];
    if (!id) {
      err("usage: steamtrain workflow history prune <id>\n");
      return 1;
    }
    const record = await store.get(id);
    if (!record) {
      err(`unknown run '${id}'\n`);
      return 1;
    }
    return pruneHistoryWorktrees(store, record, out, err);
  }

  if (sub === "clear") {
    const id = args[1];
    if (id) {
      await store.remove(id);
      out(`removed run '${id}'\n`);
    } else {
      await store.clearAll();
      out(`cleared all run history in ${store.rootDir}\n`);
    }
    return 0;
  }

  err(`unknown workflow history command '${sub}'\n\n${helpText()}`);
  return 1;
}

/**
 * `steamtrain workflow costs [--workflow <name>] [--json]` — aggregate recorded
 * spend by workflow, step, agent, and model. Answers "which step / model is
 * eating the budget?" from history rather than one run at a time.
 */
async function runCostsCommand(
  args: string[],
  cwd: string,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  let workflowFilter: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") json = true;
    else if (arg === "--workflow" || arg === "-w") workflowFilter = args[++i];
    else {
      err(`unknown flag '${arg}' for workflow costs\n`);
      return 1;
    }
  }

  const store = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));
  const summaries = await store.list();
  const records: RunRecord[] = [];
  for (const summary of summaries) {
    if (workflowFilter && summary.workflow !== workflowFilter) continue;
    const full = await store.get(summary.id);
    if (full) records.push(full);
  }

  if (records.length === 0) {
    out(
      workflowFilter ? `no recorded runs for workflow '${workflowFilter}'\n` : "no recorded runs\n",
    );
    return 0;
  }

  const analytics = aggregateCosts(records);

  if (json) {
    out(`${JSON.stringify(analytics, null, 2)}\n`);
    return 0;
  }

  const scopeLabel = workflowFilter ? ` · workflow '${workflowFilter}'` : "";
  out(`workflow costs (${analytics.runs} run${analytics.runs === 1 ? "" : "s"}${scopeLabel})\n`);
  out(
    `  total: ${formatUsd(analytics.costUsd)} · ${formatTokens(totalTokens(analytics.tokens))} tok\n`,
  );
  const tok = formatTokenSummary(analytics.tokens);
  if (tok) out(`         ${tok}\n`);

  if (!workflowFilter && analytics.byWorkflow.length > 0) {
    out("\n  by workflow\n");
    for (const w of analytics.byWorkflow) {
      out(
        `    ${w.workflow.padEnd(24)} ${formatUsd(w.costUsd).padStart(10)}  ${formatTokens(totalTokens(w.tokens))} tok  (${w.runs} run${w.runs === 1 ? "" : "s"}, ${w.steps} step${w.steps === 1 ? "" : "s"})\n`,
      );
    }
  }

  if (analytics.byModel.length > 0) {
    out("\n  by model\n");
    for (const m of analytics.byModel) {
      out(
        `    ${m.model.padEnd(28)} ${formatUsd(m.costUsd).padStart(10)}  ${formatTokens(totalTokens(m.tokens))} tok  (${m.steps} step${m.steps === 1 ? "" : "s"})\n`,
      );
    }
  }

  if (analytics.byStep.length > 0) {
    out("\n  by step (top spenders)\n");
    for (const s of analytics.byStep.slice(0, 20)) {
      const label = workflowFilter ? s.stepId : `${s.workflow}/${s.stepId}`;
      out(
        `    ${label.padEnd(32)} ${formatUsd(s.costUsd).padStart(10)}  ${formatTokens(totalTokens(s.tokens))} tok  (${s.runs}×)\n`,
      );
    }
  }
  return 0;
}

function printHistoryRow(run: RunRecordSummary, out: (text: string) => void): void {
  const when = new Date(run.startedAt).toISOString();
  const statusGlyph =
    run.status === "done"
      ? "ok  "
      : run.status === "canceled"
        ? "cxl "
        : run.status === "budget-exceeded"
          ? "bdgt"
          : "fail";
  const totals = formatRunTotals(run.totals, { durationMs: run.durationMs, tokens: true });
  out(`  ${statusGlyph} ${run.id}  ${run.workflow}  ${when}  ${totals}\n`);
  out(`       input: ${truncateLine(run.input, 100)}\n`);
}

function printHistoryRecord(
  record: Awaited<ReturnType<WorkflowHistoryStoreGet>>,
  out: (text: string) => void,
): void {
  if (!record) return;
  out(`run ${record.id}\n`);
  out(`  workflow: ${record.workflow}\n`);
  out(`  status:   ${record.status}${record.ok ? "" : " (not ok)"}\n`);
  out(`  started:  ${new Date(record.startedAt).toISOString()}\n`);
  out(`  duration: ${(record.durationMs / 1000).toFixed(1)}s\n`);
  out(`  input:    ${truncateLine(record.input, 200)}\n`);
  if (record.error) out(`  error:    ${record.error}\n`);
  if (record.budget) {
    const b = record.budget;
    const scope = b.scope === "step" && b.stepId ? `step '${b.stepId}'` : "workflow";
    out(
      `  budget:   ${scope} cap ${formatUsd(b.limitUsd)} reached (spent ${formatUsd(b.spentUsd)}) — resumable after raising the cap\n`,
    );
  }
  if (record.harvest) {
    const bits: string[] = [];
    if (record.harvest.appliedSteps?.length) {
      const when = record.harvest.appliedAt
        ? ` at ${new Date(record.harvest.appliedAt).toISOString()}`
        : "";
      bits.push(`applied ${record.harvest.appliedSteps.join(", ")}${when}`);
    }
    if (record.harvest.prunedAt) {
      bits.push(`worktrees pruned at ${new Date(record.harvest.prunedAt).toISOString()}`);
    }
    if (bits.length > 0) out(`  harvest:  ${bits.join(" · ")}\n`);
  }
  out(`  totals:   ${formatRunTotals(record.totals, { cached: true, tokens: true })}\n`);
  printModelBreakdown(modelBreakdownForRecord(record), out);
  for (const phase of record.phases) {
    out(
      `\n  phase ${phase.index + 1}: ${phase.title}${phase.done ? (phase.ok ? "" : " (failed)") : ""}\n`,
    );
    for (const step of phase.steps) {
      const glyph = step.status === "done" ? "✓" : step.status === "error" ? "✗" : "·";
      const runnerId = step.agent ?? step.api;
      const runner = runnerId ? ` ${runnerId}${step.model ? `/${step.model}` : ""}` : "";
      const dur = step.result ? ` · ${(step.result.durationMs / 1000).toFixed(1)}s` : "";
      const cost = step.result?.costUsd ? ` · $${step.result.costUsd.toFixed(4)}` : "";
      const tokenLine = formatTokenSummary(step.result?.tokens);
      const tok = tokenLine ? ` · ${tokenLine}` : "";
      const cached = step.cached ? " · cached" : "";
      const indent = step.parentStepId ? "      " : "    ";
      out(`${indent}${glyph} ${step.stepId}${runner}${dur}${cost}${tok}${cached}\n`);
      if (step.text.trim()) {
        out(`${indent}    ${truncateLine(step.text.replace(/\s+/g, " ").trim(), 160)}\n`);
      }
    }
  }
}

type WorkflowHistoryStoreGet = ReturnType<typeof createWorkflowHistoryStore>["get"];

/** Value following `flag`; undefined if absent, null if the flag has no value. */
function flagValue(args: string[], flag: string): string | undefined | null {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

/**
 * The harvestable steps of a recorded run: every step that ran in a git
 * worktree, deduped by step id keeping the LAST occurrence (a loop body step
 * appears once per iteration; the final iteration's worktree is its final
 * state).
 */
function worktreeStepsOf(record: RunRecord, stepFilter?: string): WorktreeSource[] {
  const byId = new Map<string, WorktreeSource>();
  for (const phase of record.phases) {
    for (const step of phase.steps) {
      if (!step.worktree) continue;
      if (stepFilter && step.stepId !== stepFilter) continue;
      byId.set(step.stepId, worktreeSourceFromInfo(step.stepId, step.worktree));
    }
  }
  return [...byId.values()];
}

/**
 * EVERY recorded worktree of a run, including non-final loop iterations
 * (deduped by worktree root, not step id) — prune must remove them all, not
 * just each step's final iteration.
 */
function allWorktreesOf(record: RunRecord): WorktreeSource[] {
  const byRoot = new Map<string, WorktreeSource>();
  for (const phase of record.phases) {
    for (const step of phase.steps) {
      if (!step.worktree) continue;
      byRoot.set(step.worktree.root, worktreeSourceFromInfo(step.stepId, step.worktree));
    }
  }
  return [...byRoot.values()];
}

/** `workflow history show <id> --diff` — per-step worktree diffs of a past run. */
async function printHistoryDiff(
  record: RunRecord,
  stepFilter: string | undefined,
  statOnly: boolean,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const sources = worktreeStepsOf(record, stepFilter);
  if (sources.length === 0) {
    err(
      stepFilter
        ? `run '${record.id}' has no worktree recorded for step '${stepFilter}'\n`
        : `run '${record.id}' has no step worktrees (agent steps get worktrees only inside a git repository)\n`,
    );
    return 1;
  }
  let printed = 0;
  for (const source of sources) {
    let diff: WorktreeDiff;
    try {
      diff = await worktreeDiff(source, { patch: !statOnly });
    } catch (e) {
      err(`── ${source.stepId}: ${message(e)}\n`);
      continue;
    }
    if (diff.files.length === 0) continue;
    printed += 1;
    out(`── ${source.stepId} (${source.branch})\n`);
    for (const file of diff.files) {
      out(`   ${file.status} ${file.path}  +${file.additions} -${file.deletions}\n`);
    }
    out(`   ${diff.files.length} file(s), +${diff.additions} -${diff.deletions}\n`);
    if (!statOnly && diff.patch) out(`\n${diff.patch}\n`);
  }
  if (printed === 0) out("no changes in any recorded worktree\n");
  return 0;
}

/** `workflow history apply <id>` — merge a past run's worktrees into the workspace. */
async function applyHistoryWorktrees(
  store: ReturnType<typeof createWorkflowHistoryStore>,
  record: RunRecord,
  stepFilter: string | undefined,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const sources = worktreeStepsOf(record, stepFilter);
  if (sources.length === 0) {
    err(
      stepFilter
        ? `run '${record.id}' has no worktree recorded for step '${stepFilter}'\n`
        : `run '${record.id}' has no step worktrees to apply\n`,
    );
    return 1;
  }
  let result: HarvestResult;
  try {
    result = await harvestWorktrees({ repoRoot: record.cwd, sources, mode: "apply" });
  } catch (e) {
    err(`${message(e)}\n`);
    if (e instanceof MergeConflictError) {
      err(
        'hint: apply steps one at a time with --step <stepId>, or add a merge step with onConflict "agent" to the workflow\n',
      );
    }
    return 1;
  }
  if (result.noChanges) {
    out("no changes to apply\n");
    return 0;
  }
  out(
    `applied ${result.mergedSources.join(", ")} to ${record.cwd} (uncommitted): ${result.files.length} file(s) +${result.additions} -${result.deletions}\n`,
  );
  record.harvest = {
    ...record.harvest,
    appliedSteps: [...new Set([...(record.harvest?.appliedSteps ?? []), ...result.mergedSources])],
    appliedAt: Date.now(),
  };
  await store
    .save(record)
    .catch((e) => err(`warning: could not update run record: ${message(e)}\n`));
  return 0;
}

/** `workflow history prune <id>` — discard a past run's worktrees and branches. */
async function pruneHistoryWorktrees(
  store: ReturnType<typeof createWorkflowHistoryStore>,
  record: RunRecord,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const sources = allWorktreesOf(record);
  if (sources.length === 0) {
    out(`run '${record.id}' has no step worktrees to prune\n`);
    return 0;
  }
  let pruned = 0;
  for (const source of sources) {
    if (await pruneWorktree(source, record.cwd)) pruned += 1;
  }
  record.harvest = { ...record.harvest, prunedAt: Date.now() };
  await store
    .save(record)
    .catch((e) => err(`warning: could not update run record: ${message(e)}\n`));
  out(`pruned ${pruned}/${sources.length} worktree(s) for run '${record.id}'\n`);
  return 0;
}

interface CreateOptions {
  input?: string;
  stdin: boolean;
  json: boolean;
  save: boolean;
  scope: "user" | "project";
  agent: AgentInstanceId;
  model?: string;
  effort?: string;
  name?: string;
}

const DEFAULT_CREATE_AGENT: AgentInstanceId = "opencode";
const DEFAULT_CREATE_MODEL = "opencode/mimo-v2.5-free";

async function runWorkflowCreateCommand(
  config: SteamtrainConfig,
  args: string[],
  io: CliIO,
  out: (text: string) => void,
  err: (text: string) => void,
  /** Resolved project config path (honors `--config-file`); used for `--scope project`. */
  projectConfigPath: string,
): Promise<number> {
  const options = parseCreateOptions(args);
  if (!options) {
    err(
      "usage: steamtrain workflow create --input <description> [--agent <id>] [--model <model>] [--effort <e>] [--name <name>] [--save] [--scope user|project] [--json]\n",
    );
    return 1;
  }

  const description =
    options.input ?? (options.stdin ? await readAll(io.stdin ?? process.stdin) : undefined);
  if (!description?.trim()) {
    err("workflow create requires --input <description> or --stdin\n");
    return 1;
  }

  const model =
    options.model ?? (options.agent === DEFAULT_CREATE_AGENT ? DEFAULT_CREATE_MODEL : undefined);
  if (!model) {
    err(`workflow create requires --model when --agent is '${options.agent}'\n`);
    return 1;
  }

  if (!options.json) {
    err(`generating workflow with ${options.agent} (${model})…\n`);
  }

  const result = await generateWorkflow(
    {
      description: description.trim(),
      agent: options.agent,
      model,
      effort: options.effort,
      name: options.name,
    },
    {
      createAdapter,
      agentConfig: config,
      binaries: config.binaries,
      stepTimeoutSec: resolveStepTimeoutSec(undefined, undefined, config),
      cwd: io.cwd ?? process.cwd(),
    },
  );

  if (!result.ok || !result.spec) {
    if (options.json) {
      out(`${JSON.stringify({ ok: false, error: result.error, raw: result.raw })}\n`);
    } else {
      err(`workflow generation failed: ${result.error ?? "unknown error"}\n`);
      if (result.raw) err(`\n--- model output ---\n${result.raw}\n`);
    }
    return 1;
  }

  const spec = result.spec;

  // Perform the save (if requested) before reporting, so machine-readable
  // output reflects the real outcome rather than just the --save flag. The
  // scope picks the layer: user (`~/.steamtrain/workflows.json`) or project
  // (the `workflows` section of the resolved `steamtrain.json`).
  const saved = options.save
    ? options.scope === "project"
      ? saveProjectWorkflow(spec.name, spec, projectConfigPath)
      : await saveUserWorkflow(spec.name, spec)
    : undefined;

  if (options.json) {
    out(
      `${JSON.stringify(
        {
          ok: true,
          spec,
          saved: saved?.ok ?? false,
          ...(saved?.ok ? { savedPath: saved.path } : {}),
          ...(saved && !saved.ok ? { saveError: saved.error } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return saved && !saved.ok ? 1 : 0;
  }

  out(`\ngenerated workflow '${spec.name}'  ${workflowSummary(spec)}\n`);
  if (spec.description) out(`  ${spec.description}\n`);
  out(`\n${JSON.stringify({ workflows: { [spec.name]: spec } }, null, 2)}\n`);

  if (saved) {
    if (!saved.ok) {
      err(`could not save '${spec.name}': ${saved.error}\n`);
      return 1;
    }
    out(`\n${saved.replaced ? "updated" : "saved"} '${spec.name}' → ${saved.path}\n`);
  } else {
    out(
      "\n(not saved — re-run with --save [--scope project] to write it to ~/.steamtrain/workflows.json or ./steamtrain.json)\n",
    );
  }
  return 0;
}

function parseCreateOptions(args: string[]): CreateOptions | null {
  const options: CreateOptions = {
    stdin: false,
    json: false,
    save: false,
    scope: "user",
    agent: DEFAULT_CREATE_AGENT,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--input" || arg === "-i") {
      const value = args[++i];
      if (!value) return null;
      options.input = value;
    } else if (arg === "--agent") {
      const value = args[++i];
      if (value !== "claude" && value !== "opencode" && value !== "codex" && value !== "amp")
        return null;
      options.agent = value;
    } else if (arg === "--model") {
      const value = args[++i];
      if (!value) return null;
      options.model = value;
    } else if (arg === "--effort") {
      const value = args[++i];
      if (!value) return null;
      options.effort = value;
    } else if (arg === "--name") {
      const value = args[++i];
      if (!value) return null;
      options.name = value;
    } else if (arg === "--stdin") {
      options.stdin = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--save") {
      options.save = true;
    } else if (arg === "--scope") {
      const value = args[++i];
      if (value !== "user" && value !== "project") return null;
      options.scope = value;
    } else if (arg === "--project") {
      options.scope = "project";
    } else {
      return null;
    }
  }
  return options;
}

interface CacheClearOptions {
  workflow?: string;
  input?: string;
  stdin: boolean;
  params: Record<string, string>;
}

function parseCacheClearOptions(args: string[]): CacheClearOptions | null {
  const options: CacheClearOptions = { stdin: false, params: {} };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) return null;
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
    } else if (arg === "--stdin") {
      options.stdin = true;
    } else if (arg.startsWith("-")) {
      return null;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return null;
  options.workflow = positional[0];
  return options;
}

function workflowSummary(spec: WorkflowSpec): string {
  const phaseCount = spec.phases.length;
  const stepCount = spec.phases.reduce((n, phase) => n + phase.steps.length, 0);
  const counts = new Map<string, number>();
  for (const phase of spec.phases) {
    for (const step of phase.steps) {
      const kind = workflowStepKind(step);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  const blocks = [...counts.entries()].map(([kind, count]) => `${kind}:${count}`).join(", ");
  return `${phaseCount} phase${phaseCount === 1 ? "" : "s"} · ${stepCount} step${
    stepCount === 1 ? "" : "s"
  } · ${blocks}`;
}

function helpText(): string {
  return `steamtrain workflow commands

Usage:
  steamtrain init [--yes]
  steamtrain workflow list
  steamtrain workflow validate [name]
  steamtrain workflow plan <name> --input <text> [--param key=value ...] [--json]
  steamtrain workflow plan <name> --stdin [--param key=value ...] [--json]
  steamtrain workflow run <name> --input <text> [--param key=value ...] [--json] [--fresh] [--detach] [--approve-all | --on-approval fail|stop]
  steamtrain workflow run <name> --stdin [--param key=value ...] [--json] [--fresh] [--detach] [--approve-all | --on-approval fail|stop]
  steamtrain workflow run --from <runId> [--retry-failed] [--param key=value ...] [--input <text>] [--json] [--detach]
  steamtrain workflow attach [<runId>] [--json]
  steamtrain workflow runs [--all] [--json]
  steamtrain workflow cancel <runId>
  steamtrain workflow approve <runId> [--step <stepId>] [--reject [--on-reject fail|stop]] [--note <text>]
  steamtrain workflow create --input <description> [--agent <id>] [--model <model>] [--name <name>] [--save] [--scope user|project] [--json]
  steamtrain workflow cache clear [<workflow> --input <text> --param key=value ... | --stdin]
  steamtrain workflow history [list]
  steamtrain workflow history show <id> [--diff [--step <stepId>] [--stat]]
  steamtrain workflow history apply <id> [--step <stepId>]
  steamtrain workflow history prune <id>
  steamtrain workflow history clear [<id>]
  steamtrain workflow costs [--workflow <name>] [--json]

init checks agent readiness (with copy-paste fixes), detects this repo's real
test/lint commands, and offers starter workflows wired to them (written to
./steamtrain.json; --yes accepts them all without prompting). To see the engine
without installing any agent, ride the bundled $0 demo:
'steamtrain workflow run tour --input "all aboard"'.

workflow create delegates to an agent (default: opencode/mimo-v2.5-free) to
draft a workflow from a plain-English description, validates it, prints the JSON,
and (with --save) writes it so it shows up in the picker and CLI alongside the
bundled workflows. --scope user (default) writes to ~/.steamtrain/workflows.json;
--scope project (or --project) writes to the project's ./steamtrain.json so the
workflow can be committed and shared with the team.

Workflow runs resume from ${WORKFLOW_CACHE_DIR} by default (file name from workflow +
input + cwd; contents validated with specHash). Pass --fresh to ignore and delete
the on-disk cache for that run. Parallel runs of the same workflow + input are not supported.

Every run is recorded to ${WORKFLOW_HISTORY_DIR} (one JSON record per run, newest
${100} kept). Inspect past runs with 'workflow history', 'workflow history show <id>',
and remove them with 'workflow history clear [<id>]'. 'workflow costs' aggregates
recorded spend and tokens by workflow, step, and model — "which step is eating the
budget?".

Agent steps run in isolated git worktrees that are retained after the run.
'history show <id> --diff' shows what each step changed (--stat for a summary,
--step to focus one step); 'history apply <id>' merges those changes into the
workspace as uncommitted edits; 'history prune <id>' discards the run's
worktrees and branches. To harvest changes automatically instead, end the
workflow with a "merge" step (see docs/workflow-spec.md).

Set 'maxCostUsd' on a workflow (or a forEach step) to cap spend: the engine stops
scheduling new steps once the cap is reached, records the run as budget-exceeded,
and leaves the cache intact so raising the cap and re-running resumes it.

Detached runs & the run queue: 'workflow run --detach' launches the run under a
background process that survives this terminal, mirroring live events into
.steamtrain/runs/. 'workflow runs' lists in-flight runs; 'workflow attach <id>'
replays the run so far and tails it live (Ctrl+C detaches again — the TUI's
/attach and the web UI's Active runs list do the same); 'workflow cancel <id>'
stops it. Approval checkpoints on a detached run wait for a decision from any
attached UI ('workflow approve <id>', TUI keys, or the web buttons) unless the
launch passed --approve-all / --on-approval. All runs — CLI, TUI, and web —
share one queue: at most 'maxParallelRuns' (steamtrain.json, default ${DEFAULT_MAX_PARALLEL_RUNS})
execute at once and the rest wait, so parallel runs never collide over the
step cache or git worktrees.

Running steamtrain with no command opens the workflow-first TUI.
Running steamtrain --web-ui opens the same engine behind a local browser UI.

Global options (TUI and workflow commands):
  -v, --version              Print the steamtrain version and exit
  -w, --workspace <path>     Load workspace presets from a custom workspace.json
      --config-file <path>   Load project config from a custom steamtrain.json
      --web-ui               Serve the browser UI instead of the TUI
      --port <n>             Web UI port (default 4317; with --web-ui)
      --host <host>          Web UI bind host (default 127.0.0.1; with --web-ui)
      --auth-token <token>   Require this token for web UI access (with --web-ui)
`;
}
