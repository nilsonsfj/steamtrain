import { existsSync, readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { defaultModelForAgent } from "../agents/models";
import type { CliIO } from "../cli";
import { loadConfig } from "../config";
import { type DoctorResult, runDoctor } from "../doctor";
import { atomicWriteFile } from "../workflow/fs-util";
import { type WorkflowSpec, validateWorkflow } from "../workflow/types";
import { type ProjectDetection, detectProject } from "./detect";
import { buildImplementVerifiedWorkflow, buildVerifyWorkflow } from "./starters";

/**
 * `steamtrain init` — the first five minutes: report agent readiness with
 * copy-paste fixes, detect this repo's real check commands, and offer starter
 * workflows wired to them. Everything it suggests degrades gracefully: with
 * zero agents installed the bundled `tour` and the agentless `verify` starter
 * still run for $0.
 */

export interface InitDeps {
  /** Injected doctor for tests (defaults to the real preflight). */
  doctor?: typeof runDoctor;
  /** Injected detection for tests (defaults to real filesystem probing). */
  detect?: (cwd: string) => ProjectDetection;
  /** Overrides TTY detection (tests drive prompts through a fake stdin). */
  interactive?: boolean;
}

interface InitOptions {
  /** `--yes`: accept every offered starter without prompting. */
  yes: boolean;
  /** `--help`: print init-specific help and exit. */
  help: boolean;
}

export async function runInitCommand(
  args: string[],
  io: CliIO = {},
  deps: InitDeps = {},
): Promise<number> {
  const out = io.stdout ?? ((text: string) => process.stdout.write(text));
  const err = io.stderr ?? ((text: string) => process.stderr.write(text));

  const options = parseInitOptions(args);
  if (!options) {
    err("usage: steamtrain init [--yes]  (--help for details)\n");
    return 1;
  }
  if (options.help) {
    out(initHelpText());
    return 0;
  }

  const cwd = io.cwd ?? process.cwd();
  const { config, scope, warning } = loadConfig({ cwd, customPath: io.configPath });
  if (warning) err(`${warning}\n`);

  out("steamtrain init — get this repo ride-ready\n");

  // 1. Agent readiness, with copy-paste fixes for anything not ok.
  out("\nchecking agents (a fresh machine can take a few seconds per agent)…\n");
  const doctor = await (deps.doctor ?? runDoctor)(config);
  out("\nagents\n");
  for (const result of doctor) {
    out(`  ${statusGlyph(result.status)} ${result.agent.padEnd(10)} ${statusLine(result)}\n`);
    if (result.status !== "ok" && result.detail) out(`      fix: ${result.detail}\n`);
  }
  const ready = doctor.filter((result) => result.status === "ok");
  if (ready.length === 0) {
    out(
      "\n  No agent is ready yet — that's fine to start: agentless workflows\n" +
        "  (like the bundled 'tour' and the 'verify' starter) run without one.\n",
    );
  }

  // 2. What does this repo already know how to check?
  const detection = (deps.detect ?? detectProject)(cwd);
  out("\nthis repo\n");
  if (detection.stacks.length > 0) out(`  detected: ${detection.stacks.join(", ")}\n`);
  if (detection.checks.length > 0) {
    for (const check of detection.checks) out(`  check: ${check.label}\n`);
  } else {
    out("  no test/lint commands detected — starter workflows will be limited\n");
  }

  // 3. Offer starter workflows built from the detection.
  const offers: { spec: WorkflowSpec; why: string }[] = [];
  if (detection.checks.length > 0) {
    offers.push({
      spec: buildVerifyWorkflow(detection.checks),
      why: "runs this repo's checks as parallel $0 command steps",
    });
  }
  const firstReady = ready[0];
  const implementModel = firstReady ? defaultModelForAgent(firstReady.agent, config) : undefined;
  if (firstReady && implementModel && detection.testCheck) {
    offers.push({
      spec: buildImplementVerifiedWorkflow(firstReady.agent, implementModel, detection.testCheck),
      why: `${firstReady.agent} implements, ${detection.testCheck.label} verifies, only passing changes land`,
    });
  }

  if (offers.length === 0) {
    out("\nnothing to add yet — no checks detected and no ready agent.\n");
    printNextSteps(out, []);
    return 0;
  }

  // Only an explicit --yes may write config unattended. Without a TTY (piped
  // stdin, CI) and without --yes, list the offers but decline them — init
  // must never mutate a repo just because output was redirected.
  const stdin: Readable = io.stdin ?? process.stdin;
  const interactive = deps.interactive ?? Boolean((stdin as { isTTY?: boolean }).isTTY);
  const mode: "accept-all" | "ask" | "decline-all" = options.yes
    ? "accept-all"
    : interactive
      ? "ask"
      : "decline-all";

  const accepted: WorkflowSpec[] = [];
  out("\nstarter workflows\n");
  const reader = mode === "ask" ? createPromptReader(stdin, out) : undefined;
  for (const offer of offers) {
    const validation = validateWorkflow(offer.spec);
    if (!validation.ok) {
      err(`  skipping '${offer.spec.name}': generated spec is invalid (${validation.error})\n`);
      continue;
    }
    if (mode === "accept-all") {
      out(`  + ${offer.spec.name} — ${offer.why}\n`);
      accepted.push(offer.spec);
    } else if (mode === "decline-all") {
      out(`  · ${offer.spec.name} — ${offer.why}\n`);
    } else if (reader) {
      const add = await reader.ask(`  add '${offer.spec.name}' (${offer.why})? [Y/n] `);
      if (add) accepted.push(offer.spec);
    }
  }
  reader?.dispose();
  if (mode === "decline-all") {
    out("\n  non-interactive session without --yes — nothing written.\n");
    out("  re-run with --yes to add the starters above.\n");
  }

  if (accepted.length === 0) {
    if (mode !== "decline-all") out("\nno starters added.\n");
    printNextSteps(out, []);
    return 0;
  }

  // 4. Write them into the project config (create or merge, never clobber).
  const write = await writeStarters(scope.path, accepted);
  if (!write.ok) {
    err(`\ncould not update ${scope.path}: ${write.error}\n`);
    return 1;
  }
  for (const name of write.skipped) {
    out(`\n  '${name}' already exists in ${scope.path} — left untouched\n`);
  }
  if (write.written.length > 0) {
    out(`\nwrote ${write.written.map((name) => `'${name}'`).join(", ")} → ${scope.path}\n`);
  }
  if (write.written.includes("implement-verified") && firstReady) {
    // The agent is simply the first one the doctor reported ready — make it
    // obvious the choice is editable rather than a considered recommendation.
    out(
      `  implement-verified uses ${firstReady.agent} (${implementModel}) — the first ready agent;\n` +
        `  edit its 'agent'/'model' in ${scope.path} to use a different one.\n`,
    );
  }
  printNextSteps(out, write.written);
  return 0;
}

function parseInitOptions(args: string[]): InitOptions | null {
  const options: InitOptions = { yes: false, help: false };
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else return null;
  }
  return options;
}

function initHelpText(): string {
  return `steamtrain init — get this repo ride-ready

Checks each agent's readiness (with copy-paste fixes for anything not ok),
detects this repo's test/lint commands, and offers starter workflows wired to
them, merged into ./steamtrain.json (existing keys and same-named workflows
are never overwritten).

Starter workflows:
  verify              every detected check as a parallel $0 command step,
                      plus a combined report (agentless)
  implement-verified  an agent implements in an isolated worktree, your real
                      test command verifies the edits, a gate blocks failures,
                      and a merge step applies only verified changes
                      (offered when an agent is ready and a test command was
                      detected; edit agent/model in steamtrain.json to change)

Usage:
  steamtrain init            confirm each starter interactively
  steamtrain init --yes      accept every offered starter without prompting
                             (required to write in non-interactive sessions)

Options:
  -y, --yes    Accept all offers. Piped/CI sessions decline without it.
  -h, --help   Show this help.

Try the engine with zero credentials first:
  steamtrain workflow run tour --input "all aboard"   # $0 demo ride
`;
}

function statusGlyph(status: DoctorResult["status"]): string {
  switch (status) {
    case "ok":
      return "✓";
    case "binary_missing":
      return "✗";
    case "not_authenticated":
    case "unknown_error":
      return "!";
    default:
      // A new DoctorStatus fails to compile here (the never check), while a
      // value that sneaks past types at runtime degrades to "?" rather than
      // rendering "undefined" in the readiness table.
      return unreachableFallback(status, "?");
  }
}

/** Compile-time exhaustiveness guard with a graceful runtime fallback. */
function unreachableFallback(_value: never, fallback: string): string {
  return fallback;
}

function statusLine(result: DoctorResult): string {
  if (result.status === "ok") {
    return result.version ? `ready (${result.version})` : "ready";
  }
  return result.message;
}

function printNextSteps(out: (text: string) => void, written: string[]): void {
  out("\nnext stops\n");
  out('  steamtrain workflow run tour --input "all aboard"   # zero-credential demo ride ($0)\n');
  if (written.includes("verify")) {
    out(
      '  steamtrain workflow run verify --input "pre-flight" # run this repo\'s checks as a workflow\n',
    );
  }
  if (written.includes("implement-verified")) {
    out('  steamtrain workflow run implement-verified --input "<task>"\n');
  }
  out("  steamtrain                                          # open the TUI\n");
  out("  docs/workflow-overview.md                           # how workflows fit together\n");
}

interface WriteResult {
  ok: boolean;
  error?: string;
  written: string[];
  skipped: string[];
}

/**
 * Merge starter workflows into the project config file. Creates the file when
 * absent; otherwise preserves every existing key and every existing workflow
 * (same-named starters are skipped, never overwritten). A file that exists but
 * doesn't parse aborts the write — init must never destroy a config it can't
 * read.
 */
async function writeStarters(path: string, specs: WorkflowSpec[]): Promise<WriteResult> {
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "existing file is not a JSON object", written: [], skipped: [] };
      }
      existing = parsed as Record<string, unknown>;
    } catch (error) {
      return {
        ok: false,
        error: `existing file is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        written: [],
        skipped: [],
      };
    }
  }

  // A `workflows` key that isn't a name→spec map is broken config; replacing
  // it would silently discard whatever the user meant. Same contract as
  // unparseable JSON: refuse, and let them fix it first.
  if (existing.workflows !== undefined) {
    if (
      !existing.workflows ||
      typeof existing.workflows !== "object" ||
      Array.isArray(existing.workflows)
    ) {
      return {
        ok: false,
        error:
          "existing 'workflows' is not an object (expected a name → spec map; fix or remove it, then re-run init)",
        written: [],
        skipped: [],
      };
    }
  }
  const workflows: Record<string, unknown> = { ...(existing.workflows as Record<string, unknown>) };

  const written: string[] = [];
  const skipped: string[] = [];
  for (const spec of specs) {
    if (spec.name in workflows) {
      skipped.push(spec.name);
      continue;
    }
    // The catalog injects the map key as `name`; don't store it twice.
    const { name, ...body } = spec;
    workflows[name] = body;
    written.push(name);
  }

  if (written.length > 0) {
    // Spread keeps every other top-level key (maxConcurrency, binaries, …)
    // byte-identical; only the merged `workflows` map is replaced.
    await atomicWriteFile(path, `${JSON.stringify({ ...existing, workflows }, null, 2)}\n`);
  }
  return { ok: true, written, skipped };
}

interface PromptReader {
  /** Print `question` and resolve with the next line's y/n answer (Enter accepts). */
  ask(question: string): Promise<boolean>;
  /** Detach from stdin (and pause it, so it can't hold the process open). */
  dispose(): void;
}

/**
 * Line-buffered y/n prompting over one shared Readable. One `data` chunk is
 * NOT one answer: a paste or a scripted `write("y\nn\n")` delivers several
 * answers in a single chunk, and a slow terminal can split one answer across
 * chunks. So chunks are reassembled into lines and each pending question
 * consumes exactly one line — extra lines wait for the next question
 * (type-ahead), and a partial line waits for its newline (or end-of-input,
 * which flushes it as a final answer). A closed/errored/already-dead stream
 * resolves every pending and future question as "no" instead of hanging.
 */
function createPromptReader(stdin: Readable, out: (text: string) => void): PromptReader {
  let buffer = "";
  const lines: string[] = [];
  const waiters: Array<(line: string | undefined) => void> = [];
  let gone = stdin.destroyed || !stdin.readable;

  const deliver = (): void => {
    while (waiters.length > 0 && lines.length > 0) {
      waiters.shift()?.(lines.shift());
    }
    if (gone) {
      while (waiters.length > 0) waiters.shift()?.(undefined);
    }
  };
  const onData = (chunk: unknown): void => {
    buffer += String(chunk);
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    lines.push(...parts);
    deliver();
  };
  const onGone = (): void => {
    if (gone) return;
    gone = true;
    // "y" followed by EOF (no trailing newline) is still an answer.
    if (buffer.trim() !== "") {
      lines.push(buffer);
      buffer = "";
    }
    deliver();
  };
  if (!gone) {
    stdin.on("data", onData);
    stdin.on("end", onGone);
    stdin.on("close", onGone);
    stdin.on("error", onGone);
  }

  return {
    ask(question: string): Promise<boolean> {
      out(question);
      return new Promise((resolve) => {
        waiters.push((line) => resolve(line !== undefined && isYesLine(line)));
        deliver();
      });
    },
    dispose(): void {
      stdin.off("data", onData);
      stdin.off("end", onGone);
      stdin.off("close", onGone);
      stdin.off("error", onGone);
      // A resumed process.stdin keeps the event loop alive; release it.
      stdin.pause();
    },
  };
}

function isYesLine(line: string): boolean {
  const answer = line.trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}
