import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "../src/init";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "steamtrain-init-detect-"));
  tempRoots.push(dir);
  return dir;
}

async function writeJson(dir: string, name: string, value: unknown): Promise<void> {
  await writeFile(join(dir, name), JSON.stringify(value, null, 2));
}

describe("detectProject", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("finds nothing in an empty directory", async () => {
    const dir = await tempDir();
    const detection = detectProject(dir);
    expect(detection.stacks).toEqual([]);
    expect(detection.checks).toEqual([]);
    expect(detection.testCheck).toBeUndefined();
  });

  it("detects node scripts and picks the runner from the lockfile", async () => {
    const dir = await tempDir();
    await writeJson(dir, "package.json", {
      scripts: { test: "vitest run", lint: "biome check", typecheck: "tsc --noEmit" },
    });
    await writeFile(join(dir, "bun.lock"), "");
    const detection = detectProject(dir);
    expect(detection.stacks).toEqual(["node (bun)"]);
    expect(detection.checks.map((c) => c.cmd)).toEqual([
      "bun run test",
      "bun run lint",
      "bun run typecheck",
    ]);
    expect(detection.testCheck?.cmd).toBe("bun run test");
  });

  it("defaults the node runner to npm and skips the scaffold placeholder test", async () => {
    const dir = await tempDir();
    await writeJson(dir, "package.json", {
      scripts: { test: 'echo "Error: no test specified" && exit 1', lint: "eslint ." },
    });
    const detection = detectProject(dir);
    expect(detection.checks.map((c) => c.cmd)).toEqual(["npm run lint"]);
    expect(detection.testCheck).toBeUndefined();
  });

  it("detects rust, go, and python ecosystems", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "Cargo.toml"), "[package]\nname = 'x'\n");
    await writeFile(join(dir, "go.mod"), "module x\n");
    await writeFile(join(dir, "pyproject.toml"), "[tool.pytest.ini_options]\n[tool.ruff]\n");
    const detection = detectProject(dir);
    expect(detection.stacks).toEqual(["rust", "go", "python"]);
    expect(detection.checks.map((c) => c.id)).toEqual([
      "cargo-test",
      "go-test",
      "go-vet",
      "pytest",
      "ruff",
    ]);
    expect(detection.testCheck?.id).toBe("cargo-test");
  });

  it("falls back to a Makefile test target only when no other test command exists", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "Makefile"), "build:\n\ttrue\n\ntest:\n\ttrue\n");
    const detection = detectProject(dir);
    expect(detection.checks.map((c) => c.id)).toEqual(["make-test"]);
    expect(detection.testCheck?.cmd).toBe("make test");

    const withNode = await tempDir();
    await writeJson(withNode, "package.json", { scripts: { test: "vitest run" } });
    await writeFile(join(withNode, "Makefile"), "test:\n\ttrue\n");
    expect(detectProject(withNode).checks.map((c) => c.id)).toEqual(["node-test"]);
  });

  it("ignores an unparseable package.json instead of guessing", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "package.json"), "{ not json");
    expect(detectProject(dir).checks).toEqual([]);
  });

  it("treats an array-typed scripts key as no scripts", async () => {
    const dir = await tempDir();
    await writeJson(dir, "package.json", { scripts: ["test", "lint"] });
    const detection = detectProject(dir);
    expect(detection.stacks).toEqual(["node (npm)"]);
    expect(detection.checks).toEqual([]);
  });

  it("requires pytest/ruff config sections, not bare mentions in dependency pins", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "pyproject.toml"),
      '[project]\ndependencies = ["pytest>=7", "ruff==0.4"]\n',
    );
    expect(detectProject(dir).checks).toEqual([]);
  });
});
