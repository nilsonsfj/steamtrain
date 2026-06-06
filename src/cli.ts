import { join } from "node:path";
import type { Readable } from "node:stream";
import { type SteamtrainConfig, loadConfig } from "./config";
import { runDoctor } from "./doctor";
import { Orchestrator } from "./orchestrator";
import {
  type StepResult,
  WORKFLOW_CACHE_DIR,
  type WorkflowEvent,
  type WorkflowSpec,
  createWorkflowCacheStore,
  persistWorkflowStepDone,
  validateWorkflow,
  workflowCacheKey,
  workflowStepKind,
} from "./workflow";

export interface CliIO {
  cwd?: string;
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
  const { config, source, warning } = loadConfig(cwd);
  if (warning) err(`${warning}\n`);
  const orchestrator = new Orchestrator(config, []);

  switch (command ?? "list") {
    case "list":
    case "ls":
      printWorkflowList(orchestrator.listWorkflows(), source, out);
      return 0;
    case "validate":
      return validateWorkflows(orchestrator.listWorkflows(), rest[0], out, err);
    case "cache":
      return runCacheCommand(rest, cwd, io, orchestrator, out, err);
    case "run":
      return runWorkflowCommand(orchestrator, config, rest, io, out, err);
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
  workflows: Record<string, WorkflowSpec>,
  source: string,
  out: (text: string) => void,
): void {
  out(`workflows (${source})\n`);
  for (const [name, spec] of Object.entries(workflows)) {
    out(`- ${name}  ${workflowSummary(spec)}\n`);
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
  const doctor = await runDoctor(config);
  orchestrator.setDoctor(doctor);
  const check = orchestrator.canDispatchWorkflow(name);
  if (!check.ok) {
    err(`cannot run '${name}': ${check.reason}\n`);
    return 1;
  }

  const spec = orchestrator.listWorkflows()[name];
  if (!spec) {
    err(`unknown workflow '${name}'\n`);
    return 1;
  }

  const store = createWorkflowCacheStore(join(cwd, WORKFLOW_CACHE_DIR));
  const key = workflowCacheKey(name, input.trim(), cwd, spec);
  const cache = new Map<string, StepResult>();
  if (options.fresh) {
    await store.clear(key);
  } else {
    const loaded = await store.load(key);
    for (const [stepId, result] of loaded) cache.set(stepId, result);
  }

  let ok = false;
  for await (const event of orchestrator.runWorkflow(name, input.trim(), undefined, cache, cwd)) {
    if (options.json) out(`${JSON.stringify(event)}\n`);
    else printHumanEvent(event, out);
    if (event.kind === "step_done") {
      await persistWorkflowStepDone(store, key, cache, event.stepId, event.result, event.cached);
    }
    if (event.kind === "workflow_done") ok = event.ok;
  }
  return ok ? 0 : 1;
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
  steamtrain workflow cache clear [<workflow> --input <text> | --stdin]

Workflow runs resume from ${WORKFLOW_CACHE_DIR} by default (keyed by workflow spec,
input, and cwd). Pass --fresh to ignore and delete the on-disk cache for that run.
Parallel runs of the same workflow + input are not supported.

Running steamtrain with no command opens the workflow-first TUI.
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
