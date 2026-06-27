import { describe, expect, it } from "vitest";
import { checkAgent } from "../src/doctor/doctor";

describe("checkAgent codex", () => {
  it("reports missing binary with an install hint", async () => {
    const result = await checkAgent("codex", "__steamtrain_missing_codex__");
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
    const result = await checkAgent("amp", "__steamtrain_missing_amp__");
    expect(result).toMatchObject({
      agent: "amp",
      status: "binary_missing",
      binary: "__steamtrain_missing_amp__",
    });
    expect(result.detail).toContain("npm i -g @sourcegraph/amp");
  });
});

describe("checkAgent ok", () => {
  it("reports ok status for a reachable binary", async () => {
    const result = await checkAgent("claude", "node");
    expect(result).toMatchObject({
      agent: "claude",
      status: "ok",
      binary: "node",
    });
    expect(result.version).toBeDefined();
    expect(result.message).toBe("ready");
  });
});
