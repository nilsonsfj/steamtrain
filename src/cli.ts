import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { createAdapter } from "./agents";
import { refreshAgentCatalogCaches } from "./agents/models";
import { type SteamtrainConfig, configDisplayLabel, loadConfig } from "./config";
import { runDoctor } from "./doctor";
import { Orchestrator } from "./orchestrator";
import { loadSettings } from "./settings";
import type { AgentId } from "./types/events";
import {
  RunRecordBuilder,
  type RunRecordSummary,
  type StepResult,
  WORKFLOW_CACHE_DIR,
  WORKFLOW_HISTORY_DIR,
  type WorkflowEvent,
  type WorkflowSpec,
  createWorkflowCacheStore,
  createWorkflowHistoryStore,
  formatRunTotals,
  generateWorkflow,
  persistWorkflowStepDone,
  saveUserWorkflow,
  validateWorkflow,
  workflowAgentIds,
  workflowCacheKey,
  workflowStepKind,
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
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
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
    rest.push(arg);
  }
  return { args: rest, workspacePath, configPath, webUi: webUi || undefined, port, host };
}

export interface CliIO {
  cwd?: string;
  workspacePath?: string;
  configPath?: string;
  stdin?: Readable;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface RunOptions {
  input?: string;
  stdin: boolean;
  json: boolean;
  fresh: boolean;
}

export async function runCli(args: string[], io: CliIO = {}): Promise<number> {
  const out = io.stdout ?? ((text: string) => process.stdout.write(text));
  const err = io.stderr ?? ((text: string) => process.stderr.write(text));
  const [scope, command, ...rest] = normalizeArgs(args);

  if (!scope || scope === "help" || scope === "--help" || scope === "-h") {
    out(helpText());
    return 0;
  }

  if (scope !== "workflow") {
    err(`unknown command '${scope}'\n\n${helpText()}`);
    return 1;
  }

  const cwd = io.cwd ?? process.cwd();
  const { config, scope: configScope, warning } = loadConfig({ cwd, customPath: io.configPath });
  if (warning) err(`${warning}\n`);
  const { hasUserFile: hasUserSettings } = loadSettings();
  const configLabel = configDisplayLabel(configScope, { hasUserSettings });
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
    case "cache":
      return runCacheCommand(rest, cwd, io, orchestrator, out, err);
    case "history":
      return runHistoryCommand(rest, cwd, out, err);
    case "run":
      return runWorkflowCommand(orchestrator, config, rest, io, out, err);
    case "create":
    case "new":
      return runWorkflowCreateCommand(config, rest, io, out, err);
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
    } else {
      ok = false;
      err(`bad ${workflowName}: ${result.error}\n`);
    }
  }

  return ok ? 0 : 1;
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
    err("usage: steamtrain workflow cache clear [--input <text> | --stdin] [<workflow>]\n");
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

  const input =
    options.input ?? (options.stdin ? await readAll(io.stdin ?? process.stdin) : undefined);
  if (!input?.trim()) {
    err("workflow cache clear <name> requires --input <text> or --stdin\n");
    return 1;
  }

  const key = workflowCacheKey(options.workflow, input.trim(), cwd, spec);
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
      err("usage: steamtrain workflow history show <id>\n");
      return 1;
    }
    const record = await store.get(id);
    if (!record) {
      err(`unknown run '${id}'\n`);
      return 1;
    }
    printHistoryRecord(record, out);
    return 0;
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

function printHistoryRow(run: RunRecordSummary, out: (text: string) => void): void {
  const when = new Date(run.startedAt).toISOString();
  const statusGlyph = run.status === "done" ? "ok  " : run.status === "canceled" ? "cxl " : "fail";
  const totals = formatRunTotals(run.totals, { durationMs: run.durationMs });
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
  out(`  totals:   ${formatRunTotals(record.totals, { cached: true })}\n`);
  for (const phase of record.phases) {
    out(
      `\n  phase ${phase.index + 1}: ${phase.title}${phase.done ? (phase.ok ? "" : " (failed)") : ""}\n`,
    );
    for (const step of phase.steps) {
      const glyph = step.status === "done" ? "✓" : step.status === "error" ? "✗" : "·";
      const runner = step.agent ? ` ${step.agent}${step.model ? `/${step.model}` : ""}` : "";
      const dur = step.result ? ` · ${(step.result.durationMs / 1000).toFixed(1)}s` : "";
      const cost = step.result?.costUsd ? ` · $${step.result.costUsd.toFixed(4)}` : "";
      const cached = step.cached ? " · cached" : "";
      const indent = step.parentStepId ? "      " : "    ";
      out(`${indent}${glyph} ${step.stepId}${runner}${dur}${cost}${cached}\n`);
      if (step.text.trim()) {
        out(`${indent}    ${truncateLine(step.text.replace(/\s+/g, " ").trim(), 160)}\n`);
      }
    }
  }
}

type WorkflowHistoryStoreGet = ReturnType<typeof createWorkflowHistoryStore>["get"];

function truncateLine(text: string, max: number): string {
  const oneLine = text.replace(/\n/g, " ");
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

async function runWorkflowCommand(
  orchestrator: Orchestrator,
  config: SteamtrainConfig,
  args: string[],
  io: CliIO,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const name = args[0];
  if (!name) {
    err("workflow run requires a workflow name\n");
    return 1;
  }

  const options = parseRunOptions(args.slice(1));
  if (!options) {
    err("usage: steamtrain workflow run <name> --input <text> [--json] [--fresh]\n");
    return 1;
  }

  const input =
    options.input ?? (options.stdin ? await readAll(io.stdin ?? process.stdin) : undefined);
  if (!input?.trim()) {
    err("workflow run requires --input <text> or --stdin\n");
    return 1;
  }

  const cwd = io.cwd ?? process.cwd();
  const spec = orchestrator.listWorkflows()[name];
  if (!spec) {
    err(`unknown workflow '${name}'\n`);
    return 1;
  }

  // Agentless workflows (only distributors / consolidators / gates) never spawn
  // a CLI, so skip the doctor + catalog refresh — they would otherwise spawn
  // real agent binaries just to gate a run that needs none.
  if (workflowAgentIds(spec).length > 0) {
    const doctor = await runDoctor(config);
    orchestrator.setDoctor(doctor);
    await refreshAgentCatalogCaches(config, doctor);
    const check = orchestrator.canDispatchWorkflow(name);
    if (!check.ok) {
      err(`cannot run '${name}': ${check.reason}\n`);
      return 1;
    }
  }

  const store = createWorkflowCacheStore(join(cwd, WORKFLOW_CACHE_DIR));
  const historyStore = createWorkflowHistoryStore(join(cwd, WORKFLOW_HISTORY_DIR));
  const key = workflowCacheKey(name, input.trim(), cwd, spec);
  const cache = new Map<string, StepResult>();
  if (options.fresh) {
    await store.clear(key);
  } else {
    const loaded = await store.load(key);
    for (const [stepId, result] of loaded) cache.set(stepId, result);
  }

  const recorder = new RunRecordBuilder({
    id: randomUUID(),
    workflow: name,
    input: input.trim(),
    cwd,
  });
  // Wire cancellation so Ctrl+C unwinds the run and records it as "canceled"
  // (matching the TUI and web drivers) instead of hard-killing the process
  // before history is written. A second Ctrl+C force-exits.
  const ac = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts === 1) ac.abort();
    else process.exit(130);
  };
  process.on("SIGINT", onSigint);
  let ok = false;
  try {
    for await (const event of orchestrator.runWorkflow(name, input.trim(), ac.signal, cache, cwd)) {
      recorder.handle(event);
      if (options.json) out(`${JSON.stringify(event)}\n`);
      else printHumanEvent(event, out);
      if (event.kind === "step_done") {
        await persistWorkflowStepDone(store, key, cache, event.stepId, event.result, event.cached);
      }
      if (event.kind === "workflow_done") {
        ok = event.ok;
        if (!options.json) printRunSummary(event.results, out);
      }
    }
    // The engine yields a final workflow_done on abort rather than throwing, so
    // check the signal first: a canceled run must not be mislabeled done/error.
    if (ac.signal.aborted) {
      await saveHistory(historyStore, recorder, "canceled", err);
      return 130;
    }
    await saveHistory(historyStore, recorder, ok ? "done" : "error", err);
  } catch (runErr) {
    if (ac.signal.aborted) {
      await saveHistory(historyStore, recorder, "canceled", err);
      return 130;
    }
    await saveHistory(historyStore, recorder, "error", err, message(runErr));
    throw runErr;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  return ok ? 0 : 1;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Persist a finished run to history; a write failure only warns, never fails the run. */
async function saveHistory(
  historyStore: ReturnType<typeof createWorkflowHistoryStore>,
  recorder: RunRecordBuilder,
  status: "done" | "error" | "canceled",
  err: (text: string) => void,
  error?: string,
): Promise<void> {
  try {
    await historyStore.save(recorder.build({ status, error }));
  } catch (e) {
    err(`warning: could not record run history: ${message(e)}\n`);
  }
}

/**
 * A compact, end-of-run report: per-step status (with data-flow source for
 * fan-out children), duration, cache/cost, and roll-up totals. This is the CLI
 * analog of the TUI's live status header.
 */
function printRunSummary(results: StepResult[], out: (text: string) => void): void {
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
    if (cost > 0) bits.push(`$${cost.toFixed(4)}`);
    if (result.gate) bits.push(result.gate.passed ? "gate:passed" : "gate:blocked");
    const from = result.item ? ` (item ${result.item.index})` : "";
    out(`  ${status} ${result.stepId}${from}  ${bits.join(" · ")}\n`);
  }
  const totals = [
    `${okCount} ok`,
    failCount > 0 ? `${failCount} failed` : undefined,
    totalCost > 0 ? `$${totalCost.toFixed(4)}` : undefined,
    `${(totalMs / 1000).toFixed(1)}s total`,
  ].filter(Boolean);
  out(`  ── ${totals.join(" · ")}\n`);
}

interface CreateOptions {
  input?: string;
  stdin: boolean;
  json: boolean;
  save: boolean;
  agent: AgentId;
  model?: string;
  effort?: string;
  name?: string;
}

const DEFAULT_CREATE_AGENT: AgentId = "opencode";
const DEFAULT_CREATE_MODEL = "opencode/mimo-v2.5-free";

async function runWorkflowCreateCommand(
  config: SteamtrainConfig,
  args: string[],
  io: CliIO,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const options = parseCreateOptions(args);
  if (!options) {
    err(
      "usage: steamtrain workflow create --input <description> [--agent <id>] [--model <model>] [--effort <e>] [--name <name>] [--save] [--json]\n",
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
      binaries: config.binaries,
      timeoutMs: config.timeoutMs,
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
  // output reflects the real outcome rather than just the --save flag.
  const saved = options.save ? saveUserWorkflow(spec.name, spec) : undefined;

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
    out("\n(not saved — re-run with --save to write it to ~/.steamtrain/workflows.json)\n");
  }
  return 0;
}

function parseCreateOptions(args: string[]): CreateOptions | null {
  const options: CreateOptions = {
    stdin: false,
    json: false,
    save: false,
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
      if (value !== "claude" && value !== "opencode" && value !== "codex") return null;
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
}

function parseCacheClearOptions(args: string[]): CacheClearOptions | null {
  const options: CacheClearOptions = { stdin: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) return null;
    if (arg === "--input" || arg === "-i") {
      const value = args[i + 1];
      if (!value) return null;
      options.input = value;
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

function parseRunOptions(args: string[]): RunOptions | null {
  const options: RunOptions = { stdin: false, json: false, fresh: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--input" || arg === "-i") {
      const value = args[i + 1];
      if (!value) return null;
      options.input = value;
      i += 1;
    } else if (arg === "--stdin") {
      options.stdin = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fresh") {
      options.fresh = true;
    } else {
      return null;
    }
  }
  return options;
}

function printHumanEvent(event: WorkflowEvent, out: (text: string) => void): void {
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
    case "step_done":
      out(
        `  ${event.result.ok ? "done" : "fail"} ${event.stepId}${event.cached ? " (cached)" : ""}\n`,
      );
      return;
    case "phase_done":
      out(`phase ${event.phaseId} ${event.ok ? "ok" : "failed"}\n`);
      return;
    case "workflow_done":
      out(`\nworkflow ${event.ok ? "done" : "failed"}\n`);
      return;
  }
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
  steamtrain workflow list
  steamtrain workflow validate [name]
  steamtrain workflow run <name> --input <text> [--json] [--fresh]
  steamtrain workflow run <name> --stdin [--json] [--fresh]
  steamtrain workflow create --input <description> [--agent <id>] [--model <model>] [--name <name>] [--save] [--json]
  steamtrain workflow cache clear [<workflow> --input <text> | --stdin]
  steamtrain workflow history [list]
  steamtrain workflow history show <id>
  steamtrain workflow history clear [<id>]

workflow create delegates to an agent (default: opencode/mimo-v2.5-free) to
draft a workflow from a plain-English description, validates it, prints the JSON,
and (with --save) writes it to ~/.steamtrain/workflows.json so it shows up in the
picker and CLI alongside the bundled workflows.

Workflow runs resume from ${WORKFLOW_CACHE_DIR} by default (file name from workflow +
input + cwd; contents validated with specHash). Pass --fresh to ignore and delete
the on-disk cache for that run. Parallel runs of the same workflow + input are not supported.

Every run is recorded to ${WORKFLOW_HISTORY_DIR} (one JSON record per run, newest
${100} kept). Inspect past runs with 'workflow history', 'workflow history show <id>',
and remove them with 'workflow history clear [<id>]'.

Running steamtrain with no command opens the workflow-first TUI.
Running steamtrain --web-ui opens the same engine behind a local browser UI.

Global options (TUI and workflow commands):
  -w, --workspace <path>     Load workspace presets from a custom workspace.json
      --config-file <path>   Load project config from a custom steamtrain.json
      --web-ui               Serve the browser UI instead of the TUI
      --port <n>             Web UI port (default 4317; with --web-ui)
      --host <host>          Web UI bind host (default 127.0.0.1; with --web-ui)
`;
}

function readAll(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      text += String(chunk);
    });
    stream.on("end", () => resolve(text));
    stream.on("error", reject);
  });
}
