import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAgent, doctorVersionCheckPids, killDoctorVersionChecks } from "../src/doctor/doctor";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path to a shim that ignores argv and busy-loops (stands in for a hung `amp --version`). */
function writeSpinningVersionShim(): string {
  const dir = join(tmpdir(), `steamtrain-doctor-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "spin-version.mjs");
  writeFileSync(
    path,
    // Shebang so doctor can spawn the path directly (same as a real agent binary).
    // Tight loop so Activity Monitor shows the same 100% CPU symptom as a hung Bun CLI.
    "#!/usr/bin/env node\nfor (;;) {}\n",
    { mode: 0o755 },
  );
  return path;
}

afterEach(() => {
  killDoctorVersionChecks();
});

describe("checkAgent codex", () => {
  it("reports missing binary with an install hint", async () => {
    const result = await checkAgent("codex", "__steamtrain_missing_codex__", { provider: "codex" });
    expect(result).toMatchObject({
      agent: "codex",
      status: "binary_missing",
      binary: "__steamtrain_missing_codex__",
    });
    expect(result.detail).toContain("npm i -g @openai/codex");
  });
});

describe("checkAgent amp", () => {
  it("reports missing binary with an install hint", async () => {
    const result = await checkAgent("amp", "__steamtrain_missing_amp__", { provider: "amp" });
    expect(result).toMatchObject({
      agent: "amp",
      status: "binary_missing",
      binary: "__steamtrain_missing_amp__",
    });
    expect(result.detail).toContain("npm i -g @sourcegraph/amp");
  });
});

describe("checkAgent kiro", () => {
  it("reports missing binary with an install hint", async () => {
    const result = await checkAgent("kiro", "__steamtrain_missing_kiro__", { provider: "kiro" });
    expect(result).toMatchObject({
      agent: "kiro",
      status: "binary_missing",
      binary: "__steamtrain_missing_kiro__",
    });
    expect(result.detail).toContain("cli.kiro.dev");
    expect(result.detail).not.toContain("@anthropic-ai/kiro-cli");
  });
});

describe("checkAgent cursor", () => {
  it("reports missing binary with an install hint", async () => {
    const result = await checkAgent("cursor", "__steamtrain_missing_cursor__", {
      provider: "cursor",
    });
    expect(result).toMatchObject({
      agent: "cursor",
      status: "binary_missing",
      binary: "__steamtrain_missing_cursor__",
    });
    expect(result.detail).toContain("cursor.com/install");
  });
});

describe("checkAgent antigravity", () => {
  it("reports missing binary with an install hint", async () => {
    const result = await checkAgent("antigravity", "__steamtrain_missing_agy__", {
      provider: "antigravity",
    });
    expect(result).toMatchObject({
      agent: "antigravity",
      status: "binary_missing",
      binary: "__steamtrain_missing_agy__",
    });
    expect(result.detail).toContain("antigravity.google/cli/install.sh");
  });
});

describe("checkAgent ok", () => {
  it("reports ok status for a reachable binary", async () => {
    const result = await checkAgent("claude", "node", { provider: "claude" });
    expect(result).toMatchObject({
      agent: "claude",
      status: "ok",
      binary: "node",
    });
    expect(result.version).toBeDefined();
    expect(result.message).toBe("ready");
  });
});

describe("doctor version-check cleanup", () => {
  it("kills in-flight --version children so they cannot outlive steamtrain", async () => {
    const shim = writeSpinningVersionShim();
    const pending = checkAgent("amp", shim, { provider: "amp" });

    let pids: number[] = [];
    for (let i = 0; i < 40; i++) {
      pids = doctorVersionCheckPids();
      if (pids.length > 0) break;
      await delay(50);
    }
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) expect(alive(pid)).toBe(true);

    const started = Date.now();
    killDoctorVersionChecks();
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.status).toBe("unknown_error");

    await delay(100);
    for (const pid of pids) expect(alive(pid)).toBe(false);
    expect(doctorVersionCheckPids()).toEqual([]);
  });
});
