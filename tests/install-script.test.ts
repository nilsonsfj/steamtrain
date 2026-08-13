import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The top-level `install.sh` is what `curl -fsSL steamtrain.app/install.sh | sh`
 * runs, so nothing in the TypeScript suite covers it and a broken line is only
 * discovered by a new user. These tests drive the real script against a stub
 * git repo: clone, build, link, PATH guidance, and the update path.
 *
 * The stub stands in for steamtrain itself — cloning and building the real repo
 * would make this suite minutes long, and what is under test is the installer,
 * not the build.
 */

const INSTALL_SH = join(__dirname, "..", "install.sh");
const HAS_GIT = binaryExists("git");
const HAS_BUN = binaryExists("bun");

/** `command -v`, not `--version`: dash has no --version flag and exits nonzero. */
function binaryExists(name: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" }).status === 0;
}

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "steamtrain-install-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A git repo whose `bun run build` writes a dist/index.js that prints a version. */
function makeStubRepo(version: string): string {
  const repo = mkdtempSync(join(root, "repo-"));
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify(
      {
        name: "steamtrain",
        version,
        private: true,
        scripts: { build: "node build.mjs" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repo, "build.mjs"),
    [
      'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
      'const { version } = JSON.parse(readFileSync("package.json", "utf8"));',
      'mkdirSync("dist", { recursive: true });',
      'writeFileSync("dist/index.js", `#!/usr/bin/env node\\nconsole.log("steamtrain ${version}");\\n`);',
    ].join("\n"),
  );
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "--quiet", "-m", `v${version}`);
  return repo;
}

function runInstaller(
  args: string[],
  options: { env?: Record<string, string>; unset?: string[]; shell?: string } = {},
): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, ...(options.env ?? {}) };
  for (const key of options.unset ?? []) delete env[key];
  const result = spawnSync(options.shell ?? "sh", [INSTALL_SH, ...args], {
    encoding: "utf8",
    env,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("install.sh", () => {
  it("parses under every shell it might be piped into", () => {
    // `| sh` is whatever /bin/sh happens to be: bash on a Mac, dash on Debian
    // and on the CI runners.
    for (const shell of ["sh", "bash", "dash"].filter(binaryExists)) {
      const result = spawnSync(shell, ["-n", INSTALL_SH], { encoding: "utf8" });
      expect(result.stderr, `${shell} -n`).toBe("");
      expect(result.status, `${shell} -n`).toBe(0);
    }
  });

  it("prints usage for --help without touching anything", () => {
    const { status, stdout } = runInstaller(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("one-line installer");
    expect(stdout).toContain("--src-dir");
  });

  it("rejects an unknown option", () => {
    const { status, stderr } = runInstaller(["--nope"]);
    expect(status).toBe(1);
    expect(stderr).toContain("unknown option");
  });

  it("rejects an option that is missing its value", () => {
    const { status, stderr } = runInstaller(["--ref"]);
    expect(status).toBe(1);
    expect(stderr).toContain("needs a value");
  });

  it.skipIf(!HAS_GIT || !HAS_BUN)("clones, builds and links a working command", () => {
    const repo = makeStubRepo("1.2.3");
    const src = join(root, "install-a", "src");
    const bin = join(root, "install-a", "bin");

    const { status, stdout, stderr } = runInstaller([
      "--repo",
      repo,
      "--src-dir",
      src,
      "--bin-dir",
      bin,
    ]);
    expect(status, stderr).toBe(0);

    const link = join(bin, "steamtrain");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(src, "dist", "index.js"));
    expect(stdout).toContain("Installed steamtrain 1.2.3");
    expect(stdout).toContain("Uninstall:");

    const run = spawnSync(link, ["--version"], { encoding: "utf8" });
    expect(run.stdout.trim()).toBe("steamtrain 1.2.3");
  });

  it.skipIf(!HAS_GIT || !HAS_BUN)("updates an existing checkout on a second run", () => {
    const repo = makeStubRepo("2.0.0");
    const src = join(root, "install-b", "src");
    const bin = join(root, "install-b", "bin");
    const args = ["--repo", repo, "--src-dir", src, "--bin-dir", bin];

    expect(runInstaller(args).status).toBe(0);

    writeFileSync(
      join(repo, "package.json"),
      `${JSON.stringify({ name: "steamtrain", version: "2.1.0", private: true, scripts: { build: "node build.mjs" } }, null, 2)}\n`,
    );
    execFileSync("git", ["commit", "--quiet", "-am", "v2.1.0"], { cwd: repo, stdio: "ignore" });

    const second = runInstaller(args);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("Updating the checkout");
    expect(second.stdout).toContain("Installed steamtrain 2.1.0");
  });

  it.skipIf(!HAS_GIT || !HAS_BUN)("refuses to overwrite local changes in the checkout", () => {
    const repo = makeStubRepo("3.0.0");
    const src = join(root, "install-c", "src");
    const bin = join(root, "install-c", "bin");
    const args = ["--repo", repo, "--src-dir", src, "--bin-dir", bin];

    expect(runInstaller(args).status).toBe(0);
    writeFileSync(join(src, "package.json"), "{}\n");

    const second = runInstaller(args);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain("local changes");
  });

  it.skipIf(!HAS_GIT)("refuses a src dir that exists but is not a checkout", () => {
    const src = join(root, "install-d", "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "stray.txt"), "hi\n");

    const { status, stderr } = runInstaller([
      "--repo",
      "https://example.invalid/nope.git",
      "--src-dir",
      src,
      "--bin-dir",
      join(root, "install-d", "bin"),
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("not a git checkout");
  });

  it.skipIf(!HAS_GIT)("cleans up after a failed clone", () => {
    const src = join(root, "install-e", "src");
    const { status, stderr } = runInstaller(
      [
        "--repo",
        join(root, "definitely-not-a-repo"),
        "--src-dir",
        src,
        "--bin-dir",
        join(root, "install-e", "bin"),
      ],
      { env: { GIT_TERMINAL_PROMPT: "0" } },
    );
    expect(status).toBe(1);
    expect(stderr).toContain("could not clone");
    expect(existsSync(src)).toBe(false);
  });

  it.skipIf(!HAS_GIT || !HAS_BUN)("installs from an existing checkout without cloning", () => {
    const repo = makeStubRepo("4.0.0");
    const bin = join(root, "install-f", "bin");

    const { status, stdout, stderr } = runInstaller(["--from-checkout", repo, "--bin-dir", bin]);
    expect(status, stderr).toBe(0);
    expect(stdout).toContain("Installing from the checkout");
    expect(stdout).not.toContain("Cloning");
    expect(readlinkSync(join(bin, "steamtrain"))).toBe(join(repo, "dist", "index.js"));
  });

  it.skipIf(!HAS_GIT || !HAS_BUN)("refuses to replace a real file at the link path", () => {
    const repo = makeStubRepo("5.0.0");
    const bin = join(root, "install-g", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "steamtrain"), "#!/bin/sh\necho other\n");

    const blocked = runInstaller(["--from-checkout", repo, "--bin-dir", bin]);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("--force");

    const forced = runInstaller(["--from-checkout", repo, "--bin-dir", bin, "--force"]);
    expect(forced.status, forced.stderr).toBe(0);
    expect(lstatSync(join(bin, "steamtrain")).isSymbolicLink()).toBe(true);
  });

  // CI, cron and bare containers set neither SHELL nor HOME. Under `set -u`
  // an unguarded expansion of either aborts the run — and the SHELL one lands
  // in the PATH-guidance block, i.e. after the install has already succeeded,
  // so it fails a run that actually worked.
  it.each(["sh", "bash", "dash"].filter(binaryExists))(
    "installs under %s with SHELL and HOME unset",
    (shell) => {
      if (!HAS_GIT || !HAS_BUN) return;
      const repo = makeStubRepo("6.0.0");
      const bin = join(root, `install-i-${shell}`, "bin");

      const { status, stdout, stderr } = runInstaller(["--from-checkout", repo, "--bin-dir", bin], {
        unset: ["SHELL", "HOME"],
        shell,
      });
      expect(status, stderr).toBe(0);
      expect(stdout).toContain("Installed steamtrain 6.0.0");
      expect(stderr).not.toContain("parameter not set");
    },
  );

  it("explains that HOME is unset when it needs the default bin dir", () => {
    const { status, stderr } = runInstaller(["--no-build"], { unset: ["HOME"] });
    expect(status).toBe(1);
    expect(stderr).toContain("HOME is not set");
  });

  it("reports a missing build instead of linking a broken command", () => {
    const checkout = mkdtempSync(join(root, "empty-checkout-"));
    writeFileSync(join(checkout, "package.json"), '{"name":"steamtrain"}\n');

    const { status, stderr } = runInstaller([
      "--from-checkout",
      checkout,
      "--bin-dir",
      join(root, "install-h", "bin"),
      "--no-build",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("build output not found");
  });
});
