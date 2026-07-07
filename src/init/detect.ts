import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Repo detection for `steamtrain init`: find the deterministic check commands
 * (tests, linters, typecheckers) this project already has, so the generated
 * starter workflows gate on real signals instead of an agent's opinion.
 */

export interface DetectedCheck {
  /** Step id used in generated workflows (unique per detection, kebab-case). */
  id: string;
  /** Human-readable label ("npm run test"). */
  label: string;
  /** Shell command for a `command` step. */
  cmd: string;
}

export interface ProjectDetection {
  /** Detected ecosystems, for the summary line ("node", "rust", …). */
  stacks: string[];
  /** All detected check commands, test-ish first. */
  checks: DetectedCheck[];
  /** The check `implement-verified` gates on (the test command, when present). */
  testCheck?: DetectedCheck;
}

/** npm's scaffold placeholder — a "test" script that only errors out. */
const NPM_PLACEHOLDER_TEST = /echo .*no test specified/i;

/** Node script names worth turning into checks, in report order. */
const NODE_CHECK_SCRIPTS = ["test", "lint", "typecheck", "check"] as const;

export function detectProject(cwd: string): ProjectDetection {
  const stacks: string[] = [];
  const checks: DetectedCheck[] = [];

  const node = detectNode(cwd);
  if (node) {
    stacks.push(node.stack);
    checks.push(...node.checks);
  }
  if (existsSync(join(cwd, "Cargo.toml"))) {
    stacks.push("rust");
    checks.push({ id: "cargo-test", label: "cargo test", cmd: "cargo test" });
  }
  if (existsSync(join(cwd, "go.mod"))) {
    stacks.push("go");
    checks.push(
      { id: "go-test", label: "go test ./...", cmd: "go test ./..." },
      { id: "go-vet", label: "go vet ./...", cmd: "go vet ./..." },
    );
  }
  const python = detectPython(cwd);
  if (python) {
    stacks.push("python");
    checks.push(...python);
  }
  // Makefile `test` target: only as a fallback when nothing else surfaced a
  // test command — Makefiles routinely wrap the same commands detected above.
  if (!checks.some(isTestCheck) && makefileHasTestTarget(cwd)) {
    checks.unshift({ id: "make-test", label: "make test", cmd: "make test" });
  }

  return { stacks, checks, testCheck: checks.find(isTestCheck) };
}

function isTestCheck(check: DetectedCheck): boolean {
  return /(^|-)test$/.test(check.id) || check.id === "pytest";
}

function detectNode(cwd: string): { stack: string; checks: DetectedCheck[] } | undefined {
  const raw = readTextIfExists(join(cwd, "package.json"));
  if (raw === undefined) return undefined;
  let scripts: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = (parsed as { scripts?: unknown }).scripts;
    scripts = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return undefined; // unparseable package.json ⇒ don't guess
  }

  const runner = detectNodeRunner(cwd);
  const checks: DetectedCheck[] = [];
  for (const name of NODE_CHECK_SCRIPTS) {
    const script = scripts[name];
    if (typeof script !== "string" || script.trim() === "") continue;
    if (name === "test" && NPM_PLACEHOLDER_TEST.test(script)) continue;
    checks.push({
      id: `node-${name}`,
      label: `${runner} run ${name}`,
      cmd: `${runner} run ${name}`,
    });
  }
  return { stack: `node (${runner})`, checks };
}

function detectNodeRunner(cwd: string): string {
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

function detectPython(cwd: string): DetectedCheck[] | undefined {
  const pyproject = readTextIfExists(join(cwd, "pyproject.toml"));
  const hasPytestConfig =
    existsSync(join(cwd, "pytest.ini")) || pyproject?.includes("pytest") === true;
  if (pyproject === undefined && !hasPytestConfig) return undefined;

  const checks: DetectedCheck[] = [];
  if (hasPytestConfig) checks.push({ id: "pytest", label: "pytest", cmd: "pytest" });
  // Match the config section header, not the bare word — "ruff" alone appears
  // in comments and dependency pins of projects that don't actually use it.
  if (pyproject?.includes("[tool.ruff")) {
    checks.push({ id: "ruff", label: "ruff check .", cmd: "ruff check ." });
  }
  return checks.length > 0 ? checks : undefined;
}

function makefileHasTestTarget(cwd: string): boolean {
  const makefile = readTextIfExists(join(cwd, "Makefile"));
  return makefile !== undefined && /^test\s*:/m.test(makefile);
}

function readTextIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
