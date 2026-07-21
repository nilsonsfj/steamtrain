import { describe, expect, it } from "vitest";
import { checkAgent } from "../src/doctor/doctor";

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
    expect(result.detail).toContain("npm i -g @anthropic-ai/kiro-cli");
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
