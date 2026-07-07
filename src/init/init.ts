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
    err("usage: steamtrain init [--yes]\n");
    return 1;
  }

  const cwd = io.cwd ?? process.cwd();
  const { config, scope, warning } = loadConfig({ cwd, customPath: io.configPath });
  if (warning) err(`${warning}\n`);

  out("steamtrain init — get this repo ride-ready\n");

  // 1. Agent readiness, with copy-paste fixes for anything not ok.
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
  if (firstReady && detection.testCheck) {
    offers.push({
      spec: buildImplementVerifiedWorkflow(
        firstReady.agent,
        defaultModelForAgent(firstReady.agent, config),
        detection.testCheck,
      ),
      why: `${firstReady.agent} implements, ${detection.testCheck.label} verifies, only passing changes land`,
    });
  }

  if (offers.length === 0) {
    out("\nnothing to add yet — no checks detected and no ready agent.\n");
    printNextSteps(out, []);
    return 0;
  }

  const stdin: Readable = io.stdin ?? process.stdin;
  const interactive = deps.interactive ?? Boolean((stdin as { isTTY?: boolean }).isTTY);
  const accepted: WorkflowSpec[] = [];
  out("\nstarter workflows\n");
  for (const offer of offers) {
    const validation = validateWorkflow(offer.spec);
    if (!validation.ok) {
      err(`  skipping '${offer.spec.name}': generated spec is invalid (${validation.error})\n`);
      continue;
    }
    if (options.yes || !interactive) {
      out(`  + ${offer.spec.name} — ${offer.why}\n`);
      accepted.push(offer.spec);
      continue;
    }
    const add = await askYesNo(stdin, out, `  add '${offer.spec.name}' (${offer.why})? [Y/n] `);
    if (add) accepted.push(offer.spec);
  }

  if (accepted.length === 0) {
    out("\nno starters added.\n");
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
  printNextSteps(out, write.written);
  return 0;
}

function parseInitOptions(args: string[]): InitOptions | null {
  const options: InitOptions = { yes: false };
  for (const arg of args) {
    if (arg === "--yes" || arg === "-y") options.yes = true;
    else return null;
  }
  return options;
}

function statusGlyph(status: DoctorResult["status"]): string {
  switch (status) {
    case "ok":
      return "✓";
    case "binary_missing":
      return "✗";
    default:
      return "!";
  }
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

  const workflows: Record<string, unknown> =
    existing.workflows &&
    typeof existing.workflows === "object" &&
    !Array.isArray(existing.workflows)
      ? { ...(existing.workflows as Record<string, unknown>) }
      : {};

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
    await atomicWriteFile(path, `${JSON.stringify({ ...existing, workflows }, null, 2)}\n`);
  }
  return { ok: true, written, skipped };
}

/** Minimal y/n prompt over an injected Readable (default: accept on Enter). */
function askYesNo(
  stdin: Readable,
  out: (text: string) => void,
  question: string,
): Promise<boolean> {
  out(question);
  return new Promise((resolve) => {
    const onData = (chunk: unknown): void => {
      stdin.off("data", onData);
      const answer = String(chunk).trim().toLowerCase();
      resolve(answer === "" || answer === "y" || answer === "yes");
    };
    stdin.on("data", onData);
  });
}
